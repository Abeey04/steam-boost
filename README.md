<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="" />
</p>

<h1 align="center">Steam Boost</h1>

<p align="center">
  Steam downloads over every internet connection you have at once.<br />
  <a href="https://abeey04.github.io/steam-boost/">Website</a> ·
  <a href="https://github.com/Abeey04/steam-boost/releases/latest">Download</a>
</p>

<p align="center">
  <img src="docs/assets/app.png" width="720" alt="Steam Boost in its dark and light themes, downloading over Wi-Fi at 6.4 MB/s and a phone at 2.3 MB/s, 8.75 MB/s together" />
</p>

Steam Boost splits Steam's downloads across your Wi-Fi, Ethernet and phone, piece by piece, so a
game arrives at their combined speed. Home broadband plus your phone's mobile data over a USB
cable is the usual pair. It's free and open source (MIT), and it doesn't touch Steam, your games
or your account.

> **Pre-release.** Steam Boost is tested end to end against a simulated Steam (a mock content
> server and a client that downloads the way Steam does through a cache), and it has worked with
> the real Steam client on Windows. It's still early: if you try it, a reply in
> [Speed reports](https://github.com/Abeey04/steam-boost/discussions/2) saying how it went, working
> or not, is the most useful thing you can send.

## How it works

Steam can download through a cache on your local network, a feature it has for LAN parties
([lancache.net](https://lancache.net/news/2020/01/14/steam-client-now-supports-lancache/)). When
Steam starts, it looks up `lancache.steamcontent.com`; if that name points at a private address,
Steam sends its content requests there over plain HTTP, naming the real content server in the
`Host` header, and falls back to its own servers whenever the cache can't help.

Steam Boost is that cache, on your own PC, and it caches nothing:

1. **Set up** adds one line to your hosts file, `127.0.0.1 lancache.steamcontent.com`, so the cache
   Steam finds is Steam Boost.
2. Steam asks for a game in chunks of about a megabyte, many at a time. Each chunk goes to the
   connection that will finish it soonest, judged from each connection's speed, latency and
   backlog. A slow connection still carries its share without holding up the fast one, a
   connection that keeps failing is rested, and a straggler is raced on another connection.
3. Chunks arrive encrypted with the game's depot key, and Steam checks each against its checksum,
   so nothing Steam Boost does can change a game: a bad chunk would be rejected, never installed.

Each connection is used by binding its sockets to that adapter's address (and, on Linux, to the
device itself), which is how [Plexo](https://github.com/anmolkapil/plexo) splits a file across
connections; Steam Boost's networking code comes from it. If Steam ever talks HTTPS to the cache
(reported on Linux and the Steam Deck), Steam Boost passes each connection through to the server
it names, over one of the connections, the way LANCache does.

## Using it

1. **Connect a second internet connection.** On Android, plug the phone in and turn on Settings ›
   Network & internet › Hotspot & tethering › USB tethering. Wi-Fi and Ethernet to the same router
   share one line, so that pair adds nothing.
2. **Open Steam Boost.** It opens on the one thing to do: click **Set up and restart Steam** and
   approve the administrator prompt. Steam Boost adds its line to your hosts file, then restarts
   Steam, which only looks for a cache as it starts.
3. **Download something in Steam.** The window names the game, with how far along it is, the time
   left and the time the boost has saved on it. Each connection's speed shows too, and in the
   chart, with what the others add on top of the fastest.

Give your phone a **daily cap** (Set daily cap, under its connection) to keep your mobile data in
check: Steam Boost stops using it once the day's cap is reached and starts again at midnight.
Adapters for virtual machines, containers and VPNs are listed apart, under Other adapters, and
stay off unless you switch one on. Closing the window keeps the boost running in the tray; quit
from the tray icon. **Undo setup** (in Settings) takes the hosts-file line out again, and so does
uninstalling. On Windows, a new version installs from the window: Update, then Restart to update.

### Checking a download

From 0.2.1 on, GitHub builds every release from its tagged source, and the release notes list each
file's SHA-256 and link its VirusTotal scan. To check that a download is a file the Release
workflow built, run `gh attestation verify steam-boost-setup.exe -R Abeey04/steam-boost` with the
[GitHub CLI](https://cli.github.com).

### If Steam doesn't use it

- **Steam ignores 127.0.0.1.** Some Steam builds may not take a cache on loopback. If Steam has
  restarted and still sends nothing, the window offers **Use my LAN address**, which listens on
  your PC's LAN address instead, points Steam there and restarts it. The same switch is in
  Settings › Listen on.
- **Port 80 is taken.** Steam only talks to a cache on port 80. The window says which program has
  it, and what to do: IIS, XAMPP/Apache and old Skype are the usual ones. To look yourself:
  `netstat -ano | findstr ":80 "` and `tasklist /FI "PID eq <pid>"`. PID 4 is Windows' own HTTP
  service: `netsh http show servicestate` shows who registered it.
- **One connection drops when the phone is plugged in.** Windows keeps one internet connection
  by default. To allow both, run this as administrator and restart Windows:
  `reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\WcmSvc\GroupPolicy" /v fMinimizeConnections /t REG_DWORD /d 0 /f`
- **Everything goes over the phone, Steam Boost or not.** Windows often prefers a tethered phone
  for all traffic. Make Wi-Fi the default again with
  `Set-NetIPInterface -InterfaceAlias "Ethernet 3" -InterfaceMetric 500` (the phone's adapter
  name, as administrator). Steam Boost still uses the phone: it binds to each adapter directly.
- **Something else.** Settings › **Tell us how it went** (or Feedback, at the bottom of the
  window) opens a new [issue](https://github.com/Abeey04/steam-boost/issues) with a summary filled
  in, and puts the diagnostics on the clipboard to paste into it: versions, settings, the
  hosts-file line, Steam's cache log lines and Steam Boost's log. They name your connections and
  their local addresses, so look them over first. **Copy diagnostics** copies them alone.

## Building it

You need Node.js 22 or newer.

```bash
npm install
npm run dev          # build, run, and rebuild + restart on every change
npm test             # the engine against a mock Steam CDN, plus the app's own pieces
npm run typecheck
npm run ui           # the window in a browser on made-up data, every state side by side
npm run test:ui      # each state, light and dark, against its screenshot (in Edge)
npm run dist:win     # installers in dist/ (dist:mac, dist:linux on those systems)
npm run build:cli    # out/cli/steam-boost-cli.mjs: the engine as a command-line tool
```

After a change to the window that's meant to show, `npm run test:ui -- --update-snapshots` takes
new screenshots (`test/ui/screenshots`): look them over in the diff before committing them.

| Where                         | What                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/steam/`             | The engine: the cache Steam talks to (`steamBoost.ts`), which connection gets each chunk (`dispatcher.ts`), the hosts file, TLS pass-through, Steam's log |
| `src/main/network/`           | Connections: finding them, and opening sockets on each (from Plexo)                                                                                       |
| `src/main/boostController.ts` | Runs the engine the way the settings say, and watches whether Steam uses it                                                                               |
| `src/main/index.ts`           | The app: window, tray, settings, daily usage, update check                                                                                                |
| `src/renderer/`               | The window (React)                                                                                                                                        |
| `src/cli/`                    | `steam-boost-cli`: the engine without the app                                                                                                             |
| `test/`                       | `node --test` suites; `fixtures.ts` is the mock CDN and the Steam-like client                                                                             |
| `test/ui/`                    | The window's playground (`mock.js` stands in for the app) and its screenshot tests                                                                        |
| `docs/`                       | The website, served by GitHub Pages                                                                                                                       |
| `build/`, `resources/`        | Icons (rendered from `build/icon.svg`), and the website's link preview (`build/og.html`)                                                                  |

A development build reads two settings from its environment, which a packaged build ignores:
`STEAM_BOOST_TEST_NETWORKS="Wi-Fi=127.0.0.2=wifi,Phone=127.0.0.3=usb"` replaces the computer's
networks with these, and `STEAM_BOOST_USER_DATA` keeps settings and logs in another folder.

## Releasing

1. Set the new version in `package.json`, commit, and tag it: `git tag v0.2.0 && git push origin main v0.2.0`.
2. The Release workflow builds Windows, macOS and Linux and leaves a **draft** release with the
   installers, `steam-boost-cli.mjs`, and `latest.yml` with the `.blockmap` files, which the
   app's updater reads, each with a build attestation. Its notes start with how to check a
   download: the files' SHA-256s and, with a `VT_API_KEY` secret (a free
   [VirusTotal](https://www.virustotal.com) account's API key, in Settings › Secrets and variables
   › Actions), each file's VirusTotal scan. Write what's new above them. The run's log shows
   `latest.yml`: it should list both Windows installers.
3. Look over the draft and any scans, then publish it as a full release. The website's download
   buttons and the app's update check use GitHub's latest release, which skips pre-releases. The
   buttons link to each file by name (`releases/latest/download/steam-boost-setup.exe`), so keep
   the names `electron-builder.yml` gives them.

Windows has an installer for each architecture, `steam-boost-setup-x64.exe` and
`steam-boost-setup-arm64.exe`; the x64 one is also uploaded as `steam-boost-setup.exe`, the name
links have used from the start. Electron's fuses are set as the app is packaged, so it can't be
run as a plain Node.js and only runs its own, checked, `app.asar`.

Builds aren't code-signed yet. Windows shows a SmartScreen warning on first run: choose More info,
then Run anyway. macOS blocks the app the first time it's opened: go to System Settings › Privacy &
Security and click Open Anyway (macOS 15 no longer offers right-click › Open for this). If macOS
says the app is damaged, run `xattr -dr com.apple.quarantine "/Applications/Steam Boost.app"` in
Terminal and open it again.

### Signing, once there's a certificate

[SignPath Foundation](https://signpath.org) signs open-source Windows builds at no cost. It asks for
an OSI licence (MIT is one), a public repository, builds made by CI (the Release workflow), and a
code signing policy published with the project, which names who may commit and who approves a
release. Applying is the owner's to do, at signpath.org/apply. Once accepted, the signing step goes
between the Windows build and the upload in `release.yml`, using SignPath's GitHub Action, and the
installer's publisher name goes in `electron-builder.yml` (`win.signtoolOptions.publisherName`), so
the updater checks it. macOS needs an Apple Developer ID for the same.

## The website

`docs/` is the website: plain HTML and CSS, with download links straight to the latest release's
files, which `site.js` swaps for the exact ones when GitHub's API answers. Its look (the
typeface, colours and buttons) is `theme.css`, kept apart from the page layout in `styles.css`:
the app's window imports it too (`src/renderer/styles.css`), so a change there shows in both.
GitHub Pages serves it at https://abeey04.github.io/steam-boost/ with the repository's Settings ›
Pages set to **Deploy from a branch**, branch `main`, folder `/docs`.

### A custom domain, later

To move the site to steamboost.app once that domain is registered to you:

1. At the registrar, give the bare domain A records `185.199.108.153`, `185.199.109.153`,
   `185.199.110.153` and `185.199.111.153`, and AAAA records `2606:50c0:8000::153`,
   `2606:50c0:8001::153`, `2606:50c0:8002::153` and `2606:50c0:8003::153`. Give `www` a CNAME to
   `abeey04.github.io`. Delete the registrar's own parking records, and on Cloudflare make every
   record DNS only.
2. In Settings › Pages, enter `steamboost.app` as the custom domain. Once the DNS check passes,
   tick **Enforce HTTPS**. GitHub adds `docs/CNAME` in a commit of its own: pull it.
3. Point the project at the new address: `site` in `src/shared/project.ts`, `homepage` in
   `package.json`, the canonical and `og:` addresses at the top of `docs/index.html`, and the
   `/steam-boost/` paths in `docs/404.html`.

See GitHub's guide to [managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

## Credits

- [Plexo](https://github.com/anmolkapil/plexo) by Anmol Kapil (MIT): the networking code in
  `src/main/network/` and the rate meter in `src/main/steam/meter.ts`, and the idea of splitting
  downloads across connections.
- [lancache.net](https://lancache.net), [SteamKit2](https://github.com/SteamRE/SteamKit) and
  [steam-lancache-prefill](https://github.com/tpill90/steam-lancache-prefill), for how Steam
  finds and talks to a cache.
- [Archivo](https://github.com/Omnibus-Type/Archivo) by Omnibus-Type (SIL Open Font License), the
  typeface of the website and the app.

Steam Boost is not affiliated with Valve Corporation. Steam and the Steam logo are trademarks of
Valve Corporation.

## License

MIT. See [LICENSE](LICENSE).
