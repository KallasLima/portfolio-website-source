'use strict';
// Crawlers retain release-prefixed icon URLs after the release is retired.
// Cloudflare placeholders match exactly one path segment; only these icon
// names redirect. Never send retired scripts or artwork to the current release.
const icons = ['favicon.ico', 'favicon-96.png', 'favicon.svg', 'apple-touch-icon.png'];
const rules = Object.fromEntries(icons.map((name) => [`/r/:release/${name}`, `/${name}`]));
function target(pathname) {
  const parts = pathname.split('/');
  return parts.length === 4 && parts[1] === 'r' && parts[2] && icons.includes(parts[3])
    ? `/${parts[3]}`
    : null;
}
module.exports = { rules, target };
