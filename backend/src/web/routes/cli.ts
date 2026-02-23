import { Hono } from 'hono'
import { z } from 'zod'
import { PROTOCOL_VERSION } from '@hapi/protocol'
import { configuration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Session, SyncEngine } from '../../sync/syncEngine'

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const createOrLoadSessionSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional()
})

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

type CliEnv = { Variables: { namespace: string } }

function resolveSessionForNamespace(
    engine: SyncEngine, sessionId: string, namespace: string
): { ok: true; session: Session; sessionId: string } | { ok: false; status: 403 | 404; error: string } {
    const access = engine.resolveSessionAccess(sessionId, namespace)
    if (access.ok) return { ok: true, session: access.session, sessionId: access.sessionId }
    return { ok: false, status: access.reason === 'access-denied' ? 403 : 404, error: access.reason === 'access-denied' ? 'Session access denied' : 'Session not found' }
}

export function createCliRoutes(getSyncEngine: () => SyncEngine | null): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    app.use('*', async (c, next) => {
        c.header('X-Hapi-Protocol-Version', String(PROTOCOL_VERSION))
        const raw = c.req.header('authorization')
        if (!raw) return c.json({ error: 'Missing Authorization header' }, 401)
        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) return c.json({ error: 'Invalid Authorization header' }, 401)
        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }
        c.set('namespace', parsedToken.namespace)
        return await next()
    })

    app.post('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadSessionSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)
        const namespace = c.get('namespace')
        const session = engine.getOrCreateSession(parsed.data.tag, parsed.data.metadata, parsed.data.agentState ?? null, namespace)
        return c.json({ session })
    })

    app.get('/sessions/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const resolved = resolveSessionForNamespace(engine, c.req.param('id'), c.get('namespace'))
        if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status)
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not ready' }, 503)
        const resolved = resolveSessionForNamespace(engine, c.req.param('id'), c.get('namespace'))
        if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status)
        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query' }, 400)
        const messages = engine.getMessagesAfter(resolved.sessionId, { afterSeq: parsed.data.afterSeq, limit: parsed.data.limit ?? 200 })
        return c.json({ messages })
    })

    // Keep /machines endpoint for bootstrapSession compatibility
    app.post('/machines', async (c) => {
        return c.json({ machine: { id: 'local', namespace: c.get('namespace'), seq: 0, createdAt: Date.now(), updatedAt: Date.now(), active: true, activeAt: Date.now(), metadata: null, metadataVersion: 1, runnerState: null, runnerStateVersion: 1 } })
    })

    app.get('/machines/:id', (c) => {
        return c.json({ machine: { id: c.req.param('id'), namespace: c.get('namespace'), seq: 0, createdAt: Date.now(), updatedAt: Date.now(), active: true, activeAt: Date.now(), metadata: null, metadataVersion: 1, runnerState: null, runnerStateVersion: 1 } })
    })

    return app
}
