import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { DEFAULT_SHORTCUTS, sanitizeShortcuts, type ShortcutsConfig } from './shortcuts';

export type { ShortcutsConfig } from './shortcuts';

export type Service = 'whatsapp' | 'telegram';

export interface AccountConfig {
  id: string;
  name: string;
  service: Service;
  url: string;
}

export interface GroupConfig {
  id: string;
  name: string;
  color: string;
  accounts: string[];
}

export interface AppConfig {
  groups: GroupConfig[];
  accounts: AccountConfig[];
  activeGroup: string;
  activeAccount: string;
  suspendAfterMinutes: number;
  closeToTray: boolean;
  allowMicrophone: boolean;
  allowCamera: boolean;
  shortcuts: ShortcutsConfig;
}

export const SERVICE_URLS: Record<Service, string> = {
  whatsapp: 'https://web.whatsapp.com',
  telegram: 'https://web.telegram.org/k/'
};

/** Only the official web clients are allowed to load inside the app. */
const SERVICE_ORIGINS: Record<Service, string[]> = {
  whatsapp: ['https://web.whatsapp.com'],
  telegram: ['https://web.telegram.org']
};

export const DEFAULT_CONFIG: AppConfig = {
  groups: [
    {
      id: 'trabajo',
      name: 'Trabajo',
      color: '#3b82f6',
      accounts: ['wa-trabajo']
    },
    {
      id: 'personal',
      name: 'Personal',
      color: '#10b981',
      accounts: ['wa-personal']
    }
  ],
  accounts: [
    {
      id: 'wa-trabajo',
      name: 'WhatsApp Trabajo',
      service: 'whatsapp',
      url: SERVICE_URLS.whatsapp
    },
    {
      id: 'wa-personal',
      name: 'WhatsApp Personal',
      service: 'whatsapp',
      url: SERVICE_URLS.whatsapp
    }
  ],
  activeGroup: 'trabajo',
  activeAccount: 'wa-trabajo',
  suspendAfterMinutes: 10,
  closeToTray: true,
  allowMicrophone: true,
  allowCamera: true,
  shortcuts: { ...DEFAULT_SHORTCUTS }
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_NAME = 80;

/**
 * Account/group ids become session partition names and on-disk folder names
 * (`<userData>/Partitions/<id>`), so they must never contain path separators.
 */
export function sanitizeId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function newAccountId(): string {
  return `acc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function newGroupId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${slug || 'group'}_${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

export function isValidServiceUrl(raw: string, service: Service): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && SERVICE_ORIGINS[service].includes(parsed.origin);
  } catch {
    return false;
  }
}

export function configDir(): string {
  const override = process.env.MENSAJERIA_HUB_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);

  if (process.platform === 'win32') {
    // Matches Electron's userData folder on Windows, so config and session
    // partitions live together under %APPDATA%\mensajeria-hub.
    const appData = process.env.APPDATA?.trim();
    return appData
      ? path.join(appData, 'mensajeria-hub')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'mensajeria-hub');
  }

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, 'mensajeria-hub');
  return path.join(os.homedir(), '.config', 'mensajeria-hub');
}

export function configFile(): string {
  return path.join(configDir(), 'config.json');
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Repairs anything that would make the app crash or lose access to a session:
 * invalid ids, dangling account references, duplicated account/group ids,
 * out-of-range settings and missing shortcut values.
 */
export function normalizeConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  const src = raw as Record<string, unknown>;
  const hasAccounts = Array.isArray(src.accounts);
  const hasGroups = Array.isArray(src.groups);
  // A freshly created or hand-written empty config is valid: keep it empty
  // instead of resurrecting the demo accounts.
  if (!hasAccounts && !hasGroups) return structuredClone(DEFAULT_CONFIG);

  const accounts: AccountConfig[] = [];
  const accountIds = new Set<string>();

  for (const candidate of hasAccounts ? (src.accounts as unknown[]) : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const acc = candidate as Record<string, unknown>;
    const id = sanitizeId(acc.id);
    if (!id || accountIds.has(id)) continue;

    const service: Service = acc.service === 'telegram' ? 'telegram' : 'whatsapp';
    const name =
      asString(acc.name).trim().slice(0, MAX_NAME) || (service === 'whatsapp' ? 'WhatsApp' : 'Telegram');
    const url =
      typeof acc.url === 'string' && isValidServiceUrl(acc.url, service) ? acc.url : SERVICE_URLS[service];

    accounts.push({ id, name, service, url });
    accountIds.add(id);
  }

  const groups: GroupConfig[] = [];
  const groupIds = new Set<string>();
  const placedAccounts = new Set<string>();

  for (const candidate of hasGroups ? (src.groups as unknown[]) : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const group = candidate as Record<string, unknown>;

    let id = sanitizeId(group.id);
    if (!id) id = newGroupId(asString(group.name));
    while (groupIds.has(id)) id = `${id.slice(0, 56)}_${randomUUID().replace(/-/g, '').slice(0, 4)}`;
    groupIds.add(id);

    const name = asString(group.name).trim().slice(0, 60) || 'Grupo';
    const color = typeof group.color === 'string' && COLOR_PATTERN.test(group.color) ? group.color : '#3b82f6';

    const groupAccounts: string[] = [];
    if (Array.isArray(group.accounts)) {
      for (const rawId of group.accounts) {
        const accountId = sanitizeId(rawId);
        if (!accountId || !accountIds.has(accountId)) continue;
        // An account must belong to exactly one group: its session/partition is
        // unique, so showing it twice would mean two views sharing a session.
        if (placedAccounts.has(accountId) || groupAccounts.includes(accountId)) continue;
        groupAccounts.push(accountId);
        placedAccounts.add(accountId);
      }
    }

    groups.push({ id, name, color, accounts: groupAccounts });
  }

  // Accounts that lost their group (hand-edited config, interrupted migration).
  const orphans = accounts.filter((account) => !placedAccounts.has(account.id)).map((account) => account.id);
  if (orphans.length > 0) {
    let target = groups[0];
    if (!target) {
      target = { id: 'general', name: 'General', color: '#3b82f6', accounts: [] };
      groups.push(target);
    }
    target.accounts.push(...orphans);
    for (const id of orphans) placedAccounts.add(id);
  }

  const requestedGroup = sanitizeId(src.activeGroup);
  let activeGroup = groups.find((group) => group.id === requestedGroup)?.id ?? groups[0]?.id ?? '';

  const requestedAccount = sanitizeId(src.activeAccount);
  let activeAccount = accounts.find((account) => account.id === requestedAccount)?.id ?? '';

  const activeGroupObj = groups.find((group) => group.id === activeGroup);
  if (activeGroupObj) {
    if (!activeGroupObj.accounts.includes(activeAccount)) {
      activeAccount = activeGroupObj.accounts[0] ?? '';
    }
  } else {
    activeGroup = '';
    activeAccount = '';
  }

  // If the group is empty but an account exists elsewhere, keep the user on a
  // group that actually shows something.
  if (!activeAccount && accounts.length > 0) {
    activeAccount = accounts[0]?.id ?? '';
    const owner = groups.find((group) => group.accounts.includes(activeAccount));
    if (owner) activeGroup = owner.id;
  }

  const rawSuspend = Number(src.suspendAfterMinutes);
  const suspendAfterMinutes =
    Number.isFinite(rawSuspend) && rawSuspend >= 0.1
      ? Math.min(rawSuspend, 24 * 60)
      : DEFAULT_CONFIG.suspendAfterMinutes;

  const rawShortcuts =
    src.shortcuts && typeof src.shortcuts === 'object' && !Array.isArray(src.shortcuts)
      ? (src.shortcuts as Partial<ShortcutsConfig>)
      : undefined;

  return {
    groups,
    accounts,
    activeGroup,
    activeAccount,
    suspendAfterMinutes,
    closeToTray: typeof src.closeToTray === 'boolean' ? src.closeToTray : DEFAULT_CONFIG.closeToTray,
    allowMicrophone:
      typeof src.allowMicrophone === 'boolean' ? src.allowMicrophone : DEFAULT_CONFIG.allowMicrophone,
    allowCamera: typeof src.allowCamera === 'boolean' ? src.allowCamera : DEFAULT_CONFIG.allowCamera,
    shortcuts: sanitizeShortcuts(rawShortcuts)
  };
}

function backupCorruptConfig(file: string): void {
  try {
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.copyFileSync(file, backup);
    console.error(`[config] Corrupt config backed up to ${backup}`);
  } catch (err) {
    console.error('[config] Could not back up corrupt config:', err);
  }
}

export function loadConfig(): AppConfig {
  const file = configFile();
  try {
    fs.mkdirSync(configDir(), { recursive: true });

    if (fs.existsSync(file)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const normalized = normalizeConfig(parsed);
      // Persist migrations/repairs so the next start sees the canonical file.
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        saveConfig(normalized);
      }
      return normalized;
    }
  } catch (err) {
    console.error('[config] Error loading config:', err);
    if (fs.existsSync(file)) backupCorruptConfig(file);
  }

  const defaults = structuredClone(DEFAULT_CONFIG);
  saveConfig(defaults);
  return defaults;
}

export function saveConfig(config: AppConfig): void {
  const dir = configDir();
  const file = path.join(dir, 'config.json');
  const tempFile = path.join(dir, `config.json.tmp-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    // Atomic rename: a crash or power loss never leaves a truncated config.
    fs.renameSync(tempFile, file);
  } catch (err) {
    console.error('[config] Error saving config:', err);
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}
