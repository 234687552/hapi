import { useCallback, useEffect, useRef, useState } from 'react'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; error: string }

type UseTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
    terminalId: string
}

export function useTerminalSocket(options: UseTerminalSocketOptions): {
    state: TerminalConnectionState
    connect: (cols: number, rows: number) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    disconnect: () => void
    onOutput: (handler: (data: string) => void) => void
    onExit: (handler: (code: number | null, signal: string | null) => void) => void
} {
    const [state, setState] = useState<TerminalConnectionState>({ status: 'idle' })
    const wsRef = useRef<WebSocket | null>(null)
    const outputHandlerRef = useRef<(data: string) => void>(() => {})
    const exitHandlerRef = useRef<(code: number | null, signal: string | null) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const terminalIdRef = useRef(options.terminalId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const reconnectAttemptsRef = useRef(0)
    const intentionalCloseRef = useRef(false)

    useEffect(() => {
        sessionIdRef.current = options.sessionId
        terminalIdRef.current = options.terminalId
        baseUrlRef.current = options.baseUrl
    }, [options.sessionId, options.terminalId, options.baseUrl])

    useEffect(() => { tokenRef.current = options.token }, [options.token])

    const setErrorState = useCallback((message: string) => setState({ status: 'error', error: message }), [])

    const createConnection = useCallback((cols: number, rows: number) => {
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        const terminalId = terminalIdRef.current
        const wsUrl = `${baseUrlRef.current.replace(/^http/, 'ws')}/ws/terminal/${sessionId}?token=${encodeURIComponent(token)}`
        const ws = new WebSocket(wsUrl)
        wsRef.current = ws
        setState({ status: 'connecting' })

        ws.onopen = () => {
            reconnectAttemptsRef.current = 0
            const size = lastSizeRef.current ?? { cols, rows }
            ws.send(JSON.stringify({ type: 'create', terminalId, cols: size.cols, rows: size.rows }))
        }

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data)
                if (msg.terminalId !== terminalIdRef.current) return
                if (msg.type === 'ready') setState({ status: 'connected' })
                else if (msg.type === 'output') outputHandlerRef.current(msg.data)
                else if (msg.type === 'exit') { exitHandlerRef.current(msg.code, msg.signal); setErrorState('Terminal exited.') }
                else if (msg.type === 'error') setErrorState(msg.message)
            } catch {}
        }

        ws.onerror = () => setErrorState('Connection error')

        ws.onclose = () => {
            if (intentionalCloseRef.current) { setState({ status: 'idle' }); return }
            const attempts = reconnectAttemptsRef.current
            if (attempts >= 10) { setErrorState('Disconnected'); return }
            reconnectAttemptsRef.current++
            const delay = Math.min(1000 * Math.pow(1.5, attempts), 5000)
            reconnectTimerRef.current = setTimeout(() => {
                if (!intentionalCloseRef.current) createConnection(cols, rows)
            }, delay)
        }
    }, [setErrorState])

    const connect = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        if (!tokenRef.current || !sessionIdRef.current || !terminalIdRef.current) {
            setErrorState('Missing terminal credentials.')
            return
        }
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'create', terminalId: terminalIdRef.current, cols, rows }))
            setState({ status: 'connecting' })
            return
        }
        intentionalCloseRef.current = false
        createConnection(cols, rows)
    }, [createConnection, setErrorState])

    const write = useCallback((data: string) => {
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'write', terminalId: terminalIdRef.current, data }))
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', terminalId: terminalIdRef.current, cols, rows }))
    }, [])

    const disconnect = useCallback(() => {
        intentionalCloseRef.current = true
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
        const ws = wsRef.current
        if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null; ws.close(); wsRef.current = null }
        setState({ status: 'idle' })
    }, [])

    const onOutput = useCallback((handler: (data: string) => void) => { outputHandlerRef.current = handler }, [])
    const onExit = useCallback((handler: (code: number | null, signal: string | null) => void) => { exitHandlerRef.current = handler }, [])

    return { state, connect, write, resize, disconnect, onOutput, onExit }
}
