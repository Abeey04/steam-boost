# Changelog

## Unreleased

- Only a request Steam Boost forwards counts as Steam using it. A status check, a prefill tool's
  heartbeat or a refused request no longer does, so the window, the tray and
  `steam-boost-cli check` say when Steam really last asked.
- Release files no longer carry the version in their names (`steam-boost-setup.exe`,
  `steam-boost-arm64.dmg`, …), so the website links straight to the newest ones.

## 0.1.0

The first release: a pre-release for Windows 10 and 11, with experimental macOS and Linux builds.

- Steam's downloads split across every connection with a way to the internet, each chunk on the
  connection that will finish it soonest.
- One-click setup (one hosts-file line, behind the administrator prompt) and one-click undo.
- Restart Steam from the window, and a switch to the LAN address for a Steam that won't use a
  cache on 127.0.0.1.
- Per-connection switches and daily data caps, kept across restarts and reset at midnight.
- A live chart of each connection's speed, a tray icon, start with Windows, and an update notice.
- HTTPS pass-through on port 443 for a Steam that talks HTTPS to its cache.
- Copy diagnostics, for reporting problems.
- `steam-boost-cli`, the same engine as a command-line tool for Node.js 20 or newer.
