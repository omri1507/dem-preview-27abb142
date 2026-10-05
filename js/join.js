/* Democratim — registration flow controller (beta).

   Flow (from the campaign's own diagram):
     details -> otp -> [status check] ->
        not a member            -> done(not_member)
        member -> address -> clusters ->
            "place me anywhere"  -> done(place_me_anywhere)
            pick a cluster ->
                cluster has a manager  -> done(assigned)  (shows manager + WhatsApp)
                no manager -> manage ->
                    wants to manage    -> done(no_manager_wants_to_manage)
                    declines           -> done(no_manager_declines)

   The OTP code is made and checked by this site's backend, never in the
   browser — see js/webhooks.js. A correct code gets a session token that the
   later calls (status, clusters, submit) carry.

   Every finished step also posts a snapshot of everything gathered so far
   (Webhooks.saveProgress), so a visitor who drops out midway isn't lost. */

(function () {
  'use strict';

  // join.html calls it #flow; on the landing page it doubles as the #join
  // anchor the CTA buttons point at.
  var form = document.getElementById('flow') || document.getElementById('join');
  var steps = {};
  form.querySelectorAll('.step').forEach(function (el) { steps[el.dataset.step] = el; });

  var progress = document.querySelector('.progress');
  var progressLabel = document.querySelector('.progress__label');
  var progressFill = document.querySelector('.progress__fill');
  var errorBox = form.querySelector('.flow-error');
  var veil = document.querySelector('.loading');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // step -> position on the 5-dot progress rail (non-member ends early, that's fine)
  var RAIL = { details: 1, otp: 2, address: 3, clusters: 4, manage: 5, done: 5 };

  var S = {
    firstName: '', lastName: '', phone: '', email: '',
    city: '', cityStreetId: 0,
    otp: '',
    isMember: null, age: null,
    street: '', houseNumber: '', idNumber: '', shifts: [],
    clusters: [], chosen: null,
    outcome: '',
    // one id for the whole visit, on every post, so n8n can keep one row
    submissionId: Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  };

  /* ------------------------------------------------ helpers */

  function show(name) {
    Object.keys(steps).forEach(function (k) { steps[k].hidden = (k !== name); });
    hideError();
    var pos = RAIL[name] || 1;
    progress.hidden = (name === 'done');
    progressLabel.textContent = 'שלב ' + pos + ' מתוך 5';
    progressFill.style.setProperty('--p', (pos / 5 * 100) + '%');
    var h = steps[name].querySelector('h1');
    if (h) { try { h.focus(); } catch (e) {} }
    scrollToFlow();
  }

  // join.html is the whole page, so the top is the right place. On the landing
  // page the flow is one section of a long scroll — go to the section instead.
  // Either way, never scroll on the first render: the user hasn't asked yet.
  var booted = false;
  var anchor = document.querySelector('[data-flow-scroll]');
  function scrollToFlow() {
    if (!booted) { booted = true; return; }
    if (anchor) anchor.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    else if (!reduce) window.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo(0, 0);
  }

  function busy(on) { veil.hidden = !on; }

  function showError(msg) {
    errorBox.textContent = msg || 'משהו השתבש. נסו שוב עוד רגע.';
    errorBox.hidden = false;
    errorBox.scrollIntoView({ block: 'nearest' });
  }
  function hideError() { errorBox.hidden = true; }

  function markInvalid(input, bad) {
    if (bad) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function cleanPhone(v) { return String(v || '').replace(/[^\d]/g, ''); }
  function validPhone(v) { return /^05\d{8}$/.test(cleanPhone(v)); }
  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }

  function echo(key, value) {
    form.querySelectorAll('[data-echo="' + key + '"]').forEach(function (el) {
      el.textContent = value;
    });
  }

  /* ------------------------------------------------ Hebrew-only fields

     Client (2026-09-30): every field except e-mail takes Hebrew only. Text
     fields keep Hebrew plus the punctuation real names and the official
     city / street lists use (אל-פחם, ג'ורג', עי"ש, (שבט), ע. הלל, א+ב);
     number fields keep digits. Anything else is dropped as it's typed or
     pasted, with a short note saying why. A value picked from a list is set
     by script, not typed, so the handful of official street names with a
     Latin letter (רובע A) still go through. */

  var HEB = '\u0590-\u05FF';   // letters, niqqud, maqaf, geresh, gershayim
  var HEB_ONLY = 'אפשר לכתוב כאן רק בעברית';
  var DIGITS_ONLY = 'אפשר להקליד כאן רק ספרות';
  var ALLOWED = {
    firstName:   { re: new RegExp('[^' + HEB + ' \'"\\-.]', 'g'), hint: HEB_ONLY },
    lastName:    { re: new RegExp('[^' + HEB + ' \'"\\-.]', 'g'), hint: HEB_ONLY },
    city:        { re: new RegExp('[^' + HEB + '0-9 \'"\\-.()]', 'g'), hint: HEB_ONLY },
    street:      { re: new RegExp('[^' + HEB + '0-9 \'"\\-.()+]', 'g'), hint: HEB_ONLY },
    houseNumber: { re: new RegExp('[^' + HEB + '0-9 /\\-]', 'g'), hint: 'מספר בית: ספרות ואות בעברית בלבד' },
    phone:       { re: /[^\d\s-]/g, hint: DIGITS_ONLY },
    idNumber:    { re: /[^\d]/g, hint: DIGITS_ONLY },
    otp:         { re: /[^\d]/g, hint: DIGITS_ONLY }
  };

  // true when something had to be dropped
  function sanitize(input) {
    var rule = ALLOWED[input.name];
    if (!rule) return false;
    var v = input.value, clean = v.replace(rule.re, '');
    if (clean === v) return false;
    var pos = input.selectionStart;
    input.value = clean;
    if (pos != null) {
      var p = Math.max(0, pos - (v.length - clean.length));
      try { input.setSelectionRange(p, p); } catch (e) { /* type without a caret */ }
    }
    return true;
  }

  function fieldNote(input, msg) {
    var box = input.closest('.field');
    if (!box) return;
    var n = box.querySelector('.field__note');
    if (!n) {
      n = document.createElement('span');
      n.className = 'field__note';
      n.setAttribute('role', 'status');
      box.appendChild(n);
    }
    n.textContent = msg;
    clearTimeout(n._t);
    n._t = setTimeout(function () { n.remove(); }, 2600);
  }

  // capture phase: runs before the comboboxes' own input handlers, so they
  // filter their lists on the cleaned value
  form.addEventListener('input', function (e) {
    var el = e.target;
    if (el.name && sanitize(el)) fieldNote(el, ALLOWED[el.name].hint);
  }, true);

  /* ------------------------------------------------ combobox */

  function Combo(root, opts) {
    var input = root.querySelector('input');
    var list = root.querySelector('.combo__list');
    var items = [];        // current source array of strings
    var view = [];         // filtered
    var active = -1;
    var onPick = opts.onPick || function () {};

    function setItems(arr) { items = arr || []; }

    function render() {
      var q = input.value.trim();
      view = !q ? items.slice(0, 40)
                : items.filter(function (s) { return s.indexOf(q) !== -1; }).slice(0, 40);
      if (!view.length) {
        list.innerHTML = '<li class="combo__none">אין תוצאות מתאימות</li>';
      } else {
        list.innerHTML = view.map(function (s, i) {
          var html = q ? s.split(q).join('<mark>' + q + '</mark>') : s;
          return '<li class="combo__opt" role="option" id="opt-' + root.dataset.combo + '-' + i +
                 '" aria-selected="' + (i === active) + '">' + html + '</li>';
        }).join('');
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    function close() {
      list.hidden = true; active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function choose(val) {
      input.value = val;
      close();
      markInvalid(input, false);
      onPick(val);
    }
    function move(d) {
      if (list.hidden) { render(); return; }
      active = Math.max(0, Math.min(view.length - 1, active + d));
      list.querySelectorAll('.combo__opt').forEach(function (li, i) {
        li.setAttribute('aria-selected', i === active);
        if (i === active) {
          li.scrollIntoView({ block: 'nearest' });
          input.setAttribute('aria-activedescendant', li.id);
        }
      });
    }

    input.addEventListener('input', function () { active = -1; render(); });
    input.addEventListener('focus', function () { if (input.value.trim() === '' || items.length) render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && !list.hidden && active >= 0) { e.preventDefault(); choose(view[active]); }
      else if (e.key === 'Escape') { close(); }
    });
    list.addEventListener('mousedown', function (e) {
      var li = e.target.closest('.combo__opt');
      if (li) { e.preventDefault(); choose(li.textContent); }
    });
    document.addEventListener('click', function (e) { if (!root.contains(e.target)) close(); });

    return { setItems: setItems, input: input, close: close };
  }

  /* ------------------------------------------------ data */

  var cityIndex = [];   // [ [name, streetFileId], ... ]
  var cityById = {};    // name -> streetFileId
  var streetCache = {};

  function loadCities() {
    return fetch('assets/data/cities.json').then(function (r) { return r.json(); }).then(function (rows) {
      cityIndex = rows;
      rows.forEach(function (r) { cityById[r[0]] = r[1]; });
      cityCombo.setItems(rows.map(function (r) { return r[0]; }));
    });
  }
  function loadStreets(id) {
    if (id === 0) return Promise.resolve(null);
    if (streetCache[id]) return Promise.resolve(streetCache[id]);
    return fetch('assets/data/streets/' + id + '.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (arr) { streetCache[id] = arr; return arr; });
  }

  var cityCombo = Combo(form.querySelector('[data-combo="city"]'), {
    onPick: function (val) {
      S.city = val;
      S.cityStreetId = cityById[val] || 0;
      applyStreetMode();
    }
  });
  var streetCombo = Combo(form.querySelector('[data-combo="street"]'), {
    onPick: function (val) { S.street = val; }
  });
  var streetInput = form.querySelector('#street-input');
  var streetHint = form.querySelector('[data-street-hint]');

  function applyStreetMode() {
    if (S.cityStreetId === 0) {
      streetCombo.setItems([]);
      streetCombo.close();
      streetInput.setAttribute('role', 'textbox');
      streetInput.removeAttribute('aria-expanded');
      streetHint.textContent = 'ביישוב זה אין רשימת רחובות — אפשר לכתוב חופשי';
    } else {
      streetInput.setAttribute('role', 'combobox');
      streetInput.setAttribute('aria-expanded', 'false');
      streetHint.textContent = 'מתוך רחובות היישוב שבחרת';
      loadStreets(S.cityStreetId).then(function (arr) {
        streetCombo.setItems(arr || []);
      });
    }
  }

  /* ------------------------------------------------ step: details */

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var current = Object.keys(steps).find(function (k) { return !steps[k].hidden; });
    if (current === 'details') submitDetails();
    else if (current === 'otp') submitOtp();
    else if (current === 'address') submitAddress();
  });

  function submitDetails() {
    var f = form.elements;
    S.firstName = f.firstName.value.trim();
    S.lastName = f.lastName.value.trim();
    S.phone = cleanPhone(f.phone.value);
    S.email = f.email.value.trim();

    var bad = null;
    markInvalid(f.firstName, !S.firstName); if (!S.firstName) bad = bad || f.firstName;
    markInvalid(f.lastName, !S.lastName); if (!S.lastName) bad = bad || f.lastName;
    markInvalid(f.phone, !validPhone(S.phone)); if (!validPhone(S.phone)) bad = bad || f.phone;
    markInvalid(f.email, !validEmail(S.email)); if (!validEmail(S.email)) bad = bad || f.email;
    markInvalid(f.city, !S.city); if (!S.city) bad = bad || f.city;

    if (bad) { showError('בדקו את השדות המסומנים.'); bad.focus(); return; }

    var consent = form.querySelector('.checkbox[aria-checked]');
    if (consent && consent.getAttribute('aria-checked') !== 'true') {
      showError('יש לאשר את תנאי השימוש ומדיניות הפרטיות.');
      consent.focus();
      return;
    }

    stepDone('details');

    busy(true);
    Webhooks.sendOtp(S.phone).then(function (res) {
      busy(false);
      if (!res.ok) { showError(sendErrorText(res.error)); return; }
      echo('phone', formatPhone(S.phone));
      form.elements.otp.value = '';
      show('otp');
    });
  }

  function formatPhone(p) {
    return p.length === 10 ? p.slice(0, 3) + '-' + p.slice(3) : p;
  }

  /* ------------------------------------------------ step: otp */

  form.querySelector('[data-act="resend"]').addEventListener('click', function () {
    busy(true);
    Webhooks.sendOtp(S.phone).then(function (res) {
      busy(false);
      if (res.ok) form.elements.otp.value = '';
      flash(res.ok ? 'הקוד נשלח שוב.' : sendErrorText(res.error));
    });
  });
  form.querySelector('[data-act="back-details"]').addEventListener('click', function () {
    show('details');
    form.elements.phone.focus();
  });

  function sendErrorText(error) {
    return error === 'rate_limited'
      ? 'נשלחו יותר מדי קודים. נסו שוב בעוד כמה דקות.'
      : 'שליחת ה־SMS נכשלה. נסו שוב.';
  }

  var VERIFY_ERRORS = {
    wrong_code: 'הקוד שגוי. בדקו את ה־SMS ונסו שוב.',
    // also what the server says after 5 wrong tries on one code
    expired: 'תוקף הקוד פג או שהיו יותר מדי ניסיונות. בקשו קוד חדש בכפתור "שליחה חוזרת".',
    rate_limited: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.'
  };

  function flash(msg) {
    var n = form.querySelector('[data-act="resend"]').closest('.row, .step__row');
    var s = document.createElement('span');
    s.className = 'field__hint';
    s.textContent = msg;
    n.appendChild(s);
    setTimeout(function () { s.remove(); }, 3000);
  }

  function submitOtp() {
    // The code was already accepted and only the status lookup failed: the
    // server has used the code up, so just ask for the status again.
    if (Webhooks.hasToken()) {
      busy(true);
      Webhooks.checkStatus().then(afterStatus);
      return;
    }
    S.otp = form.elements.otp.value.trim();

    if (!/^\d{6}$/.test(S.otp)) {
      markInvalid(form.elements.otp, true);
      showError('הקוד הוא 6 ספרות.');
      return;
    }
    busy(true);
    Webhooks.verifyOtp(S.phone, S.otp).then(function (v) {
      if (!v.ok) {
        busy(false);
        markInvalid(form.elements.otp, true);
        showError(VERIFY_ERRORS[v.error] || 'אימות הקוד נכשל. נסו שוב.');
        return;
      }
      markInvalid(form.elements.otp, false);
      return Webhooks.checkStatus().then(afterStatus);
    });
  }

  function afterStatus(st) {
    busy(false);
    if (!st.ok) {
      if (st.error === 'unauthorized') { reverify(); return; }
      showError('בדיקת הסטטוס נכשלה. נסו שוב.');
      return;
    }
    S.isMember = st.isMember;
    S.age = st.age;

    if (!S.isMember) { finish('not_member'); return; }
    stepDone('verified');

    // prefill address from the record where we can, without overwriting what
    // the visitor already typed (they come back here after a re-verify)
    if (st.person) {
      if (st.person.street && !form.elements.street.value.trim()) { form.elements.street.value = st.person.street; S.street = st.person.street; }
      if (st.person.houseNumber && !form.elements.houseNumber.value.trim()) { form.elements.houseNumber.value = st.person.houseNumber; S.houseNumber = st.person.houseNumber; }
    }
    show('address');
  }

  // The session token expired (or was never issued): text a new code and go
  // back to the OTP step. Everything already entered stays in S and the form.
  function reverify() {
    busy(true);
    Webhooks.sendOtp(S.phone).then(function (res) {
      busy(false);
      form.elements.otp.value = '';
      echo('phone', formatPhone(S.phone));
      show('otp');
      showError(res.ok
        ? 'תוקף האימות פג. שלחנו קוד חדש, הזינו אותו כדי להמשיך.'
        : sendErrorText(res.error));
    });
  }

  /* ------------------------------------------------ step: address */

  // The campaign's shift codes: 13 morning, 23 noon, 33 evening. "מתי שצריך"
  // is a UI convenience for all three, so it expands rather than travelling as
  // a value of its own.
  var SHIFT_ALL = [13, 23, 33];

  function pickShifts(nodes) {
    var out = [];
    Array.prototype.forEach.call(nodes, function (c) {
      if (!c.checked) return;
      (c.value === 'any' ? SHIFT_ALL : [Number(c.value)]).forEach(function (n) {
        if (out.indexOf(n) === -1) out.push(n);
      });
    });
    return out.sort(function (a, b) { return a - b; });
  }

  function submitAddress() {
    var f = form.elements;
    S.street = f.street.value.trim();
    S.houseNumber = f.houseNumber.value.trim();
    S.idNumber = f.idNumber ? f.idNumber.value.trim() : '';
    S.shifts = pickShifts(f.shifts);

    var bad = null;
    markInvalid(f.street, !S.street); if (!S.street) bad = bad || f.street;
    markInvalid(f.houseNumber, !S.houseNumber); if (!S.houseNumber) bad = bad || f.houseNumber;
    if (bad) { showError('בדקו את השדות המסומנים.'); bad.focus(); return; }
    if (!S.shifts.length) { showError('בחרו לפחות משמרת אחת.'); return; }

    stepDone('address');
    busy(true);
    Webhooks.getClusters({
      city: S.city,
      street: S.street,
      house_number: S.houseNumber,
      shifts: S.shifts
    }).then(function (res) {
      busy(false);
      if (!res.ok) {
        if (res.error === 'unauthorized') { reverify(); return; }
        showError(res.error === 'rate_limited'
          ? 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.'
          : 'טעינת האשכולות נכשלה. נסו שוב.');
        return;
      }
      S.clusters = res.clusters || [];
      renderClusters();
      show('clusters');
    });
  }

  /* ------------------------------------------------ step: clusters */

  var clustersList = steps.clusters.querySelector('.clusters');
  var clustersEmpty = steps.clusters.querySelector('.clusters__empty');
  var moreBtn = steps.clusters.querySelector('[data-act="more-clusters"]');
  var youthBox = steps.clusters.querySelector('[data-youth]');

  // best 4 up front, the other (up to) 4 behind "הצג אשכולות נוספים"
  var CLUSTERS_FIRST = 4;

  // Young Democrats election-day patrol: offered only when webhook 2's age is
  // strictly between 18 and 36, as specified. Ticking it adds `tags` to the
  // final submission.
  var YOUTH_MIN = 18, YOUTH_MAX = 36;
  var YOUTH_TAG = 'סיירת יום בחירות צעירים';

  function youthEligible() {
    return typeof S.age === 'number' && S.age > YOUTH_MIN && S.age < YOUTH_MAX;
  }

  function renderClusters() {
    clustersList.innerHTML = '';
    clustersEmpty.hidden = S.clusters.length > 0;
    moreBtn.hidden = S.clusters.length <= CLUSTERS_FIRST;
    youthBox.hidden = !youthEligible();
    form.elements.youthPatrol.checked = false;

    S.clusters.forEach(function (c, i) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cluster';
      var dist = c.distanceKm != null ? c.distanceKm.toFixed(1) + ' ק״מ' : '';
      btn.innerHTML =
        (c.votersPoll ? '<span class="cluster__mine">כאן אתם מצביעים</span>' : '') +
        '<span class="cluster__name">' + escapeHtml(c.name) + '</span>' +
        '<span class="cluster__meta">' + escapeHtml(c.address) +
          (c.cityName ? ' · ' + escapeHtml(c.cityName) : '') + '</span>' +
        (dist ? '<span class="cluster__dist">' + dist + '</span>' : '');
      btn.addEventListener('click', function () { chooseCluster(i); });
      li.appendChild(btn);
      if (i >= CLUSTERS_FIRST) li.hidden = true;
      clustersList.appendChild(li);
    });
  }

  moreBtn.addEventListener('click', function () {
    var revealed = clustersList.querySelectorAll('li[hidden]');
    revealed.forEach(function (li) { li.hidden = false; });
    moreBtn.hidden = true;
    // keyboard users land on the first newly shown cluster, not back at the top
    if (revealed[0]) revealed[0].querySelector('.cluster').focus();
  });

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  form.querySelector('[data-act="anywhere"]').addEventListener('click', function () {
    S.chosen = null;
    finish('place_me_anywhere');
  });

  function chooseCluster(i) {
    S.chosen = S.clusters[i];
    if (S.chosen.hasManager) {
      finish('assigned');
      return;
    }
    stepDone('cluster');
    echo('clusterName', S.chosen.name + (S.chosen.address ? ' · ' + S.chosen.address : ''));
    show('manage');
  }

  /* ------------------------------------------------ step: manage */

  form.querySelector('[data-act="manage-yes"]').addEventListener('click', function () {
    finish('no_manager_wants_to_manage');
  });
  form.querySelector('[data-act="manage-no"]').addEventListener('click', function () {
    finish('no_manager_declines');
  });

  /* ------------------------------------------------ finish */

  var DONE_MSG = {
    not_member: 'הפרטים שלך התקבלו. נהיה איתך בקשר.',
    place_me_anywhere: 'נשבץ אותך בדוכן הדמוקרטים ליד הקלפי הקרובה לביתך וניצור איתך קשר בהקדם.',
    assigned: 'נרשמת בהצלחה.',
    no_manager_wants_to_manage: 'מוביל/ת האזור ייצור/תיצור איתך קשר בקרוב כדי להתחיל.',
    no_manager_declines: 'הרישום נקלט. נהיה איתך בקשר בקרוב עם הפרטים.'
  };

  // Every query parameter the visitor arrived with (utm_*, fbclid, gclid, the
  // prefill fields…), exactly as in the address — client, 2026-10-01. Read
  // once at load. Capped (50 keys, 500 chars a value) so a freak URL can't
  // push a post past the backend's 32 KB body limit; a repeated key keeps
  // its first value.
  var URL_PARAMS = (function () {
    var out = {}, n = 0;
    try {
      new URLSearchParams(location.search).forEach(function (v, k) {
        k = k.slice(0, 100);
        if (n >= 50 || Object.prototype.hasOwnProperty.call(out, k)) return;
        out[k] = v.slice(0, 500);
        n++;
      });
    } catch (e) { /* no params, then */ }
    return out;
  })();

  // Everything gathered so far, in the final post's shape — the per-step
  // snapshots and the final submission send the same fields.
  function snapshot() {
    var payload = {
      submissionId: S.submissionId,
      urlParams: URL_PARAMS,
      person: {
        firstName: S.firstName, lastName: S.lastName,
        phone: S.phone, email: S.email,
        city: S.city, street: S.street, houseNumber: S.houseNumber,
        idNumber: S.idNumber || null
      },
      isMember: S.isMember,
      shifts: S.shifts,
      eshkolId: S.chosen ? S.chosen.id : null,
      eshkolName: S.chosen ? S.chosen.name : null,
      eshkolCityId: S.chosen ? S.chosen.cityId : null
    };
    // only sent when ticked (and only offered in the eligible age range)
    if (youthEligible() && form.elements.youthPatrol.checked) payload.tags = YOUTH_TAG;
    return payload;
  }

  // A finished step: snapshot to the submit webhook (every time — the data may
  // have changed) and a Meta pixel event (once per step per visit, so going
  // back and forward doesn't inflate the funnel). Pixel events carry only the
  // step name, no personal data:
  //   details  -> Lead + RegistrationStep{step:'details'}
  //   verified / address / cluster -> RegistrationStep{step}
  //   the finished registration -> CompleteRegistration{status} (in finish)
  var tracked = {};
  function stepDone(stage) {
    Webhooks.saveProgress(stage, snapshot());
    if (tracked[stage] || typeof window.fbq !== 'function') return;
    tracked[stage] = true;
    if (stage === 'details') window.fbq('track', 'Lead');
    window.fbq('trackCustom', 'RegistrationStep', { step: stage });
  }

  function finish(outcome) {
    S.outcome = outcome;
    busy(true);

    Webhooks.submit(outcome, snapshot()).then(function (res) {
      busy(false);
      if (!res.ok) {
        if (res.error === 'unauthorized') { reverify(); return; }
        showError('שליחת הרישום נכשלה. אפשר לנסות שוב.');
        return;
      }
      return withContact(outcome).then(function () {
        renderDone(outcome);
        show('done');
        // Meta pixel conversion (index.html loads the pixel; join.html doesn't,
        // so this is a no-op there). Only the outcome goes along — no personal data.
        if (typeof window.fbq === 'function') {
          window.fbq('track', 'CompleteRegistration', { status: outcome });
        }
      });
    });
  }

  // An assigned visitor gets their cluster's manager and WhatsApp invite from
  // the backend, for that one cluster only. A failed lookup still finishes —
  // the done screen just goes without them.
  function withContact(outcome) {
    if (outcome !== 'assigned' || !S.chosen) return Promise.resolve();
    busy(true);
    return Webhooks.getClusterContact({
      eshkolId: S.chosen.id,
      city: S.city,
      street: S.street,
      house_number: S.houseNumber,
      shifts: S.shifts
    }).then(function (res) {
      busy(false);
      S.chosen.manager = res.manager;
      S.chosen.whatsappUrl = res.whatsappUrl;
    });
  }

  function renderDone(outcome) {
    steps.done.querySelector('[data-done-msg]').textContent = DONE_MSG[outcome] || 'הרישום נקלט.';
    var extra = steps.done.querySelector('[data-done-extra]');
    extra.hidden = true; extra.innerHTML = '';

    if (outcome === 'assigned' && S.chosen) {
      extra.hidden = false;
      extra.className = 'done-extra';
      var c = S.chosen, m = c.manager;
      var bits = ['<div><b>אשכול:</b> ' + escapeHtml(c.name) +
        (c.address ? ' · ' + escapeHtml(c.address) : '') + '</div>'];
      if (S.shifts.length) bits.push('<div><b>משמרת:</b> ' + S.shifts.map(shiftLabel).join(', ') + '</div>');
      if (m && m.name) {
        var tel = String(m.phone || '').replace(/[^\d+]/g, '');
        bits.push('<div><b>מנהל/ת האשכול:</b> ' + escapeHtml(m.name) +
          (tel ? ' · <a href="tel:' + escapeHtml(tel) + '" dir="ltr">' + escapeHtml(formatPhone(tel)) + '</a>' : '') +
          '</div>');
      }
      if (c.whatsappUrl && /^https:\/\//.test(c.whatsappUrl))
        bits.push('<a class="btn btn--wa skew done-extra__wa" href="' + escapeHtml(c.whatsappUrl) +
          '" target="_blank" rel="noopener"><span>הצטרפות לקבוצת הוואטסאפ של האשכול</span>' + WA_ICON + '</a>');
      extra.innerHTML = bits.join('');
    }
  }

  // WhatsApp glyph (Simple Icons), white on the green button
  var WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>';

  function shiftLabel(v) {
    return { 13: 'בוקר', 23: 'צהריים', 33: 'ערב' }[v] || v;
  }

  /* ------------------------------------------------ prefill from URL

     ?firstName=..&lastName=..&phone=..&email=..&city=..&street=..
     &houseNumber=..&idNumber=..&shifts=13,23

     Plain fields just get dropped into their input — the visitor still sees
     them and can fix a mistake before submitting. city is the one exception:
     step 1's validation checks S.city (set only when the combo is picked
     from), not the input's raw text, so a city only "sticks" when it matches
     a name from cities.json exactly. If it doesn't, the text still shows in
     the field, but the visitor has to reselect it from the dropdown once. */

  var PREFILL_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'street', 'houseNumber', 'idNumber'];

  function applyTextPrefill() {
    var q = new URLSearchParams(location.search);

    PREFILL_FIELDS.forEach(function (name) {
      var v = q.get(name);
      var el = form.elements[name];
      if (v != null && el) { el.value = v; sanitize(el); }
    });

    var shifts = q.get('shifts');
    if (shifts) {
      var wanted = shifts.split(',').map(function (s) { return s.trim(); });
      Array.prototype.forEach.call(form.elements.shifts, function (c) {
        if (wanted.indexOf(c.value) !== -1) c.checked = true;
      });
    }
  }

  function applyCityPrefill() {
    var city = new URLSearchParams(location.search).get('city');
    if (!city) return;
    document.getElementById('city-input').value = city;
    var hit = cityIndex.find(function (r) { return r[0] === city; });
    if (hit) {
      S.city = hit[0];
      S.cityStreetId = hit[1];
      applyStreetMode();
    }
  }

  /* ------------------------------------------------ boot */

  applyTextPrefill();
  loadCities().then(applyCityPrefill).catch(function () {
    showError('טעינת רשימת היישובים נכשלה. רעננו את הדף.');
  });
  show('details');
})();
