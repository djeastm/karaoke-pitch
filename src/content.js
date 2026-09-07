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

  const browserAPI = typeof browser !== 'undefined' ? browser : null;

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
    videoId: null,
    savedPitch: null,
    savedPitchReady: false,
    restoreSavedPitch: true,
    savingPitch: false,
    saveError: false,
  };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const formatPitch = (s) => `${s > 0 ? '+' : ''}${s} st`;
  const savedPitchKey = (videoId) => `savedPitch:${videoId}`;
  let savedPitchRequest = 0;

  /* ---------- persistence ---------- */
  function currentVideoId() {
    const url = new URL(window.location.href);
    const id = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  async function syncSavedPitch() {
    const videoId = currentVideoId();
    if (videoId === state.videoId) return;
    const request = ++savedPitchRequest;
    state.videoId = videoId;
    state.savedPitch = null;
    state.savedPitchReady = false;
    state.restoreSavedPitch = true;
    state.savingPitch = false;
    state.saveError = false;
    updateSaveButton();
    if (!videoId) return;

    try {
      const key = savedPitchKey(videoId);
      const result = await browserAPI.storage.local.get(key);
      if (request !== savedPitchRequest) return;
      const pitch = result[key];
      state.savedPitch = Number.isInteger(pitch) && pitch >= MIN_SEMITONES && pitch <= MAX_SEMITONES
        ? pitch : null;
      state.savedPitchReady = true;
    } catch (e) {
      if (request !== savedPitchRequest) return;
      state.saveError = true;
    }
    updateSaveButton();
  }

  async function saveOrRestorePitch() {
    // Navigation can reuse the same <video> and precede its DOM mutations.
    if (currentVideoId() !== state.videoId) {
      syncSavedPitch();
      return;
    }
    if (!state.videoId || !state.savedPitchReady || state.savingPitch) return;
    if (state.restoreSavedPitch && state.savedPitch !== null) {
      setSemitones(state.savedPitch);
      return;
    }

    const request = savedPitchRequest;
    const videoId = state.videoId;
    const pitch = state.semitones;
    state.savingPitch = true;
    state.saveError = false;
    updateSaveButton();
    try {
      await browserAPI.storage.local.set({ [savedPitchKey(videoId)]: pitch });
      if (request !== savedPitchRequest) return;
      state.savedPitch = pitch;
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
    button.disabled = !state.videoId || !state.savedPitchReady || state.savingPitch || (matches && !state.saveError);
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
    handle.append(title, collapse);

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
    panel.append(handle, body);
    document.body.appendChild(panel);

    state.panel = panel;
    state.slider = slider;
    state.valueEl = valueEl;
    state.toggleBtn = toggle;
    state.saveBtn = save;

    slider.addEventListener('input', () => setSemitones(slider.value));
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    save.addEventListener('click', saveOrRestorePitch);
    reset.addEventListener('click', () => setSemitones(0, true));
    toggle.addEventListener('click', () => {
      state.enabled = !state.enabled;
      applyPitch();
      updateUI();
      saveSettings();
      resumeContext();
    });
    collapse.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('kp-collapsed');
      collapse.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Minimize panel');
    });

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
  }

  init().catch((err) => console.warn('[Karaoke Pitch] init failed:', err));
})();
