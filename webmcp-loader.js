(() => {
  'use strict';
  // Optional enhancement only. Ordinary browsers do not download or parse the
  // tool definitions; supported browsers wait until the reader has painted.
  if (!(document.modelContext || navigator.modelContext)?.registerTool) return;
  const load = () => {
    const script = document.createElement('script');
    script.src = new URL('webmcp.js', document.baseURI).href;
    script.async = true;
    document.head.append(script);
  };
  if (performance.getEntriesByName('hybrid-first-readable').length) setTimeout(load, 0);
  else window.addEventListener('cockpit-readable', load, { once: true });
})();
