import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Download folder: `~/Descargas` when it exists (Spanish Omarchy installs),
 * then `~/Downloads`, then the XDG path reported by Electron. Tests can point
 * it somewhere else with MENSAJERIA_HUB_DOWNLOADS_DIR.
 */
export function resolveDownloadsDir(): string {
  const override = process.env.MENSAJERIA_HUB_DOWNLOADS_DIR?.trim();
  if (override) return path.resolve(override);

  const home = os.homedir();
  for (const candidate of [path.join(home, 'Descargas'), path.join(home, 'Downloads')]) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  try {
    const xdgDownloads = app.getPath('downloads');
    if (xdgDownloads && fs.statSync(xdgDownloads).isDirectory()) return xdgDownloads;
  } catch {
    // Fall through to creating ~/Descargas.
  }

  const fallback = path.join(home, 'Descargas');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    // Best effort: the caller will surface the error when downloading.
  }
  return fallback;
}

export function assetPath(name: string): string {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'resources');
  return path.join(base, name);
}

export function iconPath(): string {
  return assetPath('icon.png');
}
