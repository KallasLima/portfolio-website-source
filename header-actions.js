(() => {
  'use strict';
  const header = document.querySelector('.site-header');
  const identity = header.querySelector('.identity');
  const nav = header.querySelector('nav');
  const actions = [...nav.querySelectorAll('.profile-action')];
  const fullMarks = actions.map((action) => action.querySelector('.profile-full'));
  const fullLocation = identity.querySelector('.identity-location-full');
  const shortLocation = identity.querySelector('.identity-location-short');
  const role = identity.querySelector('.identity-role');
  const collapseOrder = [...actions].sort((a, b) => a.dataset.fitPriority - b.dataset.fitPriority);

  function fit() {
    const style = getComputedStyle(header);
    const space =
      header.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.columnGap);
    const navGaps = parseFloat(getComputedStyle(nav).columnGap) * (actions.length - 1);
    const identityWidth = (location) =>
      Math.max(
        identity.querySelector('h1').scrollWidth,
        role.getBoundingClientRect().width + location.getBoundingClientRect().width,
      );
    // Keep the city while even the compact actions fit. When it cannot fit,
    // remove the city, never the country, without wrapping the header.
    const countryOnly = identityWidth(fullLocation) + actions.length * 36 + navGaps > space;
    identity.toggleAttribute('data-country-only', countryOnly);
    fullLocation.setAttribute('aria-hidden', String(countryOnly));
    shortLocation.setAttribute('aria-hidden', String(!countryOnly));
    const available = space - identityWidth(countryOnly ? shortLocation : fullLocation);
    const padding = parseFloat(style.getPropertyValue('--profile-padding'));
    const widths = new Map(
      actions.map((action, i) => [
        action,
        Math.max(36, fullMarks[i].getBoundingClientRect().width + padding * 2 + 2),
      ]),
    );
    let required = [...widths.values()].reduce((total, width) => total + width, 0) + navGaps;
    const compact = new Set();
    // Keep as many labels as fit; Contact is the last to lose its label.
    for (const action of collapseOrder) {
      if (required <= available) break;
      compact.add(action);
      required -= widths.get(action) - 36;
    }
    for (const action of actions) action.toggleAttribute('data-compact', compact.has(action));
  }

  const observer = new ResizeObserver(fit);
  [header, identity, fullLocation, shortLocation, ...fullMarks].forEach((element) =>
    observer.observe(element),
  );
  document.fonts.ready.then(fit);
  fit();
})();
