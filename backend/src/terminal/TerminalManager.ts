import { spawn } from 'node-pty'
import type { IPty } from 'node-pty'

type TerminalHandle = { pty: IPty; send: (msg: object) => void }

export class TerminalManager {
    private terminals = new Map<string, TerminalHandle>()

    create(terminalId: string, cols: number, rows: number, send: (msg: object) => void): void {
        if (this.terminals.has(terminalId)) {
            send({ type: 'ready', terminalId })
            return
        }
        try {
            const shell = process.env.SHELL ?? '/bin/sh'
            const pty = spawn(shell, [], {
                name: 'xterm-256color', cols, rows,
                cwd: process.env.HOME ?? process.cwd(),
                env: process.env as Record<string, string>
            })
            this.terminals.set(terminalId, { pty, send })
            pty.onData((data) => send({ type: 'output', terminalId, data }))
            pty.onExit(({ exitCode, signal }) => {
                send({ type: 'exit', terminalId, code: exitCode, signal: signal ?? null })
                this.terminals.delete(terminalId)
            })
            send({ type: 'ready', terminalId })
        } catch (error) {
            send({ type: 'error', terminalId, message: error instanceof Error ? error.message : String(error) })
        }
    }

    write(terminalId: string, data: string): void {
        this.terminals.get(terminalId)?.pty.write(data)
    }

    resize(terminalId: string, cols: number, rows: number): void {
        this.terminals.get(terminalId)?.pty.resize(cols, rows)
    }

    close(terminalId: string): void {
        const handle = this.terminals.get(terminalId)
        if (handle) { handle.pty.kill(); this.terminals.delete(terminalId) }
    }
}
