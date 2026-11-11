const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const savedScript = readFileSync(require.resolve('../src/saved.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// IDs are 11 characters, as on YouTube.
const ID_OLD = 'oldoldoldol';
const ID_NEW = 'newnewnewne';
const ID_MID = 'midmidmidmi';
const ID_LEGACY = 'legacy_0300';

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.attributes = {};
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { focused = this; }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  emit(name) { for (const listener of this.listeners[name] || []) listener({ target: this }); }
  find(className) {
    if (this.className.split(' ').includes(className)) return this;
    for (const child of this.children) {
      const found = child.find(className);
      if (found) return found;
    }
    return null;
  }
}

// The element most recently given focus, across every page set up.
let focused = null;

const decoy = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`unexpected use of the decoy extension API (read "${String(prop)}")`);
  },
});

async function setup(stored = {}, { globals = ['browser'], decoys = [], get, remove } = {}) {
  const ids = {
    count: 'p', search: 'input', 'new-tab': 'input', status: 'p', list: 'ul',
    notice: 'p', 'notice-text': 'span', undo: 'button',
  };
  const byId = Object.fromEntries(Object.entries(ids).map(([id, tag]) => [id, new Element(tag)]));
  const document = {
    getElementById: (id) => byId[id] ?? null,
    createElement: (tag) => new Element(tag),
  };
  const changeListeners = [];
  const reads = [];
  const api = {
    storage: {
      local: {
        async get(keys) {
          reads.push(keys);
          if (get) return get(keys);
          // The page must ask for everything, so a narrower read fails here.
          assert.equal(keys, null);
          return JSON.parse(JSON.stringify(stored));
        },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) {
          if (remove) return remove(keys);
          for (const key of [].concat(keys)) delete stored[key];
        },
      },
      onChanged: { addListener: (listener) => changeListeners.push(listener) },
    },
  };
  const sandbox = { document, console };
  for (const name of decoys) sandbox[name] = decoy;
  for (const name of globals) sandbox[name] = api;
  vm.runInNewContext(savedScript, sandbox);
  await flush();

  const { list, search, status, count, notice, undo } = byId;
  const newTab = byId['new-tab'];
  return {
    reads, stored, status, count, newTab, notice, undo, searchBox: search,
    noticeText: () => (notice.hidden ? '' : byId['notice-text'].textContent),
    removeButtons: () => list.children.map((item) => item.find('kp-remove')),
    async remove(index) { this.removeButtons()[index].emit('click'); await flush(); },
    async undoRemove() { undo.emit('click'); await flush(); },
    targets: () => list.children.map((item) => item.find('kp-link').target),
    toggleNewTab(checked) { newTab.checked = checked; newTab.emit('change'); },
    rows: () => list.children.map((item) => ({
      title: item.find('kp-song-title').textContent,
      details: item.find('kp-song-details').textContent,
      pitch: item.find('kp-pitch').textContent,
      href: item.find('kp-link').href,
    })),
    titles: () => list.children.map((item) => item.find('kp-song-title').textContent),
    search(value) { search.value = value; search.emit('input'); },
    async change(changes, area = 'local') {
      for (const listener of changeListeners) listener(changes, area);
      await flush();
    },
  };
}

const songs = () => ({
  [`savedPitch:${ID_OLD}`]: -3,
  [`savedPitchMeta:${ID_OLD}`]: { title: 'Dancing Queen (Karaoke Version)', savedAt: 1000 },
  [`savedPitch:${ID_NEW}`]: 2,
  [`savedPitchMeta:${ID_NEW}`]: { title: 'Total Eclipse — Lyrics', savedAt: 3000 },
  [`savedPitch:${ID_MID}`]: 0,
  [`savedPitchMeta:${ID_MID}`]: { title: 'Queen Medley', savedAt: 2000 },
  semitones: 5,
  enabled: true,
  showPanel: true,
});

test('lists every saved song, newest first, linking to its watch page', async () => {
  const app = await setup(songs());
  const rows = app.rows();
  assert.deepEqual(rows.map((row) => row.title), [
    'Total Eclipse — Lyrics', 'Queen Medley', 'Dancing Queen (Karaoke Version)',
  ]);
  assert.deepEqual(rows.map((row) => row.pitch), ['+2 st', '0 st', '-3 st']);
  assert.equal(rows[0].href, `https://www.youtube.com/watch?v=${ID_NEW}`);
  assert.equal(app.count.textContent, '3 saved songs');
  assert.equal(app.status.hidden, true);
});

