import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { serveStatic } from 'hono/bun'
import { configuration } from '../configuration'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import type { SyncEngine } from '../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from './middleware/auth'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'
import type { TerminalManager } from '../terminal/TerminalManager'
import { createAuthRoutes } from './routes/auth'
import { createEventsRoutes } from './routes/events'
import { createSessionsRoutes } from './routes/sessions'
import { createMessagesRoutes } from './routes/messages'
import { createPermissionsRoutes } from './routes/permissions'
import { createMachinesRoutes } from './routes/machines'
import { createGitRoutes } from './routes/git'
import { createCliRoutes } from './routes/cli'
import { createVoiceRoutes } from './routes/voice'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'

function findWebappDistDir(): { distDir: string; indexHtmlPath: string } {
    const candidates = [
        join(process.cwd(), '..', 'web', 'dist'),
        join(import.meta.dir, '..', '..', '..', 'web', 'dist'),
        join(process.cwd(), 'web', 'dist')
    ]
    for (const distDir of candidates) {
        const indexHtmlPath = join(distDir, 'index.html')
        if (existsSync(indexHtmlPath)) return { distDir, indexHtmlPath }
    }
    const distDir = candidates[0]!
    return { distDir, indexHtmlPath: join(distDir, 'index.html') }
}

function serveEmbeddedAsset(asset: EmbeddedWebAsset): Response {
    return new Response(Bun.file(asset.sourcePath), { headers: { 'Content-Type': asset.mimeType } })
}

function createWebApp(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    corsOrigins?: string[]
    embeddedAssetMap: Map<string, EmbeddedWebAsset> | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('*', logger())
    app.get('/health', (c) => c.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION }))

    const corsOrigins = options.corsOrigins ?? configuration.corsOrigins
    const corsOriginOption = corsOrigins.includes('*') ? '*' : corsOrigins
    const corsMiddleware = cors({
        origin: corsOriginOption,
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type']
    })
    app.use('/api/*', corsMiddleware)
    app.use('/cli/*', corsMiddleware)

    app.route('/cli', createCliRoutes(options.getSyncEngine))
    app.route('/api', createAuthRoutes())

    app.use('/api/*', createAuthMiddleware())
    app.route('/api', createEventsRoutes(options.getSseManager, options.getSyncEngine, options.getVisibilityTracker))
    app.route('/api', createSessionsRoutes(options.getSyncEngine))
    app.route('/api', createMessagesRoutes(options.getSyncEngine))
    app.route('/api', createPermissionsRoutes(options.getSyncEngine))
    app.route('/api', createMachinesRoutes(options.getSyncEngine))
    app.route('/api', createGitRoutes(options.getSyncEngine))
    app.route('/api', createVoiceRoutes())

    if (options.embeddedAssetMap) {
        const embeddedAssetMap = options.embeddedAssetMap
        const indexHtmlAsset = embeddedAssetMap.get('/index.html')
        if (!indexHtmlAsset) {
            app.get('*', (c) => c.text('Embedded Mini App is missing index.html.', 503))
            return app
        }
        app.use('*', async (c, next) => {
            if (c.req.path.startsWith('/api') || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return await next()
            const asset = embeddedAssetMap.get(c.req.path)
            if (asset) return serveEmbeddedAsset(asset)
            return await next()
        })
        app.get('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) { await next(); return }
            return serveEmbeddedAsset(indexHtmlAsset)
        })
        return app
    }

    const { distDir, indexHtmlPath } = findWebappDistDir()
    if (!existsSync(indexHtmlPath)) {
        app.get('/', (c) => c.text('Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n', 503))
        return app
    }

    app.use('/assets/*', serveStatic({ root: distDir }))
    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) { await next(); return }
        return await serveStatic({ root: distDir })(c, next)
    })
    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) { await next(); return }
        return await serveStatic({ root: distDir, path: 'index.html' })(c, next)
    })

    return app
}

type WsData = { namespace: string; sessionId: string; terminalIds: Set<string> }

export async function startWebServer(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    getVisibilityTracker: () => VisibilityTracker | null
    getTerminalManager: () => TerminalManager | null
    corsOrigins?: string[]
}): Promise<ReturnType<typeof Bun.serve>> {
    const isCompiled = isBunCompiled()
    const embeddedAssetMap = isCompiled ? await loadEmbeddedAssetMap() : null
    const app = createWebApp({
        getSyncEngine: options.getSyncEngine,
        getSseManager: options.getSseManager,
        getVisibilityTracker: options.getVisibilityTracker,
        corsOrigins: options.corsOrigins,
        embeddedAssetMap
    })

    const server = Bun.serve<WsData>({
        hostname: configuration.listenHost,
        port: configuration.listenPort,
        fetch(req, srv) {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/ws/terminal/')) {
                const token = url.searchParams.get('token') ?? ''
                const parsed = parseAccessToken(token)
                if (!parsed || !constantTimeEquals(parsed.baseToken, configuration.cliApiToken)) {
                    return new Response('Unauthorized', { status: 401 })
                }
                const sessionId = url.pathname.slice('/ws/terminal/'.length)
                if (srv.upgrade(req, { data: { namespace: parsed.namespace, sessionId, terminalIds: new Set<string>() } })) return
                return new Response('WebSocket upgrade failed', { status: 400 })
            }
            return app.fetch(req)
        },
        websocket: {
            message(ws, message) {
                const tm = options.getTerminalManager()
                if (!tm) return
                try {
                    const msg = JSON.parse(typeof message === 'string' ? message : message.toString())
                    const { type, terminalId } = msg
                    if (!terminalId) return
                    const send = (data: object) => ws.send(JSON.stringify(data))
                    if (type === 'create') {
                        ws.data.terminalIds.add(terminalId)
                        tm.create(terminalId, msg.cols ?? 80, msg.rows ?? 24, send)
                    } else if (type === 'write') {
                        tm.write(terminalId, msg.data ?? '')
                    } else if (type === 'resize') {
                        tm.resize(terminalId, msg.cols ?? 80, msg.rows ?? 24)
                    }
                } catch {}
            },
            close(ws) {
                const tm = options.getTerminalManager()
                if (!tm) return
                for (const terminalId of ws.data.terminalIds) tm.close(terminalId)
            }
        }
    })

    console.log(`[Web] backend listening on ${configuration.listenHost}:${configuration.listenPort}`)
    console.log(`[Web] public URL: ${configuration.publicUrl}`)
    return server
}
