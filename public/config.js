/**
 * DreamStream 99 - Quick configuration
 * -------------------------
 * Most user-facing copy, 1990s website details, desktop icons, and base colors
 * live here. Save the file and refresh the page; no rebuild is required.
 */
window.WT_CONFIG = {
  siteName: 'DreamStream 99',

  /**
   * Fonts
   * - All interface, body, and heading text uses the local Pixelated MS Sans
   *   Serif files from 98.css.
   *
   * Fonts load from the project so a CDN outage cannot change the layout.
   * To use another properly licensed web font later, update these URLs.
   */
  fonts: {
    latinRegularUrl: '/assets/fonts/ms_sans_serif.woff',
    latinBoldUrl: '/assets/fonts/ms_sans_serif_bold.woff',
  },

  theme: {
    desktop: '#008080',
    titleBar: '#000080',
    titleBarActive: '#000080',
    fontFamily: '"Pixelated MS Sans Serif", "MS Sans Serif", sans-serif',
    displayFontFamily: '"Pixelated MS Sans Serif", "MS Sans Serif", sans-serif',
  },

  /**
   * 4K / HiDPI: scale the entire virtual desktop by integers only.
   * auto uses 2x on large HiDPI viewports and 1x elsewhere. You can also set
   * this manually to 1, 2, or 3.
   */
  display: {
    uiScale: 'auto',
    // Auto checks both the CSS viewport and physical pixels, including 4K
    // displays with 150% or 200% Windows scaling.
    autoScale2MinViewportWidth: 1500,
    autoScale2MinViewportHeight: 820,
    autoScale2MinPhysicalWidth: 3200,
    autoScale2MinPhysicalHeight: 1800,
    rememberWindowLayout: true,
    rememberDesktopIcons: true,
  },

  /**
   * Replaceable images are centralized here. Values can be project paths
   * (prefer /assets/custom/...) or HTTPS URLs. An empty background value uses
   * the default CSS artwork.
   */
  assets: {
    desktopBackground: '',

    // Archived Windows 98 system icon used by this personal project.
    startLogo: 'https://win98icons.alexmeub.com/icons/png/windows-4.png',
    windowIcon: '/assets/win98/system/ie16.png',

    browserToolbar: {
      back: '/assets/win98/ie-toolbar/back.png',
      forward: '/assets/win98/ie-toolbar/forward.png',
      stop: '/assets/win98/ie-toolbar/stop.png',
      refresh: '/assets/win98/ie-toolbar/refresh.png',
      home: '/assets/win98/ie-toolbar/home.png',
      search: '/assets/win98/ie-toolbar/search.png',
      favorites: '/assets/win98/ie-toolbar/favorites.png',
      history: '/assets/win98/ie-toolbar/history.png',
      channels: '/assets/win98/ie-toolbar/channels.png',
      fullscreen: '/assets/win98/ie-toolbar/fullscreen.png',
      mail: '/assets/win98/ie-toolbar/mail.png',
    },

    site: {
      // Leave either logo empty to keep the current text logo.
      mediaHeaderLogo: '',
      chatHeaderLogo: '',
      mediaHeaderBackground: '',
      chatHeaderBackground: '',
      mediaPageBackground: '',
      chatPageBackground: '',

      badgeResolution: '/assets/retro/badge-resolution.png',
      badgeHtml: '/assets/retro/badge-html.png',
      badgeCool: '/assets/retro/badge-cool.png',
      badgeFriends: '/assets/retro/badge-friends.png',
      featuredIcon: 'https://win98icons.alexmeub.com/icons/png/computer_explorer-3.png',
      chatIcon: 'https://win98icons.alexmeub.com/icons/png/outlook_express-0.png',
    },

    siteIcons: {
      nowPlaying: '/assets/icons/play.png',
      rooms: 'https://win98icons.alexmeub.com/icons/png/network_normal_two_pcs-2.png',
      movies: '/assets/retro/cool.png',
      music: '/assets/retro/speaker.png',
      live: '/assets/retro/star.png',
      favorites: 'https://win98icons.alexmeub.com/icons/png/directory_favorites_small-2.png',
      directory: 'https://win98icons.alexmeub.com/icons/png/directory_open_file_mydocs_small-4.png',
      forum: '/assets/retro/guestbook.png',
      help: 'https://win98icons.alexmeub.com/icons/png/help_book_small-3.png',
    },
  },

  /**
   * Initial sizes for the two main windows. Their actual positions are
   * calculated for the current desktop, remain draggable/resizable, and are
   * remembered across refreshes.
   */
  windows: {
    media: { minWidth: 500, minHeight: 430, widthRatio: 0.62 },
    chat: { minWidth: 300, minHeight: 390, widthRatio: 0.34 },
  },

  desktopIcons: [
    { id: 'media', label: 'My Media', icon: 'https://win98icons.alexmeub.com/icons/png/computer_explorer-3.png', fallback: '/assets/retro/computer.png', x: 18, y: 18, openWindow: 'media' },
    { id: 'chat', label: 'Chat Room', icon: 'https://win98icons.alexmeub.com/icons/png/outlook_express-0.png', fallback: '/assets/retro/chat.png', x: 18, y: 96, openWindow: 'chat' },
    { id: 'guestbook', label: 'Guestbook', icon: '/assets/retro/guestbook.png', x: 18, y: 174 },
    { id: 'downloads', label: 'Downloads', icon: '/assets/retro/download.png', x: 18, y: 252 },
    { id: 'links', label: 'Web Links', icon: 'https://win98icons.alexmeub.com/icons/png/network_normal_two_pcs-2.png', fallback: '/assets/retro/globe.png', x: 18, y: 330 },
    { id: 'mail', label: 'Mail', icon: 'https://win98icons.alexmeub.com/icons/png/outlook_express-0.png', fallback: '/assets/retro/mail.png', x: 18, y: 408 },
    { id: 'projects', label: 'Web Projects', icon: 'https://win98icons.alexmeub.com/icons/png/directory_open_file_mydocs_small-4.png', fallback: '/assets/retro/folder.png', x: 18, y: 486 },
    { id: 'capture', label: 'Screenshot Tool', icon: 'https://win98icons.alexmeub.com/icons/png/camera-0.png', fallback: '/assets/retro/computer.png', x: 18, y: 564, action: 'capture-stream98' },
    { id: 'trash', label: 'Recycle Bin', icon: 'https://win98icons.alexmeub.com/icons/png/recycle_bin_empty-2.png', fallback: '/assets/retro/recycle.png', x: 0, y: 0, anchor: 'bottom-right' },
  ],

  oldWeb: {
    mediaBrand: 'DreamStream 99',
    mediaTagline: 'WATCH TOGETHER · ANYWHERE ON THE WEB!',
    chatBrand: 'Dial-Up Lounge',
    chatTagline: 'THE CHAT SPOT!',
    copyright: '© 1998-1999 DreamStream 99. All rights reserved.',
    webmaster: 'webmaster@dreamstream99.local',
    lastUpdated: 'Last updated: Aug. 17, 1999',
    visitorNumber: '00487213',
    bestViewed: 'Best viewed at 800×600 · 16-bit color',
    browserHint: 'Internet Explorer 5.0 / Netscape Communicator 4.7',
  },

  copy: {
    // The two browser windows
    mediaTitle: 'DreamStream 99 - Watch Together! - Microsoft Internet Explorer',
    chatTitle: 'Dial-Up Lounge - The Chat Spot! - Microsoft Internet Explorer',
    menuFile: 'File',
    menuEdit: 'Edit',
    menuView: 'View',
    menuFavorites: 'Favorites',
    menuTools: 'Tools',
    menuHelp: 'Help',
    addressLabel: 'Address',
    go: 'Go',
    links: 'Links',

    // Left-hand 1990s video site
    mediaNavHome: 'Home',
    mediaNavWatch: 'Watch Together',
    mediaNavChannels: 'Channels',
    mediaNavCommunity: 'Community',
    mediaNavDownloads: 'Downloads',
    mediaNavTop: 'Top Charts',
    mediaNavHelp: 'Help',
    siteNavigation: 'SITE NAVIGATION',
    navNowPlaying: 'Now Playing',
    navWatchRooms: 'Watch Rooms',
    navMovies: 'Movies',
    navMusic: 'Music Videos',
    navLive: 'Live Events',
    navFavorites: 'My Favorites',
    navRoomDirectory: 'Room Directory',
    navForum: 'Message Board',
    navFaq: 'Help & FAQ',
    memberLogin: 'MEMBER LOGIN',
    nicknameLabel: 'Nickname',
    nicknamePlaceholder: 'Nickname',
    fakePassword: 'Password',
    rememberMe: 'Remember me',
    fakeLogin: 'Log In!',
    fakeJoin: 'Sign Up Now (FREE!)',
    nowWatching: '★ NOW WATCHING TOGETHER! ★',
    currentRoom: 'Current Room',
    roomLabel: 'Room',
    watchingNow: 'watching now',
    copyInvite: 'Invite Friends!',
    sourceLabel: 'Video URL:',
    sourcePlaceholder: 'YouTube video URL',
    loadVideo: 'Load',
    emptyTitle: 'NO VIDEO LOADED',
    emptyText: 'Paste a video URL below.',
    featuredDownload: 'FEATURED DOWNLOAD',
    featuredName: 'DreamStream Player 2.0',
    featuredCopy: 'Faster. Better. Totally Rad.',
    featuredLink: 'Download Now!',
    topFive: 'TOP 5 THIS WEEK',
    coolStuff: 'COOL STUFF',
    siteStats: 'SITE STATS',
    membersStat: 'Members:',
    roomsStat: 'Rooms Today:',
    videosStat: 'Videos Watched:',
    upNext: 'UP NEXT IN ROOM QUEUE',
    announcements: 'ANNOUNCEMENTS',
    statusDone: 'Done',

    // Right-hand 1990s chat site
    chatLobby: 'Lobby',
    chatRooms: 'Rooms',
    chatProfiles: 'Profiles',
    chatSearch: 'Search',
    chatRules: 'Rules',
    chatTopicPrefix: 'Topic:',
    chatTopic: 'What should we watch tonight?',
    membersTitle: 'Members',
    chatWelcome: 'Welcome to Dial-Up Lounge! Be cool & have fun! :-)',
    chatPlaceholder: 'Type a message...',
    send: 'Send',
    chatEmpty: '*** No messages in this room yet ***',
    youSuffix: ' (you)',
    onlineLegend: 'Online',
    awayLegend: 'Away',
    busyLegend: 'Busy',
    moreSmileys: 'More »',
    changeRoom: 'Change Room',
    whosHere: "Who's Here?",
    ignoreList: 'Ignore List',
    myProfile: 'My Profile',
    coolLinks: 'COOL LINKS',

    // Join / system
    joinTitle: 'Connect to Watch Room',
    joinButton: 'Connect',
    taskStart: 'Start',
    statusWaiting: 'Waiting to connect',
    statusJoining: 'Connecting...',
    statusJoinFailed: 'Connection failed',
    statusOnline: 'Connected',
    statusDemo: 'Demo mode',
    statusReconnecting: 'Reconnecting...',
    youtubeLabel: 'YouTube',
    roleOwner: 'Host',
    roleGuest: 'Guest',
    ownerSuffix: ' [HOST]',
    guestPermissions: 'Guest Permissions',
    allowGuestControl: 'Allow playback control',
    allowGuestChat: 'Allow chat messages',
    retryPlayer: 'Retry',
    unmuteAndSync: 'Unmute & Sync',

    ariaPlay: 'Play',
    ariaPause: 'Pause',
    ariaBack: 'Back 10 seconds',
    ariaForward: 'Forward 10 seconds',
    ariaFullscreen: 'Fullscreen',

    toastAutoplayMuted: 'The browser blocked autoplay with sound. Playback remains synchronized while muted.',
    toastYoutubeError: 'YouTube player error: {code}',
    toastJoinFailed: 'Could not connect to the room.',
    toastRoomCreateFailed: 'Could not create a room. Refresh the page and try again.',
    toastSyncFailed: 'Player synchronization failed.',
    toastJoinFirst: 'Connect to the room first.',
    toastCommandFailed: 'Synchronization failed.',
    toastNoControl: 'The host has not enabled guest playback control.',
    toastPermissionsFailed: 'Could not update room permissions.',
    toastPasteLink: 'Paste a video link first.',
    toastInvalidLink: 'This link could not be recognized.',
    toastYoutubeMissingId: 'The YouTube link is missing a video ID.',
    toastUnsupportedLink: 'Only YouTube video URLs are supported.',
    toastInvalidTime: 'The time value could not be recognized.',
    toastInviteCopied: 'Invitation link copied.',
    toastCopyFailed: 'Could not copy the invitation link.',
    toastCaptureNeedVideo: 'Load a video before using the screenshot tool.',
    toastCapturePickTab: 'Choose this browser tab in the window that opens next.',
    toastCapturePreparing: 'Creating the stream98 screenshot...',
    toastCaptureReady: 'The stream98 screenshot is ready and downloading.',
    toastCaptureCanceled: 'Screenshot canceled.',
    toastCaptureFailed: 'Screenshot failed. Make sure you selected this browser tab.',
    toastFullscreenFailed: 'Could not enter fullscreen mode.',
    toastSendFailed: 'Could not send the message.',
    demoModeButton: 'Demo mode',
    toastDemoMode: 'GitHub Pages demo mode: playback and chat stay in this browser tab.',
  },
};
