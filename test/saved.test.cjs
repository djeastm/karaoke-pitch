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
  }
  append(...children) { this.children.push(...children); }
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

const decoy = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`unexpected use of the decoy extension API (read "${String(prop)}")`);
  },
});

async function setup(stored = {}, { globals = ['browser'], decoys = [], get } = {}) {
  const ids = { count: 'p', search: 'input', 'new-tab': 'input', status: 'p', list: 'ul' };
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
      },
      onChanged: { addListener: (listener) => changeListeners.push(listener) },
    },
  };
  const sandbox = { document, console };
  for (const name of decoys) sandbox[name] = decoy;
  for (const name of globals) sandbox[name] = api;
  vm.runInNewContext(savedScript, sandbox);
  await flush();

  const { list, search, status, count } = byId;
  const newTab = byId['new-tab'];
  return {
    reads, stored, status, count, newTab,
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
    [`savedPitchMeta:${ID_NEW}`]: { title: 'The only valid one', savedAt: 5 },
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

test('0.3.0 saves without a title stay hidden until they get one, and dated saves come first', async () => {
  const stored = {
    ...songs(),
    [`savedPitch:${ID_LEGACY}`]: -12,
    // A malformed meta entry is treated as missing.
    'savedPitch:zzzzzzzzzzz': 12,
    'savedPitchMeta:zzzzzzzzzzz': 'not an object',
    'savedPitch:yyyyyyyyyyy': 1,
    'savedPitchMeta:yyyyyyyyyyy': { title: '   ' },
  };
  const app = await setup(stored);
  assert.equal(app.rows().length, 3);
  assert.equal(app.count.textContent, '3 saved songs');
  app.search('LEGACY');
  assert.deepEqual(app.rows(), []);

  // The panel fills the title in (without a date) when the video is opened.
  app.search('');
  stored[`savedPitchMeta:${ID_LEGACY}`] = { title: 'A Long Lost Favourite' };
  await app.change({ [`savedPitchMeta:${ID_LEGACY}`]: { newValue: stored[`savedPitchMeta:${ID_LEGACY}`] } });
  const last = app.rows().at(-1);
  assert.deepEqual(last, {
    title: 'A Long Lost Favourite', details: '', pitch: '-12 st', href: `https://www.youtube.com/watch?v=${ID_LEGACY}`,
  });
  assert.equal(app.count.textContent, '4 saved songs');
});

test('only untitled 0.3.0 saves explains where they went', async () => {
  const app = await setup({ [`savedPitch:${ID_LEGACY}`]: 2 });
  assert.deepEqual(app.rows(), []);
  assert.equal(app.count.textContent, '0 saved songs');
  assert.equal(app.status.textContent, 'Songs saved before version 0.4 appear here once you play them again.');
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
