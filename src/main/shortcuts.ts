/**
 * Keyboard shortcut parsing, validation and normalization.
 *
 * Format: modifiers joined with `+` (Ctrl, Alt, Shift, Super) and, for full
 * bindings, one key at the end (Tab, PageDown, F1, A, 1...). Kept free of
 * Electron imports so config validation and the main process can share it.
 */

export interface ShortcutsConfig {
  accountPrefix: string;
  groupPrefix: string;
  nextAccount: string;
  prevAccount: string;
}

export interface Modifiers {
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ParsedBinding {
  modifiers: Modifiers;
  /** Lowercase key token; `space` for the space bar. */
  key: string;
}

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  accountPrefix: 'Alt',
  groupPrefix: 'Alt+Shift',
  nextAccount: 'Ctrl+Tab',
  prevAccount: 'Ctrl+Shift+Tab'
};

const MODIFIER_ALIASES: Record<string, keyof Modifiers> = {
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'meta',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta'
};

const MODIFIER_ORDER: { key: keyof Modifiers; label: string }[] = [
  { key: 'control', label: 'Ctrl' },
  { key: 'alt', label: 'Alt' },
  { key: 'shift', label: 'Shift' },
  { key: 'meta', label: 'Super' }
];

const KEY_LABELS: Record<string, string> = {
  tab: 'Tab',
  space: 'Space',
  enter: 'Enter',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
};

function emptyModifiers(): Modifiers {
  return { control: false, alt: false, shift: false, meta: false };
}

function hasModifier(modifiers: Modifiers): boolean {
  return modifiers.control || modifiers.alt || modifiers.shift || modifiers.meta;
}

function modifierLabel(modifiers: Modifiers): string {
  return MODIFIER_ORDER.filter((item) => modifiers[item.key])
    .map((item) => item.label)
    .join('+');
}

