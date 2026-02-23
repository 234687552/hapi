import type { AttachmentMetadata, DecryptedMessage } from '@hapi/protocol/types'
import type { Store } from '../store'
import { EventPublisher } from './eventPublisher'

export class MessageService {
    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher,
        private readonly sendToSession: (sessionId: string, event: string, ...args: unknown[]) => void
    ) {}

    getMessagesPage(sessionId: string, options: { limit: number; beforeSeq: number | null }): {
        messages: DecryptedMessage[]
        page: { limit: number; beforeSeq: number | null; nextBeforeSeq: number | null; hasMore: boolean }
    } {
        const stored = this.store.messages.getMessages(sessionId, options.limit, options.beforeSeq ?? undefined)
        const messages: DecryptedMessage[] = stored.map((m) => ({ id: m.id, seq: m.seq, localId: m.localId, content: m.content, createdAt: m.createdAt }))
        let oldestSeq: number | null = null
        for (const m of messages) {
            if (typeof m.seq === 'number' && (oldestSeq === null || m.seq < oldestSeq)) oldestSeq = m.seq
        }
        const nextBeforeSeq = oldestSeq
        const hasMore = nextBeforeSeq !== null && this.store.messages.getMessages(sessionId, 1, nextBeforeSeq).length > 0
        return { messages, page: { limit: options.limit, beforeSeq: options.beforeSeq, nextBeforeSeq, hasMore } }
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return this.store.messages.getMessagesAfter(sessionId, options.afterSeq, options.limit)
            .map((m) => ({ id: m.id, seq: m.seq, localId: m.localId, content: m.content, createdAt: m.createdAt }))
    }

    async sendMessage(sessionId: string, payload: {
        text: string; localId?: string | null; attachments?: AttachmentMetadata[]; sentFrom?: 'telegram-bot' | 'webapp'
    }): Promise<void> {
        const sentFrom = payload.sentFrom ?? 'webapp'
        const content = {
            role: 'user',
            content: { type: 'text', text: payload.text, attachments: payload.attachments },
            meta: { sentFrom }
        }
        const msg = this.store.messages.addMessage(sessionId, content, payload.localId ?? undefined)
        const update = {
            id: msg.id, seq: msg.seq, createdAt: msg.createdAt,
            body: {
                t: 'new-message' as const, sid: sessionId,
                message: { id: msg.id, seq: msg.seq, createdAt: msg.createdAt, localId: msg.localId, content: msg.content }
            }
        }
        this.sendToSession(sessionId, 'update', update)
        this.publisher.emit({
            type: 'message-received', sessionId,
            message: { id: msg.id, seq: msg.seq, localId: msg.localId, content: msg.content, createdAt: msg.createdAt }
        })
    }
}
