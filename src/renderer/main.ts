import type { MensajeriaAPI, ActionResult } from '../preload/index';
import type { AppConfig, AccountConfig, GroupConfig } from '../main/config';

declare global {
  interface Window {
    api: MensajeriaAPI;
  }
}

const api = window.api;

const EMPTY_CONFIG: AppConfig = {
  groups: [],
  accounts: [],
  activeGroup: '',
  activeAccount: '',
  suspendAfterMinutes: 10,
  closeToTray: true,
  allowMicrophone: true,
  allowCamera: true,
  shortcuts: {
    accountPrefix: 'Alt',
    groupPrefix: 'Alt+Shift',
    nextAccount: 'Ctrl+Tab',
    prevAccount: 'Ctrl+Shift+Tab'
  }
};

let config: AppConfig = EMPTY_CONFIG;
let unreadCounts: Record<string, number> = {};
let suspendedAccounts: string[] = [];
let accountStatus: Record<string, 'loading' | 'ready' | 'error'> = {};

let targetAccountForMenu: { account: AccountConfig; group: GroupConfig } | null = null;
let targetGroupForMenu: GroupConfig | null = null;
let confirmCallback: (() => void | Promise<void>) | null = null;
let toastTimer: number | undefined;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const sidebar = $('sidebar');
const groupsContainer = $('groups-container');
const accountsContainer = $('accounts-container');
const accountsGroupTitle = $('accounts-group-title');
const footerHints = $('footer-hints');
const viewPlaceholder = $('view-placeholder');
const toast = $('toast');

const modalGroup = $<HTMLDialogElement>('modal-group');
const modalGroupTitle = $('modal-group-title');
const groupEditIdInput = $<HTMLInputElement>('group-edit-id');
const formGroup = $<HTMLFormElement>('form-group');
const groupNameInput = $<HTMLInputElement>('group-name');
const groupColorInput = $<HTMLInputElement>('group-color');
const groupColorHex = $('group-color-hex');
const btnAddGroup = $<HTMLButtonElement>('btn-add-group');
const btnCancelGroup = $<HTMLButtonElement>('btn-cancel-group');

const modalAccount = $<HTMLDialogElement>('modal-account');
const modalAccountTitle = $('modal-account-title');
const accountEditIdInput = $<HTMLInputElement>('account-edit-id');
const formAccount = $<HTMLFormElement>('form-account');
const accountNameInput = $<HTMLInputElement>('account-name');
const accountServiceSelect = $<HTMLSelectElement>('account-service');
const accountGroupSelect = $<HTMLSelectElement>('account-group');
const accountUrlInput = $<HTMLInputElement>('account-url');
const btnAddAccount = $<HTMLButtonElement>('btn-add-account');
const btnCancelAccount = $<HTMLButtonElement>('btn-cancel-account');
const accountServiceGroup = $('account-service-group');

const modalSettings = $<HTMLDialogElement>('modal-settings');
const btnSettings = $<HTMLButtonElement>('btn-settings');
const btnCloseSettings = $<HTMLButtonElement>('btn-close-settings');
const settingSuspendInput = $<HTMLInputElement>('setting-suspend');
const settingCloseToTrayInput = $<HTMLInputElement>('setting-closetotray');
const settingAllowMicrophoneInput = $<HTMLInputElement>('setting-allow-microphone');
const settingAllowCameraInput = $<HTMLInputElement>('setting-allow-camera');
const settingAccountPrefix = $<HTMLInputElement>('settings-account-prefix');
const settingGroupPrefix = $<HTMLInputElement>('settings-group-prefix');
const settingNextAccount = $<HTMLInputElement>('settings-next-account');
const settingPrevAccount = $<HTMLInputElement>('settings-prev-account');
const settingShortcutPreview = $('settings-shortcut-preview');
const btnResetShortcuts = $<HTMLButtonElement>('btn-reset-shortcuts');
const settingsConfigPath = $('settings-config-path');
const settingsVersion = $('settings-version');
const settingsTheme = $('settings-theme');
const btnOpenConfig = $<HTMLButtonElement>('btn-open-config');

