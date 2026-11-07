const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewServer } = require('./preview.cjs');
test('preview serves runtime assets while hiding dotfiles/tooling and refusing writes', async (t) => {
  const server = createPreviewServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/', '/about-this-project/', '/contact.js'])
    assert.equal((await fetch(base + route)).status, 200);
  for (const route of [
    '/.git/config',
    '/.env',
    '/scripts/preview.cjs',
    '/package.json.bak',
    '/CONTACT.md',
  ])
    assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'message' })).status, 405);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /data-access-key=""/);
});
