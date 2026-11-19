import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  Notification,
  session,
  shell,
  WebContentsView
} from 'electron';
import fs from 'fs';
import path from 'path';
import type { AppConfig, AccountConfig, Service } from './config';
import { resolveDownloadsDir } from './paths';

const DEBUG = process.env.MENSAJERIA_HUB_DEBUG === '1';
const SUPPRESS_EXTERNAL_OPEN = process.env.MENSAJERIA_HUB_SUPPRESS_EXTERNAL_OPEN === '1';

// Modern Chrome UA so WhatsApp Web does not show the "unsupported browser"
// screen. Electron's default UA contains "Electron/" which some services block.
const USER_AGENT =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`;

const SERVICE_ORIGINS: Record<Service, Set<string>> = {
  whatsapp: new Set(['https://web.whatsapp.com']),
  telegram: new Set(['https://web.telegram.org'])
};

export interface ViewStatus {
  accountId: string;
  state: 'loading' | 'ready' | 'error';
  message?: string;
}

export interface ViewInfo {
  accountId: string;
  url: string;
  title: string;
  partition: string;
  contextIsolation: boolean;
  sandbox: boolean;
  nodeIntegration: boolean;
}

export interface ViewManagerCallbacks {
  onUnreadChange?: (counts: Record<string, number>) => void;
  onSuspendedChange?: (accounts: string[]) => void;
  /** Return `true` when the shortcut was handled (the page must not see it). */
  onShortcutInput?: (input: Electron.Input) => boolean;
  onNotificationClick?: (accountId: string) => void;
  onStatus?: (status: ViewStatus) => void;
  onExternalOpen?: (url: string) => void;
  /** Return true when a WhatsApp/Telegram deep link was routed inside the app. */
  onDeepLink?: (url: string, sourceAccountId: string) => boolean;
}

export interface ViewManagerOptions {
  iconPath?: string;
}

interface ManagedView {
  accountId: string;
  view: WebContentsView;
  lastActive: number;
  suspendTimer: NodeJS.Timeout | null;
  attached: boolean;
}

function log(...args: unknown[]): void {
  if (DEBUG) console.log('[mh]', ...args);
}

export function partitionFor(accountId: string): string {
  return `persist:${accountId}`;
}

function isServiceUrl(raw: string, service: Service): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && SERVICE_ORIGINS[service].has(parsed.origin);
  } catch {
    return false;
  }
}

export class ViewManager {
  private views = new Map<string, ManagedView>();
  private activeAccountId: string | null = null;
  private sidebarWidth = 280;
  private uiHidden = false;
  private unreadCounts = new Map<string, number>();
  private statusByAccount = new Map<string, string>();
  private lastSuspendedKey = '';
  private initializedSessions = new Set<string>();

  constructor(
    private mainWindow: BrowserWindow,
    private config: AppConfig,
    private callbacks: ViewManagerCallbacks = {},
    private options: ViewManagerOptions = {}
  ) {}

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  public setSidebarWidth(width: number): void {
    this.sidebarWidth = Math.max(200, Math.min(520, Math.round(width) || 280));
    this.updateActiveViewBounds();
  }

  public updateActiveViewBounds(): void {
    if (!this.activeAccountId) return;
    const managed = this.views.get(this.activeAccountId);
    if (!managed || !managed.attached) return;

    const [winWidth, winHeight] = this.mainWindow.getContentSize();
    managed.view.setBounds({
      x: this.sidebarWidth,
      y: 0,
      width: Math.max(1, winWidth - this.sidebarWidth),
      height: Math.max(1, winHeight)
    });
  }

  /**
   * Modals live in the UI renderer, but WebContentsView is always painted on
   * top of it. Hide the active view while a dialog is open so dialogs are
   * never covered by the chat page.
   */
  public setUiHidden(hidden: boolean): void {
    this.uiHidden = hidden;
    if (!this.activeAccountId) return;
    const managed = this.views.get(this.activeAccountId);
    if (!managed) return;
    managed.view.setVisible(!hidden);
    if (!hidden) {
      this.updateActiveViewBounds();
      managed.view.webContents.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Activation / suspension
  // ---------------------------------------------------------------------------

  public activateAccount(accountId: string): boolean {
    const account = this.config.accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      this.clearActive();
      return false;
    }

    const startedAt = performance.now();
    const previous = this.activeAccountId;

    let managed = this.views.get(accountId);
    const created = !managed;
    if (!managed) {
      managed = this.createView(account);
      this.views.set(accountId, managed);
    }

    if (managed.suspendTimer) {
      clearTimeout(managed.suspendTimer);
      managed.suspendTimer = null;
    }

    managed.lastActive = Date.now();
    // Update the active id *before* scheduling the previous account: the
    // scheduler refuses to arm a timer for the active account.
    this.activeAccountId = accountId;

    if (previous && previous !== accountId) {
      const previousView = this.views.get(previous);
      if (previousView) {
        previousView.view.setVisible(false);
        this.scheduleSuspend(previous);
      }
    }

    this.attachView(managed);
    managed.view.setVisible(!this.uiHidden);
    this.updateActiveViewBounds();
    managed.view.webContents.focus();

    // Different group: notify the sidebar so the account list can re-render.
    if (previous !== accountId) this.notifySuspended();
    log(
      `[timing] activate ${accountId} created=${created} ` +
        `${(performance.now() - startedAt).toFixed(1)}ms`
    );
    return true;
  }

  public clearActive(): void {
    const previous = this.activeAccountId;
    this.activeAccountId = null;
    if (previous) {
      const managed = this.views.get(previous);
      if (managed) {
        managed.view.setVisible(false);
        this.scheduleSuspend(previous);
      }
    }
    this.notifySuspended();
  }

  public suspendAccount(accountId: string): void {
    if (accountId === this.activeAccountId) {
      log(`[suspend] skipped ${accountId} (active)`);
      return;
    }
    const managed = this.views.get(accountId);
    if (!managed) return;

    this.clearSuspendTimer(managed);
    this.detachView(managed);
    try {
      // Closing the WebContents releases the renderer process while the
      // partition (cookies, IndexedDB, cache) stays on disk.
      managed.view.webContents.close({ waitForBeforeUnload: false });
    } catch (err) {
      log(`[suspend] close failed for ${accountId}:`, err);
    }

    this.views.delete(accountId);
    this.statusByAccount.delete(accountId);
    this.notifySuspended();
    log(`[suspend] ${accountId} closed (session kept on disk)`);
  }

  private scheduleSuspend(accountId: string): void {
    const managed = this.views.get(accountId);
    if (!managed || accountId === this.activeAccountId) return;
    this.clearSuspendTimer(managed);

    const minutes = Math.max(0.1, Number(this.config.suspendAfterMinutes) || 10);
    managed.suspendTimer = setTimeout(() => {
      const current = this.views.get(accountId);
      if (current) current.suspendTimer = null;
      log(`[suspend] timer fired for ${accountId}`);
      this.suspendAccount(accountId);
    }, minutes * 60_000);
    log(`[suspend] ${accountId} scheduled in ${minutes} min`);
  }

  private clearSuspendTimer(managed: ManagedView): void {
    if (managed.suspendTimer) {
      clearTimeout(managed.suspendTimer);
      managed.suspendTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Views / sessions
  // ---------------------------------------------------------------------------

  private createView(account: AccountConfig): ManagedView {
    const partition = partitionFor(account.id);
    this.ensureSession(account);

    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, '../preload/account.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
        backgroundThrottling: true
      }
    });

    const contents = view.webContents;
    contents.setUserAgent(USER_AGENT);

    const handleNavigation = (event: Electron.Event, rawUrl: string): void => {
      if (!rawUrl) return;
      if (isServiceUrl(rawUrl, account.service)) return;
      event.preventDefault();
      if (this.callbacks.onDeepLink?.(rawUrl, account.id)) return;
      this.openExternal(rawUrl);
    };

    contents.on('will-navigate', (details, url) => {
      handleNavigation(details, (details as unknown as { url?: string }).url ?? url);
    });
    contents.on('will-redirect', (details, url) => {
      handleNavigation(details, (details as unknown as { url?: string }).url ?? url);
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (this.callbacks.onDeepLink?.(url, account.id)) {
        return { action: 'deny' };
      }
      this.openExternal(url);
      return { action: 'deny' };
    });

    contents.on('page-title-updated', (_event, title) => {
      this.handleTitleUpdated(account.id, title);
    });

    contents.on('before-input-event', (event, input) => {
      if (this.callbacks.onShortcutInput?.(input)) event.preventDefault();
    });

    contents.on('did-start-loading', () => this.emitStatus(account.id, 'loading'));
    contents.on('did-finish-load', () => this.emitStatus(account.id, 'ready'));
    contents.on('did-stop-loading', () => this.emitStatus(account.id, 'ready'));
    contents.on('dom-ready', () => this.emitStatus(account.id, 'ready'));

    contents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      // -3 = ERR_ABORTED, normal when the user changes page quickly.
      if (!isMainFrame || errorCode === -3) return;
      this.emitStatus(account.id, 'error', errorDescription || `Error ${errorCode}`);
    });

    contents.on('render-process-gone', (_event, details) => {
      log(`[crash] ${account.id}: ${details.reason}`);
      this.handleViewGone(account.id, details.reason);
    });

    contents.on('context-menu', (_event, params) => this.showContextMenu(params));
    contents.on('will-attach-webview', (event) => event.preventDefault());

    contents.loadURL(account.url).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // Deep-link routing can supersede this initial load; that is not an error.
      if (/ERR_ABORTED|\(-3\)/.test(message)) return;
      this.emitStatus(account.id, 'error', message);
      log(`[load] ${account.id} failed:`, message);
    });

    log(`[view] created ${account.id} (${partition})`);
    return {
      accountId: account.id,
      view,
      lastActive: Date.now(),
      suspendTimer: null,
      attached: false
    };
  }

  private ensureSession(account: AccountConfig): Electron.Session {
    const partition = partitionFor(account.id);
    const accountSession = session.fromPartition(partition);
    if (this.initializedSessions.has(partition)) return accountSession;
    this.initializedSessions.add(partition);

    accountSession.setUserAgent(USER_AGENT, 'es-ES,es;q=0.9,en;q=0.8');

    // WhatsApp/Telegram calls need microphone/camera. Electron has no browser
    // permission UI, so grants are automatic for the official service origin
    // only; everything else (geolocation, MIDI, USB...) stays denied. The
    // microphone/camera toggles in Ajustes are checked on every request.
    accountSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (!isServiceUrl(webContents.getURL(), account.service)) {
        callback(false);
        return;
      }
      if (permission === 'notifications' || permission === 'fullscreen') {
        callback(true);
        return;
      }
      if (permission === 'media') {
        const mediaTypes =
          (details as unknown as { mediaTypes?: string[] } | undefined)?.mediaTypes ?? [];
        const wantsAudio = mediaTypes.includes('audio');
        const wantsVideo = mediaTypes.includes('video');
        if (mediaTypes.length === 0) {
          callback(this.config.allowMicrophone && this.config.allowCamera);
          return;
        }
        callback(
          (!wantsAudio || this.config.allowMicrophone) &&
            (!wantsVideo || this.config.allowCamera)
        );
        return;
      }
      callback(false);
    });

    accountSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (permission === 'media') {
        // Electron may call this check with a null webContents; the request
        // handler above already validated the origin of the calling view.
        return this.config.allowMicrophone || this.config.allowCamera;
      }
      if (permission !== 'notifications' && permission !== 'fullscreen') return false;
      try {
        const origin = requestingOrigin || webContents?.getURL() || '';
        return isServiceUrl(origin, account.service);
      } catch {
        return false;
      }
    });

    accountSession.on('will-download', (_event, item) => {
      this.handleDownload(account, item);
    });

    return accountSession;
  }

  // ---------------------------------------------------------------------------
  // Notifications, unread title and downloads
  // ---------------------------------------------------------------------------

  public handleTitleUpdated(accountId: string, title: string): void {
    // WhatsApp: "(3) WhatsApp" · Telegram: "(3) Telegram" / "Telegram (3)".
    const match = title.match(/\((\d+)\+?\)/);
    const unread = match ? Math.min(parseInt(match[1], 10) || 0, 9999) : 0;
    if ((this.unreadCounts.get(accountId) ?? 0) === unread) return;

    this.unreadCounts.set(accountId, unread);
    this.callbacks.onUnreadChange?.(this.getUnreadCounts());
    log(`[unread] ${accountId}=${unread}`);
  }

  public handleNotification(accountId: string, data: { title?: string; body?: string }): void {
    const account = this.config.accounts.find((candidate) => candidate.id === accountId);
    if (!account) return;

    const title = String(data?.title ?? 'Nuevo mensaje')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Nuevo mensaje';
    const body = String(data?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    log(`[notif] ${accountId} :: ${title} :: ${body}`);

    try {
      const notification = new Notification({
        title: `${account.name}: ${title}`,
        body,
        icon: this.options.iconPath,
        silent: false
      });
      notification.on('click', () => this.callbacks.onNotificationClick?.(accountId));
      notification.show();
    } catch (err) {
      console.error('[notif] could not show notification:', err);
    }
  }

  private handleDownload(account: AccountConfig, item: Electron.DownloadItem): void {
    try {
      const downloadsDir = this.downloadsDir();
      fs.mkdirSync(downloadsDir, { recursive: true });

      const original = path.basename(item.getFilename() || 'descarga').replace(/[\\/:*?"<>|]/g, '_');
      const safeName = original || 'descarga';
      const ext = path.extname(safeName);
      const base = path.basename(safeName, ext);

      let target = path.join(downloadsDir, safeName);
      let counter = 1;
      while (fs.existsSync(target)) {
        target = path.join(downloadsDir, `${base} (${counter++})${ext}`);
      }
      item.setSavePath(target);

      item.once('done', (_event, state) => {
        if (state === 'completed') {
          this.showSimpleNotification('Descarga completada', `${account.name}: ${path.basename(target)}`);
          log(`[download] completed ${target}`);
        } else if (state === 'interrupted') {
          this.showSimpleNotification('Descarga interrumpida', `${account.name}: ${item.getFilename()}`);
          log(`[download] interrupted ${item.getFilename()}`);
        }
      });
    } catch (err) {
      console.error('[download] could not prepare download:', err);
    }
  }

  private downloadsDir(): string {
    return resolveDownloadsDir();
  }

  private showSimpleNotification(title: string, body: string): void {
    try {
      new Notification({ title, body, icon: this.options.iconPath }).show();
    } catch (err) {
      console.error('[notif] could not show notification:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  private openExternal(rawUrl: string): void {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        log(`[external] blocked non-http url: ${rawUrl}`);
        return;
      }
      log(`[external] ${parsed.href}`);
      this.callbacks.onExternalOpen?.(parsed.href);
      // Test-only escape hatch: keeps automated checks from opening browser tabs.
      if (!SUPPRESS_EXTERNAL_OPEN) void shell.openExternal(parsed.href);
    } catch {
      log(`[external] invalid url: ${rawUrl}`);
    }
  }

  private showContextMenu(params: Electron.ContextMenuParams): void {
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      template.push(
        { role: 'undo', label: 'Deshacer' },
        { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { type: 'separator' },
        { role: 'selectAll', label: 'Seleccionar todo' }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy', label: 'Copiar' });
    }

    if (params.linkURL) {
      if (template.length > 0) template.push({ type: 'separator' });
      template.push(
        {
          label: 'Abrir enlace en el navegador',
          click: () => this.openExternal(params.linkURL)
        },
        {
          label: 'Copiar enlace',
          click: () => clipboard.writeText(params.linkURL)
        }
      );
    }

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: this.mainWindow });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle / diagnostics
  // ---------------------------------------------------------------------------

  private attachView(managed: ManagedView): void {
    if (managed.attached) return;
    try {
      this.mainWindow.contentView.addChildView(managed.view);
      managed.attached = true;
    } catch (err) {
      log(`[view] attach failed for ${managed.accountId}:`, err);
    }
  }

  private detachView(managed: ManagedView): void {
    if (!managed.attached) return;
    try {
      this.mainWindow.contentView.removeChildView(managed.view);
    } catch {
      // Window may already be destroyed.
    }
    managed.attached = false;
  }

  private handleViewGone(accountId: string, reason: string): void {
    const managed = this.views.get(accountId);
    if (!managed) return;
    this.clearSuspendTimer(managed);
    this.detachView(managed);
    this.views.delete(accountId);
    if (this.activeAccountId === accountId) this.activeAccountId = null;
    this.emitStatus(accountId, 'error', `La vista se cerró (${reason})`);
    this.notifySuspended();
  }

  public reloadAccount(accountId: string): void {
    const account = this.config.accounts.find((candidate) => candidate.id === accountId);
    const managed = this.views.get(accountId);
    if (!account || !managed) return;
    managed.view.webContents.loadURL(account.url).catch((err: unknown) => {
      log(`[reload] ${accountId} failed:`, err);
    });
  }

  /**
   * Opens a deep link inside the view of the right account. If that account is
   * suspended, it is activated/recreated first; the session is reused.
   */
  public openInAccount(accountId: string, url: string): boolean {
    const account = this.config.accounts.find((candidate) => candidate.id === accountId);
    if (!account) return false;

    if (this.activeAccountId !== accountId) {
      if (!this.activateAccount(accountId)) return false;
    }

    const managed = this.views.get(accountId);
    if (!managed) return false;

    managed.view.webContents.loadURL(url).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/ERR_ABORTED|\(-3\)/.test(message)) return;
      log(`[deep-link] ${accountId} failed to load ${url}:`, message);
    });
    log(`[deep-link] ${accountId} <- ${url}`);
    return true;
  }

  public updateConfig(newConfig: AppConfig): void {
    const previousMinutes = this.config.suspendAfterMinutes;
    this.config = newConfig;
    if (previousMinutes !== newConfig.suspendAfterMinutes) {
      for (const accountId of this.views.keys()) {
        if (accountId !== this.activeAccountId) this.scheduleSuspend(accountId);
      }
    }
  }

  public async deleteAccountSession(accountId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) {
      // Refuse path traversal via hand-edited config.
      console.error(`[delete] invalid account id: ${accountId}`);
      return;
    }

    const managed = this.views.get(accountId);
    if (managed) {
      this.clearSuspendTimer(managed);
      this.detachView(managed);
      try {
        managed.view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Already closed.
      }
      this.views.delete(accountId);
    }
    if (this.activeAccountId === accountId) this.activeAccountId = null;

    this.unreadCounts.delete(accountId);
    this.statusByAccount.delete(accountId);
    this.callbacks.onUnreadChange?.(this.getUnreadCounts());
    this.notifySuspended();

    const accountSession = session.fromPartition(partitionFor(accountId));
    try {
      await accountSession.clearStorageData();
      await accountSession.clearCache();
    } catch (err) {
      console.error(`[delete] could not clear session for ${accountId}:`, err);
    }

    // clearStorageData() empties the partition but leaves its folder behind.
    // Removing it makes "delete account" really delete the on-disk session.
    const partitionDir = path.join(app.getPath('userData'), 'Partitions', accountId);
    try {
      fs.rmSync(partitionDir, { recursive: true, force: true });
      log(`[delete] removed session dir ${partitionDir}`);
    } catch (err) {
      console.error(`[delete] could not remove ${partitionDir}:`, err);
    }
  }

  public getUnreadCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [accountId, count] of this.unreadCounts) counts[accountId] = count;
    return counts;
  }

  public getLoadedAccounts(): string[] {
    return [...this.views.keys()];
  }

  /**
   * Resolve which account owns a WebContents (used to attach notifications to
   * the right account without trusting the payload sent by the page).
   */
  public getAccountIdByWebContentsId(webContentsId: number): string | null {
    for (const [accountId, managed] of this.views) {
      if (managed.view.webContents.id === webContentsId) return accountId;
    }
    return null;
  }

  public getSuspendedAccounts(): string[] {
    return this.config.accounts.filter((account) => !this.views.has(account.id)).map((account) => account.id);
  }

  public getViewInfos(): ViewInfo[] {
    return [...this.views.values()].map((managed) => {
      const contents = managed.view.webContents;
      const prefs =
        (
          contents as unknown as {
            getLastWebPreferences?: () => Electron.WebPreferences;
          }
        ).getLastWebPreferences?.() ?? {};
      return {
        accountId: managed.accountId,
        url: contents.getURL(),
        title: contents.getTitle(),
        partition: partitionFor(managed.accountId),
        contextIsolation: prefs.contextIsolation !== false,
        sandbox: prefs.sandbox !== false,
        nodeIntegration: prefs.nodeIntegration === true
      };
    });
  }

  private notifySuspended(): void {
    const suspended = this.getSuspendedAccounts();
    const key = suspended.join(',');
    if (key === this.lastSuspendedKey) return;
    this.lastSuspendedKey = key;
    this.callbacks.onSuspendedChange?.(suspended);
  }

  private emitStatus(accountId: string, state: ViewStatus['state'], message?: string): void {
    const key = `${state}:${message ?? ''}`;
    if (this.statusByAccount.get(accountId) === key) return;
    this.statusByAccount.set(accountId, key);
    log(`[status] ${accountId} ${state}${message ? ` (${message})` : ''}`);
    this.callbacks.onStatus?.({ accountId, state, message });
  }

  public destroy(): void {
    for (const managed of this.views.values()) {
      this.clearSuspendTimer(managed);
      this.detachView(managed);
      try {
        managed.view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // Already closed.
      }
    }
    this.views.clear();
    this.activeAccountId = null;
  }

  /** Used by diagnostics/tests to inspect which account owns the visible view. */
  public getActiveAccountId(): string | null {
    return this.activeAccountId;
  }
}
