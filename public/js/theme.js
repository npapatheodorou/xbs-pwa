/**
 * Light / dark theme control, shared by the landing page and the app.
 *
 * Loaded as a synchronous (non-module) script in <head> so the saved choice is
 * applied to <html data-theme> before first paint — no flash of the wrong
 * theme. It is an external same-origin file, so it satisfies the strict CSP
 * (script-src 'self'); an inline script would be blocked.
 *
 * Preference model: 'light' (default) or 'dark'. The OS appearance setting is
 * deliberately ignored. Stored under a single key so both pages and multiple
 * tabs stay in sync; any other stored value, including the old follow-the-OS
 * setting, reads as light.
 */
(function () {
  var KEY = 'xbs.theme';
  var root = document.documentElement;

  function saved() {
    try {
      return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
    } catch (e) {
      return 'light';
    }
  }

  /** Apply a preference to the document. Light is the base palette, so only
   *  dark needs the attribute. */
  function apply(pref) {
    if (pref === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    updateThemeColor(pref);
  }

  /** Keep the address-bar / status-bar tint in step with the theme. */
  function updateThemeColor(pref) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', pref === 'dark' ? '#071519' : '#1b6b7d');
  }

  // Apply immediately, before the body paints.
  apply(saved());

  function set(pref) {
    try {
      if (pref === 'dark') localStorage.setItem(KEY, 'dark');
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* storage may be unavailable (private mode); theme still applies for now */
    }
    apply(pref);
    syncControls();
  }

  /** Reflect the current choice in every control on the page. */
  function syncControls() {
    var cur = saved();
    var next = cur === 'dark' ? 'light' : 'dark';

    var cycles = document.querySelectorAll('[data-theme-cycle]');
    for (var i = 0; i < cycles.length; i++) {
      cycles[i].setAttribute('data-state', cur);
      cycles[i].setAttribute('aria-label', 'Switch to ' + next + ' theme');
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
        set(saved() === 'dark' ? 'light' : 'dark');
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

  // Another tab changed the preference: mirror it here.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) {
      apply(saved());
      syncControls();
    }
  });
})();
