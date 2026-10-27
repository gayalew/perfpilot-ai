// The promo is not in the initial HTML. It is inserted after the first paint, above the
// hero, with no reserved slot, so the content that is already visible gets pushed down.
function insertPromoBanner() {
  if (document.querySelector('.promo')) return;
  var banner = document.createElement('div');
  banner.className = 'promo';
  banner.textContent = 'Free pastry with every pour-over this week. Ask at the bar before noon.';
  document.body.insertBefore(banner, document.body.firstChild);
}

window.addEventListener('DOMContentLoaded', function () {
  requestAnimationFrame(function () {
    requestAnimationFrame(insertPromoBanner);
  });
});

// Heavy startup work, run as one task after load. Lighthouse simulates a 4x CPU
// slowdown, so this ~130 ms of real work becomes a long task of several hundred ms.
// The chunks are separate so a later fix can yield between them.
var STARTUP_CHUNK_MS = 32;
var STARTUP_CHUNKS = 4;

function runStartupChunk(index) {
  var started = Date.now();
  var guard = index + 1;
  while (Date.now() - started < STARTUP_CHUNK_MS) {
    guard = (guard + Math.sqrt(guard + 1)) % 1000000;
  }
  return guard;
}

function runStartupWork() {
  var total = 0;
  for (var i = 0; i < STARTUP_CHUNKS; i++) total += runStartupChunk(i);
  window.__startupWork = total;
}

window.addEventListener('load', function () {
  setTimeout(runStartupWork, 0);
});
