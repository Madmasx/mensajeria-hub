#!/usr/bin/env bash
# Installs the launcher, wrapper and icon in the user's home.
# Run again after moving the project (the wrapper embeds the project path).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_BIN="$PROJECT_DIR/node_modules/electron/dist/electron"

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron no está instalado. Ejecuta 'npm install' en $PROJECT_DIR" >&2
  exit 1
fi

BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
SCALABLE_ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
PNG_ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$BIN_DIR" "$APPS_DIR" "$SCALABLE_ICON_DIR" "$PNG_ICON_DIR"

cat > "$BIN_DIR/mensajeria-hub" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
# Development/local launcher for mensajeria-hub.
PROJECT_DIR="$PROJECT_DIR"
ELECTRON_BIN="\$PROJECT_DIR/node_modules/electron/dist/electron"
if [ ! -x "\$ELECTRON_BIN" ]; then
  echo "Electron no encontrado en \$ELECTRON_BIN (ejecuta npm install)" >&2
  exit 1
fi
exec "\$ELECTRON_BIN" "\$PROJECT_DIR" --ozone-platform-hint=auto "\$@"
WRAPPER
chmod +x "$BIN_DIR/mensajeria-hub"

cp "$PROJECT_DIR/resources/icon.svg" "$SCALABLE_ICON_DIR/mensajeria-hub.svg"
cp "$PROJECT_DIR/resources/icon.png" "$PNG_ICON_DIR/mensajeria-hub.png"
chmod 644 "$SCALABLE_ICON_DIR/mensajeria-hub.svg" "$PNG_ICON_DIR/mensajeria-hub.png"

cat > "$APPS_DIR/mensajeria-hub.desktop" <<DESKTOP
[Desktop Entry]
Name=Mensajería Hub
Comment=Multi-account WhatsApp and Telegram hub with isolated sessions
Exec=$BIN_DIR/mensajeria-hub %u
Icon=mensajeria-hub
Terminal=false
Type=Application
Categories=Network;InstantMessaging;Chat;
MimeType=x-scheme-handler/mensajeria-hub;x-scheme-handler/whatsapp;x-scheme-handler/tg;
StartupWMClass=mensajeria-hub
Keywords=whatsapp;telegram;chat;messaging;
DESKTOP

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo "Instalado: $BIN_DIR/mensajeria-hub"
echo "Instalado: $APPS_DIR/mensajeria-hub.desktop"
echo "Iconos: $SCALABLE_ICON_DIR/mensajeria-hub.svg y $PNG_ICON_DIR/mensajeria-hub.png"
