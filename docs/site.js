// Steam Boost's website (this folder, served by GitHub Pages): download links for the latest
// release with its version, sizes and checksums, the right button for the visitor's computer (on
// a phone, a way to send the page on to one), and the speed-up calculator.

const REPO = 'Abeey04/steam-boost'
const RELEASES = `https://github.com/${REPO}/releases/latest`

/** Each download link's file in the latest release. Release files carry no version in their names
 * (electron-builder.yml), so these work with no script at all: index.html has them as they are.
 * steam-boost-setup.exe is the x64 installer, as it has been since there's been one for Arm. */
const DIRECT = {
  windows: `${RELEASES}/download/steam-boost-setup.exe`,
  'windows-arm64': `${RELEASES}/download/steam-boost-setup-arm64.exe`,
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
  'windows-arm64': (name) => /setup-arm64\.exe$/i.test(name),
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

/** Whether this is a Windows on Arm PC, where the browser says (Chromium browsers do, when asked;
 * the others get the x64 installer, which most Windows PCs want and Windows 11 on Arm can run). */
async function onArm() {
  try {
    const { architecture } = await navigator.userAgentData.getHighEntropyValues(['architecture'])
    return architecture === 'arm'
  } catch {
    return false
  }
}

/** On a Windows on Arm PC, the Windows card's big button is its installer, and the link beside it
 * the x64 one. */
function preferArmInstaller() {
  const main = document.getElementById('windows-download')
  const other = document.getElementById('windows-other')
  const note = document.getElementById('windows-note')
  const size = document.getElementById('windows-size')
  if (!main || !other || !note) return
  main.dataset.asset = 'windows-arm64'
  main.href = DIRECT['windows-arm64']
  main.textContent = 'Download the installer for Arm'
  other.dataset.asset = 'windows'
  other.href = DIRECT.windows
  other.textContent = 'the x64 installer'
  note.replaceChildren('For Windows on Arm, as this PC is. Most other PCs want ', other, '.')
  if (size) size.dataset.sizeOf = 'windows-arm64'
}

/** The main button: the download for the visitor's computer, or on a phone a way to send it on. */
async function primaryButton() {
  const link = document.getElementById('primary-download')
  if (!link) return
  const note = document.getElementById('release-note')
  if (onPhoneOrTablet()) {
    offerToSend(link, note)
    return
  }
  const platform = visitorPlatform()
  const arm = platform === 'windows' && (await onArm())
  if (arm) preferArmInstaller()
  const [asset, label] = {
    windows: arm
      ? ['windows-arm64', 'Download for Windows on Arm']
      : ['windows', 'Download for Windows'],
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

/** Each file's SHA-256 from the release, for anyone checking a download before they run it, with
 * a link to what VirusTotal's scanners make of it. Shown only once GitHub has said. */
function showChecksums(release, version) {
  const details = document.getElementById('checksums')
  const list = document.getElementById('checksums-list')
  if (!details || !list) return
  const files = (release.assets ?? []).filter(
    (asset) =>
      /\.(exe|dmg|appimage|deb|mjs)$/i.test(asset.name) &&
      /^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '')
  )
  if (files.length === 0) return
  list.replaceChildren()
  for (const asset of files) {
    const hash = asset.digest.slice('sha256:'.length).toLowerCase()
    const name = document.createElement('dt')
    name.textContent = asset.name
    const value = document.createElement('dd')
    const code = document.createElement('code')
    code.textContent = hash
    const scan = document.createElement('a')
    scan.href = `https://www.virustotal.com/gui/file/${hash}`
    scan.textContent = 'VirusTotal'
    value.append(code, scan)
    list.append(name, value)
  }
  const shown = document.getElementById('checksums-version')
  if (shown) shown.textContent = version ?? ''
  details.hidden = false
}

/** Points every download link at its file in `hrefs`, or the Releases page when it has none. */
function pointLinks(hrefs) {
  for (const link of document.querySelectorAll('a[data-asset]')) {
    link.href = hrefs[link.dataset.asset] ?? RELEASES
  }
}

/** A file's size as Windows and GitHub show it: in MB of 1024 × 1024 bytes. */
const megabytes = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`

/** The latest release from GitHub's API: its version, and each file's exact address and size. The
 * links work without it, which is as well: it allows 60 calls an hour from each IP address. */
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
  const sizes = {}
  for (const asset of release.assets ?? []) {
    for (const [key, matches] of Object.entries(MATCHERS)) {
      if (!hrefs[key] && matches(asset.name)) {
        hrefs[key] = asset.browser_download_url
        sizes[key] = asset.size
      }
    }
  }
  // A file this release lacks: its release page, rather than a missing file.
  for (const key of Object.keys(DIRECT)) hrefs[key] ??= release.html_url ?? RELEASES
  pointLinks(hrefs)

  const version = release.tag_name ? release.tag_name.replace(/^v/, '') : null
  const downloadVersion = document.getElementById('download-version')
  if (downloadVersion && version) {
    downloadVersion.textContent = `Version ${version}. `
    const notes = document.createElement('a')
    notes.href = release.html_url
    notes.textContent = 'What changed'
    downloadVersion.append(notes)
  }
  for (const element of document.querySelectorAll('[data-size-of]')) {
    const bytes = sizes[element.dataset.sizeOf]
    if (bytes) element.textContent = `${megabytes(bytes)}${version ? `, version ${version}` : ''}`
  }
  showChecksums(release, version)
  // Under the main button: the version and the size of what it downloads (not on a phone).
  const primary = document.getElementById('primary-download')
  const heroVersion = document.getElementById('hero-version')
  const primaryBytes = primary?.dataset.asset ? sizes[primary.dataset.asset] : undefined
  if (heroVersion && version && primaryBytes) {
    heroVersion.textContent = `Version ${version} · ${megabytes(primaryBytes)}`
    heroVersion.hidden = false
  }
}

/** The calculator: download times from Mbps and GB, and line widths that follow the speeds. */
function calculator() {
  const $ = (id) => document.getElementById(id)
  const home = $('calc-home')
  const homeRange = $('calc-home-range')
  const phone = $('calc-phone')
  const phoneRange = $('calc-phone-range')
  const size = $('calc-size')
  if (!home || !homeRange || !phone || !phoneRange || !size) return

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
  const duration = (seconds) => {
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min`
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
  }

  const update = () => {
    const homeMbps = clamp(Number(home.value) || 1, 1, 2000)
    const phoneMbps = clamp(Number(phone.value) || 0, 0, 2000)
    const megabits = Number(size.value) * 8000
    const alone = megabits / homeMbps
    const both = megabits / (homeMbps + phoneMbps)
    $('out-alone').textContent = duration(alone)
    $('out-both').textContent = duration(both)
    $('out-saved').textContent = duration(alone - both)
    $('calc-summary').textContent =
      phoneMbps > 0
        ? `${Math.round((phoneMbps / homeMbps) * 100)}% faster than home alone.`
        : 'Add a second connection to see a gain.'
    const total = homeMbps + phoneMbps
    const width = (mbps) => (3 + 21 * (mbps / total)).toFixed(1)
    $('calc-line-home').setAttribute('stroke-width', width(homeMbps))
    $('calc-line-phone').setAttribute('stroke-width', phoneMbps > 0 ? width(phoneMbps) : '2')
    $('calc-label-home').textContent = `${homeMbps} Mbps`
    $('calc-label-phone').textContent = `${phoneMbps} Mbps`
    $('calc-label-total').textContent = `${total} Mbps · ${(total / 8).toFixed(1)} MB/s`
  }

  const pair = (number, range) => {
    range.addEventListener('input', () => {
      number.value = range.value
      update()
    })
    number.addEventListener('input', () => {
      range.value = number.value
      update()
    })
  }
  pair(home, homeRange)
  pair(phone, phoneRange)
  size.addEventListener('change', update)
  update()
}

calculator()
// The main button first: the release's sizes are for the file it ends up pointing at.
void primaryButton().then(() => loadRelease())
