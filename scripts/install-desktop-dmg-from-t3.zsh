#!/bin/zsh
set -euo pipefail

readonly APP_PATH="/Applications/T3 Code (Alpha).app"
readonly BUNDLE_ID="com.t3tools.t3code"
readonly SCRIPT_PATH="${0:A}"

detach_mount() {
  local mount_dir="${1:?missing mount directory}"
  local attempt

  for attempt in 1 2 3; do
    if hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  hdiutil detach "$mount_dir" -force -quiet >/dev/null 2>&1
}

cleanup_stale_mounts() {
  local stale_mount

  for stale_mount in /tmp/t3-code-dmg.*(N/); do
    detach_mount "$stale_mount" >/dev/null 2>&1 || true
    rmdir "$stale_mount" >/dev/null 2>&1 || true
  done
}

close_terminal_window() {
  local window_title="${1:?missing window title}"
  (
    sleep 0.75
    /usr/bin/osascript >/dev/null 2>&1 <<APPLESCRIPT || true
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t is "$window_title" then
        close w saving no
        return
      end if
    end repeat
  end repeat
end tell
APPLESCRIPT
  ) &
}

install_dmg() {
  local dmg="${1:?missing dmg path}"
  local window_title="${2:?missing window title}"
  local mount_dir
  local signature_details
  local source_app

  cleanup_stale_mounts
  mount_dir="$(mktemp -d /tmp/t3-code-dmg.XXXXXX)"
  source_app="$mount_dir/T3 Code (Alpha).app"

  cleanup() {
    detach_mount "$mount_dir" >/dev/null 2>&1 || true
    rmdir "$mount_dir" >/dev/null 2>&1 || true
  }

  trap cleanup EXIT

  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  sleep 2

  print "Mounting $dmg..."
  hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir"

  if [[ ! -d "$source_app" ]]; then
    print -u2 "The DMG does not contain T3 Code (Alpha).app"
    return 1
  fi

  print "Installing to $APP_PATH..."
  rm -rf -- "$APP_PATH"
  ditto "$source_app" "$APP_PATH"

  if ! codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
    signature_details="$(codesign -d --verbose=4 "$APP_PATH" 2>&1 || true)"
    if [[ "$signature_details" != *"Signature=adhoc"* &&
      "$signature_details" != *"code object is not signed at all"* ]]; then
      print -u2 "The installed application has an invalid non-local signature"
      return 1
    fi

    print "Applying a local ad-hoc application signature..."
    codesign --force --deep --sign - --preserve-metadata=entitlements "$APP_PATH"
  fi

  print "Verifying the installed application..."
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"

  if ! detach_mount "$mount_dir"; then
    print -u2 "Could not detach the T3 Code disk image"
    return 1
  fi
  rmdir "$mount_dir"
  trap - EXIT

  print "Launching T3 Code..."
  open -a "$APP_PATH"
  close_terminal_window "$window_title"
}

handoff_to_terminal() {
  local dmg="${1:?missing dmg path}"
  local launcher
  local window_title
  local self

  launcher="$(mktemp /tmp/t3-code-launch.applescript.XXXXXX)"
  window_title="T3-Code-Installer-$$-$(date +%s)"
  self="$SCRIPT_PATH"

  cleanup_launcher() {
    rm -f -- "$launcher"
  }

  trap cleanup_launcher EXIT

  cat > "$launcher" <<'APPLESCRIPT'
on run argv
  set scriptPath to item 1 of argv
  set dmgPath to item 2 of argv
  set windowTitle to item 3 of argv

  tell application "Terminal"
    activate
    set installerTab to do script "/bin/zsh " & quoted form of scriptPath & " --install " & quoted form of dmgPath & " " & quoted form of windowTitle
    set custom title of installerTab to windowTitle
  end tell
end run
APPLESCRIPT

  /usr/bin/osascript "$launcher" "$self" "$dmg" "$window_title"
  cleanup_launcher
  trap - EXIT
}

main() {
  if [[ "${1:-}" == "--install" ]]; then
    install_dmg "${2:?missing dmg path}" "${3:?missing window title}"
    return
  fi

  local dmg
  dmg="$(ls -t "$PWD"/release/T3-Code-*-arm64.dmg 2>/dev/null | head -1)" || true
  if [[ -z "$dmg" || ! -f "$dmg" ]]; then
    print -u2 "No arm64 T3 Code DMG found under $PWD/release"
    return 1
  fi

  handoff_to_terminal "$dmg"
}

main "$@"
