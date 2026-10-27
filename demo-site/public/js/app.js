// Inserts a promo banner after a delay. It is added above the content with no reserved space,
// which pushes everything down and causes layout shift.
window.addEventListener('load', function () {
  setTimeout(function () {
    var banner = document.createElement('div');
    banner.className = 'promo';
    banner.textContent = 'Free pastry with every pour-over this week';
    document.body.insertBefore(banner, document.body.firstChild);
  }, 600);
});
