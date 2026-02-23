import { EventEmitter } from 'node:events'

/**
 * In-process transport replacing Socket.IO for backend-embedded sessions.
 * Implements the subset of Socket.IO client API used by ApiSessionClient.
 */
export class LocalTransport {
    private readonly inbound = new EventEmitter()
    private readonly outbound = new EventEmitter()

    connected = true

    on(event: string, handler: (...args: any[]) => void): this {
        this.inbound.on(event, handler)
        return this
    }

    off(event: string, handler: (...args: any[]) => void): this {
        this.inbound.off(event, handler)
        return this
    }

    removeAllListeners(event?: string): this {
        this.inbound.removeAllListeners(event)
        return this
    }

    emit(event: string, ...args: any[]): boolean {
        this.outbound.emit(event, ...args)
        return true
    }

    get volatile(): this {
        return this
    }

    async emitWithAck(event: string, ...args: any[]): Promise<unknown> {
        return new Promise((resolve) => {
            this.outbound.emit(event, ...args, resolve)
        })
    }

    timeout(_ms: number): { emitWithAck: (event: string, ...args: any[]) => Promise<unknown> } {
        return { emitWithAck: (event: string, ...args: any[]) => this.emitWithAck(event, ...args) }
    }

    connect(): void {
        setImmediate(() => this.inbound.emit('connect'))
    }

    disconnect(): void {
        this.inbound.emit('disconnect', 'io client disconnect')
    }

    // Backend-side: send event to session
    send(event: string, ...args: any[]): void {
        this.inbound.emit(event, ...args)
    }

    // Backend-side: listen for events from session
    onFromSession(event: string, handler: (...args: any[]) => void): void {
        this.outbound.on(event, handler)
    }

    offFromSession(event: string, handler: (...args: any[]) => void): void {
        this.outbound.off(event, handler)
    }
}
