import type { Service } from './config';

export interface DeepLinkTarget {
  service: Service;
  /** URL to load inside the account's WebContentsView. */
  url: string;
}

function firstPathSegment(url: URL): string {
  return url.pathname.split('/').filter(Boolean)[0] ?? '';
}

function whatsappSendUrl(phone: string | null, text: string | null): string | null {
  if (!phone) return null;
  const normalizedPhone = phone.replace(/[^\d+]/g, '');
  if (!normalizedPhone) return null;

  const target = new URL('https://web.whatsapp.com/send');
  target.searchParams.set('phone', normalizedPhone);
  if (text) target.searchParams.set('text', text);
  return target.toString();
}

function whatsappInviteUrl(code: string | null): string | null {
  if (!code) return null;
  return `https://web.whatsapp.com/accept?code=${encodeURIComponent(code)}`;
}

function telegramUsernameUrl(username: string | null): string | null {
  if (!username) return null;
  const clean = username.replace(/^@/, '').trim();
  if (!clean) return null;
  return `https://web.telegram.org/k/#@${encodeURIComponent(clean)}`;
}

function telegramInviteUrl(invite: string | null): string | null {
  if (!invite) return null;
  const clean = invite.replace(/^\+/, '').trim();
  if (!clean) return null;
  // Telegram Web K accepts a tg:// deep link through its tgaddr hash route.
  const deepLink = `tg://join?invite=${encodeURIComponent(clean)}`;
  return `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(deepLink)}`;
}

/**
 * Recognizes the links WhatsApp/Telegram Web use to point outside the current
 * chat (contact links, invite links, custom schemes). When recognized, the
 * caller can load the returned URL in the proper account instead of handing it
 * to the system browser (which asks to open xdg-open/WhatsApp).
 */
export function parseDeepLink(rawUrl: string, sourceService?: Service): DeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();

  // whatsapp://send?phone=... / whatsapp://chat?code=...
  if (protocol === 'whatsapp:') {
    const action = host || firstPathSegment(url);
    if (action === 'send') {
      const target = whatsappSendUrl(url.searchParams.get('phone'), url.searchParams.get('text'));
      return target ? { service: 'whatsapp', url: target } : null;
    }
    if (action === 'chat' || action === 'invite') {
      const code = url.searchParams.get('code') ?? url.searchParams.get('invite');
      const target = whatsappInviteUrl(code);
      return target ? { service: 'whatsapp', url: target } : null;
    }
    return null;
  }

  // tg://resolve?domain=user / tg://join?invite=...
  if (protocol === 'tg:') {
    const action = host;
    if (action === 'resolve') {
      const target = telegramUsernameUrl(url.searchParams.get('domain'));
      return target ? { service: 'telegram', url: target } : null;
    }
    if (action === 'join') {
      const target = telegramInviteUrl(url.searchParams.get('invite'));
      return target ? { service: 'telegram', url: target } : null;
    }
    return null;
  }

  if (protocol !== 'https:' && protocol !== 'http:') return null;

  // WhatsApp links.
  if (host === 'api.whatsapp.com' && url.pathname.startsWith('/send')) {
    const target = whatsappSendUrl(url.searchParams.get('phone'), url.searchParams.get('text'));
    return target ? { service: 'whatsapp', url: target } : null;
  }

  if (host === 'wa.me') {
    const phone = firstPathSegment(url);
    const target = whatsappSendUrl(phone, url.searchParams.get('text'));
    return target ? { service: 'whatsapp', url: target } : null;
  }

  if (host === 'chat.whatsapp.com') {
    const target = whatsappInviteUrl(firstPathSegment(url));
    return target ? { service: 'whatsapp', url: target } : null;
  }

  if (host === 'web.whatsapp.com' && url.pathname.startsWith('/send')) {
    const target = whatsappSendUrl(url.searchParams.get('phone'), url.searchParams.get('text'));
    return target ? { service: 'whatsapp', url: target } : null;
  }

  // Telegram links.
  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog') {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'joinchat') {
      const target = telegramInviteUrl(segments[1] ?? null);
      return target ? { service: 'telegram', url: target } : null;
    }
    if (segments[0]?.startsWith('+')) {
      const target = telegramInviteUrl(segments[0]);
      return target ? { service: 'telegram', url: target } : null;
    }
    if (segments[0] === 's' || segments[0] === 'c') return null;
    const target = telegramUsernameUrl(segments[0] ?? null);
    return target ? { service: 'telegram', url: target } : null;
  }

  // Already inside the service web app: nothing to reroute.
  if (sourceService === 'whatsapp' && host === 'web.whatsapp.com') return null;
  if (sourceService === 'telegram' && host === 'web.telegram.org') return null;

  return null;
}
