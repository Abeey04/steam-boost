// Steam Boost's website (this folder, served by GitHub Pages): download links from the latest GitHub release, the right button for the
// visitor's computer, and the line map held still for people who'd rather no motion.

const REPO = 'Abeey04/steam-boost'
const RELEASES = `https://github.com/${REPO}/releases/latest`

/** Which release file each download link wants, by its name. */
const MATCHERS = {
  windows: (name) => /setup\.exe$/i.test(name),
  'mac-arm64': (name) => /\.dmg$/i.test(name) && /arm64/i.test(name),
  'mac-x64': (name) => /\.dmg$/i.test(name) && /(x64|x86_64|intel)/i.test(name),
  appimage: (name) => /\.appimage$/i.test(name),
  deb: (name) => /\.deb$/i.test(name),
  cli: (name) => /^steam-boost-cli\.mjs$/i.test(name)
}

function visitorPlatform() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  const agent = navigator.userAgent.toLowerCase()
  if (platform.includes('win') || agent.includes('windows')) return 'windows'
  if (platform.includes('mac') || agent.includes('mac os')) return 'mac'
  if (platform.includes('linux') || agent.includes('linux')) return 'linux'
  return null
}

function primaryButton(assets) {
  const button = document.getElementById('primary-download')
  if (!button) return
  const platform = visitorPlatform()
  const pick = {
    windows: ['windows', 'Download for Windows'],
    // Apple silicon is most Macs now; Intel is one click away below.
    mac: ['mac-arm64', 'Download for macOS'],
    linux: ['appimage', 'Download for Linux']
  }[platform ?? 'windows']
  const [key, label] = pick
  button.textContent = label
  button.href = assets[key] ?? RELEASES
  if (platform && platform !== 'windows') {
    const note = document.getElementById('release-note')
    if (note) {
      note.textContent =
        'Free and open source. The macOS and Linux builds are experimental: Steam Boost is made for Windows 10 and 11 first.'
    }
  }
}

async function loadRelease() {
  let assets = {}
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' }
    })
    if (!response.ok) throw new Error(String(response.status))
    const release = await response.json()
    for (const asset of release.assets ?? []) {
      for (const [key, matches] of Object.entries(MATCHERS)) {
        if (!assets[key] && matches(asset.name)) assets[key] = asset.browser_download_url
      }
    }
    const version = document.getElementById('download-version')
    if (version && release.tag_name) {
      version.textContent = `Version ${release.tag_name.replace(/^v/, '')}. `
      const notes = document.createElement('a')
      notes.href = release.html_url
      notes.textContent = 'What changed'
      version.append(notes)
    }
  } catch {
    // No release to read (none yet, or GitHub said no): every link goes to the releases page.
    assets = {}
  }
  for (const link of document.querySelectorAll('[data-asset]')) {
    link.href = assets[link.dataset.asset] ?? RELEASES
  }
  primaryButton(assets)
}

function holdStillIfAsked() {
  const svg = document.getElementById('line-map')
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  const apply = () => {
    if (!svg || typeof svg.pauseAnimations !== 'function') return
    if (query.matches) {
      // Paused partway, so the pieces sit spread along their lines.
      svg.setCurrentTime(1.6)
      svg.pauseAnimations()
    } else {
      svg.unpauseAnimations()
    }
  }
  apply()
  query.addEventListener?.('change', apply)
}

holdStillIfAsked()
void loadRelease()
