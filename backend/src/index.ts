import { createConfiguration } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { startWebServer } from './web/server'
import { SSEManager } from './sse/sseManager'
import { VisibilityTracker } from './visibility/visibilityTracker'
import { AgentManager } from './agent/agentManager'
import { TerminalManager } from './terminal/TerminalManager'
let syncEngine: SyncEngine | null = null
let webServer: ReturnType<typeof Bun.serve> | null = null
let sseManager: SSEManager | null = null
let visibilityTracker: VisibilityTracker | null = null

async function main() {
    console.log('HAPI Backend starting...')

    const config = await createConfiguration()

    if (config.cliApiTokenIsNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log(`  Token: ${config.cliApiToken}`)
        console.log(`  Saved to: ${config.settingsFile}`)
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Backend] CLI_API_TOKEN: loaded from ${config.cliApiTokenSource}`)
    }

    console.log(`[Backend] HAPI_LISTEN_HOST: ${config.listenHost}`)
    console.log(`[Backend] HAPI_LISTEN_PORT: ${config.listenPort}`)
    console.log(`[Backend] HAPI_PUBLIC_URL: ${config.publicUrl}`)

    const store = new Store(config.dbPath)

    visibilityTracker = new VisibilityTracker()
    sseManager = new SSEManager(30_000, visibilityTracker)

    const agentManager = new AgentManager(store, {
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event)
    })

    const terminalManager = new TerminalManager()

    syncEngine = new SyncEngine(store, agentManager, sseManager)

    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        getVisibilityTracker: () => visibilityTracker,
        getTerminalManager: () => terminalManager,
        corsOrigins: config.corsOrigins,
    })

    console.log('')
    console.log('[Web] Backend listening on :' + config.listenPort)
    console.log('[Web] Local:  http://localhost:' + config.listenPort)
    console.log('')
    console.log('HAPI Backend is ready!')

    const shutdown = async () => {
        console.log('\nShutting down...')
        syncEngine?.stop()
        sseManager?.stop()
        webServer?.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    await new Promise(() => {})
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
