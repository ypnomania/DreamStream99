function clampInteger(value, fallback, min = 1, max = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function renderOne(element, settings) {
  if (!element || element.dataset.pixelRendered === '1') return;
  const text = element.textContent?.trim();
  if (!text) return;

  const sourceSize = clampInteger(element.dataset.pixelSource, settings.sourceSize || 12, 8, 24);
  const scale = clampInteger(element.dataset.pixelScale, settings.defaultScale || 2, 1, 6);
  const weight = element.dataset.pixelWeight || '700';
  const fontFamily = settings.fontFamily || '"Pixelated MS Sans Serif", "MS Sans Serif", sans-serif';
  const font = `${weight} ${sourceSize}px ${fontFamily}`;

  // Draw once at the small source resolution, then let CSS upscale the already-rasterized bitmap.
  const probe = document.createElement('canvas');
  const pctx = probe.getContext('2d', { alpha: true });
  pctx.font = font;
  pctx.textBaseline = 'top';
  const metrics = pctx.measureText(text);
  const sourceWidth = Math.max(1, Math.ceil(metrics.width) + 2);
  const sourceHeight = Math.max(sourceSize + 3, Math.ceil((metrics.actualBoundingBoxAscent || sourceSize) + (metrics.actualBoundingBoxDescent || 2)) + 3);

  const canvas = document.createElement('canvas');
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.width = `${sourceWidth * scale}px`;
  canvas.style.height = `${sourceHeight * scale}px`;
  canvas.style.imageRendering = 'pixelated';

  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.imageSmoothingEnabled = false;
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.fillStyle = getComputedStyle(element).color || '#000';
  ctx.fillText(text, 1, 0);

  element.setAttribute('aria-label', text);
  element.textContent = '';
  element.append(canvas);
  element.classList.add('pixelized');
  element.dataset.pixelRendered = '1';
}

export function initPixelText(settings = {}) {
  if (settings.enabled === false) return;
  const run = () => document.querySelectorAll('[data-pixel-text]').forEach((el) => renderOne(el, settings));
  if (document.fonts?.ready) document.fonts.ready.then(run).catch(run);
  else run();
}