const modalMenu = $<HTMLDialogElement>('modal-menu');
const menuTitle = $('menu-title');
const menuBtnEdit = $<HTMLButtonElement>('menu-btn-edit');
const menuBtnMoveUp = $<HTMLButtonElement>('menu-btn-move-up');
const menuBtnMoveDown = $<HTMLButtonElement>('menu-btn-move-down');
const menuBtnDelete = $<HTMLButtonElement>('menu-btn-delete');
const btnCloseMenu = $<HTMLButtonElement>('btn-close-menu');

const modalConfirm = $<HTMLDialogElement>('modal-confirm');
const confirmTitle = $('confirm-title');
const confirmMessage = $('confirm-message');
const btnConfirmOk = $<HTMLButtonElement>('btn-confirm-ok');
const btnConfirmCancel = $<HTMLButtonElement>('btn-confirm-cancel');

const SVG_WA = `
<svg class="service-icon whatsapp" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.04 14.69 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 15 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67M9.08 6.64C8.93 6.64 8.68 6.7 8.48 6.92C8.28 7.14 7.71 7.67 7.71 8.76C7.71 9.85 8.5 10.9 8.61 11.05C8.73 11.2 10.17 13.43 12.37 14.38C14.2 15.17 14.58 15.01 14.98 14.97C15.39 14.93 16.3 14.43 16.49 13.9C16.68 13.37 16.68 12.92 16.62 12.83C16.56 12.73 16.41 12.67 16.18 12.56C15.96 12.45 14.85 11.9 14.64 11.83C14.44 11.75 14.29 11.71 14.14 11.93C14 12.16 13.58 12.67 13.46 12.82C13.33 12.97 13.21 13 12.98 12.88C12.76 12.77 12.03 12.53 11.16 11.76C10.49 11.16 10.03 10.42 9.9 10.2C9.78 9.97 9.89 9.85 10 9.74C10.1 9.64 10.22 9.48 10.33 9.35C10.45 9.22 10.49 9.13 10.56 8.98C10.64 8.83 10.6 8.7 10.54 8.59C10.49 8.48 10.03 7.35 9.84 6.89C9.66 6.45 9.47 6.51 9.33 6.5C9.2 6.5 9.05 6.64 9.08 6.64Z"/>
</svg>
`;

const SVG_TG = `
<svg class="service-icon telegram" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/>
</svg>
`;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  try {
    applyTheme(await api.getTheme());
  } catch (err) {
    console.warn('No se pudo cargar el tema de Omarchy:', err);
  }

  wireDialogs();
  registerIpcListeners();
  setupEvents();

  try {
    const state = await api.rendererReady();
    config = state.config;
    unreadCounts = state.unreadCounts ?? {};
    suspendedAccounts = state.suspendedAccounts ?? [];
  } catch (err) {
    console.error('No se pudo inicializar la interfaz:', err);
    showToast('No se pudo cargar la configuración.', 'error');
  }

  updateBounds();
  window.addEventListener('resize', updateBounds);
  render();
}

function applyTheme(theme: Awaited<ReturnType<MensajeriaAPI['getTheme']>>): void {
  const root = document.documentElement;
  root.style.setProperty('--color-bg', theme.background);
  root.style.setProperty('--color-bg-darker', theme.darkerBackground);
  root.style.setProperty('--color-bg-lighter', theme.lighterBackground);
  root.style.setProperty('--color-fg', theme.foreground);
  root.style.setProperty('--color-muted', theme.muted);
  root.style.setProperty('--color-accent', theme.accent);
  root.style.setProperty('--color-selection', theme.selection);
  root.style.setProperty('--color-border', theme.border);
}

function updateBounds(): void {
  const width = sidebar.offsetWidth || 280;
  void api.setSidebarBounds(width);
}

// ---------------------------------------------------------------------------
// IPC events
// ---------------------------------------------------------------------------

