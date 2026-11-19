import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, GroupConfig, AccountConfig } from '../main/config';
import type { ThemeColors } from '../main/theme';

export interface ActionResult {
  ok: boolean;
  error?: string;
  group?: GroupConfig;
  account?: AccountConfig;
  movedTo?: string;
  config?: AppConfig;
}

export interface RendererState {
  config: AppConfig;
  unreadCounts: Record<string, number>;
  suspendedAccounts: string[];
  activeGroup: string;
  activeAccount: string;
}

export interface AccountStatusPayload {
  accountId: string;
  state: 'loading' | 'ready' | 'error';
  message?: string;
}

export interface AppInfo {
  version: string;
  configPath: string;
  configDir: string;
  userDataDir: string;
  downloadsDir: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  themeName: string;
  themeSource: string;
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

export interface Diagnostics {
  activeGroup: string;
  activeAccount: string;
  suspendAfterMinutes: number;
  shortcuts: AppConfig['shortcuts'];
  loadedAccounts: string[];
  suspendedAccounts: string[];
  unreadCounts: Record<string, number>;
  views: ViewInfo[];
  trayAvailable: boolean;
  debug: boolean;
  processes: { pid: number; type: string; name?: string; memoryMB: number }[];
}

export interface MensajeriaAPI {
  getConfig: () => Promise<AppConfig>;
  rendererReady: () => Promise<RendererState>;
  getTheme: () => Promise<ThemeColors>;
  getInfo: () => Promise<AppInfo>;
  getDiagnostics: () => Promise<Diagnostics>;
  updateSettings: (settings: {
    suspendAfterMinutes?: number;
    closeToTray?: boolean;
    allowMicrophone?: boolean;
    allowCamera?: boolean;
    shortcuts?: AppConfig['shortcuts'];
  }) => Promise<ActionResult>;
  selectGroup: (groupId: string) => Promise<boolean>;
  selectAccount: (accountId: string) => Promise<boolean>;
  createGroup: (group: { name: string; color: string }) => Promise<ActionResult>;
  updateGroup: (groupId: string, group: { name?: string; color?: string }) => Promise<ActionResult>;
  deleteGroup: (groupId: string) => Promise<ActionResult>;
  createAccount: (account: {
    name: string;
    service: 'whatsapp' | 'telegram';
    url?: string;
    groupId?: string;
  }) => Promise<ActionResult>;
  updateAccount: (
    accountId: string,
    account: { name?: string; url?: string; groupId?: string }
  ) => Promise<ActionResult>;
  deleteAccount: (accountId: string) => Promise<ActionResult>;
  reorderAccounts: (groupId: string, accountIds: string[]) => Promise<ActionResult>;
  reorderGroups: (groupIds: string[]) => Promise<ActionResult>;
  setSidebarBounds: (width: number) => Promise<void>;
  setAccountViewVisible: (visible: boolean) => Promise<void>;
  openConfig: () => Promise<ActionResult>;
  openExternal: (url: string) => Promise<boolean>;
  reloadAccount: (accountId: string) => Promise<boolean>;
  onUnreadCounts: (callback: (counts: Record<string, number>) => void) => () => void;
  onActiveChanged: (callback: (data: { groupId: string; accountId: string }) => void) => () => void;
  onSuspendedAccounts: (callback: (accounts: string[]) => void) => () => void;
  onAccountStatus: (callback: (status: AccountStatusPayload) => void) => () => void;
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: MensajeriaAPI = {
  getConfig: () => ipcRenderer.invoke('app:get-config'),
  rendererReady: () => ipcRenderer.invoke('app:renderer-ready'),
  getTheme: () => ipcRenderer.invoke('app:get-theme'),
  getInfo: () => ipcRenderer.invoke('app:get-info'),
  getDiagnostics: () => ipcRenderer.invoke('app:get-diagnostics'),

  updateSettings: (settings) => ipcRenderer.invoke('app:update-settings', settings),
  selectGroup: (groupId) => ipcRenderer.invoke('app:select-group', groupId),
  selectAccount: (accountId) => ipcRenderer.invoke('app:select-account', accountId),
  createGroup: (group) => ipcRenderer.invoke('app:create-group', group),
  updateGroup: (groupId, group) => ipcRenderer.invoke('app:update-group', groupId, group),
  deleteGroup: (groupId) => ipcRenderer.invoke('app:delete-group', groupId),
  createAccount: (account) => ipcRenderer.invoke('app:create-account', account),
  updateAccount: (accountId, account) => ipcRenderer.invoke('app:update-account', accountId, account),
  deleteAccount: (accountId) => ipcRenderer.invoke('app:delete-account', accountId),
  reorderAccounts: (groupId, accountIds) => ipcRenderer.invoke('app:reorder-accounts', groupId, accountIds),
  reorderGroups: (groupIds) => ipcRenderer.invoke('app:reorder-groups', groupIds),

  setSidebarBounds: (width) => ipcRenderer.invoke('app:set-sidebar-bounds', width),
  setAccountViewVisible: (visible) => ipcRenderer.invoke('app:set-account-view-visible', visible),
  openConfig: () => ipcRenderer.invoke('app:open-config'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  reloadAccount: (accountId) => ipcRenderer.invoke('app:reload-account', accountId),

  onUnreadCounts: (callback) => subscribe('app:unread-counts', callback),
  onActiveChanged: (callback) => subscribe('app:active-changed', callback),
  onSuspendedAccounts: (callback) => subscribe('app:suspended-accounts', callback),
  onAccountStatus: (callback) => subscribe('app:account-status', callback)
};

contextBridge.exposeInMainWorld('api', api);
