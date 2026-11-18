/* Lenis smooth scrolling for document-level scroll.
   Skipped for reduced-motion users and touch-only devices (native scroll is
   already smooth there). Nested scroll containers (dropdowns, lists, modals)
   keep native scrolling. */
(function () {
  if (typeof window === 'undefined' || typeof window.Lenis !== 'function') return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;

  function isScrollable(node) {
    if (!node || node.nodeType !== 1 || node === document.body || node === document.documentElement) return false;
    var s = window.getComputedStyle(node);
    var y = /(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1;
    var x = /(auto|scroll)/.test(s.overflowX) && node.scrollWidth > node.clientWidth + 1;
    return y || x;
  }

  function isOverlay(node) {
    if (!node || node.nodeType !== 1) return false;
    return window.getComputedStyle(node).position === 'fixed';
  }

  var lenis = new window.Lenis({
    autoRaf: true,
    lerp: 0.12,
    wheelMultiplier: 1,
    anchors: true,
    prevent: function (node) { return isScrollable(node) || isOverlay(node); }
  });

  window.__lenis = lenis;
})();
