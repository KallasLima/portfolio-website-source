'use strict';

// Layout stays in neutral camera coordinates behind the loading veil. The
// display joints can animate inside it, without measuring through the head turn.
window.CockpitEntrance = (() => {
  if (window.HybridBoot) return window.HybridBoot.entrance;
  const root = document.documentElement,
    cockpit = document.getElementById('cockpit');
  // The unenhanced HTML stays readable and interactive without JavaScript.
  cockpit.inert = true;
  cockpit.setAttribute('aria-busy', 'true');
  const overlay = document.getElementById('entrance'),
    status = document.getElementById('entrance-status');
  const retry = document.getElementById('entrance-retry');
  let state = 'loading',
    animations = [],
    resolveEntrance,
    visibilityListener;
  let poseFrame = 0,
    updateDisplays;
  const liftAt = (offset) => {
    const t = Math.max(0, Math.min(1, (offset - 0.06) / 0.88));
    return t * t * t * (t * (t * 6 - 15) + 10);
  };
  const setState = (value) => {
    state = value;
    root.dataset.boot = value;
  };
  try {
    history.scrollRestoration = 'manual';
    // Remove only the two obsolete pose preferences, never unrelated storage.
    localStorage.removeItem('kallas-console-tilt');
    localStorage.removeItem('kallas-monitor-angles');
  } catch {
    /* Private browsing may deny storage; loading remains available. */
  }
  let timeout = 0,
    assetsPrepared = false;
  function watchLoading() {
    clearTimeout(timeout);
    // Background tabs can suspend rendering and timers for an arbitrary time.
    // Only an unfinished, visible asset load gets a timeout/retry deadline.
    if (
      state === 'loading' &&
      !assetsPrepared &&
      !document.hidden &&
      (!window.ConsoleLayout || window.ConsoleLayout.snapshot())
    )
      timeout = setTimeout(
        () => fail('The cockpit is taking longer than expected. Please try again.'),
        45000,
      );
  }
  watchLoading();
  // A hidden/collapsed layout cannot be presented yet. It must not spend the
  // visible asset-load deadline while waiting for real browser measurements.
  const loadingLayoutObserver = new ResizeObserver(watchLoading);
  for (const id of ['stage', 'reading-layout', 'display-stage'])
    loadingLayoutObserver.observe(document.getElementById(id));
  retry.addEventListener('click', () => location.reload());

  function finish() {
    if (state !== 'entering') return;
    setState('settling');
    window.CockpitFrame.cancel(poseFrame);
    poseFrame = 0;
    for (const animation of animations) animation.cancel();
    animations = [];
    cockpit.classList.remove('waking');
    updateDisplays?.(1);
    updateDisplays = null;
    overlay.hidden = true;
    // Removing the effects restores neutral DOM measurements synchronously.
    resolveEntrance?.();
    resolveEntrance = null;
  }
  function complete() {
    if (state === 'failed') return;
    clearTimeout(timeout);
    loadingLayoutObserver.disconnect();
    overlay.hidden = true;
    setState('ready');
    cockpit.inert = false;
    cockpit.setAttribute('aria-busy', 'false');
    performance.mark('cockpit-ready');
  }
  function fail(message = 'The cockpit could not load. Please try again.') {
    if (state === 'ready' || state === 'failed') return;
    finish();
    clearTimeout(timeout);
    loadingLayoutObserver.disconnect();
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    setState('failed');
    overlay.hidden = false;
    status.textContent = message;
    retry.hidden = false;
  }
  async function reveal(displayPose) {
    if (state === 'failed') return;
    clearTimeout(timeout);
    performance.mark('cockpit-first-frame');
    if (document.hidden)
      await new Promise((resolve) => {
        visibilityListener = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', visibilityListener);
          visibilityListener = null;
          resolve();
        };
        document.addEventListener('visibilitychange', visibilityListener);
      });
    if (state === 'failed') return;
    setState('entering');
    updateDisplays = displayPose;
    performance.mark('cockpit-entrance-start');
    cockpit.classList.add('waking');
    const done = new Promise((resolve) => {
      resolveEntrance = resolve;
    });
    if (window.CockpitMotion.matches) {
      finish();
      return done;
    }
    // The approved entrance runs by default, just like the existing journey;
    // it never requires a visitor to enable animations. Escape can finish it.
    const duration = 1500,
      options = { duration, fill: 'both' };
    // Pure camera pitch: K * R * inverse(K), about the eye, with a fixed
    // focal length. This projects the complete view equally at every depth;
    // no dolly, zoom, or independently sliding HTML/physical screens.
    // Dense samples preserve the rotation path in compositor-only animation.
    const focal = cockpit.clientHeight * 1.2;
    const pitch = Array.from({ length: 61 }, (_, i) => {
      const offset = i / 60;
      const angle = ((1 - liftAt(offset)) * 4 * Math.PI) / 180;
      const c = Math.cos(angle),
        s = Math.sin(angle);
      return {
        offset,
        transform: `matrix3d(1,0,0,0,0,${c},0,${s / focal},0,0,1,0,0,${-focal * s},0,${c})`,
      };
    });
    const head = cockpit.animate(pitch, options);
    animations.push(head);
    // Sample the same animation timeline, not a second elapsed-time clock.
    // Setters only change joints; the shared frame queue paints them together.
    const openDisplays = () => {
      poseFrame = 0;
      if (state !== 'entering') return;
      updateDisplays?.(liftAt(Number(head.currentTime || 0) / duration));
      poseFrame = window.CockpitFrame.request(openDisplays);
    };
    if (updateDisplays) poseFrame = window.CockpitFrame.request(openDisplays);
    animations.push(
      cockpit.animate(
        [
          { filter: 'blur(7px) brightness(1.06)' },
          { filter: 'blur(4px) brightness(1.12)', offset: 0.16 },
          { filter: 'blur(1px) brightness(1.04)', offset: 0.36 },
          { filter: 'none', offset: 0.58 },
          { filter: 'none' },
        ],
        options,
      ),
    );
    // Eyelids are far outside the eye's focus: broad soft light occlusion,
    // dominated by the upper lid, never a visible almond-shaped aperture.
    animations.push(
      overlay
        .querySelector('.entrance-lid-top')
        .animate(
          [
            { transform: 'translateY(0)' },
            { transform: 'translateY(-26%)', offset: 0.2 },
            { transform: 'translateY(-74%)', offset: 0.56 },
            { transform: 'translateY(-115%)' },
          ],
          { duration: 850, fill: 'both', easing: 'ease-out' },
        ),
    );
    animations.push(
      overlay.querySelector('.entrance-lid-bottom').animate(
        [
          { transform: 'translateY(0)', opacity: 1 },
          { transform: 'translateY(85%)', opacity: 0 },
        ],
        { duration: 720, fill: 'both', easing: 'ease-out' },
      ),
    );
    animations.push(
      overlay.querySelector('.entrance-darkness').animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 460,
        fill: 'both',
        easing: 'ease-in',
      }),
    );
    Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
    return done;
  }
  // Resizing or leaving mid-intro must never strand a blurred, inert page or
  // let a ResizeObserver rebuild the physical display from transformed bounds.
  window.CockpitMotion?.addEventListener('change', (event) => {
    if (event.matches) finish();
  });
  window.addEventListener('resize', finish, { capture: true });
  window.visualViewport?.addEventListener('resize', finish);
  window.addEventListener('pagehide', finish);
  document.addEventListener('visibilitychange', () => {
    watchLoading();
    if (document.hidden) finish();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (state === 'entering' && event.key === 'Escape') {
        event.preventDefault();
        finish();
      }
    },
    true,
  );
  // A missing startup script should produce a retry surface rather than an
  // endless loader. Runtime errors after successful startup are not swallowed.
  window.addEventListener(
    'error',
    (event) => {
      if (state === 'loading' && (event.target?.tagName === 'SCRIPT' || event.error)) fail();
    },
    true,
  );
  return {
    reveal,
    complete,
    fail,
    beforeLayout: finish,
    prepared() {
      assetsPrepared = true;
      clearTimeout(timeout);
    },
    get blocked() {
      return state !== 'ready';
    },
    get state() {
      return state;
    },
  };
})();
