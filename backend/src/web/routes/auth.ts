import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { WebAppEnv } from '../middleware/auth'

const authBodySchema = z.object({ accessToken: z.string() })

export function createAuthRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = authBodySchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const parsedToken = parseAccessToken(parsed.data.accessToken)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid access token' }, 401)
        }

        return c.json({
            token: parsed.data.accessToken,
            user: { id: 1, firstName: 'Web User' }
        })
    })
    return app
}
