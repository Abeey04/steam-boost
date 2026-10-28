import type { AppState, NetworkInterfaceKindLabel } from './types'

// Numbers and states in words.

export type SpeedUnit = 'MB/s' | 'Mbps'
export const SPEED_UNITS: readonly SpeedUnit[] = ['MB/s', 'Mbps']

const MiB = 1024 * 1024

/** A speed as a number and its unit: MB/s (as Steam shows it) or Mbps (as a plan is sold). */
export function formatSpeed(bytesPerSec: number, unit: SpeedUnit): { value: string; unit: string } {
  const amount = unit === 'MB/s' ? bytesPerSec / MiB : (bytesPerSec * 8) / 1e6
  const value =
    amount === 0
      ? '0'
      : amount >= 100
        ? amount.toFixed(0)
        : amount >= 10
          ? amount.toFixed(1)
          : amount.toFixed(2)
  return { value, unit }
}

export function speedText(bytesPerSec: number, unit: SpeedUnit): string {
  const { value, unit: shown } = formatSpeed(bytesPerSec, unit)
  return `${value} ${shown}`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 1 : 2)} GB`
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(0)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function secondsAgo(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

export const KIND_LABEL: Record<NetworkInterfaceKindLabel, string> = {
  wifi: 'Wi-Fi',
  usb: 'Phone or USB',
  ethernet: 'Ethernet',
  bridge: 'Bridge',
  other: 'Network'
}

export type Phase =
  'off' | 'starting' | 'error' | 'setup' | 'elsewhere' | 'restart' | 'ready' | 'boosting'

/** Where things stand, as the top of the window says it. */
export function phaseOf(
  state: AppState,
  now = Date.now()
): {
  phase: Phase
  title: string
  detail: string
} {
  const { boost, settings } = state
  const active = state.networks.filter((network) => network.role === 'active').length
  const over = `${active} ${active === 1 ? 'connection' : 'connections'}`
  if (!settings.enabled) {
    return { phase: 'off', title: 'Off', detail: 'Steam downloads the usual way.' }
  }
  if (boost.state === 'starting') {
    return { phase: 'starting', title: 'Starting…', detail: 'Opening port 80 for Steam.' }
  }
  if (boost.state === 'error') {
    return {
      phase: 'error',
      title: "Couldn't start",
      detail: "It couldn't listen for Steam. The first step below says why."
    }
  }
  if (boost.hostsEntry === 'elsewhere') {
    return {
      phase: 'elsewhere',
      title: 'Steam is pointed elsewhere',
      detail: 'Another line in your hosts file sends Steam to a different cache.'
    }
  }
  if (boost.hostsEntry !== 'set') {
    return { phase: 'setup', title: 'One step to go', detail: 'Point Steam at Steam Boost below.' }
  }
  if (boost.lastRequestAt === null && boost.steamUsing !== true) {
    return {
      phase: 'restart',
      title: 'Restart Steam',
      detail: 'Steam looks for Steam Boost only when it starts.'
    }
  }
  if (
    boost.speedBytesPerSec > 0 ||
    (boost.lastRequestAt !== null && now - boost.lastRequestAt < 5000)
  ) {
    const moving = state.networks.filter((network) => network.speedBytesPerSec > 0).length
    return {
      phase: 'boosting',
      title: moving > 1 ? 'Boosting' : 'Downloading',
      detail: `Steam is downloading over ${over}.`
    }
  }
  return { phase: 'ready', title: 'Ready', detail: `Downloads in Steam go over ${over}.` }
}
