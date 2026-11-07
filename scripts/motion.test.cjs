const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const root = path.resolve(__dirname, '..');
function setup({ os = false, saved = null, storageFails = false, search = '' } = {}) {
  const system = new EventTarget();
  system.matches = os;
  const button = new EventTarget();
  button.attrs = {};
  button.setAttribute = (key, value) => (button.attrs[key] = value);
  const window = new EventTarget(),
    document = {
      documentElement: { dataset: {} },
      getElementById: () => button,
      addEventListener() {},
    };
  const storage = {
    getItem() {
      if (storageFails) throw Error('Storage blocked');
      return saved;
    },
    removeItem() {
      if (storageFails) throw Error('Storage blocked');
      saved = null;
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'frame-clock.js'), 'utf8'), {
    window,
    document,
    location: { search },
    URLSearchParams,
    matchMedia: () => system,
    localStorage: storage,
    EventTarget,
    Event,
    requestAnimationFrame() {},
  });
  return { window, document, button, system, motion: window.CockpitMotion, saved: () => saved };
}
test('default flight stays animated even when the OS requests or changes reduced motion', () => {
  const x = setup();
  let changes = 0;
  x.motion.addEventListener('change', () => changes++);
  x.system.matches = true;
  x.system.dispatchEvent(new Event('change'));
  assert.equal(x.motion.matches, false);
  assert.equal(x.motion.source, 'default');
  assert.equal(x.motion.systemReduced, true);
  x.system.matches = false;
  x.system.dispatchEvent(new Event('change'));
  assert.equal(x.motion.matches, false);
  assert.equal(changes, 0);
  assert.equal(setup({ os: true }).motion.matches, false);
});
test('only an explicit reduced-motion URL suppresses movement, independent of OS and storage', () => {
  for (const os of [false, true]) {
    const x = setup({ os, search: '?utm_source=test&motion=reduced', storageFails: true });
    assert.equal(x.motion.matches, true);
    assert.equal(x.motion.source, 'request');
    assert.equal(x.document.documentElement.dataset.motion, 'reduced');
  }
  assert.equal(setup({ os: true, search: '?motion=full' }).motion.matches, false);
  assert.equal(setup({ os: true, search: '?motion=unknown' }).motion.matches, false);
});
test('old site overrides are removed and ignored even when storage is blocked', () => {
  const x = setup({ os: false, saved: 'true' });
  assert.equal(x.motion.matches, false);
  assert.equal(x.saved(), null);
  assert.equal(setup({ os: true, saved: 'false' }).motion.matches, false);
  assert.equal(setup({ os: false, saved: 'true', storageFails: true }).motion.matches, false);
  assert.equal(setup({ os: true, storageFails: true }).motion.matches, false);
});
test('there is no motion button or site override API', () => {
  assert.equal(setup().motion.setReduced, undefined);
  assert(!fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('motion-toggle'));
  assert(!fs.readFileSync(path.join(root, 'style.css'), 'utf8').includes('motion-toggle'));
});
test('reduced motion settles automatic hinge return but preserves a directly held pose', () => {
  const window = {
    CockpitMotion: { matches: true },
    CockpitFrame: {
      cancel() {},
      request() {
        throw Error('Must not animate');
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hinges.js'), 'utf8'), { window });
  const monitor = Object.create(window.HingedMonitors.prototype);
  Object.assign(monitor, {
    doorFrame: 4,
    doors: { left: { start: 0, offset: 20 }, right: { offset: 15 } },
    reopening: { left: { angle: 10 }, right: null },
    angles: { left: 10, right: 5 },
    render() {
      this.rendered = true;
    },
  });
  monitor.animateDoors(100);
  assert.equal(monitor.doorFrame, 0);
  assert.equal(monitor.doors.left, null);
  assert.equal(monitor.doors.right.offset, 15);
  assert.equal(monitor.angles.left, 0);
  assert.equal(monitor.rendered, true);
  monitor.closeDoor('right');
  assert.equal(monitor.doors.right, null);
});
