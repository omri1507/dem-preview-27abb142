/* Democratim — registration flow, backend layer.
   Kept separate from the flow controller so the calls are easy to find.

   Nothing here talks to n8n. Every call goes to this site's own backend,
   POST /api/public/form/<action> (src/routes/api/public/form.$action.ts),
   which holds the n8n URLs and the shared secret server-side.

   OTP is checked by the SERVER: otp-send makes the code and has n8n SMS it;
   otp-verify checks it (5 tries, 10 minutes) and returns a session token
   bound to the phone. The token is kept in memory only and sent as
   `Authorization: Bearer` on every later call — status, clusters and the
   cluster contact all use the phone from the token, never from the body.

   Actions used here:
     otp-send                 {phone, flow}             → {ok}
     otp-verify               {phone, code}             → {ok, token}
     newform-status           {}                        → {ok, isMember, age, person}
     newform-clusters         {city, street, ...}       → {ok, clusters}  (no contacts)
     newform-cluster-contact  {eshkolId, city, ...}     → {ok, manager, whatsappUrl}
     newform-submit           {stage, ...snapshot}      → {ok}
   Only the first snapshot (stage "details", before the SMS) goes without a
   token; the server marks it unverified. */

(function (global) {
  'use strict';

  var API = '/api/public/form/';
  var TIMEOUT = 20000;

  // Held for this page visit only — never written to storage.
  var token = null;

  // The backend returns up to 8 clusters; the page shows the first 4.
  // Ordered by nationalRank, HIGHEST first — confirmed with the client
  // (2026-09-23). Despite the name, a higher rank is a higher priority here.
  var MAX_CLUSTERS = 8;
  var RANK_FIELD = 'nationalRank';
  var RANK_ASCENDING = false;

  function post(action, body) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(API + action, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body || {}),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(t);
      return r.text().then(function (txt) {
        var json = null;
        try { json = txt ? JSON.parse(txt) : null; } catch (e) { /* leave null */ }
        return {
          ok: r.ok && !!json && json.ok === true,
          status: r.status,
          json: json,
          error: json && json.error ? json.error : (r.ok ? null : 'server_error')
        };
      });
    }).catch(function (err) {
      clearTimeout(t);
      return { ok: false, status: 0, json: null, error: 'network', detail: String(err) };
    });
  }

  /* ---- OTP -----------------------------------------------------------------
     The server makes and checks the code. A new code (resend) replaces the
     old one, so it also clears any token from an earlier number. */

  function sendOtp(phone) {
    token = null;
    return post('otp-send', { phone: phone, flow: 'newform' }).then(function (res) {
      return { ok: res.ok, error: res.error };
    });
  }

  // error: wrong_code | expired (also after 5 wrong tries) | rate_limited | ...
  function verifyOtp(phone, code) {
    return post('otp-verify', { phone: phone, code: code }).then(function (res) {
      if (res.ok && res.json.token) {
        token = res.json.token;
        return { ok: true, error: null };
      }
      return { ok: false, error: res.error || 'server_error' };
    });
  }

  // True once otp-verify succeeded for the current number (sendOtp clears it).
  function hasToken() { return !!token; }

  /* ---- volunteer / party-member status ------------------------------- */

  // The server picks the strongest match (highest finalScore) and counts the
  // visitor as a party member when that score is above 80 — membershipStatus
  // doesn't count (client, 2026-09-30). Returns only what the form uses.
  function checkStatus() {
    return post('newform-status', {}).then(function (res) {
      if (!res.ok) return { ok: false, error: res.error, isMember: false, age: null, person: null };
      var j = res.json;
      return {
        ok: true,
        isMember: j.isMember === true,
        age: typeof j.age === 'number' ? j.age : null,
        person: j.person ? {
          street: j.person.street || '',
          houseNumber: j.person.houseNumber || ''
        } : null
      };
    });
  }

  /* ---- nearby clusters --------------------------------------------------- */

  // A failed lookup comes back as { ok: false, error } so the page can tell
  // it apart from "no clusters nearby".
  function getClusters(payload) {
    // payload: { city, street, house_number, shifts } — the phone comes from the token
    return post('newform-clusters', payload).then(function (res) {
      if (!res.ok) return { ok: false, error: res.error, clusters: [] };
      var raw = Array.isArray(res.json.clusters) ? res.json.clusters : [];
      var list = raw.map(function (c) {
        return {
          id: c.eshkolId,
          name: c.eshkolName || '',
          address: c.eshkolAddress || '',
          cityName: c.cityName || '',
          distanceKm: typeof c.distanceKm === 'number' ? c.distanceKm : null,
          rank: typeof c[RANK_FIELD] === 'number' ? c[RANK_FIELD] : null,
          cityId: c.cityId != null ? String(c.cityId) : null,
          capacityPerShift: c.capacityPerShift,
          votersPoll: c.votersPoll === true,
          hasManager: c.hasManager === true
        };
      });
      // Most important first; a cluster with no rank goes after every ranked
      // one; distance breaks ties.
      list.sort(function (a, b) {
        var ar = a.rank == null ? Infinity : a.rank;
        var br = b.rank == null ? Infinity : b.rank;
        if (ar !== br) {
          if (ar === Infinity) return 1;
          if (br === Infinity) return -1;
          return RANK_ASCENDING ? ar - br : br - ar;
        }
        return (a.distanceKm == null ? 1e9 : a.distanceKm) -
               (b.distanceKm == null ? 1e9 : b.distanceKm);
      });
      return { ok: true, error: null, clusters: list.slice(0, MAX_CLUSTERS) };
    });
  }

  // The chosen cluster's manager and WhatsApp invite — only ever for the one
  // cluster the visitor picked, never for the whole list.
  // payload: { eshkolId, city, street, house_number, shifts }
  function getClusterContact(payload) {
    return post('newform-cluster-contact', payload).then(function (res) {
      if (!res.ok) return { ok: false, manager: null, whatsappUrl: null };
      var m = res.json.manager;
      return {
        ok: true,
        manager: m && m.name ? { name: m.name, phone: m.phone || '' } : null,
        whatsappUrl: res.json.whatsappUrl || null
      };
    });
  }

  /* ---- submission ----------------------------------------------------- */

  // Same action for the final post and the per-step snapshots; `stage` tells
  // them apart:
  //   details  — name/phone/email/city entered (phone NOT yet verified)
  //   verified — SMS code confirmed, member status known
  //   address  — street / house / shifts entered
  //   cluster  — a cluster picked that has no manager (the manage question is next)
  //   final    — the finished registration; the only one with an `outcome`
  // Every post carries everything gathered so far, plus the same
  // `submissionId` for the whole visit so n8n can update one row per person.

  // outcome: not_member | assigned | no_manager_wants_to_manage |
  //          no_manager_declines | place_me_anywhere
  function submit(outcome, data) {
    var body = Object.assign({ stage: 'final', outcome: outcome, submittedAt: new Date().toISOString() }, data);
    return post('newform-submit', body).then(function (res) {
      return { ok: res.ok, error: res.error };
    });
  }

  // Fire-and-forget: a lost snapshot must never hold the visitor up.
  function saveProgress(stage, data) {
    var body = Object.assign({ stage: stage, outcome: null, submittedAt: new Date().toISOString() }, data);
    post('newform-submit', body);
  }

  global.Webhooks = {
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    hasToken: hasToken,
    checkStatus: checkStatus,
    getClusters: getClusters,
    getClusterContact: getClusterContact,
    submit: submit,
    saveProgress: saveProgress
  };
})(window);
