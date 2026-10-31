import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppState, NetworkView, SteamBoostApi } from '../shared/boost'

// The window's side of things: the state as the main process sends it, and running its actions.

declare global {
  interface Window {
    steamBoost: SteamBoostApi
  }
}

export const api = (): SteamBoostApi => window.steamBoost

/** The latest AppState; null until the main process has one. */
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)
  useEffect(() => {
    let alive = true
    const stop = api().onState((next) => setState(next))
    void api()
      .getState()
      .then((first) => {
        if (alive && first) setState((current) => current ?? first)
      })
    return () => {
      alive = false
      stop()
    }
  }, [])
  return state
}

/** What a failed action says, without Electron's "Error invoking remote method …" in front. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

/** Runs one action at a time per component, saying which one is busy, and hands failures to
 * `onError`. */
export function useAction(onError: (message: string) => void): {
  busy: string | null
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>
} {
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async <T>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
      setBusy(key)
      try {
        return await action()
      } catch (error) {
        onError(errorMessage(error))
        return undefined
      } finally {
        setBusy(null)
      }
    },
    [onError]
  )
  return { busy, run }
}

export interface Sample {
  time: number
  /** Bytes a second, by network id. */
  speeds: Record<string, number>
}

export const HISTORY_SECONDS = 60

/** Each network's speed, once a second, for the last minute: the chart's data. Sampled here on a
 * clock of its own, since the main process only sends what changed. */
export function useSpeedHistory(state: AppState | null): Sample[] {
  const latest = useRef(state)
  latest.current = state
  const [samples, setSamples] = useState<Sample[]>([])
  useEffect(() => {
    const timer = setInterval(() => {
      const current = latest.current
      if (!current) return
      const speeds: Record<string, number> = {}
      for (const network of current.networks) {
        if (network.speedBytesPerSec > 0) speeds[network.id] = network.speedBytesPerSec
      }
      setSamples((previous) => [
        ...previous.slice(-(HISTORY_SECONDS - 1)),
        { time: Date.now(), speeds }
      ])
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  return samples
}

/** Each network's average over the last `seconds` of samples, a second without it counting as
 * nothing: steadier than one second's speeds, for shares and the gain. */
export function averageSpeeds(samples: readonly Sample[], seconds: number): Record<string, number> {
  const recent = samples.slice(-seconds)
  const sums: Record<string, number> = {}
  for (const sample of recent) {
    for (const [id, speed] of Object.entries(sample.speeds)) sums[id] = (sums[id] ?? 0) + speed
  }
  for (const id of Object.keys(sums)) sums[id] /= recent.length
  return sums
}

/** Each kind's colour, as on the website and in the logo: Wi-Fi blue, a phone orange, Ethernet
 * purple (docs/theme.css). */
const KIND_COLORS: Partial<Record<NetworkView['kind'], string>> = {
  wifi: 'var(--wifi)',
  usb: 'var(--phone)',
  ethernet: 'var(--ethernet)'
}
/** For a second network of a kind, and kinds without a colour of their own (styles.css). */
const EXTRA_COLORS = ['var(--teal)', 'var(--pink)', 'var(--gold)']

/** A colour per network that stays put for the session: its kind's, unless a network seen
 * earlier has that one, and then the first spare. */
export function useNetworkColors(networks: NetworkView[]): {
  colorOf: (id: string) => string
  /** The order they were first seen in, for anything that should keep it (the chart's bands). */
  rankOf: (id: string) => number
} {
  const assigned = useRef(new Map<string, string>())
  for (const network of networks) {
    if (assigned.current.has(network.id)) continue
    const taken = new Set(assigned.current.values())
    // A WSL switch says it's Ethernet: the colour stays the real Ethernet's.
    const own = network.virtual ? undefined : KIND_COLORS[network.kind]
    const free = [own, ...EXTRA_COLORS].find((color) => color !== undefined && !taken.has(color))
    assigned.current.set(
      network.id,
      free ?? EXTRA_COLORS[assigned.current.size % EXTRA_COLORS.length]
    )
  }
  const colorOf = useCallback((id: string) => assigned.current.get(id) ?? EXTRA_COLORS[0], [])
  const rankOf = useCallback((id: string) => [...assigned.current.keys()].indexOf(id), [])
  return { colorOf, rankOf }
}

/** Each game's art, asked for once per window. */
const artFor = new Map<number, Promise<string | null>>()

/** The header art Steam keeps for a game, as a data: URL; null while it loads, or if there's
 * none. */
export function useGameArt(appId: number | null): string | null {
  const [art, setArt] = useState<{ appId: number; url: string | null } | null>(null)
  useEffect(() => {
    if (appId === null) return
    let alive = true
    let pending = artFor.get(appId)
    if (!pending) {
      pending = api()
        .gameArt(appId)
        .catch(() => null)
      artFor.set(appId, pending)
    }
    void pending.then((url) => {
      if (alive) setArt({ appId, url })
    })
    return () => {
      alive = false
    }
  }, [appId])
  return art && art.appId === appId ? art.url : null
}

/** Sets --c, the colour styles.css draws a connection's marks in, on an element. */
export function colorStyle(color: string): React.CSSProperties {
  return { '--c': color } as React.CSSProperties
}

/** A value kept in localStorage: only for this window's own conveniences (the speed unit). */
export function useStoredState<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[]
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key) as T | null
      return stored && allowed.includes(stored) ? stored : fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        // Not kept, then.
      }
    },
    [key]
  )
  return [value, set]
}
