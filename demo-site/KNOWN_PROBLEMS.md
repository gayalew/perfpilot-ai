# Planted problems

Answer key for the unfixed demo site. One line per problem: where it lives, and the change that clears it.

- Render-blocking scripts in the head — `demo-site/public/index.html` — Add `defer` to `/js/vendor.js` and `/js/analytics.js`.
- Render-blocking stylesheets in the head — `demo-site/public/index.html` — Inline the critical rules from `/css/base.css` and `/css/theme.css`, or load those files without blocking first paint.
- Synchronous analytics work before first paint — `demo-site/public/js/analytics.js` — Remove the 250 ms busy-loop from the head script so it does not block parsing.
- Large, mostly unused library — `demo-site/public/js/vendor.js` — Delete the unused `utilityFunction*` helpers and keep only what the page calls.
- Unminified JavaScript — `demo-site/public/js/vendor.js` — Minify the file that is actually shipped.
- No text compression — `demo-site/server.mjs` — Compress HTML, CSS, and JavaScript responses with gzip or brotli.
- No cache headers — `demo-site/server.mjs` — Send a long-lived `Cache-Control` header for the static assets.
- Oversized PNGs — `demo-site/public/img/` (built by `demo-site/scripts/gen-assets.mjs`) — Serve the hero and gallery images at display size in WebP or AVIF.
- Gallery images loaded up front — `demo-site/public/index.html` — Add `loading="lazy"` to the six `#gallery` images. The `#journal` section is what pushes them below the fold; leave that in place.
- Gallery images have no reserved box — `demo-site/public/index.html` — Set `width` and `height` on the six gallery `<img>` elements (they have neither attributes nor `aspect-ratio`).
- LCP image is lazy and not prioritized — `demo-site/public/index.html` — Take `loading="lazy"` off the hero image, add `<link rel="preload" as="image" href="/img/hero.png" fetchpriority="high">` in the head, and set `fetchpriority="high"` on the hero `<img>`.
- Promo banner inserted after first paint — `demo-site/public/js/app.js` (`insertPromoBanner`) — Put the `.promo` banner in the initial HTML above the hero, with its height reserved, instead of inserting it from a double `requestAnimationFrame` after `DOMContentLoaded`.
- One long startup task after load — `demo-site/public/js/app.js` (`runStartupWork`) — Yield between `runStartupChunk` calls instead of running all four chunks inside a single synchronous loop.
