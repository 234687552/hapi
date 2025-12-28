/**
 * HAPI Server - Main Entry Point
 *
 * Provides:
 * - Web app + HTTP API
 * - Socket.IO for CLI connections
 * - SSE updates for the web UI
 * - Optional Telegram bot for notifications and Mini App entrypoint
 */

import { createConfiguration, type ConfigSource } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { NotificationHub } from './notifications/notificationHub'
import type { NotificationChannel } from './notifications/notificationTypes'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './config/jwtSecret'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import { getOrCreateVapidKeys } from './config/vapidKeys'
import { PushService } from './push/pushService'
import { PushNotificationChannel } from './push/pushNotificationChannel'
import { VisibilityTracker } from './visibility/visibilityTracker'
import { TunnelManager } from './tunnel'
import QRCode from 'qrcode'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'

/** Format config source for logging */
function formatSource(source: ConfigSource | 'generated'): string {
    switch (source) {
        case 'env':
            return 'environment'
        case 'file':
            return 'settings.json'
        case 'default':
            return 'default'
        case 'generated':
            return 'generated'
    }
}

let syncEngine: SyncEngine | null = null
let happyBot: HappyBot | null = null
let webServer: BunServer<WebSocketData> | null = null
let sseManager: SSEManager | null = null
let visibilityTracker: VisibilityTracker | null = null
let notificationHub: NotificationHub | null = null
let tunnelManager: TunnelManager | null = null

async function main() {
    console.log('HAPI Server starting...')

    // Load configuration (async - loads from env/file with persistence)
    const config = await createConfiguration()
    const relayApiDomain = process.env.HAPI_RELAY_API || null

    // Display CLI API token information
    if (config.cliApiTokenIsNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log('')
        console.log(`  Token: ${config.cliApiToken}`)
        console.log('')
        console.log(`  Saved to: ${config.settingsFile}`)
        console.log('')
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Server] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`)
    }

    // Display other configuration sources
    console.log(`[Server] WEBAPP_HOST: ${config.webappHost} (${formatSource(config.sources.webappHost)})`)
    console.log(`[Server] WEBAPP_PORT: ${config.webappPort} (${formatSource(config.sources.webappPort)})`)
    console.log(`[Server] WEBAPP_URL: ${config.miniAppUrl} (${formatSource(config.sources.webappUrl)})`)

    if (!config.telegramEnabled) {
        console.log('[Server] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        console.log(`[Server] Telegram: enabled (${tokenSource})`)
        const notificationSource = formatSource(config.sources.telegramNotification)
        console.log(`[Server] Telegram notifications: ${config.telegramNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    }

    // Display tunnel status
    if (config.tunnelEnabled) {
        const apiDomain = relayApiDomain || 'relay.hapi.run'
        console.log(`[Server] Tunnel: enabled (${formatSource(config.sources.tunnelEnabled)}), API: ${apiDomain}`)
    } else {
        console.log(`[Server] Tunnel: disabled (${formatSource(config.sources.tunnelEnabled)})`)
    }

    const store = new Store(config.dbPath)
    const jwtSecret = await getOrCreateJwtSecret()
    const vapidKeys = await getOrCreateVapidKeys(config.dataDir)
    const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:admin@hapi.run'
    const pushService = new PushService(vapidKeys, vapidSubject, store)

    visibilityTracker = new VisibilityTracker()
    sseManager = new SSEManager(30_000, visibilityTracker)

    const socketServer = createSocketServer({
        store,
        jwtSecret,
        getSession: (sessionId) => syncEngine?.getSession(sessionId) ?? store.sessions.getSession(sessionId),
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry, sseManager)

    const notificationChannels: NotificationChannel[] = [
        new PushNotificationChannel(pushService, sseManager, visibilityTracker, config.miniAppUrl)
    ]

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            miniAppUrl: config.miniAppUrl,
            store
        })
        // Only add to notification channels if notifications are enabled
        if (config.telegramNotification) {
            notificationChannels.push(happyBot)
        }
    }

    notificationHub = new NotificationHub(syncEngine, notificationChannels)

    // Start HTTP server first (before tunnel, so tunnel has something to forward to)
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        getVisibilityTracker: () => visibilityTracker,
        jwtSecret,
        store,
        vapidPublicKey: vapidKeys.publicKey,
        socketEngine: socketServer.engine
    })

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    console.log('')
    console.log('[Web] Server listening on :' + config.webappPort)
    console.log('[Web] Local:  http://localhost:' + config.webappPort)

    // Initialize tunnel AFTER web server is ready
    let tunnelUrl: string | null = null
    if (config.tunnelEnabled) {
        tunnelManager = new TunnelManager({
            localPort: config.webappPort,
            enabled: true,
            apiDomain: relayApiDomain,
            authKey: process.env.HAPI_RELAY_AUTH || null,
            useRelay: process.env.HAPI_RELAY_FORCE_TCP === 'true' || process.env.HAPI_RELAY_FORCE_TCP === '1'
        })

        try {
            tunnelUrl = await tunnelManager.start()
        } catch (error) {
            console.error('[Tunnel] Failed to start:', error instanceof Error ? error.message : error)
            console.log('[Tunnel] Server continuing without tunnel. Use --no-relay to disable.')
        }
    }

    if (tunnelUrl) {
        console.log('[Web] Public: ' + tunnelUrl)

        // Generate direct access link with server and token
        const officialWebUrl = process.env.HAPI_OFFICIAL_WEB_URL || 'https://app.hapi.run'
        const params = new URLSearchParams({
            server: tunnelUrl,
            token: config.cliApiToken
        })
        const directAccessUrl = `${officialWebUrl}/?${params.toString()}`

        console.log('')
        console.log('Open in browser:')
        console.log(`  ${directAccessUrl}`)
        console.log('')
        console.log('or scan the QR code to open:')

        // Display QR code for easy mobile access
        try {
            const qrString = await QRCode.toString(directAccessUrl, {
                type: 'terminal',
                small: true,
                margin: 1,
                errorCorrectionLevel: 'L'
            })
            console.log('')
            console.log(qrString)
        } catch {
            // QR code generation failure should not affect main flow
        }
    }
    console.log('')
    console.log('HAPI Server is ready!')

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...')
        await tunnelManager?.stop()
        await happyBot?.stop()
        notificationHub?.stop()
        syncEngine?.stop()
        sseManager?.stop()
        webServer?.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep process running
    await new Promise(() => {})
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
