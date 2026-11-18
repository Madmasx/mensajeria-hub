#!/usr/bin/env bash
# Makes Mensajería Hub the system handler for its own scheme and (optionally)
# WhatsApp/Telegram links. Run ./scripts/install-desktop.sh first.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="$HOME/.local/share/applications"
DESKTOP="$APPS_DIR/mensajeria-hub.desktop"

if [ ! -f "$DESKTOP" ]; then
  "$PROJECT_DIR/scripts/install-desktop.sh"
fi

if ! command -v xdg-mime >/dev/null 2>&1; then
  echo "xdg-mime no está instalado" >&2
  exit 1
fi

TG_DEFAULT="$(xdg-mime query default x-scheme-handler/tg 2>/dev/null || true)"

xdg-mime default mensajeria-hub.desktop x-scheme-handler/mensajeria-hub
xdg-mime default mensajeria-hub.desktop x-scheme-handler/whatsapp

if [ "${1:-}" = "--telegram" ]; then
  # This replaces the current Telegram Desktop handler for tg: links.
  xdg-mime default mensajeria-hub.desktop x-scheme-handler/tg
  echo "También se registró tg:// (antes podía abrir Telegram Desktop)."
elif [ -n "$TG_DEFAULT" ] && [ "$TG_DEFAULT" != "mensajeria-hub.desktop" ]; then
  # Keep the user's previous Telegram handler.
  xdg-mime default "$TG_DEFAULT" x-scheme-handler/tg
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true

echo "Registrado: mensajeria-hub:// y whatsapp:// abren Mensajería Hub."
echo "Para revertir whatsapp:// al navegador: xdg-mime default brave-browser.desktop x-scheme-handler/whatsapp"
