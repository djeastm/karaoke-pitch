/* Karaoke Pitch — background script.
 * Handles the toolbar button: clicking it toggles the floating panel on/off
 * across all YouTube tabs. The panel defaults to hidden.
 *
 * Runs as a persistent background script in Firefox and as a (restartable)
 * service worker in Chrome, so every listener is registered synchronously at
 * top level and no state is kept in memory between events.
 */
(() => {
  'use strict';

  const KEY = 'showPanel';

  // Injected by build.js via esbuild's `define`: Firefox ships a single SVG per
  // state, Chrome a size-keyed map of PNGs.
  const ICONS = __KP_ICONS__;

  // Firefox exposes `browser` (promise-based); Chrome exposes `chrome`. Firefox
  // also defines a callback-style `chrome` alias, so `browser` must win.
  const browserAPI = globalThis.browser ?? globalThis.chrome ?? null;

  function getShowPanel() {
    return browserAPI.storage.local.get({ [KEY]: false }).then((res) => res[KEY] === true);
  }

  function updateAction(value) {
    // Grayed-out icon when the panel is hidden, full-color when shown.
    browserAPI.action.setIcon({ path: value ? ICONS.enabled : ICONS.disabled });
    browserAPI.action.setBadgeText({ text: value ? 'ON' : '' });
    browserAPI.action.setBadgeBackgroundColor({ color: value ? '#2e7d32' : '#666666' });
    browserAPI.action.setTitle({
      title: value ? 'Karaoke Pitch — hide panel' : 'Karaoke Pitch — show panel'
    });
  }

  async function refreshAction() {
    try {
      updateAction(await getShowPanel());
    } catch (e) {
      /* storage unavailable */
    }
  }

  browserAPI.action.onClicked.addListener(async () => {
    let next;
    try {
      next = !(await getShowPanel());
      await browserAPI.storage.local.set({ [KEY]: next });
    } catch (e) {
      return;
    }

    try {
      updateAction(next);
    } catch (e) {
      /* action APIs may be unavailable (e.g., Firefox for Android) */
    }

    // Notify every open tab so the panel reacts immediately; tabs without the
    // content script simply reject the message, which we ignore.
    try {
      const tabs = await browserAPI.tabs.query({});
      for (const tab of tabs) {
        browserAPI.tabs.sendMessage(tab.id, { type: 'setShowPanel', value: next })
          .catch(() => {});
      }
    } catch (e) {
      /* ignore */
    }
  });

  // Chrome tears the service worker down when idle, losing the icon/badge state
  // it set. Re-derive it whenever the worker starts up again.
  if (browserAPI.runtime.onStartup) {
    browserAPI.runtime.onStartup.addListener(refreshAction);
  }
  if (browserAPI.runtime.onInstalled) {
    browserAPI.runtime.onInstalled.addListener(refreshAction);
  }

  refreshAction();
})();
