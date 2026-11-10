/* Karaoke Pitch — content script.
 * Routes the YouTube <video> element's audio through a tempo-preserving pitch
 * shifter (SoundTouchJS AudioWorklet) and adds a floating control panel.
 */
(() => {
  'use strict';

  const MIN_SEMITONES = -12;
  const MAX_SEMITONES = 12;
  // Processor name registered by dist/soundtouch-processor.js.
  const PROCESSOR_NAME = 'soundtouch-processor';

  // Firefox exposes `browser` (promise-based); Chrome exposes `chrome`. Firefox
  // also defines a callback-style `chrome` alias, so `browser` must win. Every
  // API used here (storage.local, runtime, onMessage) returns promises in both.
  const browserAPI = globalThis.browser ?? globalThis.chrome ?? null;

  // createMediaElementSource() may only be called once per element.
  const attachedElements = new WeakSet();

  // One AudioContext + one worklet registration for the lifetime of the page.
  const engine = {
    ctx: null,
    workletRegistered: false,
  };

  const state = {
    video: null,
    source: null,
    stNode: null,
    gain: null,
    semitones: 0,
    enabled: true,
    showPanel: false,
    panel: null,
    slider: null,
    valueEl: null,
    toggleBtn: null,
    saveBtn: null,
    collapseBtn: null,
    collapsed: false,
    videoId: null,
    savedPitch: null,
    savedMeta: null,
    // The last title seen for a video, and the one shown by the video we just
    // left (which can linger on screen after in-page navigation).
    seenTitle: null,
    leftTitle: '',
    savedPitchReady: false,
    restoreSavedPitch: true,
    savingPitch: false,
    saveError: false,
  };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const formatPitch = (s) => `${s > 0 ? '+' : ''}${s} st`;
  const savedPitchKey = (videoId) => `savedPitch:${videoId}`;
  // Kept beside the bare integer under savedPitch:<id> (which stays as it was in
  // 0.3.0) so the Saved songs page can show something more useful than an ID.
  const savedPitchMetaKey = (videoId) => `savedPitchMeta:${videoId}`;
  let savedPitchRequest = 0;

  // The ☰ drawer: saved songs listed inside the panel, so the user can pick
  // the next one without leaving (or pausing) the video that is playing.
  const drawer = {
    open: false,
    songs: null,
    request: 0,
    el: null,
    button: null,
    search: null,
    list: null,
    status: null,
  };

  /* ---------- persistence ---------- */
  function currentVideoId() {
    const url = new URL(window.location.href);
    const id = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  const collapseSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  // "(3) Song title - YouTube" -> "Song title". The tab title is the fallback
  // for pages without the watch metadata (Shorts, embeds), and may be generic.
  function cleanDocumentTitle(text) {
    const title = collapseSpace(text)
      .replace(/^\(\d+\+?\)\s*/, '')
      .replace(/\s+-\s+YouTube$/, '')
      .trim();
    return title === 'YouTube' ? '' : title;
  }

  // YouTube swaps the watch page in place, so the heading can briefly belong to
  // the previous video; only trust it once the page says which video it shows,
  // and never take the title the previous video was showing.
  function currentVideoTitle(videoId) {
    const page = document.querySelector('ytd-watch-flexy[video-id]');
    if (page && page.getAttribute('video-id') === videoId) {
      const heading = collapseSpace(document.querySelector('ytd-watch-metadata h1')?.textContent);
      if (heading && heading !== state.leftTitle) return heading;
    }
    const title = cleanDocumentTitle(document.title);
    return title !== state.leftTitle ? title : '';
  }

  function validMeta(value) {
    if (!value || typeof value !== 'object') return null;
    const meta = {};
    if (typeof value.title === 'string' && value.title.trim()) meta.title = value.title.trim();
    if (Number.isFinite(value.savedAt)) meta.savedAt = value.savedAt;
    return meta;
  }

  async function readSavedMeta(videoId) {
    const key = savedPitchMetaKey(videoId);
    try {
      return validMeta((await browserAPI.storage.local.get(key))[key]);
    } catch (e) {
      // The title is a nicety; never let it block the saved pitch itself.
      return null;
    }
  }

  // Stricter than currentVideoTitle(), since no one is clicking Save to vouch
  // for it: on watch pages wait for the heading YouTube has tied to this video
  // (a hidden watch page can outlive a visit to Shorts, so only look there on
  // /watch), and never take the previous video's title.
  function observedVideoTitle(videoId) {
    let title;
    if (new URL(window.location.href).pathname === '/watch') {
      const page = document.querySelector('ytd-watch-flexy[video-id]');
      title = page && page.getAttribute('video-id') === videoId
        ? collapseSpace(document.querySelector('ytd-watch-metadata h1')?.textContent)
        : '';
    } else {
      title = cleanDocumentTitle(document.title);
    }
    return title && title !== state.leftTitle ? title : '';
  }

  // Called on every page change. Saves from 0.3.0 have a pitch but no title,
  // and are listed as "Untitled video" until they get one, so fill it in as
  // soon as the video is opened again.
  function observeTitle() {
    const videoId = state.videoId;
    if (!videoId || videoId !== currentVideoId()) return;
    const title = observedVideoTitle(videoId);
    if (!title) return;
    state.seenTitle = { id: videoId, title };
    backfillSavedTitle(title);
  }

  function backfillSavedTitle(title) {
    const videoId = state.videoId;
    const meta = state.savedMeta || {};
    if (!state.savedPitchReady || state.savedPitch === null || state.savingPitch || meta.title) return;
    // No savedAt: when the pitch was saved was never recorded.
    const next = { ...meta, title };
    state.savedMeta = next;
    updateSaveButton();
    try {
      browserAPI.storage.local.set({ [savedPitchMetaKey(videoId)]: next }).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  async function syncSavedPitch() {
    const videoId = currentVideoId();
    if (videoId === state.videoId) return;
    const request = ++savedPitchRequest;
    state.leftTitle = state.videoId && state.seenTitle?.id === state.videoId ? state.seenTitle.title : '';
    state.videoId = videoId;
    state.savedPitch = null;
    state.savedMeta = null;
    state.savedPitchReady = false;
    state.restoreSavedPitch = true;
    state.savingPitch = false;
    state.saveError = false;
    updateSaveButton();
    renderDrawer();
    if (!videoId) return;

    try {
      const key = savedPitchKey(videoId);
      const [result, meta] = await Promise.all([
        browserAPI.storage.local.get(key),
        readSavedMeta(videoId),
      ]);
      if (request !== savedPitchRequest) return;
      const pitch = result[key];
      state.savedPitch = Number.isInteger(pitch) && pitch >= MIN_SEMITONES && pitch <= MAX_SEMITONES
        ? pitch : null;
      state.savedMeta = meta;
      state.savedPitchReady = true;
    } catch (e) {
      if (request !== savedPitchRequest) return;
      state.saveError = true;
    }
    updateSaveButton();
    // The title may already be on screen, with no further page changes coming.
    observeTitle();
  }

  async function saveOrRestorePitch() {
    // Navigation can reuse the same <video> and precede its DOM mutations.
    if (currentVideoId() !== state.videoId) {
      syncSavedPitch();
      return;
    }
    if (!state.videoId || !state.savedPitchReady || state.savingPitch) return;
    // When the pitch already matches, a click re-saves it (with this video's
    // title) rather than restoring a value that is already applied.
    if (state.restoreSavedPitch && state.savedPitch !== null && state.savedPitch !== state.semitones) {
      setSemitones(state.savedPitch);
      return;
    }

    const request = savedPitchRequest;
    const videoId = state.videoId;
    const pitch = state.semitones;
    // Keep a title we already know rather than blanking it if the page has
    // none to offer right now.
    const title = currentVideoTitle(videoId) || state.savedMeta?.title || '';
    const meta = { title, savedAt: Date.now() };
    state.savingPitch = true;
    state.saveError = false;
    updateSaveButton();
    try {
      // One write, so the index never sees a pitch without its title.
      await browserAPI.storage.local.set({
        [savedPitchKey(videoId)]: pitch,
        [savedPitchMetaKey(videoId)]: meta,
      });
      if (request !== savedPitchRequest) return;
      state.savedPitch = pitch;
      state.savedMeta = validMeta(meta);
    } catch (e) {
      if (request !== savedPitchRequest) return;
      state.saveError = true;
    }
    state.savingPitch = false;
    updateSaveButton();
  }

  async function loadSettings() {
    try {
      const res = await browserAPI.storage.local.get({ semitones: 0, enabled: true, showPanel: false });
      state.semitones = clamp(Math.round(Number(res.semitones) || 0), MIN_SEMITONES, MAX_SEMITONES);
      state.enabled = res.enabled !== false;
      state.showPanel = res.showPanel === true;
    } catch (e) {
      /* fall back to defaults */
    }
  }

  function saveSettings() {
    try {
      browserAPI.storage.local.set({ semitones: state.semitones, enabled: state.enabled });
    } catch (e) {
      /* ignore */
    }
  }

  function processorUrl() {
    if (browserAPI && browserAPI.runtime && browserAPI.runtime.getURL) {
      return browserAPI.runtime.getURL('soundtouch-processor.js');
    }
    return 'soundtouch-processor.js';
  }

  /* ---------- audio engine ---------- */
  function ensureContext() {
    if (engine.ctx) return engine.ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    engine.ctx = new Ctor();
    return engine.ctx;
  }

  function resumeContext() {
    if (engine.ctx && engine.ctx.state === 'suspended') {
      engine.ctx.resume().catch(() => {});
    }
  }

  // MediaElementAudioSourceNode does NOT reflect the element's volume/muted
  // state, so we mirror it onto a GainNode ourselves.
  function syncGain() {
    const v = state.video;
    if (!v || !state.gain || !engine.ctx) return;
    const now = engine.ctx.currentTime;
    const target = v.muted ? 0 : typeof v.volume === 'number' ? v.volume : 1;
    const p = state.gain.gain;
    p.cancelScheduledValues(now);
    if (target === 0) {
      p.setValueAtTime(0, now);
    } else {
      p.setTargetAtTime(target, now, 0.02);
    }
  }

  function applyPitch() {
    if (!state.stNode) return;
    const semitones = state.enabled ? state.semitones : 0;
    const params = state.stNode.parameters;
    const pitch = params.get('pitch');
    const pitchSemitones = params.get('pitchSemitones');
    const playbackRate = params.get('playbackRate');
    if (pitch) pitch.value = 1;
    if (pitchSemitones) pitchSemitones.value = semitones;
    if (playbackRate) playbackRate.value = 1;
  }

  async function attachVideo(video) {
    if (!video || attachedElements.has(video)) return;
    attachedElements.add(video);

    const ctx = ensureContext();
    if (!ctx) return;

    let source;
    try {
      source = ctx.createMediaElementSource(video);
    } catch (err) {
      console.warn('[Karaoke Pitch] createMediaElementSource failed:', err);
      return;
    }

    state.video = video;
    state.source = source;

    const gain = ctx.createGain();
    gain.gain.value = 1;
    state.gain = gain;

    let stNode = null;

    // 1) Load the processor module into this AudioContext (once per page).
    try {
      if (!engine.workletRegistered) {
        await ctx.audioWorklet.addModule(processorUrl());
        engine.workletRegistered = true;
      }
    } catch (err) {
      console.warn('[Karaoke Pitch] worklet addModule failed:', err && err.name, err && err.message, err);
    }

    // 2) Build a raw AudioWorkletNode (bypasses the library wrapper so we fully
    //    control the options object that Firefox structured-clones).
    if (engine.workletRegistered) {
      try {
        stNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
      } catch (err) {
        console.warn('[Karaoke Pitch] AudioWorkletNode(options) failed:', err && err.name, err && err.message);
        try {
          stNode = new AudioWorkletNode(ctx, PROCESSOR_NAME);
        } catch (err2) {
          console.warn('[Karaoke Pitch] AudioWorkletNode() failed:', err2 && err2.name, err2 && err2.message, err2);
          stNode = null;
        }
      }
      if (stNode) console.info('[Karaoke Pitch] pitch shifter ready');
    }

    if (stNode) {
      source.connect(stNode);
      stNode.connect(gain);
      state.stNode = stNode;
    } else {
      source.connect(gain);
    }

    gain.connect(ctx.destination);

    syncGain();
    applyPitch();

    video.addEventListener('play', resumeContext, true);
    video.addEventListener('volumechange', syncGain, true);

    updatePanelVisibility();
  }

  function detachVideo() {
    const video = state.video;
    if (video) {
      video.removeEventListener('play', resumeContext, true);
      video.removeEventListener('volumechange', syncGain, true);
    }
    if (state.source) { try { state.source.disconnect(); } catch (e) {} }
    if (state.stNode) { try { state.stNode.disconnect(); } catch (e) {} }
    if (state.gain) { try { state.gain.disconnect(); } catch (e) {} }
    state.video = null;
    state.source = null;
    state.stNode = null;
    state.gain = null;
    updatePanelVisibility();
  }

  /* ---------- video discovery ---------- */
  const findVideo = () => document.querySelector('video');

  function checkVideo() {
    syncSavedPitch();
    observeTitle();
    // Whether Save can add a title depends on what the page shows right now.
    updateSaveButton();
    const current = findVideo();
    if (current === state.video) return;
    if (state.video && !state.video.isConnected) detachVideo();
    if (current) attachVideo(current);
    updatePanelVisibility();
  }

  let rafPending = false;
  function scheduleCheck() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      checkVideo();
    });
  }

  function startObserving() {
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('yt-navigate-finish', scheduleCheck);
    window.addEventListener('popstate', scheduleCheck);
  }

  /* ---------- UI ---------- */
  function updatePanelVisibility() {
    if (!state.panel) return;
    state.panel.style.display = state.video && state.showPanel ? '' : 'none';
  }

  function updateUI() {
    const s = state.semitones;
    if (state.valueEl) {
      state.valueEl.textContent = s === 0 ? '0 st' : `${s > 0 ? '+' : ''}${s} st`;
    }
    if (state.slider) state.slider.value = String(s);
    if (state.toggleBtn) {
      state.toggleBtn.textContent = state.enabled ? 'On' : 'Off';
      state.toggleBtn.classList.toggle('kp-off', !state.enabled);
    }
    if (state.panel) state.panel.classList.toggle('kp-disabled', !state.enabled);
    updateSaveButton();
  }

  function updateSaveButton() {
    const button = state.saveBtn;
    if (!button) return;
    const hasSavedPitch = state.savedPitch !== null;
    const matches = hasSavedPitch && state.savedPitch === state.semitones;
    const canRestore = hasSavedPitch && state.restoreSavedPitch && !matches;
    // A save without a title (e.g. from 0.3.0) can be re-saved as it is, to
    // record the title shown on the page, rather than being "Saved ✓".
    const canAddTitle = matches && state.savedPitchReady && !state.savedMeta?.title
      && Boolean(currentVideoTitle(state.videoId));
    let label = 'Save';
    let title = `Save ${formatPitch(state.semitones)} for this video`;
    if (!state.videoId) {
      title = 'Open a YouTube video to save its pitch';
    } else if (state.savingPitch) {
      label = 'Saving…';
      title = 'Saving pitch for this video';
    } else if (state.saveError) {
      label = state.savedPitchReady ? 'Retry save' : 'Unavailable';
      title = state.savedPitchReady ? 'Could not save pitch. Click to try again.' : 'Could not load saved pitch. Reload the page to try again.';
    } else if (!state.savedPitchReady) {
      label = 'Loading…';
      title = 'Loading saved pitch for this video';
    } else if (canAddTitle) {
      title = `Save this video's title with its saved pitch of ${formatPitch(state.savedPitch)}`;
    } else if (matches) {
      label = 'Saved ✓';
      title = `${formatPitch(state.savedPitch)} is saved for this video. Adjust the pitch to save a new value.`;
    } else if (canRestore) {
      label = `Use ${formatPitch(state.savedPitch)}`;
      title = `Apply the saved pitch of ${formatPitch(state.savedPitch)} for this video`;
    } else if (hasSavedPitch) {
      title += ` (replaces ${formatPitch(state.savedPitch)})`;
    }
    if (button.textContent !== label) button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.disabled = !state.videoId || !state.savedPitchReady || state.savingPitch || (matches && !state.saveError && !canAddTitle);
    button.classList.toggle('kp-saved', hasSavedPitch && !state.saveError);
  }

  function step(delta) {
    setSemitones(state.semitones + delta);
  }

  function setSemitones(value, restoreSavedPitch = false) {
    state.restoreSavedPitch = restoreSavedPitch;
    if (state.savedPitchReady) state.saveError = false;
    state.semitones = clamp(Math.round(Number(value) || 0), MIN_SEMITONES, MAX_SEMITONES);
    applyPitch();
    updateUI();
    saveSettings();
    resumeContext();
  }

  function buildPanel() {
    if (!document.body) return;

    const panel = document.createElement('div');
    panel.id = 'kp-panel';
    panel.className = 'kp-panel';

    const handle = document.createElement('div');
    handle.className = 'kp-handle';
    const title = document.createElement('span');
    title.className = 'kp-title';
    title.textContent = '\u266C Karaoke Pitch';
    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'kp-iconbtn';
    collapse.textContent = '\u2014';
    collapse.setAttribute('aria-label', 'Minimize panel');
    const songs = document.createElement('button');
    songs.type = 'button';
    songs.className = 'kp-iconbtn kp-songs';
    songs.textContent = '☰';
    songs.title = 'Saved songs';
    songs.setAttribute('aria-label', 'Saved songs');
    songs.setAttribute('aria-expanded', 'false');
    const actions = document.createElement('span');
    actions.className = 'kp-actions';
    actions.append(songs, collapse);
    handle.append(title, actions);

    const body = document.createElement('div');
    body.className = 'kp-body';

    const row = document.createElement('div');
    row.className = 'kp-row';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'kp-btn';
    minus.textContent = '\u2212';
    minus.setAttribute('aria-label', 'Lower pitch one semitone');
    minus.title = 'Lower pitch one semitone';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(MIN_SEMITONES);
    slider.max = String(MAX_SEMITONES);
    slider.step = '1';
    slider.className = 'kp-slider';
    slider.setAttribute('aria-label', 'Pitch shift in semitones');

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'kp-btn';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Raise pitch one semitone');
    plus.title = 'Raise pitch one semitone';

    row.append(minus, slider, plus);

    const row2 = document.createElement('div');
    row2.className = 'kp-row kp-row2';

    const valueEl = document.createElement('span');
    valueEl.className = 'kp-value';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'kp-btn kp-btn-small';
    reset.textContent = 'Reset';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'kp-btn kp-btn-small kp-save';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kp-btn kp-btn-small';
    toggle.setAttribute('aria-label', 'Toggle pitch shift on or off');

    row2.append(valueEl, save, reset, toggle);

    body.append(row, row2);
    const songDrawer = buildDrawer();
    panel.append(handle, body, songDrawer);
    document.body.appendChild(panel);

    state.panel = panel;
    state.slider = slider;
    state.valueEl = valueEl;
    state.toggleBtn = toggle;
    state.saveBtn = save;
    state.collapseBtn = collapse;
    drawer.button = songs;

    slider.addEventListener('input', () => setSemitones(slider.value));
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    save.addEventListener('click', saveOrRestorePitch);
    songs.addEventListener('click', () => setDrawerOpen(!drawer.open));
    reset.addEventListener('click', () => setSemitones(0, true));
    toggle.addEventListener('click', () => {
      state.enabled = !state.enabled;
      applyPitch();
      updateUI();
      saveSettings();
      resumeContext();
    });
    collapse.addEventListener('click', () => setCollapsed(!state.collapsed));

    // Any interaction with the panel is a user gesture we can use to resume audio.
    panel.addEventListener('pointerdown', resumeContext, true);

    makeDraggable(panel, handle);

    updateUI();
    updatePanelVisibility();
  }

  function makeDraggable(panel, handle) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      panel.classList.add('kp-dragging');
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = clamp(e.clientX - offsetX, 0, Math.max(0, window.innerWidth - panel.offsetWidth));
      const y = clamp(e.clientY - offsetY, 0, Math.max(0, window.innerHeight - panel.offsetHeight));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });

    const endDrag = (e) => {
      dragging = false;
      panel.classList.remove('kp-dragging');
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  function setCollapsed(value) {
    state.collapsed = value;
    state.panel.classList.toggle('kp-collapsed', value);
    state.collapseBtn.setAttribute('aria-label', value ? 'Expand panel' : 'Minimize panel');
  }

  /* ---------- saved songs drawer ---------- */
  function buildDrawer() {
    const el = document.createElement('div');
    el.className = 'kp-drawer';
    el.hidden = true;

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'kp-drawer-search';
    search.placeholder = 'Search saved songs';
    search.setAttribute('aria-label', 'Search saved songs by title');
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('spellcheck', 'false');

    const status = document.createElement('p');
    status.className = 'kp-drawer-status';
    status.setAttribute('aria-live', 'polite');

    const list = document.createElement('ul');
    list.className = 'kp-drawer-list';
    list.setAttribute('aria-label', 'Saved songs');

    el.append(search, status, list);
    Object.assign(drawer, { el, search, list, status });

    search.addEventListener('input', renderDrawer);
    // Keep typing out of YouTube's keyboard shortcuts (k, f, m, space…).
    const isolate = (e) => {
      if (e.stopPropagation) e.stopPropagation();
      if (e.type === 'keydown' && e.key === 'Escape') {
        setDrawerOpen(false);
        if (drawer.button.focus) drawer.button.focus();
      }
    };
    for (const type of ['keydown', 'keypress', 'keyup']) search.addEventListener(type, isolate);
    return el;
  }

  function setDrawerOpen(open) {
    drawer.open = open;
    drawer.el.hidden = !open;
    drawer.button.setAttribute('aria-expanded', String(open));
    drawer.button.classList.toggle('kp-active', open);
    if (!open) return;
    if (state.collapsed) setCollapsed(false);
    if (drawer.songs === null) setDrawerStatus('Loading…');
    loadDrawer();
    // Skip on touch screens, where focusing would pop the keyboard over the video.
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches && drawer.search.focus) {
      drawer.search.focus({ preventScroll: true });
    }
  }

  function setDrawerStatus(text) {
    drawer.status.textContent = text;
    drawer.status.hidden = !text;
  }

  // Same rules as collectSongs() in saved.js: only entries the panel would
  // accept as a saved pitch, newest first, undated (0.3.0) saves last.
  function collectSavedSongs(items) {
    const songs = [];
    for (const [key, pitch] of Object.entries(items || {})) {
      if (!key.startsWith('savedPitch:')) continue;
      const id = key.slice('savedPitch:'.length);
      if (!/^[\w-]{11}$/.test(id)) continue;
      if (!Number.isInteger(pitch) || pitch < MIN_SEMITONES || pitch > MAX_SEMITONES) continue;
      const meta = validMeta(items[savedPitchMetaKey(id)]) || {};
      songs.push({ id, title: meta.title || '', savedAt: meta.savedAt ?? null });
    }
    return songs.sort((a, b) =>
      (b.savedAt ?? -Infinity) - (a.savedAt ?? -Infinity)
      || (a.title || '\uffff').localeCompare(b.title || '\uffff')
      || a.id.localeCompare(b.id));
  }

  async function loadDrawer() {
    const request = ++drawer.request;
    try {
      const items = await browserAPI.storage.local.get(null);
      if (request !== drawer.request) return;
      drawer.songs = collectSavedSongs(items);
    } catch (e) {
      if (request !== drawer.request) return;
      drawer.songs = null;
      drawer.list.replaceChildren();
      setDrawerStatus('Could not load saved songs.');
      return;
    }
    renderDrawer();
  }

  function renderDrawer() {
    if (!drawer.open || drawer.songs === null) return;
    const terms = (drawer.search.value || '').toLowerCase().split(/\s+/).filter(Boolean);
    const shown = drawer.songs.filter((song) => {
      const title = (song.title || 'Untitled video').toLowerCase();
      return terms.every((term) => title.includes(term));
    });
    drawer.list.replaceChildren(...shown.map(renderDrawerSong));
    setDrawerStatus(!drawer.songs.length ? 'No saved songs yet.' : !shown.length ? 'No matches.' : '');
  }

  function renderDrawerSong(song) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const current = song.id === state.videoId;
    link.className = current ? 'kp-drawer-song kp-current' : 'kp-drawer-song';
    // Relative, so m.youtube.com stays on m.youtube.com.
    link.href = `/watch?v=${song.id}`;
    link.textContent = song.title || 'Untitled video';
    link.title = link.textContent;
    if (current) link.setAttribute('aria-current', 'true');
    item.append(link);
    return item;
  }

  function watchSavedSongs() {
    if (!browserAPI || !browserAPI.storage || !browserAPI.storage.onChanged) return;
    browserAPI.storage.onChanged.addListener((changes, area) => {
      // A closed drawer re-reads when it opens; covers savedPitchMeta: too.
      if (area !== 'local' || !drawer.open) return;
      if (Object.keys(changes).some((key) => key.startsWith('savedPitch'))) loadDrawer();
    });
  }

  /* ---------- toolbar toggle ---------- */
  function initMessaging() {
    if (!browserAPI || !browserAPI.runtime || !browserAPI.runtime.onMessage) return;
    browserAPI.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'setShowPanel') {
        state.showPanel = msg.value === true;
        // The toolbar button is a master switch: hiding the panel also disables
        // the pitch effect (audio reverts to normal), showing it re-enables it.
        state.enabled = state.showPanel;
        applyPitch();
        updateUI();
        saveSettings();
        updatePanelVisibility();
      }
    });
  }

  /* ---------- init ---------- */
  async function init() {
    if (window.top !== window) return;
    await loadSettings();
    buildPanel();
    checkVideo();
    startObserving();
    initMessaging();
    watchSavedSongs();
  }

  init().catch((err) => console.warn('[Karaoke Pitch] init failed:', err));
})();
