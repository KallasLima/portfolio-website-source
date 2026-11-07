'use strict';

// Build-time only. The approved manuscript remains the single source of truth.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');
const pages = require('./site-pages.cjs');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), sandbox, {
  timeout: 1000,
});
const chapters = sandbox.window.CHAPTERS;
if (!Array.isArray(chapters) || !chapters.length) throw new Error('The manuscript is missing.');

const escape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const origin = 'https://kallaslima.com';
// Validate the deferred renderer texture without preloading it ahead of the
// readable first view. Discover the transport from the model to prevent drift.
const model = fs.readFileSync(path.join(root, 'assets/displays/center.glb'));
const modelJson = JSON.parse(model.subarray(20, 20 + model.readUInt32LE(12)).toString());
const normalImage = modelJson.images.find((image) =>
  /^normal-blue-metal-[a-f0-9]{12}\.jpg$/.test(image.uri || ''),
);
if (!normalImage) throw new Error('Shared cockpit normal texture is missing.');
const normalTransport = normalImage.uri.replace(/\.jpg$/, '.webp');
if (!fs.existsSync(path.join(root, 'assets/displays', normalTransport)))
  throw new Error('Shared cockpit normal transport is missing.');
const preview = `${origin}/assets/social-preview.png`;
const previewAlt =
  'Kallas Lima, Software engineer. Products, Systems and AI, beside the Milky Way against a dark starfield.';
// Keep the declared sharing-image dimensions in sync when its artwork changes.
const previewImage = fs.readFileSync(path.join(root, 'assets/social-preview.png'));
if (
  previewImage.length < 33 ||
  previewImage.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
  previewImage.readUInt32BE(8) !== 13 ||
  previewImage.toString('ascii', 12, 16) !== 'IHDR'
) {
  throw new Error('The sharing image must be a valid PNG.');
}
const previewWidth = previewImage.readUInt32BE(16);
const previewHeight = previewImage.readUInt32BE(20);
if (!previewWidth || !previewHeight) throw new Error('The sharing image dimensions are invalid.');
function metadataFor(page) {
  const { title, description } = page;
  const url = origin + page.path;
  const structured = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Person',
        '@id': `${origin}/#person`,
        name: 'Kallas Lima',
        url: `${origin}/`,
        jobTitle: 'Software Engineer',
        description:
          'Software engineer based in Belo Horizonte, Brazil, in Latin America, with Staff Engineer and Engineering Manager experience.',
        homeLocation: {
          '@type': 'City',
          name: 'Belo Horizonte',
          containedInPlace: { '@type': 'Country', name: 'Brazil' },
        },
        knowsAbout: [
          'Software engineering',
          'Flutter',
          'Dart',
          'TypeScript',
          'Node.js',
          'React',
          'PHP',
          'Symfony',
          'SQL',
          'Engineering management',
          'Generative AI',
        ],
        sameAs: ['https://www.linkedin.com/in/kallas-lima/', 'https://github.com/KallasLima'],
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        url: `${origin}/`,
        name: 'Kallas Lima',
        inLanguage: 'en',
        description: pages[0].description,
        author: { '@id': `${origin}/#person` },
      },
      {
        '@type': page.chapter === 0 ? 'ProfilePage' : 'WebPage',
        '@id': `${url}#page`,
        url,
        name: title,
        description,
        inLanguage: 'en',
        mainEntity: { '@id': `${origin}/#person` },
        isPartOf: { '@id': `${origin}/#website` },
      },
    ],
  };
  return [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}">`,
    '<meta name="author" content="Kallas Lima">',
    '<meta name="theme-color" content="#071620">',
    `<link rel="canonical" href="${url}">`,
    '<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">',
    '<link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Kallas Lima">',
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:title" content="${escape(title)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${preview}">`,
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:width" content="${previewWidth}">`,
    `<meta property="og:image:height" content="${previewHeight}">`,
    `<meta property="og:image:alt" content="${escape(previewAlt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escape(title)}">`,
    `<meta name="twitter:description" content="${escape(description)}">`,
    `<meta name="twitter:image" content="${preview}">`,
    `<meta name="twitter:image:alt" content="${escape(previewAlt)}">`,
    `<script type="application/ld+json">${JSON.stringify(structured).replace(/</g, '\\u003c')}</script>`,
  ].join('\n ');
}

const articles = chapters.map((chapter, index) => {
  // Match the live reader's heading hierarchy, without changing a word.
  const body = chapter.body.replace(/<(\/?)h([23])>/g, (_, close, level) =>
    close
      ? `</h${Number(level) + 1}>`
      : `<h${Number(level) + 1} class="${level === '2' ? 'section-title' : 'subsection-title'}">`,
  );
  const subtitle = index === 0 ? '' : `<p class="chapter-subtitle">${escape(chapter.sub)}</p>`;
  return `<article class="display-card screen-article" data-index="${index}" role="region" aria-labelledby="chapter-title-${index}"><div class="reading-column"><h2 id="chapter-title-${index}">${escape(chapter.title)}</h2>${subtitle}<div class="chapter-body">${body}</div></div></article>`;
});

