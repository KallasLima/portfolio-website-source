(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const dialog = $('contact-dialog'),
    opener = $('contact-open');
  const form = $('contact-form'),
    fields = $('contact-fields'),
    submit = $('contact-send');
  const status = $('contact-status'),
    copy = $('contact-copy');
  const email = 'kallaslima1@gmail.com';
  // Web3Forms access keys are public form identifiers, never Gmail credentials.
  // Configure the verified recipient's key on the form before enabling delivery.
  const accessKey = form.dataset.accessKey.trim();
  let draft = null;
  // In-memory receipts prevent duplicate agent sends in this document. They are
  // not a provider idempotency guarantee across reloads or other browser tabs.
  const receipts = new Map();
  const values = () => ({
    name: $('contact-name').value.trim(),
    email: $('contact-email').value.trim(),
    message: $('contact-message').value.trim(),
  });
  const same = (a, b) => ['name', 'email', 'message'].every((key) => a[key] === b[key]);
  const valid = (v) =>
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    v.name.length <= 100 &&
    typeof v.email === 'string' &&
    v.email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) &&
    typeof v.message === 'string' &&
    v.message.trim().length > 0 &&
    v.message.length <= 5000;
  let busy = false,
    copyTimer,
    backdropPointer = null;
  const say = (message, state = '') => {
    status.textContent = message;
    status.dataset.state = state;
  };
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  opener.disabled = false;
  opener.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });
  $('contact-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    backdropPointer = null;
    opener.focus({ preventScroll: true });
  });
  // Native modal behavior handles focus trapping, background inertness and Escape.
  // Keep reader shortcuts out of the dialog without disabling text editing keys.
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  dialog.addEventListener('pointerdown', (e) => {
    backdropPointer =
      e.isPrimary !== false && e.button === 0 && e.target === dialog && outside(e)
        ? e.pointerId
        : null;
  });
  dialog.addEventListener('pointerup', (e) => {
    if (e.pointerId === backdropPointer && e.target === dialog && outside(e)) dialog.close();
    backdropPointer = null;
  });
  dialog.addEventListener('pointercancel', () => {
    backdropPointer = null;
  });
  copy.addEventListener('click', async () => {
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(email);
      copy.setAttribute('aria-label', 'Email address copied');
      $('contact-copy-status').textContent = 'Email address copied.';
      copy.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
      copyTimer = setTimeout(() => {
        copy.innerHTML = copyMarkup;
        copy.setAttribute('aria-label', 'Copy email address');
        $('contact-copy-status').textContent = '';
      }, 2500);
    } catch {
      const address = dialog.querySelector('.contact-address a');
      const range = document.createRange();
      range.selectNodeContents(address);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      $('contact-copy-status').textContent =
        'Copy was unavailable. The email address is selected so you can copy it manually.';
    }
  });
  const copyMarkup = copy.innerHTML;
  if (!accessKey) {
    say('The form isn’t connected yet. Please use the email address above.');
    submit.setAttribute('aria-describedby', 'contact-status');
  } else {
    submit.disabled = false;
  }
  form.addEventListener('input', () => {
    if (!busy && accessKey) say('');
  });
  async function send(signal) {
    if (busy) return { status: 'busy' };
    if (!accessKey) return { status: 'unavailable' };
    if (signal?.aborted) return { status: 'canceled' };
    if (!form.reportValidity()) return { status: 'invalid' };
    const name = $('contact-name').value.trim(),
      replyTo = $('contact-email').value.trim();
    const message = $('contact-message').value.trim();
    if (!name || !message) {
      say('Please add your name and a message.', 'error');
      (!name ? $('contact-name') : $('contact-message')).focus();
      return { status: 'invalid' };
    }
    if (!valid({ name, email: replyTo, message })) {
      say('Please check the name, email address and message lengths.', 'error');
      return { status: 'invalid' };
    }
    if ($('contact-botcheck').checked) {
      say('The message could not be sent. Please use the email address above.', 'error');
      return { status: 'invalid' };
    }
    busy = true;
    fields.disabled = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    submit.textContent = 'Sending…';
    say('');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), 15000);
    const reviewed = draft && same(draft.fields, values()) ? draft.id : null;
    let outcome;
    try {
      const response = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          access_key: accessKey,
          name,
          email: replyTo,
          message,
          subject: 'New message from kallaslima.com',
          from_name: 'Kallas Lima portfolio',
          botcheck: false,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.success !== true) throw new Error('Submission not accepted');
      form.reset();
      say('Message sent. Thank you for getting in touch!', 'success');
      outcome = {
        status: 'accepted',
        message: 'The contact provider accepted the message. Inbox delivery is not confirmed.',
      };
    } catch {
      // A timeout can occur after the server accepts a message. Never auto-retry.
      say(
        'Couldn’t confirm delivery. Your message is still here. You can try again or email me directly above.',
        'error',
      );
      outcome = {
        status: 'unconfirmed',
        message:
          'The request may have been accepted. Do not retry automatically; the draft is still visible.',
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      busy = false;
      fields.disabled = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
      submit.textContent = 'Send message';
    }
    if (reviewed) receipts.set(reviewed, outcome);
    return outcome;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    return send();
  });
  window.CockpitContact = {
    prepare(input) {
      if (busy) return { status: 'busy' };
      if (!accessKey) return { status: 'unavailable' };
      if (!valid(input))
        return {
          status: 'invalid',
          message: 'Use a name (1–100), valid email (up to 254), and message (1–5000 characters).',
        };
      const next = Object.fromEntries(
        ['name', 'email', 'message'].map((key) => [key, input[key].trim()]),
      );
      const current = values();
      // A human edit invalidates the old review even if it did not emit input.
      if (draft && !same(current, draft.fields)) draft = null;
      if (
        Object.values(current).some(Boolean) &&
        !same(current, next) &&
        !(draft && input.replace_draft_id === draft.id && !receipts.has(draft.id))
      )
        return {
          status: 'draft_conflict',
          message:
            'The visible form contains a different draft. Preserve it; ask the visitor to review or clear it.',
        };
      if (!draft || !same(draft.fields, next)) draft = { id: crypto.randomUUID(), fields: next };
      for (const key of ['name', 'email', 'message']) $('contact-' + key).value = next[key];
      if (!dialog.open) dialog.showModal();
      return {
        status: 'prepared',
        draft_id: draft.id,
        recipient: email,
        ...next,
        previous_result: receipts.get(draft.id)?.status || null,
        message_for_agent:
          'Show the visitor this exact recipient, name, email and message and obtain their approval before calling send_contact.',
      };
    },
    async send(id, signal) {
      if (receipts.has(id)) return { ...receipts.get(id), repeated_call: true };
      if (!draft || draft.id !== id || !same(draft.fields, values()))
        return {
          status: 'stale_draft',
          message: 'Prepare and review the current draft before sending.',
        };
      if (!dialog.open) dialog.showModal();
      return send(signal);
    },
  };
})();
