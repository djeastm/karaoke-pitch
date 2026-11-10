const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const backgroundScript = readFileSync(require.resolve('../src/background.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const messageListeners = [];
  let optionsOpened = 0;
  const event = () => ({ addListener() {} });
  const api = {
    storage: { local: { async get(defaults) { return defaults; }, async set() {} } },
    action: {
      onClicked: event(),
      setIcon() {}, setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {},
    },
    tabs: { async query() { return []; }, async sendMessage() {} },
    runtime: {
      onStartup: event(),
      onInstalled: event(),
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      async openOptionsPage() { optionsOpened += 1; },
    },
  };
  // __KP_ICONS__ is normally injected by build.js.
  vm.runInNewContext(backgroundScript, { browser: api, __KP_ICONS__: { enabled: 'on', disabled: 'off' } });
  return {
    get optionsOpened() { return optionsOpened; },
    send: (message) => messageListeners.map((listener) => listener(message, {})),
  };
}

test('the background script opens the Saved songs page on request', async () => {
  const app = setup();
  const replies = app.send({ type: 'openSavedSongs' });
  await flush();
  assert.equal(app.optionsOpened, 1);
  // Nothing is returned, so Chrome does not keep the message channel open.
  assert.deepEqual(replies, [undefined]);

  app.send({ type: 'somethingElse' });
  app.send(null);
  await flush();
  assert.equal(app.optionsOpened, 1);
});
