'use strict';
// One bounded action at a time. The existing controllers still own geometry,
// history, shadows and painting. Human input always takes precedence.
window.createCockpitActions = function (controls) {
  let active = false;
  async function perform(signal, action, deadline = performance.now() + 15000) {
    if (active)
      return { status: 'busy', message: 'Wait for the current cockpit action to finish.' };
    active = true;
    const cancellation = new AbortController();
    let timedOut = false;
    const cancel = () => cancellation.abort();
    const timeout = setTimeout(
      () => {
        timedOut = true;
        cancel();
      },
      Math.max(0, deadline - performance.now()),
    );
    signal?.addEventListener('abort', cancel, { once: true });
    const check = () => {
      if (signal?.aborted || cancellation.signal.aborted || document.hidden)
        throw new Error(timedOut ? 'timeout' : 'canceled');
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
    const nextFrame = () =>
      new Promise((resolve) => {
        // Keep folding at the renderer's cadence, with a fallback so hidden tabs
        // can still observe cancellation rather than waiting forever on rAF.
        const frame = window.CockpitFrame.request(() => {
          clearTimeout(timer);
          resolve();
        });
        const timer = setTimeout(() => {
          window.CockpitFrame.cancel(frame);
          resolve();
        }, 100);
      });
    for (const type of ['pointerdown', 'keydown', 'wheel'])
      document.addEventListener(type, cancel, { capture: true, passive: true });
    try {
      while (!controls.ready()) {
        check();
        await pause();
      }
      check();
      if (controls.busy())
        return { status: 'busy', message: 'The visitor or cockpit is already moving.' };
      return await action({ check, pause, nextFrame });
    } catch (error) {
      return {
        status: ['timeout', 'canceled'].includes(error.message) ? error.message : 'unavailable',
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      for (const type of ['pointerdown', 'keydown', 'wheel'])
        document.removeEventListener(type, cancel, { capture: true });
      active = false;
    }
  }
  return {
    openChapter(index, signal, deadline) {
      return perform(
        signal,
        async ({ check, pause }) => {
          const flight = controls.navigate(index);
          const version = controls.version();
          let finished = false,
            started;
          // Preparation can involve network I/O. Do not keep this action alive
          // after cancellation just because an artwork request is still pending.
          flight.then(
            (value) => {
              started = value;
              finished = true;
            },
            () => {
              finished = true;
            },
          );
          try {
            while (!finished || !controls.settled()) {
              check();
              if (controls.version() !== version) return { status: 'canceled' };
              if (finished && !started)
                return {
                  status: 'unavailable',
                  message: 'Chapter artwork could not load. No page reload was attempted.',
                };
              await pause();
            }
            check();
            if (controls.version() !== version) return { status: 'canceled' };
            if (!started || controls.chapter() !== index) return { status: 'unavailable' };
            return {
              status: 'completed',
              chapter: index,
              motion: window.CockpitMotion.matches ? 'reduced' : 'animated',
            };
          } finally {
            if (!finished || !controls.settled()) controls.cancelNavigation(version);
          }
        },
        deadline,
      );
    },
    setDisplay(display, state, signal, deadline) {
      return perform(
        signal,
        async ({ check, nextFrame }) => {
          const { tilt, hinges } = controls.displays();
          if (display !== 'main' && (!hinges.sideDisplays || hinges.endpointFold(display) > 0))
            return {
              status: 'unavailable',
              message: 'This side display is hidden at this viewport or has no adjacent chapter.',
            };
          const version = controls.version();
          const initial = display === 'main' ? tilt.angle : hinges.angles[display];
          const target = state === 'open' ? 0 : display === 'main' ? 45 : hinges.data.maxAngle;
          const set = (angle) =>
            display === 'main' ? tilt.set(angle) : hinges.set(display, angle);
          const start = performance.now();
          let complete = false;
          // Setters schedule the same shared frame/lighting work as a hand drag.
          do {
            check();
            if (controls.version() !== version) return { status: 'canceled' };
            if (display !== 'main' && !hinges.sideDisplays) return { status: 'unavailable' };
            const t = window.CockpitMotion.matches
              ? 1
              : Math.min(1, (performance.now() - start) / 600);
            set(initial + (target - initial) * t * t * (3 - 2 * t));
            if (t === 1) complete = true;
            await nextFrame();
          } while (!complete);
          check();
          return {
            status: 'completed',
            display,
            state,
            angle: target,
            ...(display === 'main'
              ? {
                  note: 'The main display tilts the shared assembly, including its attached side displays.',
                }
              : {}),
          };
        },
        deadline,
      );
    },
  };
};
