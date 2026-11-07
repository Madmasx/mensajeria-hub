import { contextBridge, ipcRenderer, webFrame } from 'electron';

/**
 * Account pages run with contextIsolation + sandbox and never get Node APIs.
 * This preload does exactly two things:
 *   1. forwards Web Notifications to the main process (with the account
 *      context), so the native notification title can include the account name;
 *   2. nothing else. The unread counter is read from the page title by the
 *      main process (`page-title-updated`), without injecting anything.
 *
 * The notification shim must live in the page's main world, otherwise WhatsApp
 * and Telegram keep using their own `window.Notification`. contextBridge gives
 * us a narrow, serializable bridge; `webFrame.executeJavaScript` installs the
 * wrapper in the main world before the web client boots.
 */
contextBridge.exposeInMainWorld('__mhNotify', (payload: { title?: string; body?: string }) => {
  ipcRenderer.send('account:notification', {
    title: typeof payload?.title === 'string' ? payload.title.slice(0, 300) : '',
    body: typeof payload?.body === 'string' ? payload.body.slice(0, 500) : ''
  });
});

const NOTIFICATION_SHIM = `(() => {
  if (window.__mhNotificationShim) return;
  window.__mhNotificationShim = true;

  const send = (title, options) => {
    try {
      window.__mhNotify({
        title: String(title || 'Nuevo mensaje'),
        body: String((options && options.body) || '')
      });
    } catch (error) {
      // Never break the web client because of a notification.
    }
  };

  function HubNotification(title, options) {
    send(title, options);
    const target = new EventTarget();
    target.onclick = null;
    target.onclose = null;
    target.onerror = null;
    target.onshow = null;
    target.close = () => {};
    return target;
  }

  HubNotification.permission = 'granted';
  HubNotification.maxActions = 2;
  HubNotification.requestPermission = () => Promise.resolve('granted');

  try {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: HubNotification
    });
  } catch (error) {
    window.Notification = HubNotification;
  }

  // Service-worker notifications are also routed to the main process when the
  // page itself calls showNotification().
  try {
    const registration = window.ServiceWorkerRegistration;
    if (registration && registration.prototype && registration.prototype.showNotification) {
      registration.prototype.showNotification = function (title, options) {
        send(title, options);
        return Promise.resolve();
      };
    }
  } catch (error) {
    // Ignore: the page simply keeps its native behavior.
  }
})();`;

try {
  // webFrame.executeJavaScript may return the value synchronously or a promise
  // depending on the Electron version; normalize both cases.
  void Promise.resolve(webFrame.executeJavaScript(NOTIFICATION_SHIM)).catch((err: unknown) => {
    console.warn('[mh] could not install notification shim:', err);
  });
} catch (err) {
  console.warn('[mh] notification shim unavailable:', err);
}
