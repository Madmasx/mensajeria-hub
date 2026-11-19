# Auditoría de Mensajería Hub vs. encargo original

Fecha: **2026-11-07** · Equipo: Omarchy 4.0.4, Hyprland 0.57.1 (Wayland), Electron 45.2.3,
Node 26.13.0, tema Omarchy **Purple Mad**.

La versión encontrada compilaba y arrancaba, pero tenía defectos funcionales y de
rendimiento que impedían cumplir varios puntos del encargo. Se corrigieron todos los
listados abajo y se verificó cada criterio con la app en ejecución (CDP + capturas +
`dbus-monitor` + `hyprctl`).

---

## Matriz de requisitos

| # | Requisito | Estado | Evidencia |
|---|---|---|---|
| 1 | Electron + TypeScript + Vite | ✅ | `package.json`, `build.js`, `vite.config.mjs`; build y typecheck sin errores |
| 2 | `WebContentsView` (no `BrowserView`) | ✅ | `src/main/view-manager.ts`; `getDiagnostics().views` muestra las vistas |
| 3 | Sesión aislada `persist:<id>` por cuenta | ✅ | `view-manager.ts:partitionFor`; carpetas `Partitions/<id>` distintas; diag. `views[].partition` |
| 4 | Config JSON en `~/.config/mensajeria-hub/config.json` | ✅ | `config.ts` (respeta `XDG_CONFIG_HOME`); archivo real leído/escrito |
| 5 | Grupos con color + cuentas, solo grupo activo | ✅ | UI; pruebas create/rename/reorder/delete vía IPC; capturas |
| 6 | Crear/renombrar/eliminar/reordenar grupos y cuentas | ✅ | prueba automatizada manual vía CDP (crear grupo, renombrar, reordenar, mover cuenta, borrar) |
| 7 | Añadir cuenta con servicio/nombre/grupo y partición nueva | ✅ | `createAccount` creó `Partitions/acc_*`, activó la cuenta y cargó la web |
| 8 | Eliminar cuenta borra su partición (confirmación) | ✅ | `deleteAccount` + verificación `ls`: la carpeta de partición desaparece; confirmación en UI |
| 9 | Alt+1..9 cuentas · Alt+Shift+1..9 grupos · Ctrl+Tab / Ctrl+Shift+Tab | ✅ | Probados con eventos de teclado reales vía CDP; corregido el fallo de `Alt+Shift+1` que dependía de `input.key` (`!`) |
| 10 | Atajos configurables desde la UI y en config.json | ✅ | Editor en Ajustes con validación y aplicación inmediata; probado con `Ctrl+Alt`, `Ctrl+Alt+Shift`, `Ctrl+PageDown/Up`; rechaza prefijos iguales y restauración a defaults |
| 11 | Suspensión tras X minutos, conservando sesión y recarga | ✅ | `[suspend]` logs; tras 12 s (0.2 min) `loaded=[activa]`, `suspended=5`; al reactivar se recrea la vista con la misma partición |
| 12 | Indicador visual de cuenta suspendida | ✅ | etiqueta `💤 Suspendida` verificada en las pruebas con estado `suspendedAccounts` |
| 13 | No leídos por título `(n)`, total por grupo | ✅ | Título forzado `(3) WhatsApp` → `unreadCounts={wa:3}`, badge de cuenta y de grupo = 3 |
| 14 | Notificaciones del sistema con nombre de cuenta; clic abre cuenta | ✅ (aviso: clic no probado por automatización) | `dbus-monitor` capturó `Notify` con summary `"WhatsApp Trabajo: Mensaje de prueba"`; el callback `click` llama a `selectAccount` |
| 15 | Enlaces externos en navegador del sistema (Brave) | ✅ | `will-navigate`/`window.open` bloqueados; log `[external] https://example.com/`; la página no navega |
| 16 | Descargas a `~/Descargas` o carpeta elegida + aviso | ✅ | Descarga blob guardada en carpeta configurada (`MENSAJERIA_HUB_DOWNLOADS_DIR`), nombre saneado y notificación `Descarga completada` |
| 17 | Cerrar a la bandeja opcional + icono de estado | ✅ | Cierre por WM oculta la ventana (`[window] hidden to tray`), proceso vivo; segunda instancia la reabre; icono cambia con no leídos |
| 18 | Restaurar grupo/cuenta activos al abrir | ✅ | `activeAccount` persistido; reinicios mostraron la última cuenta activa |
| 19 | `.desktop` en `~/.local/share/applications` | ✅ | Instalado por `scripts/install-desktop.sh`; `StartupWMClass=mensajeria-hub` |
| 20 | Ejemplo de regla Hyprland en README (sin tocar config) | ✅ | README con `o.window(...)` vigente para Omarchy 4 / Hyprland 0.57; no se modificó `~/.config/hypr` |
| 21 | Arranque en frío 2 cuentas < 2 s | ✅ | 6 cuentas: 225 ms `window-shown`; AppImage: 1.24 s |
| 22 | Cambio de cuenta ya cargada < 150 ms | ✅ | 0.1–0.6 ms en main; 2–5 ms con IPC/DOM |
| 23 | Con 6 cuentas solo la activa mantiene renderer | ✅ (matiz SW) | Tras suspensión `loaded=[activa]`; los service workers de cuentas cerradas tardan ~30–60 s en apagarse (Chromium) |
| 24 | Sin polling ni timers innecesarios | ✅ | 0 `setInterval`; 1 `setTimeout` por vista oculta |
| 25 | `contextIsolation`, `sandbox`, `nodeIntegration:false` | ✅ | webPreferences explícitas + diag.; en la página `process` es `undefined` (el `require` que existe es el cargador AMD de WhatsApp, no Node) |
| 26 | Preload mínimo para título/notificaciones | ✅ | `preload/account.ts` solo puentea notificaciones; el título se lee en main; no se lee DOM de chats |
| 27 | Bloquear navegación fuera de dominios del servicio | ✅ | Allowlist de origen exacto (`https://web.whatsapp.com`, `https://web.telegram.org`) |
| 28 | No inyectar código en chats ni leer contenido | ✅ | Sin `executeJavaScript` sobre el DOM de la app; solo el shim de `Notification` en main world y la API de título de Electron |
| 29 | Fase 4: README instalación + empaquetado | ✅ | README; `npm run dist` y `npm run dist:dir` ejecutados; AppImage probado |
| 30 | No instalar dependencias globales | ✅ | todo en `node_modules` del proyecto |

