import { Hono } from 'hono'
import { z } from 'zod'
import os from 'node:os'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'

const LOCAL_MACHINE = { id: 'local', hostname: os.hostname(), online: true }

const spawnBodySchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'gemini', 'opencode']).optional(),
    model: z.string().optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional()
})

const pathsExistsSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => c.json({ machines: [LOCAL_MACHINE] }))

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = spawnBodySchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const result = await engine.spawnSession(
            'local',
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.model,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName
        )
        return c.json(result)
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) return c.json({ error: 'Not connected' }, 503)

        const body = await c.req.json().catch(() => null)
        const parsed = pathsExistsSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((p) => p.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) return c.json({ exists: {} })

        try {
            const exists = await engine.checkPathsExist('local', uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    return app
}