test('search matches every term in the title or ID, ignoring case', async () => {
  const app = await setup(songs());
  app.search('QUEEN');
  assert.deepEqual(app.titles(), ['Queen Medley', 'Dancing Queen (Karaoke Version)']);
  assert.equal(app.count.textContent, '2 of 3 saved songs');

  app.search('  karaoke   queen ');
  assert.deepEqual(app.titles(), ['Dancing Queen (Karaoke Version)']);

  app.search(ID_NEW.slice(0, 6).toUpperCase());
  assert.deepEqual(app.titles(), ['Total Eclipse — Lyrics']);

  app.search('abba');
  assert.deepEqual(app.titles(), []);
  assert.equal(app.status.hidden, false);
  assert.equal(app.status.textContent, 'No saved songs match “abba”.');

  app.search('');
  assert.equal(app.titles().length, 3);
  assert.equal(app.status.hidden, true);
});

test('skips anything that is not a valid saved pitch', async () => {
  const app = await setup({
    [`savedPitch:${ID_NEW}`]: 1,
    'savedPitch:short': 2,
    'savedPitch:has spaces!': 2,
    [`savedPitch:${ID_OLD}`]: 13,
    [`savedPitch:${ID_MID}`]: 1.5,
    'savedPitch:aaaaaaaaaaa': '4',
    [`savedPitchMeta:${ID_LEGACY}`]: { title: 'Meta without a pitch', savedAt: 9 },
    semitones: 2,
  });
  assert.deepEqual(app.rows().map((row) => row.href), [`https://www.youtube.com/watch?v=${ID_NEW}`]);
  assert.equal(app.count.textContent, '1 saved song');
});

test('0.3.0 saves without a title show as untitled with their ID, after dated ones', async () => {
  const app = await setup({
    ...songs(),
    [`savedPitch:${ID_LEGACY}`]: -12,
    // A malformed meta entry is treated as missing.
    'savedPitch:zzzzzzzzzzz': 12,
    'savedPitchMeta:zzzzzzzzzzz': 'not an object',
  });
  const rows = app.rows();
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.slice(3), [
    { title: 'Untitled video', details: ID_LEGACY, pitch: '-12 st', href: `https://www.youtube.com/watch?v=${ID_LEGACY}` },
    { title: 'Untitled video', details: 'zzzzzzzzzzz', pitch: '+12 st', href: 'https://www.youtube.com/watch?v=zzzzzzzzzzz' },
  ]);
  // Untitled saves are still findable by ID.
  app.search('LEGACY');
  assert.deepEqual(app.rows().map((row) => row.pitch), ['-12 st']);
});

test('shows an empty state when nothing has been saved', async () => {
  const app = await setup({ semitones: 0 });
  assert.deepEqual(app.rows(), []);
  assert.equal(app.count.textContent, '0 saved songs');
  assert.equal(app.status.hidden, false);
  assert.match(app.status.textContent, /No saved songs yet/);
});

test('a save made in another tab appears without a reload', async () => {
  const stored = songs();
  const app = await setup(stored);
  app.search('eclipse');

  // Unrelated changes do not trigger a re-read.
  await app.change({ semitones: { newValue: 1 } });
  await app.change({ [`savedPitch:${ID_LEGACY}`]: { newValue: 1 } }, 'sync');
  assert.equal(app.reads.length, 1);

  stored[`savedPitch:${ID_LEGACY}`] = 5;
  stored[`savedPitchMeta:${ID_LEGACY}`] = { title: 'Eclipse of the Heart', savedAt: 4000 };
  await app.change({
    [`savedPitch:${ID_LEGACY}`]: { newValue: 5 },
    [`savedPitchMeta:${ID_LEGACY}`]: { newValue: stored[`savedPitchMeta:${ID_LEGACY}`] },
  });
  // The current search still applies to the refreshed list.
  assert.deepEqual(app.titles(), ['Eclipse of the Heart', 'Total Eclipse — Lyrics']);
  assert.equal(app.count.textContent, '2 of 4 saved songs');
});

test('songs open in the same tab unless the new-tab option is ticked, which is remembered', async () => {
  const stored = songs();
  const app = await setup(stored);
  assert.equal(app.newTab.checked, false);
  assert.deepEqual(app.targets(), ['', '', '']);

  app.toggleNewTab(true);
  await flush();
  assert.deepEqual(app.targets(), ['_blank', '_blank', '_blank']);
  assert.equal(stored.savedSongsNewTab, true);

  const reopened = await setup(stored);
  assert.equal(reopened.newTab.checked, true);
  assert.deepEqual(reopened.targets(), ['_blank', '_blank', '_blank']);

  // Another open Saved songs page follows the change.
  stored.savedSongsNewTab = false;
  await reopened.change({ savedSongsNewTab: { newValue: false } });
  assert.equal(reopened.newTab.checked, false);
  assert.deepEqual(reopened.targets(), ['', '', '']);
});