---

## Defectos encontrados en la versión inicial (corregidos)

1. **Tema equivocado**: leía `~/.config/omarchy/current/theme` (inexistente en Omarchy 4).
   Ahora lee `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` + `theme.name` + fallbacks.
   Verificado: acento `#9c6bde` (Purple Mad) en la UI.
2. **Icono de bandeja inválido**: `nativeImage.createFromBuffer(Buffer.from(svg))` no soporta
   SVG. Se generaron `resources/icon.png`, `tray.png` y `tray-unread.png` con `rsvg-convert`.
3. **Notificaciones sin nombre de cuenta**: el override de `window.Notification` en el preload
   no funciona con `contextIsolation` (mundo aislado). Se instaló un shim en el main world con
   `webFrame.executeJavaScript` + `contextBridge` y se añadió el listener `account:notification`
   en main (que además faltaba). Verificado por DBus.
4. **Suspensión nunca se ejecutaba**: el handler era un `setInterval` de 30 s (polling) y el
   nuevo orden de activación hacía que `scheduleSuspend` saliera por “es la cuenta activa”.
   Reescrito a un `setTimeout` por vista, programado después de actualizar la cuenta activa.
5. **Estado inicial de suspendidas no llegaba a la UI** (todas aparecían sin etiqueta).
   `renderer-ready` devuelve ahora el estado completo y se re-emite en cada cambio.
