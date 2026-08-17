/* Karaoke Pitch — background script.
 * Handles the toolbar button: clicking it toggles the floating panel on/off
 * across all YouTube tabs. The panel defaults to hidden.
 */
(() => {
  'use strict';

  const KEY = 'showPanel';

  function getShowPanel() {
    return browser.storage.local.get({ [KEY]: false }).then((res) => res[KEY] === true);
  }

  function updateAction(value) {
    // Grayed-out icon when the panel is hidden, full-color when shown.
    browser.action.setIcon({ path: value ? 'icons/icon.svg' : 'icons/icon-disabled.svg' });
    browser.action.setBadgeText({ text: value ? 'ON' : '' });
    browser.action.setBadgeBackgroundColor({ color: value ? '#2e7d32' : '#666666' });
    browser.action.setTitle({
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

  browser.action.onClicked.addListener(async () => {
    let next;
    try {
      next = !(await getShowPanel());
      await browser.storage.local.set({ [KEY]: next });
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
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, { type: 'setShowPanel', value: next })
          .catch(() => {});
      }
    } catch (e) {
      /* ignore */
    }
  });

  refreshAction();
})();
