// Fake analytics. Runs synchronously in the head and does heavy work on load.
(function () {
  var start = Date.now();
  while (Date.now() - start < 250) { /* simulate expensive tag setup */ }
  window.__analyticsReady = true;
})();
