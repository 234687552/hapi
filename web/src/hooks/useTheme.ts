import { useSyncExternalStore } from 'react'

type ColorScheme = 'light' | 'dark'

function getColorScheme(): ColorScheme {
    if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'light'
}

function isIOS(): boolean {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

function applyTheme(scheme: ColorScheme): void {
    document.documentElement.setAttribute('data-theme', scheme)
}

function applyPlatform(): void {
    if (isIOS()) {
        document.documentElement.classList.add('ios')
    }
}

let currentScheme: ColorScheme = getColorScheme()
const listeners = new Set<() => void>()

applyTheme(currentScheme)

function subscribe(callback: () => void): () => void {
    listeners.add(callback)
    return () => listeners.delete(callback)
}

function getSnapshot(): ColorScheme {
    return currentScheme
}

function updateScheme(): void {
    const newScheme = getColorScheme()
    if (newScheme !== currentScheme) {
        currentScheme = newScheme
        applyTheme(newScheme)
        listeners.forEach((cb) => cb())
    }
}

let listenersInitialized = false

export function useTheme(): { colorScheme: ColorScheme; isDark: boolean } {
    const colorScheme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    return { colorScheme, isDark: colorScheme === 'dark' }
}

export function initializeTheme(): void {
    currentScheme = getColorScheme()
    applyTheme(currentScheme)
    applyPlatform()

    if (!listenersInitialized) {
        listenersInitialized = true
        if (typeof window !== 'undefined' && window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateScheme)
        }
    }
}
