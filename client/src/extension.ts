import * as net from 'net'
import * as path from 'path'
import * as cp from 'child_process'
import {
	workspace as Workspace, window as Window, ExtensionContext, TextDocument, OutputChannel, WorkspaceFolder, Uri, DebugConfigurationProvider, DebugConfiguration, ProviderResult, CancellationToken
} from 'vscode'

import * as vscode from 'vscode'

import {
	CloseAction,
	ErrorAction,
	LanguageClient, LanguageClientOptions, StreamInfo
} from 'vscode-languageclient/node'

let SPAWN_SERVER = true
let DEFAULT_PORT = 7999 + Math.round(Math.random() * 1000)
let defaultClient: LanguageClient
const clients: Map<string, LanguageClient> = new Map()
const sockets: Map<string, net.Socket> = new Map()
const childProcesses: Map<string, cp.ChildProcess> = new Map()

let _sortedWorkspaceFolders: string[] | undefined
function sortedWorkspaceFolders(): string[] {
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = Workspace.workspaceFolders
			? Workspace.workspaceFolders.map(folder => {
				let result = folder.uri.toString()
				if (result.charAt(result.length - 1) !== '/') {
					result = result + '/'
				}
				return result
			}).sort((a, b) => { return a.length - b.length })
			: []
	}
	return _sortedWorkspaceFolders
}
Workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined)

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
	const sorted = sortedWorkspaceFolders()
	for (const element of sorted) {
		let uri = folder.uri.toString()
		if (uri.charAt(uri.length - 1) !== '/')
			uri = uri + '/'
		if (uri.startsWith(element))
			return Workspace.getWorkspaceFolder(Uri.parse(element))!
	}
	return folder
}

function createServerWithSocket(folder_uri: string, port: number, cmd: string, args: string[], cwd: string, out: OutputChannel) {
	return new Promise<[cp.ChildProcess, net.Socket]>(resolve => {
		const log = function (data: string) {
			console.log(data)
			out.appendLine(data)
		}
		log(`> spawn server ${cmd} ${args.join(' ')} - '${folder_uri}' cwd: ${cwd}`)
		const child: cp.ChildProcess = SPAWN_SERVER ? cp.spawn(cmd, args, { cwd: cwd }) : null

		if (child) {
			const settings = Workspace.getConfiguration()
			const timeout = settings.get<number>("dascript.server.connectTimeout", 2)
			const waitTime = Date.now()
			while (Date.now() - waitTime < timeout * 1000) {
				// log("waiting child... " + timeout)
			}

			child.stdout.on('data', (data) => log(data?.toString()))
			child.stdout.on("error", (data) => log(`error: ${data}`))
			child.stderr.on("data", (data) => log(`stderr: ${data?.toString()}`))
			child.stderr.on("error", (data) => log(`stderr error: ${data}`))

			child.on('close', (code) => {
				log(`child process closed with code ${code} - '${folder_uri}'`)
				childProcesses.delete(folder_uri)
				if (sockets.has(folder_uri))
					sockets.delete(folder_uri)
				else
					resolve([child, socket])
			})
			child.on('error', (err) => {
				log(`Failed to spawn server ${err.message}`)
			})
			child.on('exit', (code) => {
				log(`child process exited with code ${code} - '${folder_uri}'`)
				childProcesses.delete(folder_uri)
				if (sockets.has(folder_uri))
					sockets.delete(folder_uri)
				else
					resolve([child, socket])
			})
		}

		const socket = net.connect({ port: port }, () => {
			socket.setNoDelay()
			log(`> ${port} connected - '${folder_uri}'`)
			childProcesses.set(folder_uri, child)
			sockets.set(folder_uri, socket)
			resolve([child, socket])
		})

		// socket.on('data', (data) => {
		// 	const msg = data.toString()
		// 	console.log(msg.length > 1000 ? msg.substr(0, 1000) + "..." : msg)
		// })
		socket.on('error', (err) => {
			console.log(`socket error: ${err.message}`)
			if (err.stack != null)
				console.log(err.stack ?? "")
		})
		socket.on('end', () => {
			console.log(`socked closed - '${folder_uri}'`)
			if (child && !child.killed)
				child.kill()
			childProcesses.delete(folder_uri)
			sockets.delete(folder_uri)
		})
	})
}

