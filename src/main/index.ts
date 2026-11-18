import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  AppConfig,
  GroupConfig,
  AccountConfig,
  ShortcutsConfig,
  SERVICE_URLS,
  configDir,
  configFile,
  isValidServiceUrl,
  loadConfig,
  newAccountId,
  newGroupId,
  saveConfig
} from './config';
import {
  bindingMatches,
  digitFromInput,
  modifiersMatch,
  parseModifierSpec,
  validateShortcuts
} from './shortcuts';
import { ThemeColors, loadOmarchyTheme, loadOmarchyThemeInfo } from './theme';
import { ViewManager, ViewStatus } from './view-manager';
import { assetPath, iconPath, resolveDownloadsDir } from './paths';

const DEBUG = process.env.MENSAJERIA_HUB_DEBUG === '1';
const startedAt = performance.now();

if (process.platform === 'linux') {
  // Linux / Hyprland: let Chromium pick Wayland when available, X11 otherwise.
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Keep a stable WM_CLASS / app_id so the Hyprland window rule can match it.
  app.commandLine.appendSwitch('class', 'mensajeria-hub');
}

app.setName('mensajeria-hub');
if (process.platform === 'win32') {
  // Required for Windows notifications to be attributed to the app.
  app.setAppUserModelId('com.madmasx.mensajeria-hub');
}

let mainWindow: BrowserWindow | null = null;
let viewManager: ViewManager | null = null;
let tray: Tray | null = null;
let trayAvailable = false;
let isQuitting = false;
let config: AppConfig = loadConfig();
let shortcutsSuspended = false;

function log(...args: unknown[]): void {
  if (DEBUG) console.log('[mh]', ...args);
}

