#!/usr/bin/env bash
# Discordio test helper for SteamOS (Steam Deck, Steam Machine, any Game Mode box).
#
#   ./discordio-test.sh install Discordio.zip   install or update a test build
#   ./discordio-test.sh report                  collect logs + environment info
#   ./discordio-test.sh logs                    follow the plugin log live
#   ./discordio-test.sh uninstall               remove Discordio
#
# Run it from Desktop Mode (Konsole) or over SSH. Needs sudo because Decky's
# plugin folder is owned by root.

set -euo pipefail

PLUGINS="$HOME/homebrew/plugins"
LOGS="$HOME/homebrew/logs"
NAME="Discordio"
REPORT="$HOME/discordio-report.txt"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

restart_decky() {
    say "Restarting Decky Loader"
    sudo systemctl restart plugin_loader
    say "Done. Switch to Game Mode (or wait ~10s if you're already there) and open the QAM."
}

cmd_install() {
    local zip="${1:-}"
    [[ -f "$zip" ]] || { echo "Zip not found: '$zip'"; echo "usage: $0 install path/to/Discordio.zip"; ls -la "$HOME/Downloads" | grep -i discordio || true; exit 1; }
    say "Using $zip"

    # Deckcord and Discordio use the same local ports and window globals, so
    # only one of them can run at a time.
    if [[ -d "$PLUGINS/Deckcord" ]]; then
        warn "Deckcord is installed and conflicts with Discordio."
        local backup="$HOME/Deckcord-backup-$(date +%Y%m%d-%H%M%S)"
        say "Moving it to $backup (delete that folder later if you don't need it)"
        sudo mv "$PLUGINS/Deckcord" "$backup"
    fi

    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    unzip -q "$zip" -d "$tmp"

    # Accept both zip layouts: Discordio/<files> or <files> at the top level.
    local src="$tmp/$NAME"
    [[ -f "$src/plugin.json" ]] || src="$tmp"
    [[ -f "$src/plugin.json" && -f "$src/dist/index.js" ]] || {
        echo "That zip doesn't look like a Discordio build (missing plugin.json or dist/index.js)."
        exit 1
    }

    say "Installing to $PLUGINS/$NAME"
    sudo rm -rf "$PLUGINS/$NAME"
    sudo mkdir -p "$PLUGINS"
    sudo cp -r "$src" "$PLUGINS/$NAME"

    # Verify before restarting, so a failed copy can't look like a success.
    if [[ ! -f "$PLUGINS/$NAME/plugin.json" || ! -f "$PLUGINS/$NAME/dist/index.js" ]]; then
        echo "Install FAILED: files did not end up in $PLUGINS/$NAME"
        sudo ls -la "$PLUGINS/$NAME" 2>&1 || true
        exit 1
    fi
    say "Installed $(grep -m1 '"version"' "$PLUGINS/$NAME/package.json" | tr -d ' ,')"
    restart_decky
}

cmd_uninstall() {
    say "Removing $PLUGINS/$NAME"
    sudo rm -rf "$PLUGINS/$NAME"
    restart_decky
}

cmd_logs() {
    say "Following Decky + Discordio logs (Ctrl+C to stop)"
    sudo journalctl -u plugin_loader -f -n 50 | grep --line-buffered -i -E "discordio|deckcord|capture|error|traceback"
}

section() { printf '\n===== %s =====\n' "$1"; }

cmd_report() {
    say "Writing $REPORT"
    {
        section "When"
        date
        section "OS"
        grep -E '^(NAME|VERSION_ID|BUILD_ID|VARIANT_ID)=' /etc/os-release 2>/dev/null || true
        command -v steamos-select-branch >/dev/null && echo "branch: $(steamos-select-branch -c 2>/dev/null || echo unknown)"
        uname -r
        section "Steam client"
        ls -la "$HOME/.steam/steam/package/" 2>/dev/null | grep -i beta || echo "(no client beta file found)"
        section "Hardware"
        grep -m1 "model name" /proc/cpuinfo || true
        lspci 2>/dev/null | grep -i -E "vga|display" || true
        section "Decky"
        cat "$HOME/homebrew/services/.loader.version" 2>/dev/null || echo "(version file not found)"
        systemctl is-active plugin_loader || true
        ls "$PLUGINS" 2>/dev/null
        section "Discordio files"
        ls -la "$PLUGINS/$NAME" 2>/dev/null || echo "NOT INSTALLED"
        cat "$PLUGINS/$NAME/package.json" 2>/dev/null | grep '"version"' || true
        section "Python + GStreamer (needed for Go Live)"
        /usr/bin/python --version 2>&1 || true
        /usr/bin/python -c "import gi; gi.require_version('Gst','1.0'); from gi.repository import Gst; Gst.init(None); print('GStreamer', Gst.version_string())" 2>&1 || true
        for el in pipewiresrc pulsesrc webrtcbin vp8enc opusenc videoscale videorate; do
            if command -v gst-inspect-1.0 >/dev/null && gst-inspect-1.0 "$el" >/dev/null 2>&1; then echo "system $el: yes"; else echo "system $el: no"; fi
        done
        [[ -d "$PLUGINS/$NAME/bin" ]] && echo "bundled GStreamer: yes" || echo "bundled GStreamer: no (using system)"
        section "Audio"
        pactl get-default-sink 2>&1 || true
        pactl get-default-source 2>&1 || true
        section "Steam UI tabs (CEF debugger)"
        curl -s -m 3 http://127.0.0.1:8080/json 2>/dev/null | grep -o '"title": *"[^"]*"' | sort | uniq -c || echo "(debugger not reachable)"
        section "Ports"
        ss -ltnp 2>/dev/null | grep -E ":(65123|65124|8080) " || echo "(none listening)"
        section "Plugin log (last 200 lines)"
        local latest
        latest="$(ls -t "$LOGS/$NAME"/*.log 2>/dev/null | head -1 || true)"
        if [[ -n "$latest" ]]; then echo "$latest"; tail -n 200 "$latest"; else echo "(no plugin log yet)"; fi
        section "Decky journal (last 300 lines)"
        sudo journalctl -u plugin_loader -n 300 --no-pager 2>/dev/null || echo "(journal not readable)"
    } > "$REPORT" 2>&1
    say "Done. Send me $REPORT (it has no Discord tokens or passwords, but skim it before sharing publicly)."
}

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    uninstall) cmd_uninstall ;;
    report) cmd_report ;;
    logs) cmd_logs ;;
    *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
