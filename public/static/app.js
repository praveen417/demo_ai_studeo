document.addEventListener('submit',function(e){var m=e.target.getAttribute('data-confirm');if(m&&!window.confirm(m)){e.preventDefault();}});
document.addEventListener('click',function(e){if(e.target.hasAttribute&&e.target.hasAttribute('data-print')){window.print();}});
document.addEventListener('click',function(e){var t=e.target;if(t.hasAttribute&&t.hasAttribute('data-confirm-btn')&&!window.confirm('Are you sure?')){e.preventDefault();}});
document.addEventListener('change',function(e){var t=e.target;if(t.tagName==='SELECT'&&t.getAttribute('data-custom-for')){var el=document.getElementById(t.getAttribute('data-custom-for'));if(el){el.style.display=(t.value==='Custom')?'block':'none';}}});

/* mobile menu drawer, PWA registration and install button */
(function () {
  var body = document.body;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest) { return; }
    if (t.closest('[data-menu-toggle]')) { body.classList.toggle('menu-open'); return; }
    if (t.closest('[data-menu-close]') || t.closest('.side a')) { body.classList.remove('menu-open'); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { body.classList.remove('menu-open'); } });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {}); });
  }
  var deferred = null, btn = document.getElementById('install-btn');
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; if (btn) { btn.hidden = false; } });
  if (btn) {
    btn.addEventListener('click', function () {
      if (!deferred) { return; }
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; btn.hidden = true; });
    });
  }
})();
