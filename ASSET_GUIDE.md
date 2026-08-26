# Asset replacement guide

Frequently replaced images are configured in **`public/assets-config.js`**, while `public/config.js` keeps the defaults. You normally do not need to edit HTML or CSS.

## Quick start

1. Place your PNG, GIF, or JPG files in `public/assets/custom/`.
2. Open `public/assets-config.js`.
3. Replace the relevant `null` with `/assets/custom/your-file-name`.
4. Save and refresh the page. You do not need to run `npm install` again.

Example:

```js
const overrides = {
  desktopBackground: '/assets/custom/clouds.gif',
  site: {
    mediaHeaderLogo: '/assets/custom/dreamstream-logo.gif',
    mediaHeaderBackground: '/assets/custom/stars.gif',
    mediaPageBackground: '/assets/custom/paper.gif',
    chatHeaderLogo: '/assets/custom/chat-logo.gif',
    chatHeaderBackground: '/assets/custom/chat-header.gif',
    chatPageBackground: '/assets/custom/chat-tile.gif',
  },
};
```

## Common keys

| Configuration key | Purpose | Default presentation |
| --- | --- | --- |
| `assets.desktopBackground` | Windows desktop wallpaper | Centered and covered |
| `assets.site.mediaHeaderLogo` | Video site header logo | Image replaces the text logo |
| `assets.site.mediaHeaderBackground` | Video site header background | Cover |
| `assets.site.mediaPageBackground` | Video site page background | Repeated tile |
| `assets.site.chatHeaderLogo` | Chat site header logo | Image replaces the text logo |
| `assets.site.chatHeaderBackground` | Chat site header background | Cover |
| `assets.site.chatPageBackground` | Chat site page background | Repeated tile |
| `assets.browserToolbar.*` | IE toolbar button icons | 24×24 |
| `assets.siteIcons.*` | Site navigation icons | 16×16 |
| `desktopIcons[].icon` | Desktop icons | 32×32 |
| `assets.startLogo` | Windows mark on the Start button | Native pixel size |

In `assets-config.js`, `null` keeps the default asset and `''` clears it intentionally. Clearing `mediaHeaderLogo` or `chatHeaderLogo` restores the corresponding text logo.

## 1990s web artwork tips

- Logos: use transparent GIF or PNG files and avoid unnecessarily large high-resolution images.
- Small buttons and badges: 88×31 pixels strongly evokes the period.
- Tiled backgrounds: small 32×32, 64×64, or 128×128 GIF and PNG files fit the era.
- Pixel artwork: prepare the target size or an integer multiple instead of stretching 17px artwork to 24px. Keep `image-rendering: pixelated` enabled.

## 4K and UI size

In `public/config.js`:

```js
display: {
  uiScale: 'auto',
}
```

`auto` combines `devicePixelRatio` with viewport dimensions to detect 4K displays at 125%, 150%, or 200% Windows scaling. To force the Win98 interface to double in size, set:

```js
uiScale: 2,
```

Use integer values such as `1`, `2`, or `3` to keep pixel artwork and bitmap text in stable proportions.

## Reset window and icon positions

If windows or icons are out of place, visit:

```text
http://localhost:3000/?resetLayout=1
```

This clears only saved window and desktop icon positions. It does not remove the saved nickname or other settings.
