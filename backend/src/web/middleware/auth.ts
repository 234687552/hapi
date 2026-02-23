import type { MiddlewareHandler } from 'hono'
import { configuration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'

export type WebAppEnv = {
    Variables: {
        namespace: string
    }
}

export function createAuthMiddleware(): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (path === '/api/auth') {
            await next()
            return
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
        const tokenFromQuery = path === '/api/events' ? c.req.query().token : undefined
        const raw = tokenFromHeader ?? tokenFromQuery

        if (!raw) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        const parsed = parseAccessToken(raw)
        if (!parsed || !constantTimeEquals(parsed.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', parsed.namespace)
        return await next()
    }
}
