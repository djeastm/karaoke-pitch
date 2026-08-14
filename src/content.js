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
    analyser: null,
    semitones: 0,
    enabled: true,
    silentWarn: false,
    panel: null,
    slider: null,
    valueEl: null,
    toggleBtn: null,
    warnEl: null,
  };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* ---------- persistence ---------- */
  async function loadSettings() {
    try {
      const res = await browserAPI.storage.local.get({ semitones: 0, enabled: true });
      state.semitones = clamp(Math.round(Number(res.semitones) || 0), MIN_SEMITONES, MAX_SEMITONES);
      state.enabled = res.enabled !== false;
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

    // Side tap for silent-stream detection; it does not affect the signal path.
    let analyser = null;
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      state.analyser = analyser;
    } catch (e) {
      /* ignore */
    }

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
    if (state.analyser) { try { state.analyser.disconnect(); } catch (e) {} }
    state.video = null;
    state.source = null;
    state.stNode = null;
    state.gain = null;
    state.analyser = null;
    updatePanelVisibility();
  }

  /* ---------- video discovery ---------- */
  const findVideo = () => document.querySelector('video');

  function checkVideo() {
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
  }

  /* ---------- UI ---------- */
  function updatePanelVisibility() {
    if (!state.panel) return;
    state.panel.style.display = state.video ? '' : 'none';
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
  }

  function step(delta) {
    state.semitones = clamp(state.semitones + delta, MIN_SEMITONES, MAX_SEMITONES);
    applyPitch();
    updateUI();
    saveSettings();
    resumeContext();
  }

  function setSemitones(value) {
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

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'kp-btn kp-btn-small';
    toggle.setAttribute('aria-label', 'Toggle pitch shift on or off');

    row2.append(valueEl, reset, toggle);

    const warn = document.createElement('div');
    warn.className = 'kp-warn';
    warn.textContent = '\u26A0 Awaiting audio...';
    warn.hidden = true;

    body.append(row, row2, warn);
    panel.append(handle, body);
    document.body.appendChild(panel);

    state.panel = panel;
    state.slider = slider;
    state.valueEl = valueEl;
    state.toggleBtn = toggle;
    state.warnEl = warn;

    slider.addEventListener('input', () => setSemitones(slider.value));
    minus.addEventListener('click', () => step(-1));
    plus.addEventListener('click', () => step(1));
    reset.addEventListener('click', () => setSemitones(0));
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

  /* ---------- silent-stream warning ---------- */
  function startSilenceWatch() {
    setInterval(() => {
      if (!state.analyser || !state.video || !state.warnEl) return;
      const playing = !state.video.paused && !state.video.ended && state.video.readyState >= 2;
      if (!playing) return;
      const data = new Uint8Array(state.analyser.fftSize);
      state.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const audible = Math.sqrt(sum / data.length) > 0.01;
      if (state.silentWarn !== !audible) {
        state.silentWarn = !audible;
        state.warnEl.hidden = audible;
      }
    }, 2000);
  }

  /* ---------- init ---------- */
  async function init() {
    if (window.top !== window) return;
    await loadSettings();
    buildPanel();
    checkVideo();
    startObserving();
    startSilenceWatch();
  }

  init().catch((err) => console.warn('[Karaoke Pitch] init failed:', err));
})();
