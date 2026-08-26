/**
 * Quick image overrides
 * ------------------------------------------------------------
 * Keep frequently replaced artwork here.
 * - null = keep the default from config.js
 * - '/assets/custom/xxx.gif' = use a local custom asset
 * - 'https://...' = use a remote image
 * - '' = clear an asset intentionally (for example, use the text logo)
 *
 * Save and refresh after editing; no rebuild is required.
 */
const overrides = {
  // Full Windows 98 desktop wallpaper
  desktopBackground: null,

  // Start button and IE window icons
  startLogo: null,
  windowIcon: null,

  // IE toolbar. Defaults are local crops from a historical Win98/IE image.
  browserToolbar: {
    back: null,
    forward: null,
    stop: null,
    refresh: null,
    home: null,
    search: null,
    favorites: null,
    history: null,
    channels: null,
    fullscreen: null,
    mail: null,
  },

  site: {
    // GIF or PNG is recommended. Setting either image hides its text logo.
    mediaHeaderLogo: null,
    chatHeaderLogo: null,

    // Header backgrounds use cover sizing.
    mediaHeaderBackground: null,
    chatHeaderBackground: null,

    // Page backgrounds repeat; 32/64/128 px retro tiles work well.
    mediaPageBackground: null,
    chatPageBackground: null,

    badgeResolution: null,
    badgeHtml: null,
    badgeCool: null,
    badgeFriends: null,
    featuredIcon: null,
    chatIcon: null,
  },

  siteIcons: {
    nowPlaying: null,
    rooms: null,
    movies: null,
    music: null,
    live: null,
    favorites: null,
    directory: null,
    forum: null,
    help: null,
  },
};

function mergeNonNull(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value === null || value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      mergeNonNull(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

if (window.WT_CONFIG?.assets) mergeNonNull(window.WT_CONFIG.assets, overrides);
