import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateCliApiToken } from './config/cliApiToken'
import { getSettingsFile } from './config/settings'
import { loadServerSettings, type ServerSettings, type ServerSettingsResult } from './config/serverSettings'

export type ConfigSource = 'env' | 'file' | 'default'

export interface ConfigSources {
    listenHost: ConfigSource
    listenPort: ConfigSource
    publicUrl: ConfigSource
    corsOrigins: ConfigSource
    cliApiToken: 'env' | 'file' | 'generated'
}

class Configuration {
    public cliApiToken: string
    public cliApiTokenSource: 'env' | 'file' | 'generated' | ''
    public cliApiTokenIsNew: boolean
    public readonly settingsFile: string
    public readonly dataDir: string
    public readonly dbPath: string
    public readonly listenPort: number
    public readonly listenHost: string
    public readonly publicUrl: string
    public readonly corsOrigins: string[]
    public readonly sources: ConfigSources

    private constructor(
        dataDir: string,
        dbPath: string,
        serverSettings: ServerSettings,
        sources: ServerSettingsResult['sources']
    ) {
        this.dataDir = dataDir
        this.dbPath = dbPath
        this.settingsFile = getSettingsFile(dataDir)
        this.listenHost = serverSettings.listenHost
        this.listenPort = serverSettings.listenPort
        this.publicUrl = serverSettings.publicUrl
        this.corsOrigins = serverSettings.corsOrigins
        this.cliApiToken = ''
        this.cliApiTokenSource = ''
        this.cliApiTokenIsNew = false
        this.sources = { ...sources } as ConfigSources
        if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
    }

    static async create(): Promise<Configuration> {
        const dataDir = process.env.HAPI_HOME
            ? process.env.HAPI_HOME.replace(/^~/, homedir())
            : join(homedir(), '.hapi')
        if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
        const dbPath = process.env.DB_PATH
            ? process.env.DB_PATH.replace(/^~/, homedir())
            : join(dataDir, 'hapi.db')
        const settingsResult = await loadServerSettings(dataDir)
        if (settingsResult.savedToFile) {
            console.log(`[Hub] Configuration saved to ${getSettingsFile(dataDir)}`)
        }
        const config = new Configuration(dataDir, dbPath, settingsResult.settings, settingsResult.sources)
        const tokenResult = await getOrCreateCliApiToken(dataDir)
        config._setCliApiToken(tokenResult.token, tokenResult.source, tokenResult.isNew)
        return config
    }

    _setCliApiToken(token: string, source: 'env' | 'file' | 'generated', isNew: boolean): void {
        this.cliApiToken = token
        this.cliApiTokenSource = source
        this.cliApiTokenIsNew = isNew
        ;(this.sources as { cliApiToken: string }).cliApiToken = source
    }
}

let _configuration: Configuration | null = null

export async function createConfiguration(): Promise<Configuration> {
    if (_configuration) return _configuration
    _configuration = await Configuration.create()
    return _configuration
}

export function getConfiguration(): Configuration {
    if (!_configuration) throw new Error('Configuration not initialized. Call createConfiguration() first.')
    return _configuration
}

export const configuration = new Proxy({} as Configuration, {
    get(_, prop) { return getConfiguration()[prop as keyof Configuration] }
})
