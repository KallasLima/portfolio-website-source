'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../contact.js'), 'utf8');

// Exercise the browser event handlers with a transport double. These checks do
// not prove native dialog focus trapping, browser rendering or inbox delivery.
function fixture({ key = 'test-public-form-id', transport, clipboardFails = false } = {}) {
  const nodes = new Map(),
    calls = [],
    timers = new Map();
  let timerId = 0,
    selected = false,
    clipboard;
  const node = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const listeners = new Map();
    const element = {
      id,
      dataset: {},
      attrs: {},
      disabled: false,
      value: '',
      textContent: '',
      innerHTML: 'copy icon',
      open: false,
      checked: false,
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      async emit(type, props = {}) {
        const e = {
          target: element,
          preventDefault() {
            this.prevented = true;
          },
          stopPropagation() {
            this.stopped = true;
          },
          ...props,
        };
        await listeners.get(type)?.(e);
        return e;
      },
      focus() {
        nodes.focused = id;
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      removeAttribute(k) {
        delete this.attrs[k];
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
        listeners.get('close')?.();
      },
      getBoundingClientRect() {
        return { left: 100, right: 688, top: 80, bottom: 680 };
      },
      querySelector() {
        return node('email-link');
      },
      reportValidity() {
        return true;
      },
      reset() {
        this.resets = (this.resets || 0) + 1;
        for (const field of ['name', 'email', 'message']) node('contact-' + field).value = '';
      },
    };
    nodes.set(id, element);
    return element;
  };
  node('contact-form').dataset.accessKey = key;
  node('contact-open').disabled = true;
  node('contact-send').disabled = true;
  node('contact-name').value = ' Example visitor ';
  node('contact-email').value = 'visitor@example.test';
  node('contact-message').value = ' An opportunity to discuss. ';
  const window = { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  vm.runInNewContext(source, {
    document: {
      getElementById: node,
      createRange: () => ({
        selectNodeContents() {
          selected = true;
        },
      }),
    },
    window,
    crypto: require('node:crypto').webcrypto,
    navigator: {
      clipboard: {
        async writeText(value) {
          if (clipboardFails) throw Error('Permission denied');
          clipboard = value;
        },
      },
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return transport
        ? transport(url, options)
        : { ok: true, json: async () => ({ success: true }) };
    },
    AbortController,
    setTimeout(fn, ms) {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  return {
    node,
    calls,
    nodes,
    timers,
    contact: window.CockpitContact,
    clipboard: () => clipboard,
    selected: () => selected,
  };
}

const sample = {
  name: 'Example visitor',
  email: 'visitor@example.test',
  message: 'An opportunity to discuss.',
};
test('agent prepares exact visible draft, refuses human edits and sends only once', async () => {
  const f = fixture();
  const draft = f.contact.prepare(sample);
  assert.equal(draft.status, 'prepared');
  assert.equal(f.calls.length, 0);
  assert.equal(f.node('contact-dialog').open, true);
  f.node('contact-message').value = 'Human edit';
  assert.equal((await f.contact.send(draft.draft_id)).status, 'stale_draft');
  assert.equal(f.contact.prepare(sample).status, 'draft_conflict');
  f.node('contact-form').reset();
  const fresh = f.contact.prepare(sample);
  assert.equal((await f.contact.send(fresh.draft_id)).status, 'accepted');
  assert.equal((await f.contact.send(fresh.draft_id)).repeated_call, true);
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0].options.body).message, sample.message);
});
test('an uncertain contact result cannot be retried through the same draft', async () => {
  const f = fixture({
    transport: async () => {
      throw new Error('network');
    },
  });
  const draft = f.contact.prepare(sample);
  assert.equal((await f.contact.send(draft.draft_id)).status, 'unconfirmed');
  assert.equal((await f.contact.send(draft.draft_id)).repeated_call, true);
  assert.equal(f.contact.prepare(sample).previous_result, 'unconfirmed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.node('contact-message').value, sample.message);
});
test('agent draft bounds, deliberate replacement and pre-dispatch cancellation', async () => {
  const f = fixture();
  assert.equal(f.contact.prepare({ ...sample, message: 'x'.repeat(5001) }).status, 'invalid');
  const first = f.contact.prepare(sample);
  const second = f.contact.prepare({
    ...sample,
    message: 'Updated draft',
    replace_draft_id: first.draft_id,
  });
  assert.equal(second.status, 'prepared');
  assert.notEqual(first.draft_id, second.draft_id);
  assert.equal((await f.contact.send(first.draft_id)).status, 'stale_draft');
  const cancellation = new AbortController();
  cancellation.abort();
  assert.equal((await f.contact.send(second.draft_id, cancellation.signal)).status, 'canceled');
  assert.equal(f.calls.length, 0);
});

test('unconfigured form stays honest and never sends; modal open/close preserves the draft', async () => {
  const f = fixture({ key: '' });
  assert.equal(f.node('contact-open').disabled, false);
  assert.equal(f.node('contact-send').disabled, true);
  assert.match(f.node('contact-status').textContent, /isn’t connected/);
  await f.node('contact-form').emit('submit');
  assert.equal(f.calls.length, 0);
  await f.node('contact-open').emit('click');
  assert.equal(f.node('contact-dialog').open, true);
  await f.node('contact-close').emit('click');
  assert.equal(f.node('contact-dialog').open, false);
  assert.equal(f.nodes.focused, 'contact-open');
  assert.match(f.node('contact-message').value, /opportunity/);
});

test('dialog keys never reach reader shortcuts and only an outside-to-outside primary click closes', async () => {
  const f = fixture(),
    d = f.node('contact-dialog');
  await f.node('contact-open').emit('click');
  for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'Escape', 'Tab']) {
    const e = await d.emit('keydown', { key });
    assert.equal(e.stopped, true);
    assert.equal(e.prevented, undefined);
  }
  await d.emit('pointerdown', { pointerId: 1, button: 0, clientX: 150, clientY: 140 });
  await d.emit('pointerup', { pointerId: 1, clientX: 20, clientY: 20 });
  assert.equal(d.open, true);
  await d.emit('pointerdown', { pointerId: 2, button: 0, clientX: 20, clientY: 20 });
  await d.emit('pointerup', { pointerId: 2, clientX: 20, clientY: 20 });
  assert.equal(d.open, false);
});

