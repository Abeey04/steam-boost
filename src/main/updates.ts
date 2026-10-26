import type { UpdateInfo } from '../shared/boost'
import { PROJECT } from '../shared/project'

// Whether a newer release is out, from GitHub's latest release (drafts and pre-releases aren't
// "latest"). It only tells: the window offers the download page. An app that installs its own
// updates needs code signing on macOS first.

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** Whether `candidate` is a later version than `current` ("v0.2.0" > "0.1.3"). A release is later
 * than its own pre-releases (1.0.0 > 1.0.0-rc.2). */
export function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [parts(candidate), parts(current)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return !candidate.includes('-') && current.includes('-')
}

export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateInfo | null> {
  const response = await fetchImpl(`https://api.github.com/repos/${PROJECT.repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `SteamBoost/${current}` },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) return null
  const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown }
  if (typeof release.tag_name !== 'string' || !isNewer(release.tag_name, current)) return null
  return {
    version: release.tag_name.replace(/^v/, ''),
    url:
      typeof release.html_url === 'string' && release.html_url.startsWith(PROJECT.github)
        ? release.html_url
        : `${PROJECT.github}/releases/latest`
  }
}
