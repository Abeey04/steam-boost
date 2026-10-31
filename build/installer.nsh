; Steam Boost's additions to electron-builder's NSIS installer (electron-builder.yml, nsis.include).

; Uninstalling takes Steam Boost's line out of the hosts file, as Undo setup does in the app, so
; Steam isn't left looking for a cache that's gone. The app does it itself (src/main/index.ts,
; --remove-hosts-line): it asks for administrator rights only if the line is there, and never
; fails the uninstall. Not when an update runs the old version's uninstaller: the line stays for
; the new version.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-hosts-line'
  ${endIf}
!macroend
