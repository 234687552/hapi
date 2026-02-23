import { existsSync } from 'node:fs'
import type { ModelMode, PermissionMode } from '@hapi/protocol/types'
import type { Store } from '../store'
import type { SyncEvent } from '../sync/syncEngine'
import { extractTodoWriteTodosFromMessageContent } from '../sync/todos'
import { bootstrapSession, runAgentSessionWithSession, LocalTransport, ApiSessionClient } from '@twsxtd/hapi/agent'

export type RpcCommandResponse = { success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }
export type RpcReadFileResponse = { success: boolean; content?: string; error?: string }
export type RpcUploadFileResponse = { success: boolean; path?: string; error?: string }
export type RpcDeleteUploadResponse = { success: boolean; error?: string }
export type RpcDirectoryEntry = { name: string; type: 'file' | 'directory' | 'other'; size?: number; modified?: number }
export type RpcListDirectoryResponse = { success: boolean; entries?: RpcDirectoryEntry[]; error?: string }

type SessionHandle = { transport: LocalTransport; session: ApiSessionClient }

type Callbacks = {
    onSessionAlive: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote'; permissionMode?: PermissionMode; modelMode?: ModelMode }) => void
    onSessionEnd: (payload: { sid: string; time: number }) => void
    onWebappEvent: (event: SyncEvent) => void
}

export class AgentManager {
    private sessions = new Map<string, SessionHandle>()

    constructor(private readonly store: Store, private readonly callbacks: Callbacks) {}

