'use strict';
const pages = require('./site-pages.cjs');
const shell = (title, body, scripts = '') => `<!doctype html>
<html lang="en"><head><base href="/"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,follow"><title>Kallas Lima | ${title}</title>
<style>:root{color-scheme:dark;font-family:Inter,"Segoe UI",Arial,sans-serif;color:#e9f2f7;background:#071620}*{box-sizing:border-box}body{margin:0;padding:clamp(24px,6vw,80px);line-height:1.6}main{max-width:680px;margin:auto}h1{font-size:clamp(28px,5vw,42px);line-height:1.2}a{color:#a1e8e7;text-underline-offset:4px}a:focus-visible{outline:2px solid #a1e8e7;outline-offset:4px}.eyebrow{color:#b3cbd9}.actions{display:flex;gap:16px;flex-wrap:wrap;margin:24px 0}.actions a{border:1px solid #628796;border-radius:6px;padding:10px 16px}li{margin:12px 0}.note{color:#b3cbd9;font-size:14px}</style>${scripts}</head><body><main>${body}</main></body></html>\n`;
module.exports = new Map([
  [
    '404.html',
    shell(
      'Page not found',
      `<p class="eyebrow">Kallas Lima · Portfolio</p><h1>This page isn’t here.</h1><p>The link may be incomplete or out of date. You can continue with any of these chapters.</p><nav aria-label="Portfolio chapters"><ul>${pages.map((page, i) => `<li><a href="${page.path}">${['About me', 'Building products', 'More experience', 'Engineering & leadership', 'AI & projects', 'About this project'][i].replace('&', '&amp;')}</a></li>`).join('')}</ul></nav><p><a href="mailto:kallaslima1@gmail.com">Email Kallas</a></p>`,
    ),
  ],
  [
    'analytics/index.html',
    shell(
      'Visitor measurement',
      `<p class="eyebrow">Kallas Lima · Portfolio</p><h1>Visitor measurement</h1><p>This site uses Cloudflare Web Analytics to understand visits, chapter views and loading performance, without analytics cookies or visitor profiles.</p><p>A small first-party counter also records daily totals for full or reduced motion, whether reduced motion was explicitly requested for this visit, and whether the device requested reduced motion. It counts page loads, not unique people. No names, visitor IDs, IP addresses, page URLs or messages are stored in these totals.</p><p id="analytics-preference-status" role="status">JavaScript is needed to read and save this browser’s preference.</p><div class="actions"><a href="/analytics/?analytics=off">Exclude this browser</a><a href="/analytics/?analytics=on">Include this browser</a></div><p class="note">The setting is saved only in this browser. Use Exclude on each browser or phone you use to review the site. Private browsing and cleared site data reset it. Do Not Track and Global Privacy Control are also respected. This cannot remove visits already recorded.</p><p><a href="/">Return to the portfolio</a> · <a href="https://www.cloudflare.com/web-analytics/privacy/">Cloudflare privacy details</a></p>`,
      '<script defer src="analytics.js"></script>',
    ),
  ],
]);
