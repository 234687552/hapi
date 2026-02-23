import type { DecryptedMessage, ModelMode, PermissionMode, Session, SyncEvent } from '@hapi/protocol/types'
import type { Store } from '../store'
import type { SSEManager } from '../sse/sseManager'
import { EventPublisher, type SyncEventListener } from './eventPublisher'
import { MessageService } from './messageService'
import { SessionCache } from './sessionCache'
import type { AgentManager, RpcCommandResponse, RpcDeleteUploadResponse, RpcListDirectoryResponse, RpcReadFileResponse, RpcUploadFileResponse } from '../agent/agentManager'

export type { Session, SyncEvent } from '@hapi/protocol/types'
export type { SyncEventListener } from './eventPublisher'
export type { RpcCommandResponse, RpcDeleteUploadResponse, RpcListDirectoryResponse, RpcReadFileResponse, RpcUploadFileResponse } from '../agent/agentManager'

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }

export class SyncEngine {
    private readonly eventPublisher: EventPublisher
    private readonly sessionCache: SessionCache
    private readonly messageService: MessageService
    private inactivityTimer: NodeJS.Timeout | null = null

    constructor(store: Store, agentManager: AgentManager, sseManager: SSEManager) {
        this.eventPublisher = new EventPublisher(sseManager, (event) => this.resolveNamespace(event))
        this.sessionCache = new SessionCache(store, this.eventPublisher)
        this.messageService = new MessageService(
            store,
            this.eventPublisher,
            (sessionId, event, ...args) => agentManager.sendToSession(sessionId, event, ...args)
        )
        this.agentManager = agentManager
        this.reloadAll()
        this.inactivityTimer = setInterval(() => this.expireInactive(), 5_000)
    }

    private readonly agentManager: AgentManager

    stop(): void {
        if (this.inactivityTimer) { clearInterval(this.inactivityTimer); this.inactivityTimer = null }
    }

    subscribe(listener: SyncEventListener): () => void {
        return this.eventPublisher.subscribe(listener)
    }

    private resolveNamespace(event: SyncEvent): string | undefined {
        if (event.namespace) return event.namespace
        if ('sessionId' in event) return this.getSession(event.sessionId)?.namespace
        return undefined
    }