function logTiming(label: string): void {
  if (!DEBUG) return;
  console.log(
    `[timing] ${label} module=${(performance.now() - startedAt).toFixed(0)}ms ` +
      `uptime=${(process.uptime() * 1000).toFixed(0)}ms`
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendToUi(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// -----------------------------------------------------------------------------
// Selection / persistence
// -----------------------------------------------------------------------------

function commitActiveSelection(): void {
  saveConfig(config);

  if (config.activeAccount) {
    viewManager?.activateAccount(config.activeAccount);
  } else {
    viewManager?.clearActive();
  }

  sendToUi('app:active-changed', {
    groupId: config.activeGroup,
    accountId: config.activeAccount
  });
  updateTray();
}

function selectGroup(groupId: string): boolean {
  const group = config.groups.find((candidate) => candidate.id === groupId);
  if (!group) return false;

  config.activeGroup = group.id;
  if (!group.accounts.includes(config.activeAccount)) {
    config.activeAccount = group.accounts[0] ?? '';
  }

  log(`[select] group ${group.id} -> account ${config.activeAccount || '(none)'}`);
  commitActiveSelection();
  return true;
}

function selectAccount(accountId: string): boolean {
  const account = config.accounts.find((candidate) => candidate.id === accountId);
  if (!account) return false;

  const owner = config.groups.find((group) => group.accounts.includes(accountId));
  config.activeAccount = accountId;
  if (owner) config.activeGroup = owner.id;

  log(`[select] account ${account.id} group ${config.activeGroup}`);
  commitActiveSelection();
  return true;
}

function pushState(): void {
  sendToUi('app:unread-counts', viewManager?.getUnreadCounts() ?? {});
  sendToUi('app:suspended-accounts', viewManager?.getSuspendedAccounts() ?? []);
  sendToUi('app:active-changed', {
    groupId: config.activeGroup,
    accountId: config.activeAccount
  });
}

// -----------------------------------------------------------------------------
// Keyboard shortcuts
// -----------------------------------------------------------------------------

function cycleAccount(delta: number): void {
  const group = config.groups.find((candidate) => candidate.id === config.activeGroup);
  if (!group || group.accounts.length === 0) return;

  const current = group.accounts.indexOf(config.activeAccount);
  const next =
    current === -1
      ? group.accounts[delta > 0 ? 0 : group.accounts.length - 1]
      : group.accounts[(current + delta + group.accounts.length) % group.accounts.length];
  if (next) selectAccount(next);
}

function handleShortcuts(input: Electron.Input): boolean {
  // While a settings dialog is open, key combinations belong to the form.
  if (shortcutsSuspended) return false;
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;

  const shortcuts: ShortcutsConfig = config.shortcuts;
  const accountPrefix = parseModifierSpec(shortcuts.accountPrefix);
  const groupPrefix = parseModifierSpec(shortcuts.groupPrefix);
  const digit = digitFromInput(input);

  if (digit && accountPrefix && modifiersMatch(input, accountPrefix)) {
    const group = config.groups.find((candidate) => candidate.id === config.activeGroup);
    const target = group?.accounts[digit - 1];
    if (target) {
      selectAccount(target);
      return true;
    }
  }

  if (digit && groupPrefix && modifiersMatch(input, groupPrefix)) {
    const target = config.groups[digit - 1];
    if (target) {
      selectGroup(target.id);
      return true;
    }
  }

  if (bindingMatches(input, shortcuts.nextAccount)) {
    cycleAccount(1);
    return true;
  }

  if (bindingMatches(input, shortcuts.prevAccount)) {
    cycleAccount(-1);
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// Tray
// -----------------------------------------------------------------------------

function trayImage(unread: boolean): Electron.NativeImage {
  const preferred = assetPath(unread ? 'tray-unread.png' : 'tray.png');
  const fallback = assetPath('icon.png');
  const file = fs.existsSync(preferred) ? preferred : fallback;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return image;
  return image.resize({ width: 22, height: 22 });
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // The window can disappear (renderer-initiated close, crash) while the app
    // lives in the tray; recreate it instead of leaving the app unreachable.
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) mainWindow.hide();
  else showWindow();
}

function setupTray(): void {
  try {
    const image = trayImage(false);
    if (image.isEmpty()) throw new Error('tray icon could not be loaded');

    tray = new Tray(image);
    tray.setToolTip('Mensajería Hub');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Mostrar / ocultar ventana', click: toggleWindow },
        { type: 'separator' },
        {
          label: 'Salir',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ])
    );
    tray.on('click', toggleWindow);
    trayAvailable = true;
    log('[tray] ready');
  } catch (err) {
    // Without a tray the app must not hide itself on close or it becomes unreachable.
    trayAvailable = false;
    console.error('[tray] system tray unavailable:', errorMessage(err));
  }
}

function updateTray(): void {
  if (!tray) return;
  const totalUnread = Object.values(viewManager?.getUnreadCounts() ?? {}).reduce(
    (sum, count) => sum + count,
    0
  );
  try {
    tray.setToolTip(totalUnread > 0 ? `Mensajería Hub — ${totalUnread} sin leer` : 'Mensajería Hub');
    tray.setImage(trayImage(totalUnread > 0));
  } catch (err) {
    log('[tray] update failed:', err);
  }
}

// -----------------------------------------------------------------------------
// Window
// -----------------------------------------------------------------------------

function createWindow(): void {
  const theme = loadOmarchyTheme();

  mainWindow = new BrowserWindow({
    title: 'Mensajería Hub',
    width: 1280,
    height: 850,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: theme.background,
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath()) ? iconPath() : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // A default Electron menu (File/Edit/View/Window) would be hidden until the
  // user taps Alt, which is commonly bound to keyboard-layout switching.
  // Remove it entirely so Alt never opens a menu bar.
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);

  viewManager = new ViewManager(
    mainWindow,
    config,
    {
      onUnreadChange: (counts) => {
        sendToUi('app:unread-counts', counts);
        updateTray();
      },
      onSuspendedChange: (accounts) => {
        sendToUi('app:suspended-accounts', accounts);
      },
      onShortcutInput: (input) => handleShortcuts(input),
      onNotificationClick: (accountId) => {
        showWindow();
        selectAccount(accountId);
      },
      onStatus: (status: ViewStatus) => {
        sendToUi('app:account-status', status);
      }
    },
    { iconPath: fs.existsSync(iconPath()) ? iconPath() : undefined }
  );

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    logTiming('window-shown');
    mainWindow?.show();
    // The renderer reports back when its listeners are ready; the account view
    // is created only then, so the UI can paint first.
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logTiming('ui-dom-finished-loading');
    pushState();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (handleShortcuts(input)) event.preventDefault();
  });

  // The UI must never navigate away from its own local files.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('resize', () => viewManager?.updateActiveViewBounds());
  mainWindow.on('maximize', () => viewManager?.updateActiveViewBounds());
  mainWindow.on('unmaximize', () => viewManager?.updateActiveViewBounds());
  mainWindow.on('enter-full-screen', () => viewManager?.updateActiveViewBounds());
  mainWindow.on('leave-full-screen', () => viewManager?.updateActiveViewBounds());

  mainWindow.on('close', (event) => {
    if (!isQuitting && config.closeToTray && trayAvailable) {
      event.preventDefault();
      mainWindow?.hide();
      log('[window] hidden to tray');
    }
  });

  mainWindow.on('closed', () => {
    viewManager?.destroy();
    viewManager = null;
    mainWindow = null;
  });
}

