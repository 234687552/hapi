import { getSettingsFile, readSettings, writeSettings } from './settings'

export interface ServerSettings {
    listenHost: string
    listenPort: number
    publicUrl: string
    corsOrigins: string[]
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        listenHost: 'env' | 'file' | 'default'
        listenPort: 'env' | 'file' | 'default'
        publicUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
    }
    savedToFile: boolean
}

function parseCorsOrigins(str: string): string[] {
    const entries = str.split(',').map(o => o.trim()).filter(Boolean)
    if (entries.includes('*')) return ['*']
    return entries.map(e => { try { return new URL(e).origin } catch { return e } })
}

function deriveCorsOrigins(publicUrl: string): string[] {
    try { return [new URL(publicUrl).origin] } catch { return [] }
}

export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettings(settingsFile)
    if (settings === null) throw new Error(`Cannot read ${settingsFile}. Please fix or remove the file and restart.`)

    let needsSave = false
    const sources: ServerSettingsResult['sources'] = {
        listenHost: 'default', listenPort: 'default', publicUrl: 'default', corsOrigins: 'default'
    }

    let listenHost = '127.0.0.1'
    if (process.env.HAPI_LISTEN_HOST) {
        listenHost = process.env.HAPI_LISTEN_HOST; sources.listenHost = 'env'
        if (settings.listenHost === undefined) { settings.listenHost = listenHost; needsSave = true }
    } else if (settings.listenHost !== undefined) {
        listenHost = settings.listenHost; sources.listenHost = 'file'
    } else if (settings.webappHost !== undefined) {
        listenHost = settings.webappHost; sources.listenHost = 'file'
        settings.listenHost = listenHost; delete settings.webappHost; needsSave = true
    }

    let listenPort = 3006
    if (process.env.HAPI_LISTEN_PORT) {
        const parsed = parseInt(process.env.HAPI_LISTEN_PORT, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('HAPI_LISTEN_PORT must be a valid port number')
        listenPort = parsed; sources.listenPort = 'env'
        if (settings.listenPort === undefined) { settings.listenPort = listenPort; needsSave = true }
    } else if (settings.listenPort !== undefined) {
        listenPort = settings.listenPort; sources.listenPort = 'file'
    } else if (settings.webappPort !== undefined) {
        listenPort = settings.webappPort; sources.listenPort = 'file'
        settings.listenPort = listenPort; delete settings.webappPort; needsSave = true
    }

    let publicUrl = `http://localhost:${listenPort}`
    if (process.env.HAPI_PUBLIC_URL) {
        publicUrl = process.env.HAPI_PUBLIC_URL; sources.publicUrl = 'env'
        if (settings.publicUrl === undefined) { settings.publicUrl = publicUrl; needsSave = true }
    } else if (settings.publicUrl !== undefined) {
        publicUrl = settings.publicUrl; sources.publicUrl = 'file'
    } else if (settings.webappUrl !== undefined) {
        publicUrl = settings.webappUrl; sources.publicUrl = 'file'
        settings.publicUrl = publicUrl; delete settings.webappUrl; needsSave = true
    }

    let corsOrigins: string[]
    if (process.env.CORS_ORIGINS) {
        corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS); sources.corsOrigins = 'env'
        if (settings.corsOrigins === undefined) { settings.corsOrigins = corsOrigins; needsSave = true }
    } else if (settings.corsOrigins !== undefined) {
        corsOrigins = settings.corsOrigins; sources.corsOrigins = 'file'
    } else {
        corsOrigins = deriveCorsOrigins(publicUrl)
    }

    if (needsSave) await writeSettings(settingsFile, settings)

    return { settings: { listenHost, listenPort, publicUrl, corsOrigins }, sources, savedToFile: needsSave }
}
