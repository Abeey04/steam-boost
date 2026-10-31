import type { AppState } from '../shared/boost'

// "Tell us how it went": a reply for the Speed reports discussion (PROJECT.speedReports), filled in
// from what the app knows and put on the clipboard as the discussion opens in the browser, for the
// reports from real PCs the project needs most. It follows the list the discussion asks for, and
// holds no addresses or logs: those go in an issue, with Copy diagnostics, when something didn't
// work.

const MiB = 1024 * 1024

function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** The system as people know it: "Windows 11 (build 26200, x64)". `release` is os.release(). */
export function systemName(platform: string, release: string, arch: string): string {
  if (platform === 'win32') {
    const build = Number(release.split('.')[2])
    if (!Number.isFinite(build)) return `Windows ${release} (${arch})`
    return `${build >= 22000 ? 'Windows 11' : 'Windows 10'} (build ${build}, ${arch})`
  }
  if (platform === 'darwin') return `macOS (Darwin ${release}, ${arch})`
  return `Linux ${release} (${arch})`
}

/** The reply, in the discussion's own words. The speeds are filled in when Steam is downloading
 * over two connections or more as it's asked for, and left for the person otherwise. */
export function speedReport(state: AppState, system: string): string {
  const inUse = state.networks.filter((network) => network.role === 'active')
  const carrying = state.networks
    .filter((network) => network.speedBytesPerSec > 0)
    .sort((a, b) => b.speedBytesPerSec - a.speedBytesPerSec)
  const mbs = (bytes: number): string => `${(bytes / MiB).toFixed(1)} MB/s`
  const total = carrying.reduce((sum, network) => sum + network.speedBytesPerSec, 0)
  const speeds =
    carrying.length >= 2
      ? `about ${mbs(carrying[0].speedBytesPerSec)} on ${carrying[0].label} alone, ${mbs(total)} with Steam Boost (as Steam Boost measured them)`
      : ''
  const saved = state.boost.savedSecondsTotal
  return [
    `- **Connections:** ${inUse.map((network) => network.label).join(' + ')}`,
    `- **Windows version:** ${system}`,
    `- **Steam's download speed without and with Steam Boost:** ${speeds}`,
    '- **Anything that got in the way:** ',
    '',
    `Steam Boost ${state.version}${saved >= 60 ? `, ${duration(saved)} saved so far` : ''}`,
    ''
  ].join('\n')
}
