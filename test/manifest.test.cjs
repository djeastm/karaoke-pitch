const assert = require('node:assert/strict');
const { test } = require('node:test');

const { manifestFor, baseManifest } = require('../build.js');

test('the Chrome manifest drops Firefox-only keys and uses a service worker', () => {
  const manifest = manifestFor('chrome');
  // Chrome MV3 rejects `background.scripts`.
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.equal(manifest.action.default_area, undefined);
  assert.equal(manifest.minimum_chrome_version, '116');
});

test('the Chrome manifest references only PNG icons', () => {
  const manifest = manifestFor('chrome');
  const paths = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  // Chrome silently shows a blank icon for SVG, so catch any that slip back in.
  assert.ok(paths.length > 0);
  for (const file of paths) assert.match(file, /\.png$/);
  // The Web Store requires a 128px icon on the listing.
  assert.equal(manifest.icons['128'], 'icons/icon-128.png');
});

test('the Firefox manifest is unchanged and the transforms do not share state', () => {
  assert.deepEqual(manifestFor('firefox'), baseManifest);
  // The Chrome transform mutates its argument; run it first to prove the
  // Firefox manifest is still built from a pristine copy.
  manifestFor('chrome');
  assert.deepEqual(manifestFor('firefox'), baseManifest);
  assert.ok(manifestFor('firefox').browser_specific_settings.gecko.id);
});

test('both targets agree on version and content script matches', () => {
  const chrome = manifestFor('chrome');
  const firefox = manifestFor('firefox');
  assert.equal(chrome.version, firefox.version);
  assert.deepEqual(chrome.content_scripts, firefox.content_scripts);
  assert.deepEqual(chrome.web_accessible_resources, firefox.web_accessible_resources);
  assert.deepEqual(chrome.permissions, firefox.permissions);
});

test('both targets open the Saved songs page as the options page, in a tab', () => {
  for (const name of ['firefox', 'chrome']) {
    assert.deepEqual(manifestFor(name).options_ui, { page: 'saved.html', open_in_tab: true }, name);
  }
  // The index reads storage it already has; it needs nothing new.
  assert.deepEqual(baseManifest.permissions, ['storage']);
});
