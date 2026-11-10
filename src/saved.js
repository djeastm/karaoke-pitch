/* Karaoke Pitch — Saved songs page.
 * Lists every per-video pitch saved from the panel, newest first, with a
 * search box. Registered as the options page and opened from the panel's ☰
 * button. Reads storage.local only; nothing here writes.
 */
(() => {
  'use strict';

  const MIN_SEMITONES = -12;
  const MAX_SEMITONES = 12;
  const PITCH_PREFIX = 'savedPitch:';
  const META_PREFIX = 'savedPitchMeta:';
  const VIDEO_ID = /^[\w-]{11}$/;
  // Songs open in this tab unless the user ticks "Open songs in a new tab".
  const NEW_TAB_KEY = 'savedSongsNewTab';

  // Same shim as the content and background scripts: `browser` must win
  // because Firefox also defines a callback-style `chrome`.
  const browserAPI = globalThis.browser ?? globalThis.chrome ?? null;

  const formatPitch = (s) => `${s > 0 ? '+' : ''}${s} st`;

  const els = {
    count: document.getElementById('count'),
    search: document.getElementById('search'),
    newTab: document.getElementById('new-tab'),
    status: document.getElementById('status'),
    list: document.getElementById('list'),
  };

  let songs = null;
  let newTab = false;
  let loadRequest = 0;

  // Turns the whole of storage.local into display rows. Anything that the
  // content script would not accept as a saved pitch is skipped.
  function collectSongs(items) {
    const result = [];
    for (const [key, pitch] of Object.entries(items || {})) {
      if (!key.startsWith(PITCH_PREFIX)) continue;
      const id = key.slice(PITCH_PREFIX.length);
      if (!VIDEO_ID.test(id)) continue;
      if (!Number.isInteger(pitch) || pitch < MIN_SEMITONES || pitch > MAX_SEMITONES) continue;
      const meta = items[META_PREFIX + id];
      const title = meta && typeof meta.title === 'string' ? meta.title.trim() : '';
      const savedAt = meta && Number.isFinite(meta.savedAt) ? meta.savedAt : null;
      result.push({ id, pitch, title, savedAt });
    }
    // Newest first; saves from before titles were recorded have no date and
    // go last, alphabetically so the order stays stable.
    return result.sort((a, b) =>
      (b.savedAt ?? -Infinity) - (a.savedAt ?? -Infinity)
      || (a.title || '￿').localeCompare(b.title || '￿')
      || a.id.localeCompare(b.id));
  }

  const searchTerms = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);

  function matches(song, terms) {
    const haystack = `${song.title} ${song.id}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }

  function formatDate(timestamp) {
    try {
      return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function renderSong(song) {
    const item = document.createElement('li');
    item.className = 'kp-song';

    const link = document.createElement('a');
    link.className = 'kp-link';
    link.href = `https://www.youtube.com/watch?v=${song.id}`;
    // Ctrl/middle-click still opens a new tab either way; this sets the
    // default for a plain click.
    link.target = newTab ? '_blank' : '';
    link.rel = newTab ? 'noopener noreferrer' : '';

    const title = document.createElement('span');
    title.className = song.title ? 'kp-song-title' : 'kp-song-title kp-untitled';
    title.textContent = song.title || 'Untitled video';

    const details = document.createElement('span');
    details.className = 'kp-song-details';
    const parts = [];
    if (!song.title) parts.push(song.id);
    if (song.savedAt !== null) {
      const date = formatDate(song.savedAt);
      if (date) parts.push(`Saved ${date}`);
    }
    details.textContent = parts.join(' · ');

    const pitch = document.createElement('span');
    pitch.className = 'kp-pitch';
    pitch.textContent = formatPitch(song.pitch);

    link.append(title, details);
    item.append(link, pitch);
    return item;
  }

  function setStatus(text) {
    els.status.textContent = text;
    els.status.hidden = !text;
  }

  function render() {
    if (songs === null) return;
    const query = els.search.value.trim();
    const terms = searchTerms(query);
    const shown = songs.filter((song) => matches(song, terms));

    els.list.replaceChildren(...shown.map(renderSong));

    const total = `${songs.length} saved ${songs.length === 1 ? 'song' : 'songs'}`;
    els.count.textContent = terms.length && songs.length ? `${shown.length} of ${total}` : total;

    if (!songs.length) {
      setStatus('No saved songs yet. Open a YouTube video, set the pitch in the Karaoke Pitch panel and click Save.');
    } else if (!shown.length) {
      setStatus(`No saved songs match “${query}”.`);
    } else {
      setStatus('');
    }
  }

  async function load() {
    const request = ++loadRequest;
    try {
      const items = await browserAPI.storage.local.get(null);
      if (request !== loadRequest) return;
      newTab = items?.[NEW_TAB_KEY] === true;
      els.newTab.checked = newTab;
      songs = collectSongs(items);
      render();
    } catch (e) {
      if (request !== loadRequest) return;
      songs = null;
      els.list.replaceChildren();
      els.count.textContent = '';
      setStatus('Could not read your saved songs. Reload the page to try again.');
    }
  }

  els.search.addEventListener('input', render);

  els.newTab.addEventListener('change', () => {
    newTab = els.newTab.checked === true;
    render();
    try {
      browserAPI.storage.local.set({ [NEW_TAB_KEY]: newTab }).catch(() => {});
    } catch (e) {
      /* the choice still applies until the page is closed */
    }
  });

  // A save made in another tab shows up here without a reload.
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // NEW_TAB_KEY keeps the checkbox in step across open Saved songs pages.
    if (Object.keys(changes).some((key) =>
      key === NEW_TAB_KEY || key.startsWith(PITCH_PREFIX) || key.startsWith(META_PREFIX))) {
      load();
    }
  });

  load();
})();
