import { useMemo } from 'react'
import { ApiClient } from '@/api/client'

export type AuthSource = { type: 'accessToken'; token: string }

export function useAuth(authSource: AuthSource | null, baseUrl: string) {
    const token = authSource?.token ?? null
    const api = useMemo(
        () => token ? new ApiClient(token, { baseUrl: baseUrl || undefined }) : null,
        [token, baseUrl]
    )
    return { token, user: null, api, isLoading: false, error: null, needsBinding: false, bind: async () => {} }
}