// -----------------------------------------------------------------------------
// IPC
// -----------------------------------------------------------------------------

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: errorMessage(err) };
}

function setupIpc(): void {
  ipcMain.handle('app:get-config', () => config);
  ipcMain.handle('app:get-theme', (): ThemeColors => loadOmarchyTheme());

  ipcMain.handle('app:renderer-ready', () => {
    logTiming('renderer-ready');
    // Idempotent: also restores the active account when the window is
    // recreated after being closed to the tray.
    if (config.activeAccount) viewManager?.activateAccount(config.activeAccount);
    else viewManager?.clearActive();
    return {
      config,
      unreadCounts: viewManager?.getUnreadCounts() ?? {},
      suspendedAccounts: viewManager?.getSuspendedAccounts() ?? config.accounts.map((account) => account.id),
      activeGroup: config.activeGroup,
      activeAccount: config.activeAccount
    };
  });

  ipcMain.handle('app:select-group', (_event, groupId: string) => selectGroup(groupId));
  ipcMain.handle('app:select-account', (_event, accountId: string) => selectAccount(accountId));

  ipcMain.handle('app:set-sidebar-bounds', (_event, width: number) => {
    viewManager?.setSidebarWidth(width);
  });

  ipcMain.handle('app:set-account-view-visible', (_event, visible: boolean) => {
    // Dialogs disable global shortcuts so typing/selecting inside them does
    // not switch accounts behind the dialog.
    shortcutsSuspended = !visible;
    viewManager?.setUiHidden(!visible);
  });

  ipcMain.handle('app:create-group', (_event, data: { name?: string; color?: string }) => {
    try {
      const name = String(data?.name ?? '').trim().slice(0, 60);
      if (!name) return fail(new Error('El nombre del grupo es obligatorio.'));
      const color = /^#[0-9a-fA-F]{6}$/.test(String(data?.color ?? '')) ? String(data.color) : '#3b82f6';

      let id = newGroupId(name);
      while (config.groups.some((group) => group.id === id)) id = newGroupId(name);

      const group: GroupConfig = { id, name, color, accounts: [] };
      config.groups.push(group);
      saveConfig(config);
      return { ok: true as const, group };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('app:update-group', (_event, groupId: string, data: { name?: string; color?: string }) => {
    try {
      const group = config.groups.find((candidate) => candidate.id === groupId);
      if (!group) return fail(new Error('Grupo no encontrado.'));
      if (typeof data?.name === 'string' && data.name.trim()) group.name = data.name.trim().slice(0, 60);
      if (typeof data?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) group.color = data.color;
      saveConfig(config);
      return { ok: true as const };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('app:delete-group', (_event, groupId: string) => {
    try {
      const group = config.groups.find((candidate) => candidate.id === groupId);
      if (!group) return fail(new Error('Grupo no encontrado.'));

      const remaining = config.groups.filter((candidate) => candidate.id !== groupId);
      let movedTo: string | undefined;

      if (remaining.length === 0) {
        if (group.accounts.length > 0) {
          return fail(
            new Error(
              'No puedes eliminar el único grupo mientras tenga cuentas. Elimina o mueve sus cuentas primero.'
            )
          );
        }
        config.groups = [];
        config.activeGroup = '';
        config.activeAccount = '';
      } else {
        // Deleting a group never deletes sessions: move its accounts to the
        // first remaining group so the user can decide what to remove.
        const target = remaining[0];
        for (const accountId of group.accounts) {
          if (!target.accounts.includes(accountId)) target.accounts.push(accountId);
        }
        config.groups = remaining;
        movedTo = target.name;
        if (config.activeGroup === groupId) config.activeGroup = target.id;
      }

      // The active account may have moved out of the deleted group.
      const owner = config.groups.find((candidate) => candidate.accounts.includes(config.activeAccount));
      if (owner) config.activeGroup = owner.id;
      else config.activeAccount = config.groups[0]?.accounts[0] ?? '';

      commitActiveSelection();
      return { ok: true as const, movedTo };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('app:create-account', (_event, data: { name?: string; service?: string; url?: string; groupId?: string }) => {
    try {
      const name = String(data?.name ?? '').trim().slice(0, 80);
      if (!name) return fail(new Error('El nombre de la cuenta es obligatorio.'));

      const service = data?.service === 'telegram' ? 'telegram' : 'whatsapp';
      const groupId = String(data?.groupId ?? '');
      let group = config.groups.find((candidate) => candidate.id === groupId);
      if (!group) group = config.groups[0];
      if (!group) {
        // First account of a fresh config: create a group so it stays visible.
        let id = newGroupId('General');
        while (config.groups.some((candidate) => candidate.id === id)) id = newGroupId('General');
        group = { id, name: 'General', color: '#3b82f6', accounts: [] };
        config.groups.push(group);
        config.activeGroup = group.id;
      }

      const rawUrl = typeof data?.url === 'string' ? data.url.trim() : '';
      const url = rawUrl || SERVICE_URLS[service];
      if (!isValidServiceUrl(url, service)) {
        return fail(
          new Error(
            service === 'whatsapp'
              ? 'La URL debe ser https://web.whatsapp.com'
              : 'La URL debe ser https://web.telegram.org'
          )
        );
      }

      let id = newAccountId();
      while (config.accounts.some((candidate) => candidate.id === id)) id = newAccountId();

      const account: AccountConfig = { id, name, service, url };
      config.accounts.push(account);
      group.accounts.push(id);
      saveConfig(config);
      selectAccount(id);
      return { ok: true as const, account };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'app:update-account',
    (_event, accountId: string, data: { name?: string; url?: string; groupId?: string }) => {
      try {
        const account = config.accounts.find((candidate) => candidate.id === accountId);
        if (!account) return fail(new Error('Cuenta no encontrada.'));

        if (typeof data?.name === 'string' && data.name.trim()) {
          account.name = data.name.trim().slice(0, 80);
        }

        let urlChanged = false;
        if (typeof data?.url === 'string' && data.url.trim()) {
          const url = data.url.trim();
          if (!isValidServiceUrl(url, account.service)) return fail(new Error('URL no válida para este servicio.'));
          if (url !== account.url) {
            account.url = url;
            urlChanged = true;
          }
        }

        if (typeof data?.groupId === 'string') {
          const targetGroup = config.groups.find((candidate) => candidate.id === data.groupId);
          if (targetGroup && !targetGroup.accounts.includes(account.id)) {
            for (const group of config.groups) {
              group.accounts = group.accounts.filter((id) => id !== account.id);
            }
            targetGroup.accounts.push(account.id);
            if (config.activeAccount === account.id) config.activeGroup = targetGroup.id;
          }
        }

        saveConfig(config);
        viewManager?.updateConfig(config);
        if (urlChanged) viewManager?.reloadAccount(account.id);
        commitActiveSelection();
        return { ok: true as const };
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle('app:delete-account', async (_event, accountId: string) => {
    try {
      const account = config.accounts.find((candidate) => candidate.id === accountId);
      if (!account) return fail(new Error('Cuenta no encontrada.'));

      if (viewManager) await viewManager.deleteAccountSession(accountId);

      for (const group of config.groups) {
        group.accounts = group.accounts.filter((id) => id !== accountId);
      }
      config.accounts = config.accounts.filter((candidate) => candidate.id !== accountId);

      if (config.activeAccount === accountId) {
        const activeGroup = config.groups.find((group) => group.id === config.activeGroup);
        const next = activeGroup?.accounts[0] ?? config.accounts[0]?.id ?? '';
        config.activeAccount = next;
      }

      const owner = config.groups.find((group) => group.accounts.includes(config.activeAccount));
      if (owner) config.activeGroup = owner.id;
      else if (config.groups.length > 0) config.activeGroup = config.groups[0].id;

      commitActiveSelection();
      return { ok: true as const };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('app:reorder-accounts', (_event, groupId: string, accountIds: string[]) => {
    try {
      const group = config.groups.find((candidate) => candidate.id === groupId);
      if (!group) return fail(new Error('Grupo no encontrado.'));
      const known = group.accounts;
      const ordered = accountIds.filter((id) => known.includes(id));
      for (const id of known) if (!ordered.includes(id)) ordered.push(id);
      group.accounts = ordered;
      saveConfig(config);
      return { ok: true as const };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('app:reorder-groups', (_event, groupIds: string[]) => {
    try {
      const ordered: GroupConfig[] = [];
      for (const id of groupIds) {
        const group = config.groups.find((candidate) => candidate.id === id);
        if (group && !ordered.includes(group)) ordered.push(group);
      }
      for (const group of config.groups) if (!ordered.includes(group)) ordered.push(group);
      config.groups = ordered;
      saveConfig(config);
      return { ok: true as const };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'app:update-settings',
    (
      _event,
      data: { suspendAfterMinutes?: number; closeToTray?: boolean; shortcuts?: ShortcutsConfig }
    ) => {
      try {
        const minutes = Number(data?.suspendAfterMinutes);
        if (Number.isFinite(minutes)) {
          config.suspendAfterMinutes = Math.min(120, Math.max(1, Math.round(minutes)));
        }
        if (typeof data?.closeToTray === 'boolean') config.closeToTray = data.closeToTray;

        if (data?.shortcuts) {
          const validation = validateShortcuts(data.shortcuts);
          if (!validation.ok) return fail(new Error(validation.error));
          config.shortcuts = validation.value;
        }

        saveConfig(config);
        viewManager?.updateConfig(config);
        updateTray();
        return { ok: true as const, config };
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle('app:open-config', async () => {
    try {
      const file = configFile();
      if (!fs.existsSync(file)) saveConfig(config);
      const error = await shell.openPath(file);
      return error ? fail(new Error(error)) : { ok: true as const };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('app:reload-account', (_event, accountId: string) => {
    viewManager?.reloadAccount(accountId);
    return true;
  });

  // Used by the "Creado por" credit in Ajustes. Only http(s) is allowed.
  ipcMain.handle('app:open-external', async (_event, rawUrl: string) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      await shell.openExternal(url.href);
      return true;
    } catch {
      return false;
    }
  });

  // Notifications and title updates are forwarded by the account preload.
  // The sender's WebContents id is the source of truth for the account id.
  ipcMain.on('account:notification', (event, data: { title?: string; body?: string }) => {
    const accountId = viewManager?.getAccountIdByWebContentsId(event.sender.id);
    if (accountId) viewManager?.handleNotification(accountId, data ?? {});
    else log('[notif] ignored notification from unknown view', event.sender.id);
  });

  ipcMain.handle('app:get-info', () => {
    const themeInfo = loadOmarchyThemeInfo();
    return {
      version: app.getVersion(),
      configPath: configFile(),
      configDir: configDir(),
      userDataDir: app.getPath('userData'),
      downloadsDir: resolveDownloadsDir(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      themeName: themeInfo.name,
      themeSource: themeInfo.source
    };
  });

  ipcMain.handle('app:get-diagnostics', () => ({
    activeGroup: config.activeGroup,
    activeAccount: config.activeAccount,
    suspendAfterMinutes: config.suspendAfterMinutes,
    shortcuts: config.shortcuts,
    loadedAccounts: viewManager?.getLoadedAccounts() ?? [],
    suspendedAccounts: viewManager?.getSuspendedAccounts() ?? [],
    unreadCounts: viewManager?.getUnreadCounts() ?? {},
    views: viewManager?.getViewInfos() ?? [],
    trayAvailable,
    debug: DEBUG,
    processes: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name,
      memoryMB: Math.round((metric.memory?.workingSetSize ?? 0) / 1024)
    }))
  }));
}

// -----------------------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

app.whenReady().then(() => {
  logTiming('app-ready');
  Menu.setApplicationMenu(null);
  setupIpc();
  createWindow();
  setupTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  viewManager?.destroy();
  viewManager = null;
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (!config.closeToTray || !trayAvailable)) {
    app.quit();
  }
});