function registerIpcListeners(): void {
  api.onUnreadCounts((counts) => {
    unreadCounts = counts || {};
    render();
  });

  api.onActiveChanged((data) => {
    config.activeGroup = data.groupId;
    config.activeAccount = data.accountId;
    render();
  });

  api.onSuspendedAccounts((accounts) => {
    suspendedAccounts = accounts || [];
    render();
  });

  api.onAccountStatus((status) => {
    if (status.state === 'loading') accountStatus[status.accountId] = 'loading';
    else if (status.state === 'error') accountStatus[status.accountId] = 'error';
    else delete accountStatus[status.accountId];
    render();
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  renderGroups();
  renderAccounts();
  renderPlaceholder();
  renderFooter();
}

function renderGroups(): void {
  groupsContainer.innerHTML = '';

  config.groups.forEach((group, index) => {
    const tab = document.createElement('div');
    tab.className = `group-tab ${group.id === config.activeGroup ? 'active' : ''}`;
    tab.dataset.groupId = group.id;
    tab.title = `${group.name} (${config.shortcuts.groupPrefix}+${index + 1}) — clic derecho para opciones`;

    const groupUnread = group.accounts.reduce((sum, accountId) => sum + (unreadCounts[accountId] || 0), 0);

    tab.innerHTML = `
      <span class="group-color-dot" style="background-color: ${escapeHtml(group.color)}"></span>
      <span class="group-name">${escapeHtml(group.name)}</span>
      ${groupUnread > 0 ? `<span class="badge">${groupUnread}</span>` : ''}
    `;

    tab.addEventListener('click', () => {
      void api.selectGroup(group.id);
    });
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openGroupMenu(group);
    });

    groupsContainer.appendChild(tab);
  });
}

function renderAccounts(): void {
  accountsContainer.innerHTML = '';
  const currentGroup = config.groups.find((group) => group.id === config.activeGroup);

  if (!currentGroup) {
    accountsGroupTitle.textContent = 'CUENTAS';
    return;
  }

  accountsGroupTitle.textContent = currentGroup.name.toUpperCase();

  const groupAccounts = currentGroup.accounts
    .map((accountId) => config.accounts.find((account) => account.id === accountId))
    .filter((account): account is AccountConfig => Boolean(account));

  groupAccounts.forEach((account, index) => {
    const item = document.createElement('div');
    item.className = `account-item ${account.id === config.activeAccount ? 'active' : ''}`;
    item.dataset.accountId = account.id;

    const isSuspended = suspendedAccounts.includes(account.id);
    const unread = unreadCounts[account.id] || 0;
    const status = accountStatus[account.id];
    const shortcut = `${config.shortcuts.accountPrefix}+${index + 1}`;
    const iconSvg = account.service === 'whatsapp' ? SVG_WA : SVG_TG;

    const metaParts: string[] = [];
    if (isSuspended) metaParts.push('<span class="suspended-tag" title="Vista descargada de memoria; la sesión sigue en disco">💤 Suspendida</span>');
    if (status === 'loading') metaParts.push('<span class="account-status">Cargando…</span>');
    if (status === 'error') metaParts.push('<span class="account-status error" title="Error al cargar la página">⚠ Error de carga</span>');

    item.innerHTML = `
      <div class="account-main">
        ${iconSvg}
        <div class="account-info">
          <span class="account-name">${escapeHtml(account.name)}</span>
          <div class="account-meta">${metaParts.join('')}</div>
        </div>
      </div>
      <div class="account-actions">
        ${unread > 0 ? `<span class="badge">${unread}</span>` : ''}
        ${status === 'error' ? '<button class="btn-item-retry" title="Recargar cuenta">⟳</button>' : ''}
        <span class="account-shortcut">${escapeHtml(shortcut)}</span>
        <button class="btn-item-more" title="Opciones de cuenta">⋮</button>
      </div>
    `;

    item.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.classList.contains('btn-item-more')) {
        event.stopPropagation();
        openAccountMenu(account, currentGroup);
      } else if (target.classList.contains('btn-item-retry')) {
        event.stopPropagation();
        accountStatus[account.id] = 'loading';
        renderAccounts();
        void api.reloadAccount(account.id);
      } else {
        void api.selectAccount(account.id);
      }
    });

    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openAccountMenu(account, currentGroup);
    });

    accountsContainer.appendChild(item);
  });
}