    getSessions(): Session[] { return this.sessionCache.getSessions() }
    getSessionsByNamespace(namespace: string): Session[] { return this.sessionCache.getSessionsByNamespace(namespace) }
    getSession(sessionId: string): Session | undefined {
        return this.sessionCache.getSession(sessionId) ?? this.sessionCache.refreshSession(sessionId) ?? undefined
    }
    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessionCache.getSessionByNamespace(sessionId, namespace) ?? this.sessionCache.refreshSession(sessionId)
        if (!session || session.namespace !== namespace) return undefined
        return session
    }
    resolveSessionAccess(sessionId: string, namespace: string): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        return this.sessionCache.resolveSessionAccess(sessionId, namespace)
    }
    getActiveSessions(): Session[] { return this.sessionCache.getActiveSessions() }

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }) {
        return this.messageService.getMessagesPage(sessionId, options)
    }
    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.messageService.getMessagesAfter(sessionId, options)
    }

    handleRealtimeEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) { this.sessionCache.refreshSession(event.sessionId); return }
        if (event.type === 'message-received' && event.sessionId) {
            if (!this.getSession(event.sessionId)) this.sessionCache.refreshSession(event.sessionId)
        }
        this.eventPublisher.emit(event)
    }

    handleSessionAlive(payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote'; permissionMode?: PermissionMode; modelMode?: ModelMode }): void {
        this.sessionCache.handleSessionAlive(payload)
    }
    handleSessionEnd(payload: { sid: string; time: number }): void {
        this.sessionCache.handleSessionEnd(payload)
    }

    private expireInactive(): void { this.sessionCache.expireInactive() }
    private reloadAll(): void { this.sessionCache.reloadAll() }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Session {
        return this.sessionCache.getOrCreateSession(tag, metadata, agentState, namespace)
    }

    async sendMessage(sessionId: string, payload: {
        text: string; localId?: string | null
        attachments?: Array<{ id: string; filename: string; mimeType: string; size: number; path: string; previewUrl?: string }>
        sentFrom?: 'telegram-bot' | 'webapp'
    }): Promise<void> {
        await this.messageService.sendMessage(sessionId, payload)
    }

    async approvePermission(sessionId: string, requestId: string, mode?: PermissionMode, allowTools?: string[], decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort', answers?: Record<string, string[]> | Record<string, { answers: string[] }>): Promise<void> {
        await this.agentManager.approvePermission(sessionId, requestId, mode, allowTools, decision, answers)
    }
    async denyPermission(sessionId: string, requestId: string, decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'): Promise<void> {
        await this.agentManager.denyPermission(sessionId, requestId, decision)
    }
    async abortSession(sessionId: string): Promise<void> { await this.agentManager.abortSession(sessionId) }
    async archiveSession(sessionId: string): Promise<void> {
        await this.agentManager.killSession(sessionId)
        this.handleSessionEnd({ sid: sessionId, time: Date.now() })
    }
    async switchSession(sessionId: string, to: 'remote' | 'local'): Promise<void> {
        await this.agentManager.switchSession(sessionId, to)
    }
    async renameSession(sessionId: string, name: string): Promise<void> {
        await this.sessionCache.renameSession(sessionId, name)
    }
    async deleteSession(sessionId: string): Promise<void> { await this.sessionCache.deleteSession(sessionId) }

    async applySessionConfig(sessionId: string, config: { permissionMode?: PermissionMode; modelMode?: ModelMode }): Promise<void> {
        const result = await this.agentManager.requestSessionConfig(sessionId, config)
        if (!result || typeof result !== 'object') throw new Error('Invalid response from session config RPC')
        const applied = (result as any).applied
        if (!applied || typeof applied !== 'object') throw new Error('Missing applied session config')
        this.sessionCache.applySessionConfig(sessionId, applied)
    }

    async spawnSession(machineId: string, directory: string, agent: 'claude' | 'codex' | 'gemini' | 'opencode' = 'claude', model?: string, yolo?: boolean, sessionType?: 'simple' | 'worktree', worktreeName?: string, resumeSessionId?: string): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string }> {
        return await this.agentManager.spawnSession({ directory, agent, model, yolo, resumeSessionId })
    }

    async resumeSession(sessionId: string, namespace: string): Promise<ResumeSessionResult> {
        const access = this.sessionCache.resolveSessionAccess(sessionId, namespace)
        if (!access.ok) {
            return { type: 'error', message: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found', code: access.reason === 'access-denied' ? 'access_denied' : 'session_not_found' }
        }
        const session = access.session
        if (session.active) return { type: 'success', sessionId: access.sessionId }
        const metadata = session.metadata
        if (!metadata || typeof metadata.path !== 'string') return { type: 'error', message: 'Session metadata missing path', code: 'resume_unavailable' }
        const flavor = metadata.flavor === 'codex' || metadata.flavor === 'gemini' || metadata.flavor === 'opencode' ? metadata.flavor : 'claude'
        const resumeToken = flavor === 'codex' ? metadata.codexSessionId : flavor === 'gemini' ? metadata.geminiSessionId : flavor === 'opencode' ? metadata.opencodeSessionId : metadata.claudeSessionId
        if (!resumeToken) return { type: 'error', message: 'Resume session ID unavailable', code: 'resume_unavailable' }
        const spawnResult = await this.agentManager.spawnSession({ directory: metadata.path, agent: flavor, resumeSessionId: resumeToken })
        if (spawnResult.type !== 'success') return { type: 'error', message: spawnResult.message, code: 'resume_failed' }
        const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
        if (!becameActive) return { type: 'error', message: 'Session failed to become active', code: 'resume_failed' }
        if (spawnResult.sessionId !== access.sessionId) {
            try { await this.sessionCache.mergeSessions(access.sessionId, spawnResult.sessionId, namespace) }
            catch (error) { return { type: 'error', message: error instanceof Error ? error.message : 'Failed to merge resumed session', code: 'resume_failed' } }
        }
        return { type: 'success', sessionId: spawnResult.sessionId }
    }

    async waitForSessionActive(sessionId: string, timeoutMs: number = 15_000): Promise<boolean> {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (this.getSession(sessionId)?.active) return true
            await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return false
    }

    async checkPathsExist(_machineId: string, paths: string[]): Promise<Record<string, boolean>> {
        return await this.agentManager.checkPathsExist(paths)
    }
    async getGitStatus(sessionId: string, cwd?: string): Promise<RpcCommandResponse> { return await this.agentManager.getGitStatus(sessionId, cwd) }
    async getGitDiffNumstat(sessionId: string, options: { cwd?: string; staged?: boolean }): Promise<RpcCommandResponse> { return await this.agentManager.getGitDiffNumstat(sessionId, options) }
    async getGitDiffFile(sessionId: string, options: { cwd?: string; filePath: string; staged?: boolean }): Promise<RpcCommandResponse> { return await this.agentManager.getGitDiffFile(sessionId, options) }
    async readSessionFile(sessionId: string, path: string): Promise<RpcReadFileResponse> { return await this.agentManager.readSessionFile(sessionId, path) }
    async listDirectory(sessionId: string, path: string): Promise<RpcListDirectoryResponse> { return await this.agentManager.listDirectory(sessionId, path) }
    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<RpcUploadFileResponse> { return await this.agentManager.uploadFile(sessionId, filename, content, mimeType) }
    async deleteUploadFile(sessionId: string, path: string): Promise<RpcDeleteUploadResponse> { return await this.agentManager.deleteUploadFile(sessionId, path) }
    async runRipgrep(sessionId: string, args: string[], cwd?: string): Promise<RpcCommandResponse> { return await this.agentManager.runRipgrep(sessionId, args, cwd) }
    async listSlashCommands(sessionId: string, agent: string): Promise<{ success: boolean; commands?: Array<{ name: string; description?: string; source: 'builtin' | 'user' }>; error?: string }> { return await this.agentManager.listSlashCommands(sessionId, agent) }
    async listSkills(sessionId: string): Promise<{ success: boolean; skills?: Array<{ name: string; description?: string }>; error?: string }> { return await this.agentManager.listSkills(sessionId) }
}