function keyLabel(token: string): string {
  if (KEY_LABELS[token]) return KEY_LABELS[token];
  if (token.length === 1) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function splitTokens(spec: string): string[] {
  return spec
    .split('+')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

/** Parses a prefix such as "Alt" or "Ctrl+Alt" (modifiers only). */
export function parseModifierSpec(spec: string): Modifiers | null {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const modifiers = emptyModifiers();
  for (const token of splitTokens(spec)) {
    const key = MODIFIER_ALIASES[token];
    if (!key) return null;
    modifiers[key] = true;
  }
  return hasModifier(modifiers) ? modifiers : null;
}

/** Parses a full binding such as "Ctrl+Tab" or "Alt+Shift+1". */
export function parseBinding(spec: string): ParsedBinding | null {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const modifiers = emptyModifiers();
  const keys: string[] = [];

  for (const token of splitTokens(spec)) {
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      modifiers[modifier] = true;
      continue;
    }
    keys.push(token === 'space' ? 'space' : token);
  }

  if (keys.length !== 1) return null;
  return { modifiers, key: keys[0] };
}

export function normalizeModifierSpec(spec: string): string | null {
  const modifiers = parseModifierSpec(spec);
  return modifiers ? modifierLabel(modifiers) : null;
}

export function normalizeBindingSpec(spec: string): string | null {
  const binding = parseBinding(spec);
  if (!binding) return null;
  const prefix = modifierLabel(binding.modifiers);
  const label = keyLabel(binding.key);
  return prefix ? `${prefix}+${label}` : label;
}

export function modifiersMatch(input: Electron.Input, modifiers: Modifiers): boolean {
  return (
    input.control === modifiers.control &&
    input.alt === modifiers.alt &&
    input.shift === modifiers.shift &&
    input.meta === modifiers.meta
  );
}

export function bindingMatches(input: Electron.Input, spec: string): boolean {
  const binding = parseBinding(spec);
  if (!binding || !modifiersMatch(input, binding.modifiers)) return false;

  const inputKey = input.key === ' ' ? 'space' : input.key.toLowerCase();
  if (inputKey === binding.key) return true;

  // Shift+digit produces a symbol on most layouts (Shift+1 = "!"); fall back
  // to the physical code so digit bindings still match.
  if (/^[1-9]$/.test(binding.key)) {
    const byCode = /^(?:Digit|Numpad)([1-9])$/.exec(input.code || '');
    if (byCode) return byCode[1] === binding.key;
  }
  return false;
}

/**
 * Shift+digit produces a symbol on most layouts ("!" for Shift+1), so digits
 * are read from `input.code` (Digit1..Digit9) instead of `input.key`.
 */
export function digitFromInput(input: Electron.Input): number | null {
  const byCode = /^(?:Digit|Numpad)([1-9])$/.exec(input.code || '');
  if (byCode) return Number(byCode[1]);
  if (/^[1-9]$/.test(input.key)) return Number(input.key);
  return null;
}

export type ShortcutValidation =
  | { ok: true; value: ShortcutsConfig }
  | { ok: false; error: string };

export function validateShortcuts(input: Partial<ShortcutsConfig>): ShortcutValidation {
  const accountPrefix = normalizeModifierSpec(input.accountPrefix ?? '');
  if (!accountPrefix) {
    return { ok: false, error: 'El prefijo de cuentas debe usar Ctrl, Alt, Shift o Super (ej: Alt).' };
  }

  const groupPrefix = normalizeModifierSpec(input.groupPrefix ?? '');
  if (!groupPrefix) {
    return { ok: false, error: 'El prefijo de grupos debe usar Ctrl, Alt, Shift o Super (ej: Alt+Shift).' };
  }

  if (accountPrefix === groupPrefix) {
    return { ok: false, error: 'Los prefijos de cuentas y grupos deben ser distintos.' };
  }

  const nextAccount = normalizeBindingSpec(input.nextAccount ?? '');
  if (!nextAccount) {
    return { ok: false, error: 'El atajo "siguiente cuenta" necesita una tecla y al menos un modificador.' };
  }

  const prevAccount = normalizeBindingSpec(input.prevAccount ?? '');
  if (!prevAccount) {
    return { ok: false, error: 'El atajo "cuenta anterior" necesita una tecla y al menos un modificador.' };
  }

  const nextModifiers = parseBinding(nextAccount)?.modifiers;
  const prevModifiers = parseBinding(prevAccount)?.modifiers;
  if (nextModifiers && !hasModifier(nextModifiers)) {
    return { ok: false, error: '"Siguiente cuenta" debe incluir Ctrl, Alt, Shift o Super.' };
  }
  if (prevModifiers && !hasModifier(prevModifiers)) {
    return { ok: false, error: '"Cuenta anterior" debe incluir Ctrl, Alt, Shift o Super.' };
  }

  if (nextAccount === prevAccount) {
    return { ok: false, error: 'Los atajos de siguiente y anterior no pueden ser iguales.' };
  }

  // A digit binding like "Alt+1" would collide with the account prefix.
  for (const bindingSpec of [nextAccount, prevAccount]) {
    const binding = parseBinding(bindingSpec);
    if (!binding) continue;
    if (/^[1-9]$/.test(binding.key)) {
      const prefix = modifierLabel(binding.modifiers);
      if (prefix === accountPrefix || prefix === groupPrefix) {
        return {
          ok: false,
          error: `"${bindingSpec}" choca con el cambio de cuentas/grupos (${prefix} + 1..9).`
        };
      }
    }
  }

  return {
    ok: true,
    value: {
      accountPrefix,
      groupPrefix,
      nextAccount,
      prevAccount
    }
  };
}

/**
 * Lenient version used while loading config.json: repairs individual fields
 * and falls back to defaults on conflicts instead of leaving the app unusable.
 */
export function sanitizeShortcuts(raw: Partial<ShortcutsConfig> | undefined): ShortcutsConfig {
  const candidate: ShortcutsConfig = {
    accountPrefix: normalizeModifierSpec(raw?.accountPrefix ?? '') ?? DEFAULT_SHORTCUTS.accountPrefix,
    groupPrefix: normalizeModifierSpec(raw?.groupPrefix ?? '') ?? DEFAULT_SHORTCUTS.groupPrefix,
    nextAccount: normalizeBindingSpec(raw?.nextAccount ?? '') ?? DEFAULT_SHORTCUTS.nextAccount,
    prevAccount: normalizeBindingSpec(raw?.prevAccount ?? '') ?? DEFAULT_SHORTCUTS.prevAccount
  };

  if (candidate.accountPrefix === candidate.groupPrefix) {
    candidate.groupPrefix = DEFAULT_SHORTCUTS.groupPrefix;
  }
  if (candidate.accountPrefix === candidate.groupPrefix) {
    candidate.accountPrefix = DEFAULT_SHORTCUTS.accountPrefix;
  }
  if (candidate.nextAccount === candidate.prevAccount) {
    candidate.prevAccount = DEFAULT_SHORTCUTS.prevAccount;
  }
  if (candidate.nextAccount === candidate.prevAccount) {
    candidate.nextAccount = DEFAULT_SHORTCUTS.nextAccount;
    candidate.prevAccount = DEFAULT_SHORTCUTS.prevAccount;
  }

  return candidate;
}
