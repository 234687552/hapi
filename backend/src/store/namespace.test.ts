import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('Store namespace filtering', () => {
    it('filters sessions by namespace', () => {
        const store = new Store(':memory:')
        const sessionAlpha = store.sessions.getOrCreateSession('tag', { path: '/alpha' }, null, 'alpha')
        const sessionBeta = store.sessions.getOrCreateSession('tag', { path: '/beta' }, null, 'beta')

        const sessionsAlpha = store.sessions.getSessionsByNamespace('alpha')
        const ids = sessionsAlpha.map((session) => session.id)

        expect(ids).toContain(sessionAlpha.id)
        expect(ids).not.toContain(sessionBeta.id)
    })
})
