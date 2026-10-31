// A stand-in for the preload API (window.steamBoost), so the built window runs in a plain browser
// on made-up data: `npm run ui` serves it (scripts/ui.mjs), and the screenshot tests look at it
// (window.spec.ts). ?scenario= picks the state it starts in (SCENARIOS below). The speeds follow
// the clock and nothing else, so a test that sets the clock gets the same window every time.
;(() => {
  const MB = 1024 * 1024
  const GB = 1024 ** 3
  const scenario = new URLSearchParams(location.search).get('scenario') || 'boosting'
  const started = Date.now()

  /** Noise from 0 to 1 that only depends on `t`. */
  const noise = (t) => {
    const x = Math.sin(t * 12.9898) * 43758.5453
    return x - Math.floor(x)
  }

  const net = (over) => ({
    customName: null,
    virtual: false,
    role: 'active',
    enabled: true,
    dailyCapBytes: null,
    usedTodayBytes: 0,
    speedBytesPerSec: 0,
    inflight: 0,
    resting: false,
    ...over
  })

  const state = {
    version: '0.2.1',
    platform: 'win32',
    settings: {
      enabled: true,
      addressMode: 'loopback',
      httpsPassthrough: true,
      networks: { 'Ethernet 3': { dailyCapBytes: 2 * GB } },
      startAtLogin: false,
      closeToTray: true
    },
    boost: {
      state: 'on',
      address: '127.0.0.1',
      httpsPassthrough: true,
      hostsEntry: 'set',
      resolvesTo: '127.0.0.1',
      steamUsing: true,
      steamRunning: true,
      lastRequestAt: started,
      speedBytesPerSec: 0,
      sessionBytes: 3.2 * GB,
      requests: { active: 12, waiting: 0, done: 3311, failed: 2 },
      hint: null,
      download: {
        appId: 1422450,
        name: 'Deadlock',
        downloadedBytes: 4.6 * GB,
        totalBytes: 7.8 * GB,
        savedSeconds: 14 * 60
      },
      savedSecondsTotal: 2 * 3600 + 10 * 60
    },
    networks: [
      net({
        id: 'Wi-Fi',
        label: 'Wi-Fi',
        adapter: 'Wi-Fi',
        kind: 'wifi',
        address: '192.168.1.23',
        usedTodayBytes: 2.3 * GB
      }),
      net({
        id: 'Ethernet 3',
        label: 'Phone (USB tethering)',
        adapter: 'Ethernet 3',
        kind: 'usb',
        address: '192.168.42.129',
        dailyCapBytes: 2 * GB,
        usedTodayBytes: 1.4 * GB
      }),
      net({
        id: 'vEthernet (WSL)',
        label: 'vEthernet (WSL)',
        adapter: 'vEthernet (WSL)',
        kind: 'ethernet',
        virtual: true,
        enabled: false,
        address: '172.28.16.1',
        role: 'off'
      }),
      net({
        id: 'Tailscale',
        label: 'Tailscale',
        adapter: 'Tailscale',
        kind: 'other',
        virtual: true,
        enabled: false,
        address: '100.101.12.7',
        role: 'off'
      })
    ],
    update: null,
    canStartAtLogin: true
  }

  /** A PC that hasn't been set up, or hasn't been seen to download yet. */
  const fresh = () => {
    Object.assign(state.boost, {
      hostsEntry: 'missing',
      resolvesTo: null,
      steamUsing: null,
      lastRequestAt: null,
      sessionBytes: 0,
      requests: { active: 0, waiting: 0, done: 0, failed: 0 },
      download: null,
      savedSecondsTotal: 0
    })
  }

  const SCENARIOS = {
    // Downloading a game over Wi-Fi and a phone.
    boosting: () => undefined,
    // Set up, and Steam has used it, but nothing is downloading.
    ready: () => {
      state.boost.download = null
      state.boost.lastRequestAt = started - 10 * 60_000
    },
    // The first run: nothing set up yet.
    setup: fresh,
    // Set up; Steam needs to restart to find it.
    restart: () => {
      fresh()
      Object.assign(state.boost, { hostsEntry: 'set', resolvesTo: '127.0.0.1', steamUsing: false })
    },
    // Restarted, and Steam still didn't take 127.0.0.1.
    lan: () => {
      SCENARIOS.restart()
      state.boost.hint = 'try-lan'
    },
    // Port 80 is taken.
    error: () => {
      fresh()
      state.boost.state = 'error'
      state.boost.error =
        'IIS (World Wide Web Publishing Service) is using port 80, the one port Steam looks for a cache on. Stop it in Services, or turn IIS off in Windows Features if you don’t use it, then try again.'
    },
    // Switched off.
    off: () => {
      state.settings.enabled = false
      state.boost.state = 'off'
      state.boost.download = null
    },
    // Only Wi-Fi.
    single: () => {
      state.networks = state.networks.filter((n) => n.id === 'Wi-Fi')
      state.boost.download = null
    },
    // A new version the app can install itself.
    update: () => {
      state.update = {
        version: '0.3.0',
        url: 'https://github.com/Abeey04/steam-boost/releases/tag/v0.3.0',
        install: 'available'
      }
    },
    // The app has just opened on a PC that's set up.
    starting: () => {
      fresh()
      Object.assign(state.boost, { state: 'off', hostsEntry: 'set', steamUsing: true })
    }
  }
  ;(SCENARIOS[scenario] ?? SCENARIOS.boosting)()

  const moving = () =>
    state.settings.enabled &&
    state.boost.state === 'on' &&
    (scenario === 'boosting' || scenario === 'single' || scenario === 'update')

  const tick = () => {
    const t = (Date.now() - started) / 1000
    let total = 0
    for (const n of state.networks) {
      let speed = 0
      if (moving() && n.role === 'active' && n.enabled) {
        if (n.kind === 'wifi') speed = (5.6 + Math.sin(t / 3) * 0.6 + noise(t) * 0.4) * MB
        if (n.kind === 'usb') speed = (2.3 + Math.sin(t / 2 + 1) * 0.5 + noise(t + 7) * 0.3) * MB
      }
      n.speedBytesPerSec = speed
      n.inflight = speed > 0 ? Math.round(speed / MB) + 2 : 0
      n.usedTodayBytes += speed
      total += speed
    }
    state.boost.speedBytesPerSec = total
    if (total > 0) {
      state.boost.sessionBytes += total
      state.boost.lastRequestAt = Date.now()
      state.boost.requests.done += Math.round(total / MB)
      if (state.boost.download) {
        const game = state.boost.download
        game.downloadedBytes = Math.min(game.totalBytes, game.downloadedBytes + total)
        game.savedSeconds += 0.4
      }
      state.boost.savedSecondsTotal += 0.4
    }
    emit()
  }

  const listeners = new Set()
  const snapshot = () => JSON.parse(JSON.stringify(state))
  const emit = () => {
    const copy = snapshot()
    for (const listener of listeners) listener(copy)
  }
  const later = (fn, ms = 400) => new Promise((done) => setTimeout(() => done(fn()), ms))

  /** Art for the game: a gradient in place of what Steam keeps. */
  const art = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="215"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a3a52"/><stop offset="1" stop-color="#b5653a"/></linearGradient></defs><rect width="460" height="215" fill="url(#g)"/><circle cx="330" cy="70" r="40" fill="#f2c46b" opacity=".85"/></svg>'
  )}`

  window.steamBoost = {
    getState: async () => snapshot(),
    onState: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    updateSettings: (patch) =>
      later(() => {
        Object.assign(state.settings, patch)
        if ('enabled' in patch) state.boost.state = patch.enabled ? 'on' : 'off'
        if (patch.addressMode) {
          state.boost.address = patch.addressMode === 'lan' ? '192.168.1.23' : '127.0.0.1'
        }
        emit()
      }),
    setNetwork: (id, patch) =>
      later(() => {
        const n = state.networks.find((x) => x.id === id)
        if (!n) return
        if (typeof patch.enabled === 'boolean') {
          n.enabled = patch.enabled
          n.role = patch.enabled ? 'active' : 'off'
        }
        if (patch.dailyCapBytes !== undefined) n.dailyCapBytes = patch.dailyCapBytes
        if (patch.name !== undefined) {
          n.defaultLabel ??= n.label
          n.customName = patch.name
          n.label = patch.name ?? n.defaultLabel
        }
        emit()
      }),
    retry: () => later(() => emit()),
    setUp: () =>
      later(() => {
        state.boost.hostsEntry = 'set'
        state.boost.resolvesTo = state.boost.address
        emit()
      }, 900),
    tearDown: () =>
      later(() => {
        state.boost.hostsEntry = 'missing'
        emit()
      }),
    restartSteam: () =>
      later(() => {
        state.boost.steamUsing = true
        emit()
        return 'restarted'
      }, 1500),
    copyDiagnostics: () => later(() => undefined),
    report: () => later(() => console.log('report')),
    openLogs: () => later(() => undefined),
    openUrl: async (url) => console.log('openUrl', url),
    gameArt: async () => art,
    installUpdate: async () => {
      const update = state.update
      if (!update) return
      if (update.install === 'ready') {
        console.log('restart to update')
        return
      }
      update.install = 'downloading'
      update.progress = 0
      emit()
      await new Promise((done) => {
        const timer = setInterval(() => {
          update.progress = Math.min(1, update.progress + 0.2)
          emit()
          if (update.progress >= 1) {
            clearInterval(timer)
            done()
          }
        }, 300)
      })
      update.install = 'ready'
      emit()
    }
  }

  setInterval(tick, 1000)
  tick()
})()