function renderPlaceholder(): void {
  const activeAccount = config.accounts.find((account) => account.id === config.activeAccount);
  if (activeAccount) {
    // The WebContentsView paints over this area; keep it neutral so a hidden
    // view (dialog open) never leaves stale loading text behind.
    viewPlaceholder.innerHTML = '';
    viewPlaceholder.style.background = 'var(--color-bg)';
    return;
  }

  const currentGroup = config.groups.find((group) => group.id === config.activeGroup);
  const message = !config.groups.length
    ? 'No hay grupos todavía. Crea uno con el botón + de GRUPOS.'
    : !currentGroup || currentGroup.accounts.length === 0
      ? 'Este grupo no tiene cuentas. Añade una con el botón + de CUENTAS.'
      : 'No hay ninguna cuenta activa.';

  viewPlaceholder.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">💬</div>
      <p>${escapeHtml(message)}</p>
      <p class="empty-hint">Atajos: ${escapeHtml(config.shortcuts.accountPrefix)}+1..9 cuentas · ${escapeHtml(
        config.shortcuts.groupPrefix
      )}+1..9 grupos</p>
    </div>
  `;
}

function renderFooter(): void {
  const { accountPrefix, groupPrefix, nextAccount, prevAccount } = config.shortcuts;
  footerHints.innerHTML = `
    <span class="shortcut-pill">${escapeHtml(accountPrefix)}+1..9</span>
    <span>Cuentas</span>
    <span class="shortcut-pill">${escapeHtml(groupPrefix)}+1..9</span>
    <span>Grupos</span>
    <span class="shortcut-pill" title="Anterior: ${escapeHtml(prevAccount)}">${escapeHtml(nextAccount)}</span>
  `;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function wireDialogs(): void {
  document.querySelectorAll<HTMLDialogElement>('dialog.modal').forEach((dialog) => {
    dialog.addEventListener('close', () => updateViewVisibility());
  });
}

function openDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  dialog.showModal();
  updateViewVisibility();
}

/** Hide the chat view while any dialog is open (WebContentsView paints above the UI). */
function updateViewVisibility(): void {
  const anyOpen = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog.modal')).some(
    (dialog) => dialog.open
  );
  void api.setAccountViewVisible(!anyOpen);
}

function showToast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  toast.textContent = message;
  toast.className = `toast visible ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.className = 'toast';
  }, 4000);
}

function openGroupMenu(group: GroupConfig): void {
  targetGroupForMenu = group;
  targetAccountForMenu = null;
  menuTitle.textContent = `Grupo: ${group.name}`;
  menuBtnMoveUp.textContent = 'Mover hacia la izquierda';
  menuBtnMoveDown.textContent = 'Mover hacia la derecha';
  openDialog(modalMenu);
}

function openAccountMenu(account: AccountConfig, group: GroupConfig): void {
  targetAccountForMenu = { account, group };
  targetGroupForMenu = null;
  menuTitle.textContent = `Cuenta: ${account.name}`;
  menuBtnMoveUp.textContent = 'Mover hacia arriba';
  menuBtnMoveDown.textContent = 'Mover hacia abajo';
  openDialog(modalMenu);
}

function openConfirmModal(title: string, message: string, onConfirm: () => void | Promise<void>): void {
  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmCallback = onConfirm;
  openDialog(modalConfirm);
}

async function refreshConfig(): Promise<void> {
  try {
    config = await api.getConfig();
  } catch (err) {
    console.error('No se pudo releer la configuración:', err);
  }
  render();
}

// ---------------------------------------------------------------------------
// Forms and buttons
// ---------------------------------------------------------------------------

