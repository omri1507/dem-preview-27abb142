/* Democratim LP — interactions
   - scale the 1440 canvas down to a 1080 floor on narrower viewports
   - infinite marquee strip
   - render the sign-up counter as live text from Mandatory glyph outlines
   - light parallax + reveal in the mid section
   - consent checkbox (the form itself is js/join.js)                                   */
(function () {
  'use strict';
  var DESIGN_W = 1440;
  /* the single-column layout lives entirely in the stylesheet; use the very
     same media query here so JS and CSS can never disagree about which mode
     we're in (a scrollbar's worth of width was enough to split them) */
  var mqMobile = window.matchMedia('(max-width: 899px)');
  var root = document.getElementById('root');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* mark JS active so CSS only arms the reveal state when we can undo it */
  document.documentElement.classList.add('js');

  /* -------------------------------------------------- scale to fit
     >= 1440      : natural, full-bleed backgrounds, 1440 content well centred.
     900 - 1440   : the whole 1440 canvas scales down proportionally, centred.
     < 900        : untouched — the mobile layout in the stylesheet takes over.  */
  function fit() {
    var vw = document.documentElement.clientWidth;
    if (mqMobile.matches || vw >= DESIGN_W) {
      root.classList.remove('is-scaled');
      root.style.cssText = '';
      document.body.style.height = '';
      document.body.style.overflowX = 'hidden';
      return;
    }
    var s = vw / DESIGN_W;
    root.classList.add('is-scaled');
    root.style.width = DESIGN_W + 'px';
    root.style.left = '50%';
    root.style.transform = 'translateX(-50%) scale(' + s + ')';
    root.style.transformOrigin = 'top center';
    document.body.style.height = (root.scrollHeight * s) + 'px';
    document.body.style.overflowX = 'hidden';
  }
  window.addEventListener('resize', fit, { passive: true });
  window.addEventListener('load', fit);
  mqMobile.addEventListener('change', fit);
  fit();

  /* -------------------------------------------------- let the navy band grow
     The desktop layout gives the registration form a fixed 534px of room (form
     top 358 → 60px clear of the footer logo at 952). Most steps fit; the
     cluster step with 8 cards and the youth box doesn't. Whatever the form
     outgrows that room by becomes --grow, which the stylesheet adds to the
     band, its slab and the footer group — then re-fit, since the canvas got
     taller. On mobile everything is in normal flow already, so it's 0.     */
  var joinForm = document.getElementById('join');
  var FORM_ROOM = 534;
  function growBand() {
    var g = (joinForm && !mqMobile.matches)
      ? Math.max(0, Math.ceil(joinForm.offsetHeight - FORM_ROOM)) : 0;
    document.documentElement.style.setProperty('--grow', g + 'px');
    fit();
  }
  if (joinForm && 'ResizeObserver' in window) {
    new ResizeObserver(growBand).observe(joinForm);
    mqMobile.addEventListener('change', growBand);
  }

  /* -------------------------------------------------- hero portrait rotator
     Cross-fades the five portraits endlessly. Purely a CSS opacity swap — the
     images are stacked in one box, so nothing reflows as it runs. Held on the
     first frame under prefers-reduced-motion, and paused while the tab is
     hidden so it doesn't burn a timer in the background.                     */
  var people = Array.prototype.slice.call(document.querySelectorAll('.hero-person'));
  if (people.length > 1 && !reduce) {
    var HOLD = 4000, personIx = 0, personTimer = null;
    function nextPerson() {
      people[personIx].classList.remove('is-on');
      personIx = (personIx + 1) % people.length;
      people[personIx].classList.add('is-on');
    }
    function startPeople() {
      if (personTimer === null) personTimer = setInterval(nextPerson, HOLD);
    }
    function stopPeople() {
      if (personTimer !== null) { clearInterval(personTimer); personTimer = null; }
    }
    document.addEventListener('visibilitychange', function () {
      document.hidden ? stopPeople() : startPeople();
    });
    startPeople();
  }

  /* -------------------------------------------------- marquee fill */
  var UNIT = '<span class="mq-unit">' +
    '<img class="mq-text" src="assets/svg/marquee-text.svg" alt="מביאים כל קול">' +
    '<img class="mq-star" src="assets/svg/star1.svg" alt="">' +
    '</span>';
  document.querySelectorAll('.marquee__seq').forEach(function (seq) {
    seq.innerHTML = new Array(9).fill(UNIT).join('');
  });

  /* -------------------------------------------------- progress bar
     The percentage is real, data-driven text — composed from the Mandatory
     glyph outlines in assets/js/mandatory-digits.js, since the face has no web
     licence and can't be loaded as a font. One number drives both the label
     and the fill width; set data-pct on .count, or call window.setProgress(n).
     It counts up (and the bar grows) when the block scrolls into view, after a
     short delay so the animation isn't already over when you get there.      */
  var count  = document.querySelector('.count');
  var pctEl  = count && count.querySelector('.bar__pct');
  var barEl  = count && count.querySelector('.bar');
  var FONT   = window.MANDATORY_DIGITS;
  var SVGNS  = 'http://www.w3.org/2000/svg';
  var target = count ? (parseFloat(count.getAttribute('data-pct')) || 0) : 0;

  var PCT_SIZE = 80;                                  // Figma type size, px
  var SCALE    = FONT ? PCT_SIZE / FONT.size : 1;     // outlines are drawn at FONT.size
  /* Figma puts a hard 4px red offset behind the white glyphs — that's what
     carries them across the grey/red edge. Expressed in the outlines' own
     units so it scales with the SVG rather than with the viewport. */
  var SHADOW   = FONT ? 4 / SCALE : 0;

  /* pen positions + ink extent for a string, honouring the font's kerning */
  function layout(str) {
    var pen = 0, pos = [], left = Infinity, right = -Infinity, i, g;
    for (i = 0; i < str.length; i++) {
      g = FONT.glyphs[str[i]];
      if (!g) continue;
      pos.push(pen);
      left = Math.min(left, pen + g.x[0]);
      right = Math.max(right, pen + g.x[1]);
      pen += g.a;
      if (i + 1 < str.length) pen += (FONT.kern[str[i] + str[i + 1]] || 0);
    }
    return { pos: pos, left: left, right: right };
  }

  /* The box is locked to the FINAL value, and shorter strings are centred in
     it — so the label doesn't jitter or reflow while it counts up. */
  var finalBox = FONT && pctEl ? layout(Math.round(target) + '%') : null;

  function paintGlyphs(g, str, L, shift) {
    while (g.childNodes.length > str.length) g.removeChild(g.lastChild);
    while (g.childNodes.length < str.length) g.appendChild(document.createElementNS(SVGNS, 'path'));
    for (var i = 0; i < str.length; i++) {
      var gl = FONT.glyphs[str[i]], p = g.childNodes[i];
      if (!gl) continue;
      if (p.getAttribute('d') !== gl.d) p.setAttribute('d', gl.d);
      p.setAttribute('transform', 'translate(' + (L.pos[i] + shift).toFixed(2) + ' 0)');
    }
  }

  function renderPct(str) {
    if (!FONT || !pctEl) return;
    var L = layout(str);
    var w = finalBox.right - finalBox.left;
    var shift = (finalBox.left + finalBox.right) / 2 - (L.left + L.right) / 2;
    var svg = pctEl.querySelector('svg');
    if (!svg) {
      pctEl.textContent = '';                       // drop the no-JS fallback
      svg = document.createElementNS(SVGNS, 'svg');
      svg.appendChild(document.createElementNS(SVGNS, 'g'));   // 0: red shadow
      svg.appendChild(document.createElementNS(SVGNS, 'g'));   // 1: white face
      svg.childNodes[0].setAttribute('fill', 'var(--red)');
      svg.childNodes[0].setAttribute('transform',
        'translate(' + SHADOW.toFixed(2) + ' ' + SHADOW.toFixed(2) + ')');
      svg.childNodes[1].setAttribute('fill', 'var(--white)');
      pctEl.appendChild(svg);
    }
    svg.setAttribute('viewBox', finalBox.left + ' 0 ' + w + ' ' + FONT.boxHeight);
    svg.setAttribute('width',  (w * SCALE).toFixed(2));
    svg.setAttribute('height', (FONT.boxHeight * SCALE).toFixed(2));
    paintGlyphs(svg.childNodes[0], str, L, shift);
    paintGlyphs(svg.childNodes[1], str, L, shift);
  }

  function paintProgress(v) {
    if (!count) return;
    count.style.setProperty('--pct', v.toFixed(2));
    if (barEl) barEl.setAttribute('aria-valuenow', String(Math.round(v)));
    renderPct(Math.round(v) + '%');
  }

  /* count-up + fill, one eased clock driving both so they stay in step */
  var PROG_DELAY = 380, PROG_DUR = 1500, progressRan = false, progGen = 0;
  function runProgress() {
    if (progressRan || !count) return;
    progressRan = true;
    if (!FONT || !pctEl) return;        /* no outlines → leave the inline --pct */
    if (reduce) { paintProgress(target); return; }
    var gen = ++progGen;                /* a later call invalidates this run */
    paintProgress(0);
    setTimeout(function () {
      if (gen !== progGen) return;
      var t0 = null;
      requestAnimationFrame(function step(ts) {
        if (gen !== progGen) return;
        if (t0 === null) t0 = ts;
        var t = Math.min(1, (ts - t0) / PROG_DUR);
        paintProgress(target * (1 - Math.pow(1 - t, 3)));   // easeOutCubic
        if (t < 1) requestAnimationFrame(step);
      });
    }, PROG_DELAY);
  }

  /* Change the value at runtime — a CMS, a fetch, the console:
     window.setProgress(62) re-runs the animation, setProgress(62, false) snaps. */
  window.setProgress = function (n, animate) {
    if (!count) return;
    progGen++;                          /* stop any run already in flight */
    target = Math.max(0, Math.min(100, Number(n) || 0));
    count.setAttribute('data-pct', String(target));
    if (FONT && pctEl) finalBox = layout(Math.round(target) + '%');
    if (animate === false || reduce) { progressRan = true; paintProgress(target); }
    else { progressRan = false; runProgress(); }
  };

  /* Start at zero so the fill has somewhere to grow from. The markup carries
     an inline --pct, so with JS off the bar is simply already at its value. */
  if (count && FONT && pctEl) { reduce ? paintProgress(target) : paintProgress(0); }
  if (reduce) progressRan = true;

  /* -------------------------------------------------- reveal on scroll
     IntersectionObserver where available, but ALWAYS backed by a rect check on
     scroll/resize and a hard safety timeout, so content can never get stuck
     hidden if IO misbehaves. */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  function inViewport(el, frac) {
    var r = el.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.height === 0) return false;
    var visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return visible / Math.min(r.height, vh) >= (frac || 0.3);
  }
  function sweep() {
    for (var i = revealEls.length - 1; i >= 0; i--) {
      if (inViewport(revealEls[i], 0.25)) {
        revealEls[i].classList.add('in');
        revealEls.splice(i, 1);
      }
    }
    if (count && !progressRan && inViewport(count, 0.35)) runProgress();
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.25, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });

    if (count) {
      var pio = new IntersectionObserver(function (entries) {
        if (!entries.some(function (e) { return e.isIntersecting; })) return;
        pio.disconnect();
        runProgress();
      }, { threshold: 0.35, rootMargin: '0px 0px -10% 0px' });
      pio.observe(count);
    }
  }
  window.addEventListener('scroll', sweep, { passive: true });
  window.addEventListener('resize', sweep, { passive: true });
  window.addEventListener('load', sweep);
  sweep();
  /* safety net: never leave anything hidden */
  setTimeout(function () {
    revealEls.forEach(function (el) { el.classList.add('in'); });
    revealEls.length = 0;
  }, 2600);

  /* -------------------------------------------------- parallax (mid section) */
  var pxEls = Array.prototype.slice.call(document.querySelectorAll('.parallax'));
  var blueBand = document.querySelector('.band--blue');
  var ticking = false;
  var PX_MAX = 44;
  function parallax() {
    ticking = false;
    if (reduce || !blueBand) return;
    var r = blueBand.getBoundingClientRect();
    var mid = r.top + r.height / 2 - window.innerHeight / 2;
    pxEls.forEach(function (el) {
      var d = parseFloat(el.getAttribute('data-depth')) || 0;
      var v = Math.max(-PX_MAX, Math.min(PX_MAX, -mid * d));
      el.style.setProperty('--px', v.toFixed(1) + 'px');
    });
  }
  function onScroll() {
    if (!ticking) { requestAnimationFrame(parallax); ticking = true; }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', parallax, { passive: true });
  parallax();

  /* -------------------------------------------------- checkbox */
  var cb = document.querySelector('.checkbox');
  if (cb) {
    var toggle = function () {
      var on = cb.classList.toggle('is-checked');
      cb.setAttribute('aria-checked', on ? 'true' : 'false');
    };
    cb.addEventListener('click', toggle);
    cb.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });
  }

  /* -------------------------------------------------- in-page links
     Every page pins a <base> to its own folder (head of index.html). That
     makes href="#join" resolve to ".../newform/#join" — a different address
     from ".../newform", so the browser would reload the page instead of
     scrolling. Take in-page links over and just scroll.                    */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  });

  /* the registration form itself lives in js/join.js */
})();
