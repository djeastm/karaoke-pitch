/* Karaoke Pitch — Saved songs page.
 * Lists every per-video pitch saved from the panel, newest first, with a
 * search box. Registered as the options page and opened from the panel's ☰
 * button. The only writes are the new-tab option and removing a save (which
 * can be undone).
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
    notice: document.getElementById('notice'),
    noticeText: document.getElementById('notice-text'),
    undo: document.getElementById('undo'),
  };

  let songs = null;
  let newTab = false;
  let loadRequest = 0;
  // The last removal, kept so Undo can write it back. `done` settles once
  // storage has dropped it, so the restore can't land before the removal.
  let removed = null;
  // The rendered rows' Remove buttons, in order, for moving focus after one goes.
  let removeButtons = [];

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
    return sortSongs(result);
  }

  // Newest first; saves from before titles were recorded have no date and go
  // last, alphabetically so the order stays stable.
  function sortSongs(list) {
    return list.sort((a, b) =>
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

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'kp-remove';
    remove.textContent = '✕';
    remove.title = 'Remove from saved songs';
    remove.setAttribute('aria-label', `Remove ${songName(song)} from saved songs`);
    remove.addEventListener('click', () => removeSong(song, removeButtons.indexOf(remove)));
    removeButtons.push(remove);

    link.append(title, details);
    item.append(link, pitch, remove);
    return item;
  }

  const songName = (song) => (song.title ? `“${song.title}”` : `untitled video ${song.id}`);

  function showNotice(text, canUndo) {
    els.noticeText.textContent = text;
    els.undo.hidden = !canUndo;
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.noticeText.textContent = '';
    els.notice.hidden = true;
  }

  // Only the latest removal can be undone; a new one makes the last final.
  async function removeSong(song, index) {
    if (songs === null) return;
    // Drop any read already in flight, which could bring the row back; the
    // change event from this removal triggers a fresh one.
    loadRequest++;
    songs = songs.filter((s) => s.id !== song.id);
    render();
    focusRemoveButton(Math.min(index, removeButtons.length - 1));

    const done = (async () => {
      await browserAPI.storage.local.remove([PITCH_PREFIX + song.id, META_PREFIX + song.id]);
    })();
    const entry = { song, done };
    removed = entry;
    showNotice(`Removed ${songName(song)}.`, true);
    try {
      await done;
    } catch (e) {
      if (removed === entry) {
        removed = null;
        showNotice(`Could not remove ${songName(song)}. Try again.`, false);
      }
      load();
    }
  }

  // Keeps keyboard users on the list rather than dropping focus to the page.
  function focusRemoveButton(index) {
    const target = removeButtons[index] || els.search;
    if (target.focus) target.focus();
  }

  async function undoRemove() {
    const entry = removed;
    if (!entry) return;
    removed = null;
    hideNotice();
    const { song } = entry;
    const values = { [PITCH_PREFIX + song.id]: song.pitch };
    const meta = {};
    if (song.title) meta.title = song.title;
    if (song.savedAt !== null) meta.savedAt = song.savedAt;
    if (Object.keys(meta).length) values[META_PREFIX + song.id] = meta;

    loadRequest++;
    if (songs !== null) {
      if (!songs.includes(song)) songs = sortSongs([...songs.filter((s) => s.id !== song.id), song]);
      focusRemoveButton(render().indexOf(song));
    }
    try {
      await entry.done.catch(() => {});
      await browserAPI.storage.local.set(values);
    } catch (e) {
      showNotice(`Could not restore ${songName(song)}.`, false);
      load();
    }
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

    removeButtons = [];
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
    return shown;
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
  els.undo.addEventListener('click', undoRemove);

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
