/**
 * Light / dark / system theme control, shared by the landing page and the app.
 *
 * Loaded as a synchronous (non-module) script in <head> so the saved choice is
 * applied to <html data-theme> before first paint — no flash of the wrong
 * theme. It is an external same-origin file, so it satisfies the strict CSP
 * (script-src 'self'); an inline script would be blocked.
 *
 * Preference model: 'system' (default — follow the OS), 'light', or 'dark'.
 * Stored under a single key so both pages and multiple tabs stay in sync.
 */
(function () {
  var KEY = 'xbs.theme';
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function saved() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  /** Apply a preference to the document. 'system' removes the attribute so the
   *  CSS media query takes over. */
  function apply(pref) {
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
    else root.removeAttribute('data-theme');
    updateThemeColor(pref);
  }

  /** The theme actually showing right now. */
  function effective(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return mql && mql.matches ? 'dark' : 'light';
  }

  /** Keep the address-bar / status-bar tint in step with a forced theme. */
  function updateThemeColor(pref) {
    var color = effective(pref) === 'dark' ? '#071519' : '#1b6b7d';
    var meta = document.querySelector('meta[name="theme-color"][data-dynamic]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      meta.setAttribute('data-dynamic', '');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', color);
  }

  // Apply immediately, before the body paints.
  apply(saved());

  function set(pref) {
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch (e) {
      /* storage may be unavailable (private mode); theme still applies for now */
    }
    apply(pref);
    syncControls();
  }

  var ORDER = ['system', 'light', 'dark'];

  /** Reflect the current choice in every control on the page. */
  function syncControls() {
    var cur = saved();

    var cycles = document.querySelectorAll('[data-theme-cycle]');
    for (var i = 0; i < cycles.length; i++) {
      cycles[i].setAttribute('data-state', cur);
      cycles[i].setAttribute(
        'aria-label',
        'Theme: ' + cur + '. Activate to change.'
      );
    }

    var opts = document.querySelectorAll('[data-theme-value]');
    for (var j = 0; j < opts.length; j++) {
      var on = opts[j].getAttribute('data-theme-value') === cur;
      opts[j].classList.toggle('is-active', on);
      opts[j].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function wire() {
    var cycles = document.querySelectorAll('[data-theme-cycle]');
    for (var i = 0; i < cycles.length; i++) {
      cycles[i].addEventListener('click', function () {
        var next = ORDER[(ORDER.indexOf(saved()) + 1) % ORDER.length];
        set(next);
      });
    }

    var opts = document.querySelectorAll('[data-theme-value]');
    for (var j = 0; j < opts.length; j++) {
      opts[j].addEventListener('click', function () {
        set(this.getAttribute('data-theme-value'));
      });
    }

    syncControls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // In 'system' mode, react to the OS flipping so the tint and any controls stay
  // correct (the CSS variables switch on their own via the media query).
  if (mql) {
    var onChange = function () {
      if (saved() === 'system') {
        updateThemeColor('system');
        syncControls();
      }
    };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
  }

  // Another tab changed the preference: mirror it here.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) {
      apply(saved());
      syncControls();
    }
  });
})();
