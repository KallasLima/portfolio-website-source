'use strict';
// Commit only at rest, never during an animation frame or partial gesture.
window.createChapterHistory = function ({ pages, navigate, readIndex }) {
  const pathIndex = () => pages.findIndex((page) => page.path === location.pathname);
  let traversal = null;
  function metadata(index) {
    const page = pages[index],
      url = 'https://kallaslima.com' + page.path;
    document.title = page.title;
    for (const [selector, value] of [
      ['meta[name="description"]', page.description],
      ['meta[property="og:title"]', page.title],
      ['meta[property="og:description"]', page.description],
      ['meta[property="og:url"]', url],
      ['meta[name="twitter:title"]', page.title],
      ['meta[name="twitter:description"]', page.description],
    ])
      document.querySelector(selector)?.setAttribute('content', value);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', url);
    document.querySelector('.skip-reading')?.setAttribute('href', page.path + '#screen-copy');
    const structured = document.querySelector('script[type="application/ld+json"]');
    if (structured) {
      const data = JSON.parse(structured.textContent);
      const entry = data['@graph']?.find((node) =>
        ['ProfilePage', 'WebPage'].includes(node['@type']),
      );
      if (entry)
        Object.assign(entry, {
          '@type': index === 0 ? 'ProfilePage' : 'WebPage',
          '@id': url + '#page',
          url,
          name: page.title,
          description: page.description,
        });
      structured.textContent = JSON.stringify(data);
    }
  }
  const state = (index) => ({ ...history.state, cockpitChapter: index });
  // Retain referral attribution and visitor settings; don't carry reading hashes.
  const url = (index) => pages[index].path + location.search;
  if (pathIndex() >= 0) history.replaceState(state(pathIndex()), '', location.href);
  window.addEventListener('popstate', () => {
    const index = pathIndex();
    if (index < 0) return;
    traversal = index;
    metadata(index);
    navigate(index, true);
  });
  return {
    begin(fromHistory = false) {
      if (!fromHistory) traversal = null;
    },
    settle(index) {
      if (traversal !== null && traversal !== index) return;
      if (pathIndex() !== index) history.pushState(state(index), '', url(index));
      else if (history.state?.cockpitChapter !== index)
        history.replaceState(state(index), '', location.href);
      traversal = null;
      metadata(index);
    },
    fail() {
      // Don't leave a URL for a view whose artwork failed to load.
      if (traversal !== null) {
        const index = readIndex();
        history.replaceState(state(index), '', url(index));
        traversal = null;
        metadata(index);
      }
    },
  };
};
