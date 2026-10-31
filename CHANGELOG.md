# Changelog

## 0.2.2

The rest of 0.2: the game and the time saved, an installer for each kind of PC, and updates from
the window.

- The window names the game Steam is downloading, with its art, how far along it is, the time left
  and the time the boost has saved on it, and under the chart, the time saved over every download.
- On Windows, a new version installs from the window: Update fetches it, Restart to update puts it
  in. That works from this version on.
- One installer for x64 PCs and one for Arm PCs, each about half the size of the single one before.
  `steam-boost-setup.exe` is the x64 one.
- Adapters for virtual machines, containers and VPNs are listed apart, under Other adapters, and
  stay off unless switched on, so a VPN no longer carries Steam's downloads unasked.
- When another program has port 80, the window says which (IIS, Apache, Skype, …) and what to do
  about it, rather than offering a netstat command.
- Tell us how it went (in Settings, and Feedback at the bottom of the window) opens the Speed
  reports discussion with a reply on the clipboard, filled in from what the app saw.
- Set up and Undo setup change the hosts file behind the administrator prompt itself, so a change
  another program makes there meanwhile isn't lost. Uninstalling takes Steam Boost's line out too.
- Which connections reach the internet is read from `route print`, rather than from a PowerShell
  started every 30 seconds.
- Electron's fuses are set: the app can't be run as a plain Node.js, and only runs its own,
  checked, files.
- Under the chart, pieces that failed are counted as retried: each went to another connection.

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
