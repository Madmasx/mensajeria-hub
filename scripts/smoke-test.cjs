#!/usr/bin/env node
/*
 * Smoke test for Mensajería Hub.
 *
 * Requires a graphical session (Wayland or X11) plus network access to
 * web.whatsapp.com / web.telegram.org. It launches a throw-away instance with
 * its own XDG_CONFIG_HOME, inspects it through the Chrome DevTools Protocol and
 * verifies the main acceptance criteria. Nothing from the user's real config or
 * sessions is touched.
 *
 * Usage: npm run smoke
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');

const results = [];
let child = null;
let tempDir = null;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    results.push({ name, ok: true });
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    results.push({ name, ok: false });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, fn, timeoutMs = 15000, intervalMs = 150) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Tiempo agotado esperando: ${description}${lastError ? ` (${lastError.message})` : ''}`
  );
}

async function openCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('No se pudo conectar a CDP'));
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    async evaluate(expression) {
      const response = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      const exception = response.result?.exceptionDetails;
      if (exception) {
        throw new Error(exception.exception?.description || exception.text || 'Error en la página');
      }
      return response.result?.result?.value;
    },
    close() {
      ws.close();
    }
  };
}

async function getTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}

function writeConfig(dir) {
  const configDir = path.join(dir, 'config', 'mensajeria-hub');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        groups: [
          { id: 'trabajo', name: 'Trabajo', color: '#3b82f6', accounts: ['wa-1', 'tg-1'] },
          { id: 'personal', name: 'Personal', color: '#10b981', accounts: [] }
        ],
        accounts: [
          { id: 'wa-1', name: 'WA Smoke', service: 'whatsapp', url: 'https://web.whatsapp.com' },
          { id: 'tg-1', name: 'TG Smoke', service: 'telegram', url: 'https://web.telegram.org/k/' }
        ],
        activeGroup: 'trabajo',
        activeAccount: 'wa-1',
        suspendAfterMinutes: 0.2,
        closeToTray: false,
        shortcuts: {
          accountPrefix: 'Alt',
          groupPrefix: 'Alt+Shift',
          nextAccount: 'Ctrl+Tab',
          prevAccount: 'Ctrl+Shift+Tab'
        }
      },
      null,
      2
    )
  );
  return configDir;
}

function startApp(port) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(tempDir, 'config'),
    MENSAJERIA_HUB_DOWNLOADS_DIR: path.join(tempDir, 'downloads'),
    MENSAJERIA_HUB_DEBUG: '1',
    MENSAJERIA_HUB_SUPPRESS_EXTERNAL_OPEN: '1'
  };
  const args = [ROOT, `--remote-debugging-port=${port}`];
  if (process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland');
  else if (process.env.DISPLAY) args.push('--ozone-platform=x11');

  child = spawn(ELECTRON, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  return {
    getOutput: () => output,
    waitForLine: (needle, timeoutMs = 15000) =>
      waitFor(`línea de log "${needle}"`, () => output.includes(needle), timeoutMs, 100)
  };
}

async function main() {
  if (!fs.existsSync(ELECTRON)) {
    throw new Error('Electron no está instalado. Ejecuta "npm install" en el proyecto.');
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'index.js'))) {
    throw new Error('No hay build. Ejecuta "npm run build" antes del smoke test.');
  }
  if (!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    throw new Error('Este test necesita una sesión gráfica (Wayland o X11).');
  }

  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mensajeria-hub-smoke-'));
  writeConfig(tempDir);
  const port = 9300 + Math.floor(Math.random() * 500);

  const startedAt = Date.now();
  const app = startApp(port);

  try {
    await app.waitForLine('[timing] window-shown', 20000);
    const startupMs = Date.now() - startedAt;
    check('Arranque en frío < 2 s', startupMs < 2000, `${startupMs} ms`);

    const uiTarget = await waitFor(
      'ventana de la UI en CDP',
      async () => {
        const targets = await getTargets(port);
        return targets.find((target) => target.type === 'page' && target.url.includes('/dist/renderer/index.html'));
      },
      20000
    );
    const ui = await openCdp(uiTarget.webSocketDebuggerUrl);

    const dom = await ui.evaluate(`(() => ({
      api: typeof window.api,
      groups: document.querySelectorAll('.group-tab').length,
      accounts: document.querySelectorAll('.account-item').length,
      active: document.querySelector('.account-item.active')?.dataset.accountId || null,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
    }))()`);
    check('API segura expuesta en la UI', dom.api === 'object');
    check('Grupos renderizados', dom.groups === 2, `${dom.groups}`);
    check('Cuentas del grupo activo renderizadas', dom.accounts === 2, `${dom.accounts}`);
    check('Cuenta activa restaurada desde config', dom.active === 'wa-1', String(dom.active));
    check('Tema de Omarchy aplicado', /^#[0-9a-f]{3,8}$/i.test(dom.accent), dom.accent);

    const initial = await ui.evaluate(`(async () => ({
      config: await window.api.getConfig(),
      diagnostics: await window.api.getDiagnostics()
    }))()`);
    check('Solo la cuenta activa está cargada al arrancar', initial.diagnostics.loadedAccounts.length === 1);
    check(
      'La otra cuenta aparece suspendida',
      initial.diagnostics.suspendedAccounts.includes('tg-1')
    );
    const activeView = initial.diagnostics.views.find((view) => view.accountId === 'wa-1');
    check(
      'Vista con contextIsolation + sandbox y sin nodeIntegration',
      Boolean(activeView && activeView.contextIsolation && activeView.sandbox && !activeView.nodeIntegration)
    );
    check(
      'Partición aislada persist:<id>',
      Boolean(activeView && activeView.partition === 'persist:wa-1')
    );

    // Wait for the WhatsApp page to finish loading before poking at it.
    await waitFor(
      'vista de WhatsApp lista',
      async () => {
        const diagnostics = await ui.evaluate('window.api.getDiagnostics()');
        return diagnostics.views.find((view) => view.accountId === 'wa-1')?.title === 'WhatsApp';
      },
      20000
    );

    // Unread badge from the page title.
    const pages = await getTargets(port);
    let activePage = null;
    for (const target of pages.filter((candidate) => candidate.type === 'page')) {
      const cdp = await openCdp(target.webSocketDebuggerUrl);
      const probe = await cdp.evaluate(
        `({ focus: document.hasFocus(), host: location.hostname, title: document.title })`
      );
      if (probe.focus && probe.host === 'web.whatsapp.com') {
        activePage = cdp;
        break;
      }
      cdp.close();
    }
    check('Página activa de WhatsApp accesible por CDP', Boolean(activePage));

    if (activePage) {
      await activePage.evaluate(`(() => { document.title = '(3) WhatsApp'; return true; })()`);
      const unread = await waitFor(
        'contador de no leídos actualizado',
        async () => {
          const diagnostics = await ui.evaluate('window.api.getDiagnostics()');
          return diagnostics.unreadCounts['wa-1'] === 3 ? diagnostics : null;
        },
        4000
      );
      const badge = await ui.evaluate(
        `document.querySelector('[data-account-id="wa-1"] .badge')?.textContent || null`
      );
      check('No leídos leídos del título', unread.unreadCounts['wa-1'] === 3);
      check('Badge de la cuenta actualizado', badge === '3', String(badge));
      const groupBadge = await ui.evaluate(
        `document.querySelector('.group-tab .badge')?.textContent || null`
      );
      check('Badge del grupo actualizado', groupBadge === '3', String(groupBadge));

      // In-page notification -> native notification title contains account name.
      await activePage.evaluate(
        `(() => { new Notification('Smoke test', { body: 'hola' }); return true; })()`
      );
      await app.waitForLine('[notif] wa-1', 5000);
      check('Notificación reenviada con contexto de cuenta', true);

      // External navigation must be blocked inside the view.
      await activePage.evaluate(`(() => { location.href = 'https://example.com/'; return true; })()`);
      await app.waitForLine('[external] https://example.com/', 5000);
      await sleep(800);
      const stillHere = await activePage.evaluate('location.hostname');
      check('Enlace externo bloqueado dentro de la vista', stillHere === 'web.whatsapp.com', stillHere);
    }

    // Account switching (first load + cached switch).
    await ui.evaluate(`window.api.selectAccount('tg-1')`);
    await waitFor(
      'cuenta de Telegram cargada',
      async () => {
        const diagnostics = await ui.evaluate('window.api.getDiagnostics()');
        return diagnostics.loadedAccounts.includes('tg-1') ? diagnostics : null;
      },
      20000
    );
    const switchStarted = Date.now();
    await ui.evaluate(`window.api.selectAccount('wa-1')`);
    const switchMs = Date.now() - switchStarted;
    check('Cambio entre cuentas cargadas < 150 ms', switchMs < 150, `${switchMs} ms`);

    // Suspension after 0.2 minutes (12 s).
    await sleep(14000);
    const suspended = await ui.evaluate('window.api.getDiagnostics()');
    check('Tras el timeout solo queda cargada la cuenta activa', suspended.loadedAccounts.length === 1);
    check(
      'Cuenta inactiva marcada como suspendida',
      suspended.suspendedAccounts.includes('tg-1'),
      suspended.suspendedAccounts.join(',')
    );

    // Account creation + session deletion.
    const created = await ui.evaluate(
      `window.api.createAccount({ name: 'Smoke Borrar', service: 'telegram', groupId: 'trabajo' })`
    );
    check('Crear cuenta', created.ok === true);
    const createdId = created.account?.id;
    await sleep(1500);
    const partitionDir = path.join(tempDir, 'config', 'mensajeria-hub', 'Partitions', createdId || '');
    check('Partición de la cuenta creada en disco', Boolean(createdId && fs.existsSync(partitionDir)));

    const deleted = await ui.evaluate(`window.api.deleteAccount('${createdId}')`);
    await sleep(1500);
    check('Eliminar cuenta', deleted.ok === true);
    check('Partición eliminada del disco', !fs.existsSync(partitionDir));

    // Group lifecycle.
    const group = await ui.evaluate(`window.api.createGroup({ name: 'Smoke Group', color: '#ff00ff' })`);
    const groupId = group.group?.id;
    check('Crear grupo', group.ok === true && Boolean(groupId));
    const renamed = await ui.evaluate(
      `window.api.updateGroup('${groupId}', { name: 'Smoke Renombrado', color: '#00ffaa' })`
    );
    check('Renombrar grupo', renamed.ok === true);
    const configAfterRename = await ui.evaluate('window.api.getConfig()');
    check(
      'Renombrado aplicado',
      configAfterRename.groups.some((candidate) => candidate.id === groupId && candidate.name === 'Smoke Renombrado')
    );
    const reorderOk = await ui.evaluate(
      `(async () => (await window.api.reorderGroups(['${groupId}', ...(await window.api.getConfig()).groups.filter((g) => g.id !== '${groupId}').map((g) => g.id)])).ok)()`
    );
    check('Reordenar grupos', reorderOk === true);
    const removedGroup = await ui.evaluate(`window.api.deleteGroup('${groupId}')`);
    check('Eliminar grupo', removedGroup.ok === true);
    const finalConfig = await ui.evaluate('window.api.getConfig()');
    check('Grupo eliminado de config', !finalConfig.groups.some((candidate) => candidate.id === groupId));

    ui.close();

    if (results.some((result) => !result.ok)) {
      throw new Error('Algunas comprobaciones fallaron.');
    }
    console.log(`\nSmoke test OK — arranque ${startupMs} ms, cambio ${switchMs} ms.`);
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await sleep(700);
    }
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
}

main().catch((err) => {
  console.error(`\nSmoke test FAIL: ${err.message}`);
  if (child) child.kill('SIGTERM');
  process.exitCode = 1;
});
