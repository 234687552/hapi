import { useCallback, useMemo, useState } from 'react'
import type { AuthSource } from './useAuth'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

function getTokenFromUrlParams(): string | null {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get('token')
}

function getAccessTokenKey(baseUrl: string): string {
    return `${ACCESS_TOKEN_PREFIX}${baseUrl}`
}

function getStoredAccessToken(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
}

function storeAccessToken(key: string, token: string): void {
    try { localStorage.setItem(key, token) } catch {}
}

function clearStoredAccessToken(key: string): void {
    try { localStorage.removeItem(key) } catch {}
}

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    setAccessToken: (token: string) => void
    clearAuth: () => void
} {
    const accessTokenKey = useMemo(() => getAccessTokenKey(baseUrl), [baseUrl])
    const [authSource, setAuthSource] = useState<AuthSource | null>(() => {
        const key = getAccessTokenKey(baseUrl)
        const urlToken = getTokenFromUrlParams()
        if (urlToken) { storeAccessToken(key, urlToken); return { type: 'accessToken', token: urlToken } }
        const stored = getStoredAccessToken(key)
        return stored ? { type: 'accessToken', token: stored } : null
    })

    const setAccessToken = useCallback((token: string) => {
        storeAccessToken(accessTokenKey, token)
        setAuthSource({ type: 'accessToken', token })
    }, [accessTokenKey])

    const clearAuth = useCallback(() => {
        clearStoredAccessToken(accessTokenKey)
        setAuthSource(null)
    }, [accessTokenKey])

    return { authSource, isLoading: false, isTelegram: false, setAccessToken, clearAuth }
}