const indexPath = path.join(root, 'index.html');
const source = fs
  .readFileSync(indexPath, 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\s*<base href="\/">/, '');
function replaceBlock(html, label, value) {
  const pattern = new RegExp(
    `(<!-- BEGIN GENERATED ${label} -->)[\\s\\S]*?(<!-- END GENERATED ${label} -->)`,
  );
  if (!pattern.test(html)) throw new Error(`Missing ${label} generation markers.`);
  return html.replace(pattern, (_, start, end) => `${start}\n ${value}\n ${end}`);
}
const outputs = new Map();
// Public tool reading uses the same manuscript and paths as rendered chapters.
// Loaded on demand, never on the critical first-paint path.
outputs.set(
  'assets/portfolio.json',
  JSON.stringify(
    pages.map((page) => ({
      path: page.path,
      title: chapters[page.chapter].title,
      description: page.description,
      html: chapters[page.chapter].body,
    })),
  ) + '\n',
);
for (const page of pages) {
  let html = replaceBlock(
    replaceBlock(source, 'METADATA', metadataFor(page)),
    'CHAPTERS',
    page.chapter === 0 ? articles.join('\n') : articles[page.chapter],
  );
  html = html.replace(
    /<html[^>]*>/,
    `<html lang="en" data-boot="loading" data-entry-chapter="${page.chapter}">`,
  );
  if (page.chapter) {
    const entry = JSON.parse(
      fs.readFileSync(path.join(root, 'assets/hybrid-entries/manifest.json')),
    )[page.chapter];
    const stars = JSON.parse(
      fs.readFileSync(path.join(root, 'assets/hybrid-parity/manifest.json')),
    );
    const ranges = {
      mobile: '(max-width: 700px)',
      tablet: '(min-width: 701px) and (max-width: 1099px)',
      desktop: '(min-width: 1100px)',
    };
    const links = Object.entries(entry.variants)
      .flatMap(([variant, files]) => {
        const selected = Object.entries(files)
          .filter(
            ([name]) =>
              !['center', 'glass'].includes(name) &&
              !(
                variant === 'mobile' &&
                ['left', 'right', 'mounts', 'strip', 'previewleft', 'previewright'].includes(name)
              ),
          )
          .map(([, file]) => entry.directory + file);
        for (const name of ['stars', 'starInset'])
          if (stars.variants[variant][name])
            selected.push(stars.directory + stars.variants[variant][name]);
        return selected.map(
          (file) =>
            ` <link rel="preload" as="image" href="${file}" media="${ranges[variant]}" fetchpriority="high">`,
        );
      })
      .join('\n');
    html = html.replace(
      /<!-- HYBRID SPEED PRELOADS -->[\s\S]*?<!-- END HYBRID SPEED PRELOADS -->/,
      `<!-- HYBRID SPEED PRELOADS -->\n${links}\n <!-- END HYBRID SPEED PRELOADS -->`,
    );
  }
  const briefTitles = [
    'About me',
    'Products',
    'More work',
    'Leading teams',
    'AI & projects',
    'The project',
  ];
  const topics = [
    ['Products & systems', 'Languages & international work'],
    ["Olly Olly's platform", 'CookUnity Smart Fridges'],
    ['Mobile & financial systems', 'Improving existing software'],
    ['Technical direction', 'Hiring & onboarding'],
    ['Working with coding agents', 'Creative AI Workflow Lab'],
    ['Human & AI collaboration', 'From ideas to a working cockpit'],
  ];
  for (const [side, offset] of [
    ['left', -1],
    ['right', 1],
  ]) {
    const adjacent = page.chapter + offset,
      c = chapters[adjacent];
    for (const id of [`monitor-hit-${side}`, offset < 0 ? 'previous' : 'next']) {
      const pattern = new RegExp(`<a([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)</a>`);
      html = html.replace(pattern, (_, attributes, content) => {
        attributes = attributes.replace(
          /\s+(?:href|role|aria-disabled|tabindex|aria-label)="[^"]*"/g,
          '',
        );
        const label = c
          ? `${offset < 0 ? 'Previous' : 'Next'} chapter: ${c.title}${id.startsWith('monitor-') ? '. Drag to adjust monitor.' : ''}`
          : offset < 0
            ? 'Beginning of journey'
            : 'End of journey';
        // href-less endpoints still describe unavailable navigation. Preserve
        // a link role so the accessible name/disabled state remain valid.
        return `<a${attributes} role="link"${c ? ` href="${pages[adjacent].path}"` : ''} aria-disabled="${!c}" tabindex="${c ? 0 : -1}" aria-label="${escape(label)}">${content}</a>`;
      });
    }
    const preview = c
      ? `<div class="display-card side-card chapter-preview hybrid-side-card"><div class="preview-direction"><span>${offset < 0 ? 'Previous chapter' : 'Next chapter'}</span><span aria-hidden="true">${offset < 0 ? '←' : '→'}</span></div><div class="preview-destination" aria-hidden="true"><img class="hybrid-preview-image" alt=""></div><strong class="preview-title"><span class="preview-title-full">${escape(c.title)}</span><span class="preview-title-brief">${briefTitles[adjacent]}</span></strong><ul class="preview-topics">${topics[adjacent].map((t) => `<li>${escape(t)}</li>`).join('')}</ul></div>`
      : '';
    // These markers keep rebuilding idempotent after index.html itself gains a preview.
    const marker = `<!-- INITIAL ${side.toUpperCase()} PREVIEW -->`,
      end = `<!-- END INITIAL ${side.toUpperCase()} PREVIEW -->`;
    const pattern = new RegExp(
      `(<div class="screen screen-${side}" id="side-${side}"[^>]*>)(?:${marker}[\\s\\S]*?${end})?(</div>)`,
    );
    html = html.replace(pattern, `$1${marker}${preview}${end}$2`);
  }
  html = html.replace(/href="(?:[^" ]*)#screen-copy"/, `href="${page.path}#screen-copy"`);
  const links = pages
    .map(
      (entry, i) =>
        `<a class="destination-dot" data-destination="${i}" data-page-title="${escape(entry.title)}" data-page-description="${escape(entry.description)}" href="${entry.path}" aria-label="Chapter ${i + 1} of ${chapters.length}: ${escape(chapters[i].title)}, ${escape(chapters[i].place)}" title="${escape(chapters[i].title)}"${i === page.chapter ? ' aria-current="true"' : ''}><span class="sr-only">${escape(chapters[i].title)}</span></a>`,
    )
    .join('');
  html = html.replace(/(<nav id="destinations"[^>]*>)[\s\S]*?(<\/nav>)/, `$1${links}$2`);
  const readingLinks = pages
    .map((entry) => `<a href="${entry.path}">${escape(chapters[entry.chapter].title)}</a>`)
    .join(' · ');
  html = replaceBlock(
    html,
    'READING NAV',
    `<noscript><nav class="reading-index" aria-label="Portfolio chapters">${readingLinks}</nav></noscript>`,
  );
  html = html.replace('<head>', '<head>\n <base href="/">');
  outputs.set(page.path === '/' ? 'index.html' : page.path.slice(1) + 'index.html', html);
}
// Associate the portfolio cover with the homepage once, using its permanent URL
// so image discovery does not depend on a release-specific asset directory.
const sitemapEntries = pages.map((page) => {
  const image =
    page.path === '/' ? `<image:image><image:loc>${escape(preview)}</image:loc></image:image>` : '';
  return `  <url><loc>${escape(origin + page.path)}</loc>${image}</url>`;
});
outputs.set(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${sitemapEntries.join('\n')}\n</urlset>\n`,
);
for (const [name, html] of require('./support-pages.cjs')) outputs.set(name, html);
const redirects = require('./site-redirects.cjs');
outputs.set(
  '_redirects',
  Object.entries({ ...redirects, ...require('./favicon-redirects.cjs').rules })
    .map(([from, to]) => `${from} ${to} 301`)
    .join('\n') + '\n',
);
// Fallback for simple development servers; production uses HTTP 301 rules.
for (const [from, to] of Object.entries(redirects).filter(([from]) => from.endsWith('/'))) {
  outputs.set(
    from.slice(1) + 'index.html',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,follow"><link rel="canonical" href="${origin}${to}"><meta http-equiv="refresh" content="0;url=${to}"><title>Kallas Lima | Page moved</title></head><body><p><a href="${to}">Continue to the chapter</a></p><script>location.replace(${JSON.stringify(to)}+location.search+location.hash)</script></body></html>\n`,
  );
}
for (const [relative, value] of outputs) {
  const target = path.join(root, relative);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== value)
      throw new Error(`Generated ${relative} is stale. Run npm run build:metadata.`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}
if (check) {
  for (const asset of [
    'favicon.svg',
    'favicon.ico',
    'favicon-96.png',
    'apple-touch-icon.png',
    'assets/social-preview.png',
    'robots.txt',
    'sitemap.xml',
    'noscript.css',
  ]) {
    if (!fs.existsSync(path.join(root, asset))) throw new Error(`Missing public asset: ${asset}`);
  }
  console.log(
    `All ${pages.length} search entry pages, manuscript chapters and sitemap are current; public assets exist.`,
  );
} else {
  console.log(
    `Generated ${pages.length} search entry pages and sitemap from the original manuscript.`,
  );
}
