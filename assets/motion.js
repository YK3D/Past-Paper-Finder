/* PaperFinder motion layer
   - Lenis smooth scroll, driven by GSAP's ticker so ScrollTrigger stays in sync
   - Intro: wordmark split into characters (SplitText), mono labels decrypt
   - Spotlight: pointer-lit border/glow on signature surfaces (--mx/--my/--spot)
   - Scroll reveal: IntersectionObserver + MutationObserver, so rows rendered
     later (leaderboard, search results) animate in too
   - Scroll progress bar on long pages
   Everything degrades: no GSAP -> CSS reveals still work; reduced motion ->
   nothing moves and nothing is hidden. */
(function () {
  'use strict';

  var doc = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var hasGsap = typeof window.gsap !== 'undefined';
  var gsap = window.gsap;

  function showIntroNow() {
    var els = document.querySelectorAll('[data-pf-intro]');
    for (var i = 0; i < els.length; i++) { els[i].style.opacity = '1'; els[i].style.animation = 'none'; }
  }

  if (reduce) { doc.classList.remove('pf-motion'); showIntroNow(); return; }

  if (hasGsap) {
    if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
    if (window.SplitText) gsap.registerPlugin(window.SplitText);
  }

  /* ---------------- Lenis ---------------- */
  var lenis = null;
  var allowLenis = !coarse && typeof window.Lenis === 'function' && !document.querySelector('.viewer-root');
  if (allowLenis) {
    var isScrollable = function (node) {
      if (!node || node.nodeType !== 1 || node === document.body || node === doc) return false;
      var s = window.getComputedStyle(node);
      return (/(auto|scroll)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1) ||
             (/(auto|scroll)/.test(s.overflowX) && node.scrollWidth > node.clientWidth + 1);
    };
    var isOverlay = function (node) {
      return !!node && node.nodeType === 1 && window.getComputedStyle(node).position === 'fixed';
    };
    lenis = new window.Lenis({
      autoRaf: !hasGsap,
      lerp: 0.11,
      anchors: true,
      prevent: function (node) { return isScrollable(node) || isOverlay(node); }
    });
    if (hasGsap) {
      if (window.ScrollTrigger) lenis.on('scroll', window.ScrollTrigger.update);
      gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
      gsap.ticker.lagSmoothing(0);
    }
    window.__lenis = lenis;
    // keep Lenis' cached height right when views are swapped (index main <-> codes)
    if ('ResizeObserver' in window) {
      var ro = new ResizeObserver(function () { lenis.resize(); if (window.ScrollTrigger) window.ScrollTrigger.refresh(); });
      ro.observe(document.body);
    }
  }

  /* ---------------- Decrypt (mono labels) ---------------- */
  var GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/#%&*+=<>';
  function decrypt(el, opts) {
    if (!el || el.__pfDecrypted) return;
    var text = el.textContent;
    if (!text || !text.trim() || el.children.length) return;
    el.__pfDecrypted = true;
    opts = opts || {};
    var speed = opts.speed || 28;
    var delay = opts.delay || 0;
    var chars = Array.from(text);
    var revealAt = chars.map(function (c, i) { return /\s/.test(c) ? -1 : i * 1.6 + 4; });
    el.setAttribute('aria-label', text);
    el.classList.add('pf-decrypt');
    var minW = el.getBoundingClientRect().width;
    if (minW) el.style.minWidth = Math.ceil(minW) + 'px';
    var frame = 0;
    setTimeout(function tick() {
      var out = '';
      var done = true;
      for (var i = 0; i < chars.length; i++) {
        if (revealAt[i] < 0 || frame >= revealAt[i]) { out += chars[i]; }
        else { done = false; out += GLYPHS[(Math.random() * GLYPHS.length) | 0]; }
      }
      el.textContent = out;
      frame++;
      if (!done) setTimeout(tick, speed);
      else { el.textContent = text; el.style.minWidth = ''; }
    }, delay);
  }

  /* ---------------- Intro ---------------- */
  function intro() {
    var targets = Array.prototype.slice.call(document.querySelectorAll('[data-pf-intro]'));
    if (!targets.length) return;
    if (!hasGsap) { showIntroNow(); return; }

    targets.forEach(function (el) { el.style.animation = 'none'; });
    var tl = gsap.timeline({ defaults: { ease: 'expo.out' } });

    var h1 = document.querySelector('[data-pf-intro] h1, h1[data-pf-intro]');
    var split = null;
    if (h1 && window.SplitText) {
      try { split = new window.SplitText(h1, { type: 'chars', charsClass: 'pf-split-char' }); } catch (e) { split = null; }
    }

    // make targets visible *before* building from() tweens, otherwise they record opacity:0 as their end value
    gsap.set(targets, { opacity: 1 });
    targets.forEach(function (el, i) {
      if (h1 && el.contains(h1) && split) {
        var rest = Array.prototype.slice.call(el.children).filter(function (c) { return !c.contains(h1); });
        tl.from(split.chars, {
          yPercent: 70, opacity: 0, rotateX: -70, transformOrigin: '50% 100%',
          duration: 0.9, stagger: 0.03
        }, 0.05);
        if (rest.length) tl.from(rest, { y: 10, opacity: 0, duration: 0.7, stagger: 0.08 }, 0.15);
      } else {
        tl.from(el, { y: 18, opacity: 0, duration: 0.9 }, 0.2 + i * 0.12);
        var fields = el.querySelectorAll(':scope > .field-group > .field, :scope > .field-group > .row-2, :scope > .btn-row');
        if (fields.length) tl.from(fields, { y: 12, opacity: 0, duration: 0.7, stagger: 0.06 }, 0.35 + i * 0.12);
      }
    });
    tl.eventCallback('onComplete', function () {
      if (split) { try { split.revert(); } catch (e) {} }
      gsap.set(targets, { clearProps: 'transform' });
    });

    var labels = document.querySelectorAll('.label-top');
    for (var j = 0; j < labels.length; j++) decrypt(labels[j], { delay: 250 });
  }

  /* ---------------- Spotlight ---------------- */
  function spotlight() {
    if (coarse) return;
    var sel = '.card, .codes-section, .contact-section, .rating-section, .lb-you-card, .auth-modal';
    var active = null;
    var raf = 0;
    var px = 0, py = 0;
    function paint() {
      raf = 0;
      if (!active) return;
      var r = active.getBoundingClientRect();
      active.style.setProperty('--mx', (px - r.left) + 'px');
      active.style.setProperty('--my', (py - r.top) + 'px');
    }
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      var t = e.target && e.target.closest ? e.target.closest(sel) : null;
      if (t !== active) {
        if (active) active.style.setProperty('--spot', '0');
        active = t;
        if (active) active.style.setProperty('--spot', '1');
      }
      px = e.clientX; py = e.clientY;
      if (active && !raf) raf = requestAnimationFrame(paint);
    }, { passive: true });
    document.addEventListener('pointerleave', function () {
      if (active) active.style.setProperty('--spot', '0');
      active = null;
    });
  }

  /* ---------------- Scroll reveal ---------------- */
  var REVEAL = [
    '.recent-box.visible', '.question-search-section', '.lb-link-btn', '.made-by',
    '.contact-section', '.rating-section', '.version-tag', '.site-footer', 'footer',
    '.codes-section', '.code-table tr', '.cat-label',
    '.lb-you-card', '.lb-row', '.lb-tabs',
    '.qs-result-card', '.recent-item',
    '.wrap > section', '.wrap .highlight-box', '.wrap > .footer-links'
  ].join(',');
  var DECRYPT_ON_VIEW = '.made-by, .contact-label, .rating-label, .sec-sub, .cat-label';

  var io = null;
  var queue = [];
  var flushTimer = 0;
  function flush() {
    flushTimer = 0;
    queue.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
    queue.forEach(function (el, i) {
      el.style.setProperty('--pf-delay', Math.min(i * 35, 420) + 'ms');
      el.classList.add('pf-in');
      if (el.matches(DECRYPT_ON_VIEW)) decrypt(el);
      var inner = el.querySelectorAll ? el.querySelectorAll('.contact-label, .rating-label') : [];
      for (var k = 0; k < inner.length; k++) decrypt(inner[k], { delay: 120 });
      // drop the transition hook once it has played so later JS-driven styles are unaffected
      setTimeout(function () { el.classList.remove('pf-reveal', 'pf-in'); el.style.removeProperty('--pf-delay'); }, 1200 + Math.min(i * 35, 420));
    });
    queue = [];
  }
  function onIntersect(entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      queue.push(en.target);
    });
    if (queue.length && !flushTimer) flushTimer = requestAnimationFrame(flush);
  }
  function arm(el) {
    if (el.__pfArmed || el.closest('[data-pf-intro]')) return;
    el.__pfArmed = true;
    var r = el.getBoundingClientRect();
    // already on screen at load: no reveal, avoids a flash
    if (document.readyState !== 'complete' && r.top < window.innerHeight && r.bottom > 0 && r.width) return;
    el.classList.add('pf-reveal');
    io.observe(el);
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches && root.matches(REVEAL)) arm(root);
    var found = root.querySelectorAll ? root.querySelectorAll(REVEAL) : [];
    for (var i = 0; i < found.length; i++) arm(found[i]);
  }
  function reveals() {
    if (!('IntersectionObserver' in window)) return;
    io = new IntersectionObserver(onIntersect, { rootMargin: '0px 0px -6% 0px', threshold: 0.01 });
    scan(document.body);
    var pending = [];
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === 'attributes') { pending.push(m.target); return; }
        for (var i = 0; i < m.addedNodes.length; i++) pending.push(m.addedNodes[i]);
      });
      requestAnimationFrame(function () { var p = pending; pending = []; p.forEach(scan); });
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  /* ---------------- Scroll progress ---------------- */
  function progress() {
    var bar = document.createElement('div');
    bar.className = 'pf-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    var ticking = false;
    function update() {
      ticking = false;
      var max = doc.scrollHeight - window.innerHeight;
      var show = max > window.innerHeight * 0.6;
      bar.style.opacity = show ? '1' : '0';
      bar.style.transform = 'scaleX(' + (show ? Math.min(1, Math.max(0, window.scrollY / max)) : 0) + ')';
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  /* ---------------- Header parallax ---------------- */
  function parallax() {
    if (!hasGsap || !window.ScrollTrigger) return;
    var header = document.querySelector('#main-view header');
    if (!header) return;
    gsap.to(header, {
      y: -24, opacity: 0.35, ease: 'none',
      scrollTrigger: { trigger: header, start: 'top top', end: 'bottom top', scrub: true }
    });
  }

  function start() {
    intro();
    spotlight();
    reveals();
    progress();
    parallax();
    doc.classList.add('pf-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
