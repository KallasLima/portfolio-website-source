'use strict';
// Source preview: no telemetry, visitor identifiers or external analytics calls.
(() => {
  const status = document.getElementById('analytics-preference-status');
  if (status) status.textContent = 'Analytics is disabled in this source preview.';
})();