function defaultUrl(service: string): string {
  return service === 'telegram' ? 'https://web.telegram.org/k/' : 'https://web.whatsapp.com';
}

function populateGroupSelect(selectedId?: string): void {
  accountGroupSelect.innerHTML = '';
  if (config.groups.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'General (se creará)';
    accountGroupSelect.appendChild(option);
    return;
  }
  config.groups.forEach((group) => {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.name;
    if (group.id === selectedId) option.selected = true;
    accountGroupSelect.appendChild(option);
  });
}

const SHORTCUT_DEFAULTS: AppConfig['shortcuts'] = {
  accountPrefix: 'Alt',
  groupPrefix: 'Alt+Shift',
  nextAccount: 'Ctrl+Tab',
  prevAccount: 'Ctrl+Shift+Tab'
};

function fillShortcutInputs(): void {
  settingAccountPrefix.value = config.shortcuts.accountPrefix;
  settingGroupPrefix.value = config.shortcuts.groupPrefix;
  settingNextAccount.value = config.shortcuts.nextAccount;
  settingPrevAccount.value = config.shortcuts.prevAccount;
  updateShortcutPreview();
}

function readShortcutInputs(): AppConfig['shortcuts'] {
  return {
    accountPrefix: settingAccountPrefix.value.trim(),
    groupPrefix: settingGroupPrefix.value.trim(),
    nextAccount: settingNextAccount.value.trim(),
    prevAccount: settingPrevAccount.value.trim()
  };
}

function updateShortcutPreview(): void {
  const shortcuts = readShortcutInputs();
  const account = shortcuts.accountPrefix ? `${shortcuts.accountPrefix}+1..9` : '—';
  const group = shortcuts.groupPrefix ? `${shortcuts.groupPrefix}+1..9` : '—';
  settingShortcutPreview.textContent =
    `Activos: ${account} · ${group} · ${shortcuts.nextAccount || '—'} · ${shortcuts.prevAccount || '—'}`;
}