test('reports a storage failure instead of an empty list', async () => {
  const app = await setup({}, { get: async () => { throw new Error('Storage unavailable'); } });
  assert.equal(app.status.hidden, false);
  assert.match(app.status.textContent, /Could not read your saved songs/);
  assert.equal(app.count.textContent, '');
});

test('the extension API resolves on Chrome, which defines only `chrome`', async () => {
  const app = await setup(songs(), { globals: ['chrome'] });
  assert.equal(app.rows().length, 3);
});

test('`browser` wins on Firefox, which defines a callback-style `chrome` too', async () => {
  const app = await setup(songs(), { globals: ['browser'], decoys: ['chrome'] });
  assert.equal(app.rows().length, 3);
});

test('✕ removes a song’s pitch and title from storage, and Undo puts both back', async () => {
  const stored = songs();
  const app = await setup(stored);
  assert.equal(app.removeButtons()[1].attributes['aria-label'], 'Remove “Queen Medley” from saved songs');

  await app.remove(1);
  assert.deepEqual(app.titles(), ['Total Eclipse — Lyrics', 'Dancing Queen (Karaoke Version)']);
  assert.equal(app.count.textContent, '2 saved songs');
  assert.equal(`savedPitch:${ID_MID}` in stored, false);
  assert.equal(`savedPitchMeta:${ID_MID}` in stored, false);
  assert.equal(stored[`savedPitch:${ID_OLD}`], -3);
  assert.equal(app.noticeText(), 'Removed “Queen Medley”.');
  assert.equal(app.undo.hidden, false);
  // Focus moves to the row that took its place.
  assert.equal(focused, app.removeButtons()[1]);

  // The change event from the removal re-reads without bringing it back.
  await app.change({ [`savedPitch:${ID_MID}`]: { oldValue: 0 } });
  assert.equal(app.titles().length, 2);

  await app.undoRemove();
  assert.equal(stored[`savedPitch:${ID_MID}`], 0);
  assert.deepEqual({ ...stored[`savedPitchMeta:${ID_MID}`] }, { title: 'Queen Medley', savedAt: 2000 });
  assert.deepEqual(app.titles(), ['Total Eclipse — Lyrics', 'Queen Medley', 'Dancing Queen (Karaoke Version)']);
  assert.equal(app.noticeText(), '');
  assert.equal(focused, app.removeButtons()[1]);
});

test('only the latest removal can be undone', async () => {
  const stored = songs();
  const app = await setup(stored);
  await app.remove(0);
  await app.remove(0);
  assert.deepEqual(app.titles(), ['Dancing Queen (Karaoke Version)']);
  assert.equal(app.noticeText(), 'Removed “Queen Medley”.');

  await app.undoRemove();
  assert.equal(`savedPitch:${ID_NEW}` in stored, false);
  assert.equal(stored[`savedPitch:${ID_MID}`], 0);
  assert.deepEqual(app.titles(), ['Queen Medley', 'Dancing Queen (Karaoke Version)']);
});

test('an untitled save can be removed while searching, and restored without inventing a title', async () => {
  const stored = { ...songs(), [`savedPitch:${ID_LEGACY}`]: 4 };
  const app = await setup(stored);
  app.search('legacy');
  await app.remove(0);
  assert.equal(`savedPitch:${ID_LEGACY}` in stored, false);
  assert.equal(app.noticeText(), `Removed untitled video ${ID_LEGACY}.`);
  assert.equal(app.status.textContent, 'No saved songs match “legacy”.');
  assert.equal(app.count.textContent, '0 of 3 saved songs');
  // With no rows left, focus falls back to the search box.
  assert.equal(focused, app.searchBox);

  await app.undoRemove();
  assert.equal(stored[`savedPitch:${ID_LEGACY}`], 4);
  assert.equal(`savedPitchMeta:${ID_LEGACY}` in stored, false);
  assert.deepEqual(app.rows().map((row) => row.details), [ID_LEGACY]);
});

test('a failed removal says so and shows the song again', async () => {
  const stored = songs();
  const app = await setup(stored, { remove: async () => { throw new Error('Storage unavailable'); } });
  await app.remove(0);
  assert.equal(app.noticeText(), 'Could not remove “Total Eclipse — Lyrics”. Try again.');
  assert.equal(app.undo.hidden, true);
  assert.equal(app.titles().length, 3);
});
