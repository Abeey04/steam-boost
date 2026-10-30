# Changelog

## 0.2.1

The same app as 0.2.0, with downloads you can check.

- Every file in a release comes with a build attestation: a signed record that this repository's
  Release workflow built it, from the release's own commit. Check a download against it with
  `gh attestation verify <file> -R Abeey04/steam-boost`.
- The release notes say how to check a download, above each file's SHA-256.

## 0.2.0

The website's look, and a window that opens on what to do next.

- Until Steam has used Steam Boost, the window opens on one card that says what will change and
  the one thing to do: setting up and restarting Steam is one button. Once Steam uses it, that card
  is a one-line summary.
- While Steam downloads, a chip says what the other connections add on top of the fastest one
  ("+42% on top of Wi-Fi"), and a bar shows each connection's share of the speed.
- Connections are called what they are, such as "Phone (USB tethering)" rather than "Ethernet 3",
  with the system's own name under them, and can be renamed.
- The window and the tray say Starting while the app opens, rather than showing the setup steps or
  Off for a moment.
- A new look, the same as the website's: the Archivo typeface, Wi-Fi in blue, a phone in orange and
  Ethernet in purple wherever they show, rounder buttons, and switches that are easier to see when
  off.
- The chart's scale sits closer above the speed, so the chart uses more of its height, and an idle
  chart no longer draws a line along the bottom.

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
