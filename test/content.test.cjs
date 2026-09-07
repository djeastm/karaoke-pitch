const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const contentScript = readFileSync(require.resolve('../src/content.js'), 'utf8');
const VIDEO_A = 'abcdefghijk';
const VIDEO_B = 'lmnopqrstuv';
const flush = () => new Promise((resolve) => setImmediate(resolve));

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.attributes = {};
    this.textContent = '';
    this.classes = new Set();
    this.classList = {
      toggle: (name, enabled = !this.classes.has(name)) => {
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
    };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  emit(name) {
    if (name === 'click' && this.disabled) return;
    for (const listener of this.listeners[name] || []) listener({ target: this });
  }
}

async function setup(stored = {}, overrides = {}) {
  const elements = [];
  const document = new Element('document');
  document.body = new Element('body');
  document.documentElement = new Element('html');
  document.createElement = (tag) => {
    const element = new Element(tag);
    elements.push(element);
    return element;
  };
  // Keeping the same discovered element tests navigation independently of
  // replacing the media element, as on YouTube's single-page watch view.
  document.querySelector = () => null;
  const window = new Element('window');
  window.top = window;
  window.location = { href: `https://www.youtube.com/watch?v=${VIDEO_A}` };
  const storage = {
    async get(key) {
      if (typeof key === 'string') return { [key]: stored[key] };
      return { ...key, ...stored };
    },
    async set(values) { Object.assign(stored, values); },
    ...overrides,
  };
  vm.runInNewContext(contentScript, {
    window, document, URL, console,
    browser: { storage: { local: storage }, runtime: { onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: (callback) => callback(),
  });
  await flush();
  const save = elements.find((element) => element.className?.includes('kp-save'));
  const slider = elements.find((element) => element.tag === 'input');
  return {
    save, slider, stored, storage, elements,
    reset: elements.find((element) => element.textContent === 'Reset'),
    edit(value) { slider.value = String(value); slider.emit('input'); },
    async navigate(path, event = 'yt-navigate-finish') {
      window.location.href = `https://www.youtube.com${path}`;
      (event === 'popstate' ? window : document).emit(event);
      await flush();
    },
  };
}

test('Save sits left of Reset and persists a pitch across page loads', async () => {
  const app = await setup();
  const row = app.elements.find((element) => element.children.includes(app.save));
  assert.equal(row.children.indexOf(app.save) + 1, row.children.indexOf(app.reset));
  app.edit(-3);
  app.save.emit('click');
  await flush();
  assert.equal(app.stored[`savedPitch:${VIDEO_A}`], -3);
  assert.equal(app.save.textContent, 'Saved ✓');
  assert.equal(app.save.disabled, true);

  const reopened = await setup({ ...app.stored, semitones: 2 });
  assert.equal(reopened.slider.value, '2');
  assert.equal(reopened.save.textContent, 'Use -3 st');
  reopened.save.emit('click');
  assert.equal(reopened.slider.value, '-3');
});

test('navigation offers each video’s saved pitch without automatically applying it', async () => {
  const app = await setup({ semitones: 1, [`savedPitch:${VIDEO_A}`]: -4, [`savedPitch:${VIDEO_B}`]: 0 });
  await app.navigate(`/watch?v=${VIDEO_B}&list=playlist`);
  assert.equal(app.save.textContent, 'Use 0 st');
  assert.equal(app.slider.value, '1');
  app.save.emit('click');
  assert.equal(app.slider.value, '0');
  await app.navigate(`/watch?v=${VIDEO_A}&t=60`, 'popstate');
  assert.equal(app.save.textContent, 'Use -4 st');
  assert.equal(app.slider.value, '0');
  await app.navigate(`/shorts/${VIDEO_A}`);
  assert.equal(app.save.textContent, 'Use -4 st');
  await app.navigate('/');
  assert.equal(app.save.disabled, true);
});

test('manual changes replace saved pitches, while Reset preserves them for restoring', async () => {
  const app = await setup({ [`savedPitch:${VIDEO_A}`]: -2 });
  app.save.emit('click');
  app.edit(4);
  assert.equal(app.save.textContent, 'Save');
  app.save.emit('click');
  await flush();
  assert.equal(app.stored[`savedPitch:${VIDEO_A}`], 4);
  app.reset.emit('click');
  assert.equal(app.slider.value, '0');
  assert.equal(app.save.textContent, 'Use +4 st');
  assert.equal(app.stored[`savedPitch:${VIDEO_A}`], 4);
  app.save.emit('click');
  assert.equal(app.slider.value, '4');
});

test('zero is saved as a valid pitch and failed saves offer a retry', async () => {
  let fail = true;
  const stored = {};
  const app = await setup(stored, {
    async set(values) {
      if (fail) throw new Error('Storage unavailable');
      Object.assign(stored, values);
    },
  });
  app.save.emit('click');
  await flush();
  assert.equal(app.save.textContent, 'Retry save');
  assert.equal(stored[`savedPitch:${VIDEO_A}`], undefined);
  fail = false;
  app.save.emit('click');
  await flush();
  assert.equal(stored[`savedPitch:${VIDEO_A}`], 0);
  assert.equal(app.save.textContent, 'Saved ✓');
});

test('a stale storage read cannot show a previous video’s pitch', async () => {
  let finishRead;
  const app = await setup({}, {
    async get(key) {
      if (typeof key !== 'string') return key;
      if (key === `savedPitch:${VIDEO_A}`) return new Promise((resolve) => { finishRead = resolve; });
      return { [key]: 5 };
    },
  });
  assert.equal(app.save.disabled, true);
  await app.navigate(`/watch?v=${VIDEO_B}`);
  finishRead({ [`savedPitch:${VIDEO_A}`]: -6 });
  await flush();
  assert.equal(app.save.textContent, 'Use +5 st');
});

test('a save completing after navigation stays associated with its original video', async () => {
  let finishSave;
  const stored = { [`savedPitch:${VIDEO_B}`]: 7 };
  const app = await setup(stored, {
    async set(values) {
      if (!Object.keys(values).some((key) => key.startsWith('savedPitch:'))) return;
      await new Promise((resolve) => { finishSave = resolve; });
      Object.assign(stored, values);
    },
  });
  app.edit(-5);
  app.save.emit('click');
  await app.navigate(`/watch?v=${VIDEO_B}`);
  finishSave();
  await flush();
  assert.equal(stored[`savedPitch:${VIDEO_A}`], -5);
  assert.equal(app.save.textContent, 'Use +7 st');
});
