/** Titles match worker/src/diagnose.ts FIX_CATALOG. */
export const FIX_CHOICES: Array<{ id: string; title: string }> = [
  { id: 'compress-text', title: 'Enable gzip/brotli compression' },
  { id: 'cache-headers', title: 'Add long-lived cache headers for static assets' },
  { id: 'defer-scripts', title: 'Defer render-blocking scripts' },
  { id: 'inline-or-async-css', title: 'Stop stylesheets blocking render' },
  { id: 'optimize-images', title: 'Resize and recompress images (WebP/AVIF)' },
  { id: 'lazy-load-images', title: 'Lazy-load below-the-fold images' },
  { id: 'image-dimensions', title: 'Set width and height on images' },
  { id: 'preload-lcp-image', title: 'Prioritize the main image' },
  { id: 'reserve-space', title: 'Reserve space for late-inserted content' },
  { id: 'minify-assets', title: 'Minify JavaScript and CSS' },
  { id: 'remove-unused-code', title: 'Remove or split unused code' },
  { id: 'split-long-tasks', title: 'Break up long main-thread tasks' },
  { id: 'preconnect', title: 'Preconnect to required origins' },
  { id: 'reduce-dom', title: 'Reduce DOM size' },
];
