// Steam Boost's website (this folder, served by GitHub Pages): download links for the latest
// release, the right button for the visitor's computer (on a phone, a way to send the page on to
// one), and the line map held still for people who'd rather no motion.

const REPO = 'Abeey04/steam-boost'
const RELEASES = `https://github.com/${REPO}/releases/latest`

/** Each download link's file in the latest release. Release files carry no version in their names
 * (electron-builder.yml), so these work with no script at all: index.html has them as they are. */
const DIRECT = {
  windows: `${RELEASES}/download/steam-boost-setup.exe`,
  'mac-arm64': `${RELEASES}/download/steam-boost-arm64.dmg`,
  'mac-x64': `${RELEASES}/download/steam-boost-x64.dmg`,
  appimage: `${RELEASES}/download/steam-boost-x86_64.AppImage`,
  deb: `${RELEASES}/download/steam-boost_amd64.deb`,
  cli: `${RELEASES}/download/steam-boost-cli.mjs`
}

/** Which release file each download link wants, by its name, for a release whose files are named
 * another way (v0.1.0's carry their version). */
const MATCHERS = {
  windows: (name) => /setup\.exe$/i.test(name),
  'mac-arm64': (name) => /\.dmg$/i.test(name) && /arm64/i.test(name),
  'mac-x64': (name) => /\.dmg$/i.test(name) && /(x64|x86_64|intel)/i.test(name),
  appimage: (name) => /\.appimage$/i.test(name),
  deb: (name) => /\.deb$/i.test(name),
  cli: (name) => /^steam-boost-cli\.mjs$/i.test(name)
}

/** Phones and tablets, which Steam Boost isn't for. Android says so even when it asks for desktop
 * sites; an iPad asks as a Mac, and no Mac has a touch screen. */
function onPhoneOrTablet() {
  const hints = navigator.userAgentData
  if (hints?.mobile || /android/i.test(hints?.platform ?? '')) return true
  const agent = navigator.userAgent
  if (/android|iphone|ipad|ipod|mobile/i.test(agent)) return true
  return /macintosh/i.test(agent) && navigator.maxTouchPoints > 1
}

function visitorPlatform() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  const agent = navigator.userAgent.toLowerCase()
  if (platform.includes('win') || agent.includes('windows')) return 'windows'
  if (platform.includes('mac') || agent.includes('mac os')) return 'mac'
  if (platform.includes('linux') || agent.includes('linux')) return 'linux'
  return null
}

/** On a phone, the main button sends the page on to a PC: through the share sheet where there is
 * one, else by copying the link. The note under it says where to go either way. */
function offerToSend(link, note) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = link.className
  button.id = link.id
  const label = navigator.share ? 'Send this page to your PC' : 'Copy the link for your PC'
  button.textContent = label
  button.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}`
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url })
        return
      } catch (error) {
        // Closing the share sheet is a choice, not a failure.
        if (error?.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      button.textContent = 'Link copied'
      setTimeout(() => (button.textContent = label), 2500)
    } catch {
      // No clipboard either: the note has the address to type.
    }
  })
  link.replaceWith(button)
  if (note) {
    note.textContent = `Steam Boost runs on Windows PCs. On your PC, open ${location.host}${location.pathname} to download it.`
  }
}

/** The main button: the download for the visitor's computer, or on a phone a way to send it on. */
function primaryButton() {
  const link = document.getElementById('primary-download')
  if (!link) return
  const note = document.getElementById('release-note')
  if (onPhoneOrTablet()) {
    offerToSend(link, note)
    return
  }
  const platform = visitorPlatform()
  const [asset, label] = {
    windows: ['windows', 'Download for Windows'],
    // Apple silicon is most Macs now; Intel is one click away below.
    mac: ['mac-arm64', 'Download for macOS'],
    linux: ['appimage', 'Download for Linux']
  }[platform ?? 'windows']
  link.textContent = label
  link.dataset.asset = asset
  link.href = DIRECT[asset]
  if (platform && platform !== 'windows' && note) {
    note.textContent =
      'Free and open source. The macOS and Linux builds are experimental: Steam Boost is made for Windows 10 and 11 first.'
  }
}

/** Points every download link at its file in `hrefs`, or the Releases page when it has none. */
function pointLinks(hrefs) {
  for (const link of document.querySelectorAll('a[data-asset]')) {
    link.href = hrefs[link.dataset.asset] ?? RELEASES
  }
}

/** The latest release from GitHub's API: its version, and each file's exact address. The links
 * work without it, which is as well: it allows 60 calls an hour from each IP address. */
async function loadRelease() {
  let response
  try {
    response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' }
    })
  } catch {
    // Offline, or GitHub out of reach: the direct links stand.
    return
  }
  // No release published yet: the files the links name don't exist, but the Releases page does.
  if (response.status === 404) {
    pointLinks({})
    return
  }
  // Rate-limited, say: the direct links stand.
  if (!response.ok) return
  const release = await response.json().catch(() => null)
  if (!release) return
  const hrefs = {}
  for (const asset of release.assets ?? []) {
    for (const [key, matches] of Object.entries(MATCHERS)) {
      if (!hrefs[key] && matches(asset.name)) hrefs[key] = asset.browser_download_url
    }
  }
  // A file this release lacks: its release page, rather than a missing file.
  for (const key of Object.keys(DIRECT)) hrefs[key] ??= release.html_url ?? RELEASES
  pointLinks(hrefs)
  const version = document.getElementById('download-version')
  if (version && release.tag_name) {
    version.textContent = `Version ${release.tag_name.replace(/^v/, '')}. `
    const notes = document.createElement('a')
    notes.href = release.html_url
    notes.textContent = 'What changed'
    version.append(notes)
  }
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

primaryButton()
holdStillIfAsked()
void loadRelease()
