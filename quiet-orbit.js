'use strict';
// Pause the existing compositor animation without resetting its current position.
// State events only: this experiment never requests a frame, timer or scene paint.
(() => {
  const cockpit = document.getElementById('cockpit');
  const stage = document.getElementById('stage');
  function sync() {
    const enabled =
      document.documentElement.dataset.boot === 'ready' &&
      stage.dataset.ready === 'true' &&
      stage.dataset.moving !== 'true' &&
      !document.hidden &&
      !window.CockpitMotion.matches &&
      !window.CockpitFrame?.effectsReduced;
    const value = enabled ? 'running' : 'paused';
    if (cockpit.dataset.orbit !== value) cockpit.dataset.orbit = value;
  }
  const observer = new MutationObserver(sync);
  observer.observe(stage, {
    attributes: true,
    attributeFilter: [
      'data-ready',
      'data-moving',
      'data-display-tilt',
      'data-left-angle',
      'data-right-angle',
    ],
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-boot'] });
  document.addEventListener('visibilitychange', sync);
  window.CockpitMotion.addEventListener('change', sync);
  sync();
})();