    async spawnSession(opts: {
        directory: string; agent: string; model?: string; yolo?: boolean; resumeSessionId?: string
    }): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        try {
            const transport = new LocalTransport()
            const { session, sessionInfo } = await bootstrapSession({
                flavor: opts.agent,
                startedBy: 'terminal',
                workingDirectory: opts.directory,
                agentState: { controlledByUser: false },
                transport,
                machineId: 'local'
            })
            const sessionId = sessionInfo.id
            this.setupHandlers(sessionId, transport)
            this.sessions.set(sessionId, { transport, session })
            void runAgentSessionWithSession({ agentType: opts.agent, workingDirectory: opts.directory, session })
                .finally(() => this.sessions.delete(sessionId))
            return { type: 'success', sessionId }
        } catch (error) {
            return { type: 'error', message: error instanceof Error ? error.message : String(error) }
        }
    }

    sendToSession(sessionId: string, event: string, ...args: unknown[]): void {
        this.sessions.get(sessionId)?.transport.send(event, ...args)
    }

    private setupHandlers(sessionId: string, transport: LocalTransport): void {
        transport.onFromSession('session-alive', (data: any) => {
            if (typeof data?.sid === 'string') this.callbacks.onSessionAlive(data)
        })
        transport.onFromSession('session-end', (data: any) => {
            if (typeof data?.sid === 'string') {
                this.callbacks.onSessionEnd(data)
                this.sessions.delete(sessionId)
            }
        })
        transport.onFromSession('message', (data: any) => {
            if (typeof data?.sid !== 'string') return
            const { sid, message: raw, localId } = data
            const content = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return raw } })() : raw
            const stored = this.store.sessions.getSession(sid)
            if (!stored) return
            const msg = this.store.messages.addMessage(sid, content, localId)
            const todos = extractTodoWriteTodosFromMessageContent(content)
            if (todos) {
                const updated = this.store.sessions.setSessionTodos(sid, todos, msg.createdAt, stored.namespace)
                if (updated) this.callbacks.onWebappEvent({ type: 'session-updated', sessionId: sid, data: { sid } })
            }
            this.callbacks.onWebappEvent({
                type: 'message-received', sessionId: sid,
                message: { id: msg.id, seq: msg.seq, localId: msg.localId, content: msg.content, createdAt: msg.createdAt }
            })
        })
        transport.onFromSession('update-metadata', (data: any, cb: (r: unknown) => void) => {
            if (typeof data?.sid !== 'string') { cb({ result: 'error' }); return }
            const stored = this.store.sessions.getSession(data.sid)
            if (!stored) { cb({ result: 'error' }); return }
            const r = this.store.sessions.updateSessionMetadata(data.sid, data.metadata, data.expectedVersion, stored.namespace)
            if (r.result === 'success') {
                cb({ result: 'success', version: r.version, metadata: r.value })
                this.callbacks.onWebappEvent({ type: 'session-updated', sessionId: data.sid, data: { sid: data.sid } })
            } else if (r.result === 'version-mismatch') {
                cb({ result: 'version-mismatch', version: r.version, metadata: r.value })
            } else { cb({ result: 'error' }) }
        })
        transport.onFromSession('update-state', (data: any, cb: (r: unknown) => void) => {
            if (typeof data?.sid !== 'string') { cb({ result: 'error' }); return }
            const stored = this.store.sessions.getSession(data.sid)
            if (!stored) { cb({ result: 'error' }); return }
            const r = this.store.sessions.updateSessionAgentState(data.sid, data.agentState, data.expectedVersion, stored.namespace)
            if (r.result === 'success') {
                cb({ result: 'success', version: r.version, agentState: r.value })
                this.callbacks.onWebappEvent({ type: 'session-updated', sessionId: data.sid, data: { sid: data.sid } })
            } else if (r.result === 'version-mismatch') {
                cb({ result: 'version-mismatch', version: r.version, agentState: r.value })
            } else { cb({ result: 'error' }) }
        })
        transport.onFromSession('ping', (cb: (r: unknown) => void) => { cb({}) })
        transport.onFromSession('rpc-register', () => { /* no-op */ })
    }

    private async sessionRpc(sessionId: string, method: string, params: unknown): Promise<unknown> {
        const handle = this.sessions.get(sessionId)
        if (!handle) throw new Error(`No active session: ${sessionId}`)
        const result = await handle.session.rpcHandlerManager.handleRequest({
            method: `${sessionId}:${method}`,
            params: JSON.stringify(params)
        })
        try { return JSON.parse(result) } catch { return result }
    }

    async approvePermission(sessionId: string, requestId: string, mode?: PermissionMode, allowTools?: string[], decision?: string, answers?: unknown): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', { id: requestId, approved: true, mode, allowTools, decision, answers })
    }
    async denyPermission(sessionId: string, requestId: string, decision?: string): Promise<void> {
        await this.sessionRpc(sessionId, 'permission', { id: requestId, approved: false, decision })
    }
    async abortSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'abort', { reason: 'User aborted' })
    }
    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.sessionRpc(sessionId, 'switch', { to })
    }
    async requestSessionConfig(sessionId: string, config: { permissionMode?: PermissionMode; modelMode?: ModelMode }): Promise<unknown> {
        return await this.sessionRpc(sessionId, 'set-session-config', config)
    }
    async killSession(sessionId: string): Promise<void> {
        await this.sessionRpc(sessionId, 'killSession', {})
    }
    async checkPathsExist(paths: string[]): Promise<Record<string, boolean>> {
        const result: Record<string, boolean> = {}
        for (const p of paths) result[p] = existsSync(p)
        return result
    }
    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-status', { cwd }) as RpcCommandResponse
    }
    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-numstat', options) as RpcCommandResponse
    }
    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'git-diff-file', options) as RpcCommandResponse
    }
    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> {
        return await this.sessionRpc(sessionId, 'readFile', { path }) as RpcReadFileResponse
    }
    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> {
        return await this.sessionRpc(sessionId, 'listDirectory', { path }) as RpcListDirectoryResponse
    }
    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> {
        return await this.sessionRpc(sessionId, 'uploadFile', { sessionId, filename, content, mimeType }) as RpcUploadFileResponse
    }
    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> {
        return await this.sessionRpc(sessionId, 'deleteUpload', { sessionId, path }) as RpcDeleteUploadResponse
    }
    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> {
        return await this.sessionRpc(sessionId, 'ripgrep', { args, cwd }) as RpcCommandResponse
    }
    async listSlashCommands(sessionId: string, agent: string): Promise<{ success: boolean; commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>; error?: string }> {
        return await this.sessionRpc(sessionId, 'listSlashCommands', { agent }) as any
    }
    async listSkills(sessionId: string): Promise<{ success: boolean; skills?: Array<{ name: string; description?: string }>; error?: string }> {
        return await this.sessionRpc(sessionId, 'listSkills', {}) as any
    }
}