test('invalid and whitespace-only input cannot send, including the bot trap', async () => {
  const f = fixture(),
    form = f.node('contact-form');
  form.reportValidity = () => false;
  await form.emit('submit');
  assert.equal(f.calls.length, 0);
  form.reportValidity = () => true;
  f.node('contact-message').value = ' \n ';
  await form.emit('submit');
  assert.equal(f.calls.length, 0);
  assert.equal(f.nodes.focused, 'contact-message');
  f.node('contact-message').value = 'Hello';
  f.node('contact-botcheck').checked = true;
  await form.emit('submit');
  assert.equal(f.calls.length, 0);
  assert.equal(f.node('contact-status').dataset.state, 'error');
});

test('one explicit submit sends only form fields and clears the draft only after confirmed acceptance', async () => {
  let complete;
  const f = fixture({
    transport: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const pending = f.node('contact-form').emit('submit');
  assert.equal(f.node('contact-fields').disabled, true);
  assert.equal(f.node('contact-send').disabled, true);
  await f.node('contact-form').emit('submit');
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0],
    body = JSON.parse(options.body);
  assert.equal(url, 'https://api.web3forms.com/submit');
  assert.equal(options.credentials, 'omit');
  assert.equal(body.email, 'visitor@example.test');
  assert.equal(body.message, 'An opportunity to discuss.');
  assert.deepEqual(Object.keys(body).sort(), [
    'access_key',
    'botcheck',
    'email',
    'from_name',
    'message',
    'name',
    'subject',
  ]);
  assert.equal(f.node('contact-form').resets, undefined);
  complete({ ok: true, json: async () => ({ success: true }) });
  await pending;
  assert.equal(f.node('contact-form').resets, 1);
  assert.equal(f.node('contact-status').dataset.state, 'success');
  assert.equal(f.node('contact-send').disabled, false);
  assert.equal(f.timers.size, 0);
});

test('quota, rejected, malformed and offline responses preserve all text and never claim success', async () => {
  for (const transport of [
    async () => ({ ok: false, json: async () => ({ success: true }) }),
    async () => ({ ok: true, json: async () => ({ success: false }) }),
    async () => ({ ok: true, json: async () => ({ success: 'true' }) }),
    async () => ({
      ok: true,
      json: async () => {
        throw Error('Invalid JSON');
      },
    }),
    async () => {
      throw Error('Offline');
    },
  ]) {
    const f = fixture({ transport });
    await f.node('contact-form').emit('submit');
    assert.equal(f.node('contact-form').resets, undefined);
    assert.match(f.node('contact-message').value, /opportunity/);
    assert.equal(f.node('contact-status').dataset.state, 'error');
    assert.equal(f.node('contact-fields').disabled, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('timeout aborts the request without retrying or losing the message', async () => {
  const f = fixture({
    transport: (_, options) =>
      new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => reject(Error('Timeout'))),
      ),
  });
  const pending = f.node('contact-form').emit('submit');
  const timeout = [...f.timers.values()].find((t) => t.ms === 15000);
  assert(timeout);
  timeout.fn();
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.node('contact-status').dataset.state, 'error');
  assert.match(f.node('contact-message').value, /opportunity/);
  assert.equal(f.node('contact-send').disabled, false);
});

test('email copying confirms success and provides a selection fallback when clipboard access fails', async () => {
  const f = fixture();
  await f.node('contact-copy').emit('click');
  assert.equal(f.clipboard(), 'kallaslima1@gmail.com');
  assert.match(f.node('contact-copy-status').textContent, /copied/);
  const denied = fixture({ clipboardFails: true });
  await denied.node('contact-copy').emit('click');
  assert.equal(denied.selected(), true);
  assert.match(denied.node('contact-copy-status').textContent, /unavailable/);
});