function setArg(args: string[], pattern: string, value: string): string[] {
	const res = new Array<string>()
	for (const it of args) {
		res.push(it.replace(pattern, value))
	}
	return res
}

export function activate(context: ExtensionContext) {

	const settings = Workspace.getConfiguration()

	const cmd = settings.get<string>("dascript.compiler")
	let args = settings.get<string[]>("dascript.server.args")
	const port: number = settings.get("dascript.debug.port", -1)
	if (port != 0) {
		SPAWN_SERVER = port > 0
		DEFAULT_PORT = Math.abs(port)
	}
	const cwd = context.asAbsolutePath(path.join('server', 'das'))
	const serverFilePath = context.asAbsolutePath(path.join('server', 'das', 'server.das'))
	args = setArg(args, "${file}", serverFilePath)
	const outputChannel: OutputChannel = Window.createOutputChannel('daScript')

	function didOpenTextDocument(document: TextDocument): void {
		if (document.languageId !== 'dascript' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return
		}

		const uri = document.uri
		if (uri.scheme === 'untitled' && !defaultClient) {
			const serverOptions = async () => {
				const port = DEFAULT_PORT
				const [_, socket] = await createServerWithSocket("____untitled____", port, cmd, setArg(args, "${port}", port.toPrecision()), cwd, outputChannel)
				const result: StreamInfo = {
					writer: socket,
					reader: socket
				}
				return Promise.resolve(result)
			}
			const clientOptions: LanguageClientOptions = {
				documentSelector: [{ scheme: 'untitled', language: 'dascript' }],
				diagnosticCollectionName: 'dascript',
				outputChannel: outputChannel
			}
			defaultClient = new LanguageClient('dascript', serverOptions, clientOptions)
			defaultClient.start()
			return
		}
		let folder = Workspace.getWorkspaceFolder(uri)
		if (!folder)
			return
		folder = getOuterMostWorkspaceFolder(folder)

		const folderUri = folder.uri.toString()
		if (!clients.has(folderUri)) {
			const serverOptions = async () => {
				const port = DEFAULT_PORT + clients.size
				const [_, socket] = await createServerWithSocket(folderUri, port, cmd, setArg(args, "${port}", port.toPrecision()), cwd, outputChannel)
				const result: StreamInfo = {
					writer: socket,
					reader: socket
				}
				return Promise.resolve(result)
			}
			const clientOptions: LanguageClientOptions = {
				documentSelector: [
					{ scheme: 'file', language: 'dascript', pattern: `${folder.uri.fsPath}/**/*` }
				],
				diagnosticCollectionName: 'dascript',
				workspaceFolder: folder,
				outputChannel: outputChannel,
				connectionOptions: {
					cancellationStrategy: null,
					maxRestartCount: 10
				}
				// errorHandler: {
				// 	error: (error, message, count) => {
				// 		outputChannel.appendLine(`[Client error] #(${count})`)
				// 		outputChannel.appendLine(error.message)
				// 		outputChannel.appendLine(message.jsonrpc)
				// 		return ErrorAction.Continue
				// 	},
				// 	closed: () => {
				// 		outputChannel.appendLine(`[Client closed] Restart`)
				// 		return CloseAction.Restart
				// 	}
				// }
			}
			const client = new LanguageClient('dascript', serverOptions, clientOptions)
			client.start()
			clients.set(folder.uri.toString(), client)
		}
	}

	Workspace.onDidOpenTextDocument(didOpenTextDocument)
	Workspace.textDocuments.forEach(didOpenTextDocument)
	Workspace.onDidChangeWorkspaceFolders((event) => {
		for (const folder of event.removed) {
			const uri = folder.uri.toString()
			const client = clients.get(uri)
			if (client) {
				clients.delete(uri)
				client.stop()
			}
			const child = childProcesses.get(uri)
			if (child) {
				childProcesses.delete(uri)
				child.kill()
			}
		}
	})

	const provider = new DascriptLaunchConfigurationProvider()
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('dascript', provider))
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('dascript', new DascriptLaunchDebugAdapterFactory()))
}