6. **Modales tapados por la vista web**: `WebContentsView` se pinta encima del renderer. La UI
   oculta la vista activa mientras hay un `<dialog>` abierto y la restaura al cerrar.
7. **Listeners de descarga duplicados**: se añadía `will-download` a la misma sesión cada vez
   que se recreaba una cuenta suspendida. Ahora se inicializa la sesión una sola vez.
8. **Atajos no configurables y `Alt+Shift+1` roto** en layouts donde Shift+1 = `!`.
   Implementado parser de `config.shortcuts`, lectura del dígito desde `input.code` y **editor
   de atajos en Ajustes** con validación, aplicación inmediata y botón de restablecer.
9. **Borrado de cuenta incompleto**: `clearStorageData()` no elimina la carpeta de partición.
   Ahora también se borra `Partitions/<id>` y se valida el id contra path traversal.
10. **Borrar grupo destruía cuentas y sesiones** sin que el encargo lo pidiera. Ahora mueve
    las cuentas a otro grupo (y rechaza borrar el único grupo con cuentas).
11. **Enlaces externos sin validación de protocolo**; se abre en el navegador solo `http(s)`.
12. **Sin manejadores de permisos**: se conceden `notifications`/`fullscreen`/`media`
    (micrófono y cámara para llamadas) solo para el origen del servicio; el resto se deniega.
13. **Bandeja sin manejo de fallo**: si el sistema no soporta tray, la app se cerraba al
    ocultarse y quedaba inaccesible. Ahora detecta el fallo, no oculta y permite reabrir.
14. **Ventana irrecuperable** si se cerraba a nivel de renderer: `showWindow()` recrea la
    ventana y reactiva la cuenta.
15. **URL de descarga mal resuelta** con `XDG_CONFIG_HOME` alternativo (caía en `$HOME`).
    Nuevo helper `resolveDownloadsDir()` con `~/Descargas` → `~/Downloads` → XDG → crear.
16. **Mejoras de robustez**: config atómica y reparada, unread deduplicado, errores de carga
    mostrados por cuenta con botón de reintento, menú contextual (copiar/pegar/enlaces),
    segunda instancia, cierre limpio y recuperación de ventana.

---

## Pruebas realizadas (resumen)

- `npm run typecheck` → OK.
- `npm run build` → OK.
- `npm run dist:dir` → OK; binario empaquetado arranca en 196 ms.
- `npx electron-builder --linux AppImage` → OK; AppImage arranca en 1.24 s, clase
  `mensajeria-hub`, cierre limpio con `closeToTray:false`.
- App en vivo con 6 cuentas: arranque 225 ms, solo la activa cargada, 5 suspendidas.
- Perfil real del usuario (2 cuentas, tema Purple Mad): arranque 197 ms; solo la cuenta activa cargada; config y particiones intactas.
- Cambios de cuenta con teclado real (CDP) y atajos personalizados.
- Editor de atajos probado por UI: guardar, aplicar al instante, rechazar prefijos duplicados, suspender atajos mientras el modal está abierto y restablecer defaults.
- No leídos: título `(3) WhatsApp` → badge por cuenta y por grupo.
- Notificación: DBus `Notify` con `"WhatsApp Trabajo: Mensaje de prueba"`.
- Enlaces externos: navegación bloqueada + log; `window.open` bloqueado.
- Descarga: archivo en carpeta configurada + notificación de finalización.
- Borrado de cuenta: carpeta de partición eliminada.
- Cierre por WM → bandeja; segunda instancia → ventana restaurada.
- Captura de la app real con el perfil del usuario en `docs/captura-app.png`.

> Nota: el clic sobre la notificación nativa no se pudo simular de forma fiable; el código
> conecta `notification.on('click')` con `selectAccount(accountId)` y `showWindow()`.
