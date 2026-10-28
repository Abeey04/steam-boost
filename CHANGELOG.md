# Changelog

## 0.1.1

- Screen readers announce only where things stand, the status line at the top of the window,
  rather than reading out the speed and the chart every second.
- The window's text is easier to read: the fine print, the green buttons, the update notice's link
  and the amber and red text all meet WCAG AA contrast now, in both themes.

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
