import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ThemeColors {
  background: string;
  darkerBackground: string;
  lighterBackground: string;
  foreground: string;
  muted: string;
  accent: string;
  selection: string;
  border: string;
}

export interface ThemeInfo extends ThemeColors {
  source: string;
  name: string;
}

const DEFAULT_THEME: ThemeColors = {
  background: '#0d0f12',
  darkerBackground: '#07080a',
  lighterBackground: '#171a21',
  foreground: '#e6edf3',
  muted: '#8b949e',
  accent: '#58a6ff',
  selection: '#21262d',
  border: '#30363d'
};

function home(): string {
  return os.homedir();
}

function stateHome(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return xdg;
  return path.join(home(), '.local', 'state');
}

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return xdg;
  return path.join(home(), '.config');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Omarchy 4 keeps the applied theme under `$XDG_STATE_HOME/omarchy/current`
 * (the old `~/.config/omarchy/current` path is only used by older versions).
 */
function themeCandidates(): string[] {
  const candidates: string[] = [];
  const stateTheme = path.join(stateHome(), 'omarchy', 'current', 'theme');
  candidates.push(path.join(stateTheme, 'colors.toml'));
  candidates.push(stateTheme);

  const legacyTheme = path.join(configHome(), 'omarchy', 'current', 'theme');
  candidates.push(path.join(legacyTheme, 'colors.toml'));
  candidates.push(legacyTheme);

  // Explicit theme name from Omarchy, resolved in user and system theme dirs.
  const name = readText(path.join(stateHome(), 'omarchy', 'current', 'theme.name')).trim();
  if (name) {
    const slug = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    for (const base of [path.join(configHome(), 'omarchy', 'themes'), '/usr/share/omarchy/themes']) {
      for (const key of [name, slug]) {
        const dir = path.join(base, key);
        candidates.push(path.join(dir, 'colors.toml'));
      }
    }
  }

  // Last-resort user themes that were materialized without `current`.
  candidates.push(path.join(configHome(), 'omarchy', 'themes', 'dark-carbon', 'colors.toml'));
  candidates.push(path.join(configHome(), 'omarchy', 'themes', 'dark-madmasx', 'colors.toml'));
  return candidates;
}

function parseColorFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/);
    if (!match) continue;
    result[match[1]] = (match[2] ?? match[3] ?? match[4] ?? '').trim();
  }
  return result;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function color(parsed: Record<string, string>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === 'string' && HEX.test(value)) return value;
  }
  return fallback;
}

function themeFrom(parsed: Record<string, string>, source: string, name: string): ThemeInfo {
  return {
    background: color(parsed, ['background'], DEFAULT_THEME.background),
    darkerBackground: color(
      parsed,
      ['darker_background', 'dark_background', 'background'],
      DEFAULT_THEME.darkerBackground
    ),
    lighterBackground: color(parsed, ['lighter_background', 'selection', 'background'], DEFAULT_THEME.lighterBackground),
    foreground: color(parsed, ['foreground', 'light_foreground', 'bright_foreground'], DEFAULT_THEME.foreground),
    muted: color(parsed, ['muted', 'dark_foreground', 'color8'], DEFAULT_THEME.muted),
    accent: color(parsed, ['accent', 'bright_blue', 'blue'], DEFAULT_THEME.accent),
    selection: color(parsed, ['selection', 'lighter_background'], DEFAULT_THEME.selection),
    border: color(parsed, ['selection', 'lighter_background'], DEFAULT_THEME.border),
    source,
    name
  };
}

function defaultThemeInfo(): ThemeInfo {
  return { ...DEFAULT_THEME, source: 'built-in', name: 'default-dark' };
}

/**
 * Reads the currently applied Omarchy colors. Synchronous on purpose: it runs
 * once before the window is created, so there is no flash of default colors.
 */
export function loadOmarchyThemeInfo(): ThemeInfo {
  for (const candidate of themeCandidates()) {
    if (!isFile(candidate)) continue;
    const parsed = parseColorFile(readText(candidate));
    if (Object.keys(parsed).length === 0) continue;

    let name = readText(path.join(stateHome(), 'omarchy', 'current', 'theme.name')).trim();
    if (!name) {
      const dir = path.dirname(candidate);
      name = path.basename(dir === 'theme' ? path.dirname(dir) : dir);
    }
    return themeFrom(parsed, candidate, name || 'omarchy');
  }
  return defaultThemeInfo();
}

export function loadOmarchyTheme(): ThemeColors {
  const { source: _source, name: _name, ...colors } = loadOmarchyThemeInfo();
  return colors;
}