export function deactivate(): Thenable<void> {
	const promises: Thenable<void>[] = []
	if (defaultClient)
		promises.push(defaultClient.stop())
	for (const client of clients.values())
		promises.push(client.stop())
	return Promise.all(promises).then(() => undefined)
}

const DEBUGGER_CONNECTION_TIMEOUT = 2
const DEBUGGER_PORT = 10000

class DascriptLaunchConfigurationProvider implements DebugConfigurationProvider {

	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor
			if (editor?.document?.languageId === 'dascript') {
				config.type = 'dascript'
				config.name = 'dascript'
				config.request = 'launch'
				config.program = '${config:dascript.compiler} ${file}'
				config.cwd = '${fileDirname}'
			}
		}
		return config
	}
}

class DascriptLaunchDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	child: cp.ChildProcess
	outputChannel: OutputChannel
	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {

		const host = "host" in _session.configuration && String(_session.configuration.host).length > 0 ? String(_session.configuration.host) : null
		let port = "port" in _session.configuration ? _session.configuration.port : 0

		if (_session.configuration.request != "launch")
			return new vscode.DebugAdapterServer(port <= 0 ? DEBUGGER_PORT : port, host)

		if (port <= 0)
			port = Math.floor(Math.random() * 1000 + DEBUGGER_PORT)

		if (this.outputChannel)
			this.outputChannel.dispose() // always recreate output
		const outputChannel: OutputChannel = Window.createOutputChannel("daScript debug output")
		outputChannel.show(true)
		this.outputChannel = outputChannel

		const log = function (data: string) {
			console.log(data)
			outputChannel.append(data)
		}

		if (this.child)
			this.child.kill()

		const hasDebug = !(_session.configuration?.noDebug ?? false)
		const cwd = _session.configuration.cwd || _session.workspaceFolder.uri.fsPath
		const cmdAndArgs: string[] = _session.configuration.program.split(" ")
		const cmd = cmdAndArgs.shift()
		const extraArgs = ["--das-debug-port", `${port}`]
		if (hasDebug)
			extraArgs.push("--das-wait-debugger")
		if ("steppingDebugger" in _session.configuration ? _session.configuration.steppingDebugger : false)
			extraArgs.push("--das-stepping-debugger")

		const args = cmdAndArgs.concat(cmdAndArgs.indexOf("--") >= 0 ? extraArgs : ["--", ...extraArgs])
		const externalConsole = _session.configuration.console == "externalTerminal"

		log(`> ${cmd} ${args.join(' ')}\n`)
		this.child = cp.spawn(cmd, args, { cwd: cwd, detached: externalConsole, shell: externalConsole })

		if (this.child) {
			// this.child.on('spawn', () => {
			// 	console.log(`da spawned`)
			// })
			this.child.on('error', (err) => {
				log(`da: child process error ${err.message}`)
				this.child.kill()
				this.child = null
			})
			this.child.on('close', (code) => {
				log(`\nda: child process exited with code ${code}`)
				this.child = null
			})
			this.child.stdout.on('data', (data) => {
				log(`${data}`)
			})
			this.child.stderr.on('data', (data) => {
				log(`da: [stderr] ${data}`)
			})
			const connectTimeout = "connectTimeout" in _session.configuration ? _session.configuration.connectTimeout : DEBUGGER_CONNECTION_TIMEOUT
			const waitTime = Date.now()
			if (hasDebug)
				while (Date.now() - waitTime < connectTimeout * 1000) {
					// log("waiting child...")
				}
		}

		return hasDebug ? new vscode.DebugAdapterServer(port, host) : new vscode.DebugAdapterExecutable("")
	}
}
