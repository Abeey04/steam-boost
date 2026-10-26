import type { AppSettings, NetworkPatch, NetworkSettings, SettingsPatch } from '../shared/boost'
import { readJson, writeJson } from './jsonStore'

// settings.json in the app's data folder: what the user chose. Whatever is read back is checked
// field by field, so a hand-edited or older file can't put the app in a state it doesn't expect.

export const DEFAULT_SETTINGS: AppSettings = {
  enabled: true,
  addressMode: 'loopback',
  httpsPassthrough: true,
  networks: {},
  startAtLogin: false,
  closeToTray: true
}

const MAX_NETWORKS = 64
const MAX_ID_LENGTH = 256
/** A petabyte a day: anything above is a typo, not a cap. */
const MAX_CAP_BYTES = 1024 ** 5

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function sanitizeCap(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.min(Math.round(value), MAX_CAP_BYTES)
    : undefined
}

function sanitizeNetworks(value: unknown): Record<string, NetworkSettings> {
  const networks: Record<string, NetworkSettings> = {}
  for (const [id, raw] of Object.entries(record(value)).slice(0, MAX_NETWORKS)) {
    if (!id || id.length > MAX_ID_LENGTH) continue
    const input = record(raw)
    const entry: NetworkSettings = {}
    if (input['enabled'] === false) entry.enabled = false
    const cap = sanitizeCap(input['dailyCapBytes'])
    if (cap !== undefined) entry.dailyCapBytes = cap
    // Only what differs from the defaults is kept.
    if (Object.keys(entry).length > 0) networks[id] = entry
  }
  return networks
}

export function sanitizeSettings(raw: unknown): AppSettings {
  const input = record(raw)
  const bool = (key: keyof AppSettings): boolean =>
    typeof input[key] === 'boolean' ? (input[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean)
  return {
    enabled: bool('enabled'),
    addressMode: input['addressMode'] === 'lan' ? 'lan' : 'loopback',
    httpsPassthrough: bool('httpsPassthrough'),
    networks: sanitizeNetworks(input['networks']),
    startAtLogin: bool('startAtLogin'),
    closeToTray: bool('closeToTray')
  }
}

/** `settings` with `patch` taken in; anything in it that doesn't belong is dropped. */
export function withSettings(settings: AppSettings, patch: SettingsPatch): AppSettings {
  const { networks: _ignored, ...rest } = record(patch) as SettingsPatch & { networks?: unknown }
  return sanitizeSettings({ ...settings, ...rest, networks: settings.networks })
}

/** `settings` with network `id` changed by `patch`. */
export function withNetwork(settings: AppSettings, id: string, patch: NetworkPatch): AppSettings {
  const current: Record<string, unknown> = { ...settings.networks[id] }
  if (typeof patch.enabled === 'boolean') current['enabled'] = patch.enabled
  if (patch.dailyCapBytes === null) delete current['dailyCapBytes']
  else if (patch.dailyCapBytes !== undefined) current['dailyCapBytes'] = patch.dailyCapBytes
  return sanitizeSettings({ ...settings, networks: { ...settings.networks, [id]: current } })
}

export class SettingsStore {
  private constructor(
    private readonly path: string,
    private value: AppSettings
  ) {}

  static async load(path: string): Promise<SettingsStore> {
    return new SettingsStore(path, sanitizeSettings(await readJson(path)))
  }

  get current(): AppSettings {
    return this.value
  }

  async set(next: AppSettings): Promise<void> {
    this.value = next
    await writeJson(this.path, next)
  }
}
