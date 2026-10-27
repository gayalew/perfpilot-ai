// Render-blocking work used only when DEMO_REGRESSION=1. It fetches nothing.
(function () {
  var started = Date.now();
  var guard = 1;
  while (Date.now() - started < 120) {
    guard = (guard + Math.sqrt(guard + 1)) % 1000000;
  }
  window.__regressionWork = guard;
})();
