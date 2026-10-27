# PerfPilot demo site

A deliberately slow landing page for a coffee shop. PerfPilot AI uses it as a safe target.

Known problems (each one has a matching fix in PerfPilot's catalog):
- Two render-blocking stylesheets and two render-blocking scripts in the head
- `analytics.js` blocks the main thread for about 250 ms
- `vendor.js` is large, unminified and mostly unused
- No text compression and no cache headers (see `server.mjs`)
- A 1600x900 PNG hero that is far heavier than it needs to be, and 6 gallery PNGs loaded eagerly
- Images have no `width` and `height`
- A promo banner is injected above the content after load, which shifts the layout

Run: `npm start` (port 4200). Regenerate assets: `npm run gen-assets`.

`DEMO_REGRESSION=1` injects `/regression.js` as the first script in HTML responses. That file does about 120 ms of synchronous work and requests nothing else. Leave the variable unset for the normal demo.