function setupEvents(): void {
  groupColorInput.addEventListener('input', () => {
    groupColorHex.textContent = groupColorInput.value;
  });

  // Add group
  btnAddGroup.addEventListener('click', () => {
    modalGroupTitle.textContent = 'Nuevo Grupo';
    groupEditIdInput.value = '';
    groupNameInput.value = '';
    groupColorInput.value = '#3b82f6';
    groupColorHex.textContent = '#3b82f6';
    openDialog(modalGroup);
  });

  btnCancelGroup.addEventListener('click', () => modalGroup.close());

  formGroup.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = groupNameInput.value.trim();
    if (!name) return;
    const color = groupColorInput.value;
    const editId = groupEditIdInput.value;

    const result: ActionResult = editId
      ? await api.updateGroup(editId, { name, color })
      : await api.createGroup({ name, color });

    if (!result.ok) {
      showToast(result.error || 'No se pudo guardar el grupo.', 'error');
      return;
    }
    modalGroup.close();
    await refreshConfig();
    showToast(editId ? 'Grupo actualizado.' : 'Grupo creado.', 'success');
  });

  // Add account
  btnAddAccount.addEventListener('click', () => {
    modalAccountTitle.textContent = 'Añadir Cuenta';
    accountEditIdInput.value = '';
    accountNameInput.value = '';
    accountServiceSelect.value = 'whatsapp';
    accountUrlInput.value = '';
    accountUrlInput.placeholder = defaultUrl('whatsapp');
    accountServiceGroup.style.display = '';
    accountServiceSelect.disabled = false;
    populateGroupSelect(config.activeGroup || config.groups[0]?.id);
    openDialog(modalAccount);
  });

  accountServiceSelect.addEventListener('change', () => {
    accountUrlInput.placeholder = defaultUrl(accountServiceSelect.value);
  });

  btnCancelAccount.addEventListener('click', () => modalAccount.close());

  formAccount.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = accountNameInput.value.trim();
    if (!name) {
      showToast('Escribe un nombre para la cuenta.', 'error');
      return;
    }
    const editId = accountEditIdInput.value;
    const service = accountServiceSelect.value as 'whatsapp' | 'telegram';
    const groupId = accountGroupSelect.value;
    const url = accountUrlInput.value.trim();

    const result: ActionResult = editId
      ? await api.updateAccount(editId, { name, url, groupId })
      : await api.createAccount({ name, service, url, groupId });

    if (!result.ok) {
      showToast(result.error || 'No se pudo guardar la cuenta.', 'error');
      return;
    }
    modalAccount.close();
    await refreshConfig();
    showToast(editId ? 'Cuenta actualizada.' : 'Cuenta añadida. Iniciando sesión aislada…', 'success');
  });

  // Menu modal
  btnCloseMenu.addEventListener('click', () => modalMenu.close());

  menuBtnEdit.addEventListener('click', () => {
    modalMenu.close();
    if (targetGroupForMenu) {
      const group = targetGroupForMenu;
      modalGroupTitle.textContent = 'Editar Grupo';
      groupEditIdInput.value = group.id;
      groupNameInput.value = group.name;
      groupColorInput.value = group.color;
      groupColorHex.textContent = group.color;
      openDialog(modalGroup);
    } else if (targetAccountForMenu) {
      const account = targetAccountForMenu.account;
      modalAccountTitle.textContent = 'Editar Cuenta';
      accountEditIdInput.value = account.id;
      accountNameInput.value = account.name;
      accountUrlInput.value = account.url;
      accountUrlInput.placeholder = defaultUrl(account.service);
      accountServiceSelect.value = account.service;
      accountServiceSelect.disabled = true;
      accountServiceGroup.style.display = 'none';
      populateGroupSelect(targetAccountForMenu.group.id);
      openDialog(modalAccount);
    }
  });

  menuBtnMoveUp.addEventListener('click', async () => {
    modalMenu.close();
    if (targetGroupForMenu) {
      const index = config.groups.findIndex((group) => group.id === targetGroupForMenu?.id);
      if (index > 0) {
        const groups = [...config.groups];
        [groups[index - 1], groups[index]] = [groups[index], groups[index - 1]];
        await api.reorderGroups(groups.map((group) => group.id));
      }
    } else if (targetAccountForMenu) {
      const group = config.groups.find((candidate) => candidate.id === targetAccountForMenu?.group.id);
      const index = group?.accounts.indexOf(targetAccountForMenu.account.id) ?? -1;
      if (group && index > 0) {
        const accounts = [...group.accounts];
        [accounts[index - 1], accounts[index]] = [accounts[index], accounts[index - 1]];
        await api.reorderAccounts(group.id, accounts);
      }
    }
    await refreshConfig();
  });

  menuBtnMoveDown.addEventListener('click', async () => {
    modalMenu.close();
    if (targetGroupForMenu) {
      const index = config.groups.findIndex((group) => group.id === targetGroupForMenu?.id);
      if (index >= 0 && index < config.groups.length - 1) {
        const groups = [...config.groups];
        [groups[index], groups[index + 1]] = [groups[index + 1], groups[index]];
        await api.reorderGroups(groups.map((group) => group.id));
      }
    } else if (targetAccountForMenu) {
      const group = config.groups.find((candidate) => candidate.id === targetAccountForMenu?.group.id);
      const index = group?.accounts.indexOf(targetAccountForMenu.account.id) ?? -1;
      if (group && index >= 0 && index < group.accounts.length - 1) {
        const accounts = [...group.accounts];
        [accounts[index], accounts[index + 1]] = [accounts[index + 1], accounts[index]];
        await api.reorderAccounts(group.id, accounts);
      }
    }
    await refreshConfig();
  });

  menuBtnDelete.addEventListener('click', () => {
    modalMenu.close();
    if (targetGroupForMenu) {
      const group = targetGroupForMenu;
      openConfirmModal(
        'Eliminar grupo',
        `¿Eliminar el grupo "${group.name}"? Sus cuentas se moverán a otro grupo y NO se borrarán sus sesiones.`,
        async () => {
          const result = await api.deleteGroup(group.id);
          if (!result.ok) {
            showToast(result.error || 'No se pudo eliminar el grupo.', 'error');
            return;
          }
          await refreshConfig();
          showToast(result.movedTo ? `Grupo eliminado. Cuentas movidas a "${result.movedTo}".` : 'Grupo eliminado.', 'success');
        }
      );
    } else if (targetAccountForMenu) {
      const account = targetAccountForMenu.account;
      openConfirmModal(
        'Eliminar cuenta',
        `¿Eliminar la cuenta "${account.name}"? Se borrará su sesión aislada del disco (cookies, caché y almacenamiento) y no se puede deshacer.`,
        async () => {
          const result = await api.deleteAccount(account.id);
          if (!result.ok) {
            showToast(result.error || 'No se pudo eliminar la cuenta.', 'error');
            return;
          }
          await refreshConfig();
          showToast('Cuenta y sesión eliminadas.', 'success');
        }
      );
    }
  });

  // Settings
  btnSettings.addEventListener('click', async () => {
    settingSuspendInput.value = String(config.suspendAfterMinutes);
    settingCloseToTrayInput.checked = config.closeToTray;
    settingAllowMicrophoneInput.checked = config.allowMicrophone;
    settingAllowCameraInput.checked = config.allowCamera;
    fillShortcutInputs();
    try {
      const info = await api.getInfo();
      settingsConfigPath.textContent = info.configPath;
      settingsVersion.textContent = `${info.version} · Electron ${info.electron} · Chrome ${info.chrome}`;
      settingsTheme.textContent = info.themeName;
    } catch {
      settingsConfigPath.textContent = 'config.json';
    }
    openDialog(modalSettings);
  });

  btnCloseSettings.addEventListener('click', async () => {
    const minutes = Number.parseFloat(settingSuspendInput.value);
    const result = await api.updateSettings({
      suspendAfterMinutes: Number.isFinite(minutes) ? minutes : config.suspendAfterMinutes,
      closeToTray: settingCloseToTrayInput.checked,
      allowMicrophone: settingAllowMicrophoneInput.checked,
      allowCamera: settingAllowCameraInput.checked,
      shortcuts: readShortcutInputs()
    });
    if (!result.ok) {
      showToast(result.error || 'No se pudieron guardar los ajustes.', 'error');
      return;
    }
    modalSettings.close();
    await refreshConfig();
    showToast('Ajustes y atajos guardados.', 'success');
  });

  [settingAccountPrefix, settingGroupPrefix, settingNextAccount, settingPrevAccount].forEach((input) => {
    input.addEventListener('input', updateShortcutPreview);
  });

  btnResetShortcuts.addEventListener('click', () => {
    settingAccountPrefix.value = SHORTCUT_DEFAULTS.accountPrefix;
    settingGroupPrefix.value = SHORTCUT_DEFAULTS.groupPrefix;
    settingNextAccount.value = SHORTCUT_DEFAULTS.nextAccount;
    settingPrevAccount.value = SHORTCUT_DEFAULTS.prevAccount;
    updateShortcutPreview();
    showToast('Atajos por defecto cargados; pulsa Listo para guardarlos.', 'info');
  });

  btnOpenConfig.addEventListener('click', async () => {
    const result = await api.openConfig();
    if (!result.ok) showToast(result.error || 'No se pudo abrir config.json.', 'error');
  });

  document.querySelectorAll<HTMLAnchorElement>('.creator-link').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const url = link.dataset.external;
      if (url) void api.openExternal(url);
    });
  });

  // Confirm modal
  btnConfirmCancel.addEventListener('click', () => {
    modalConfirm.close();
    confirmCallback = null;
  });

  btnConfirmOk.addEventListener('click', async () => {
    const callback = confirmCallback;
    confirmCallback = null;
    modalConfirm.close();
    if (!callback) return;
    try {
      await callback();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  });
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

void init();
