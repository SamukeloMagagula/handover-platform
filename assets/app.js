/* The Call book, in one file, rendered into #content.
   Depends on assets/api.js, which must load first. */
(function () {
  "use strict";

  /* ==================================================================
     utilities
     ================================================================== */

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  /* Dates are plain "YYYY-MM-DD" strings so they compare with < and >, and
     never pick up a timezone shift from Date.toISOString(). */
  const iso = d => {
    const p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  };
  const today = () => iso(new Date());
  const parse = s => { const a = s.split("-").map(Number); return new Date(a[0], a[1] - 1, a[2]); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const human = s => parse(s).toLocaleDateString(undefined,
    { weekday: "short", day: "numeric", month: "short" });
  const humanLong = s => parse(s).toLocaleDateString(undefined,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  const OUTCOMES = [
    { key: "answered", label: "Answered" },
    { key: "onway", label: "On the way" },
    { key: "noanswer", label: "No answer" },
    { key: "again", label: "Call again" },
    { key: "escalated", label: "Escalated" },
  ];
  const outcomeLabel = k => (OUTCOMES.find(o => o.key === k) || {}).label || "No outcome";
  const outcomeClass = k =>
    k === "answered" || k === "onway" ? "badge-ok"
      : k === "noanswer" ? "badge-bad"
        : k === "escalated" ? "badge-warn" : "badge-quiet";

  /* Dialling comes from config.php via the bootstrap, with these as the
     defaults for the moment before it has loaded — and for the import parser,
     which normalises numbers from a spreadsheet the same way. */
  const DIAL_FALLBACK = { scheme: "sip", domain: "", countryCode: "27" };
  const dial = () => (S && S.dial) ? S.dial : DIAL_FALLBACK;

  /* MicroSIP registers the sip: scheme on Windows, so this is what makes a
     click ring the desk phone. An empty scheme turns dialling off and numbers
     render as plain text. */
  const sipHref = v => {
    const d = dial();
    if (!d.scheme) return "";
    const num = String(v).replace(/[^\d+]/g, "");
    return d.scheme + ":" + num + (d.domain ? "@" + d.domain : "");
  };

  const canDial = () => !!dial().scheme;

  /* One number, as a link to the softphone or as plain text when dialling is
     turned off. An anchor with an empty href reloads the page, so the choice
     has to be made here rather than by letting sipHref return "". */
  function phoneHTML(value) {
    if (!value) return "";
    const shown = esc(formatPhone(value));
    if (!canDial()) return '<span class="phone-flat">' + shown + "</span>";
    return '<a class="phone" href="' + esc(sipHref(value)) + '" data-dial="' +
      esc(value) + '">' + shown + "</a>";
  }

  /* Numbers arrive as "082 123 4567", "+27 82 123 4567", "27821234567" and
     "(082) 123-4567" — the same person, four ways. Stored as E.164 so that a
     comparison, a dedupe and a dial all agree about what the number is.

     Anything not recognisable as a local or international number is kept
     exactly as typed: a four-digit extension or a switchboard code is not
     improved by guessing a country onto the front of it. */
  const DIAL_CC = () => dial().countryCode;

  function normalisePhone(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return "";

    const kept = s.replace(/[^\d+]/g, "");
    if (!kept) return s;

    if (kept.charAt(0) === "+") return "+" + kept.slice(1).replace(/\D/g, "");

    const cc = DIAL_CC();
    const d = kept.replace(/\D/g, "");
    if (d.slice(0, 2) === "00") return "+" + d.slice(2);
    if (d.slice(0, cc.length) === cc && d.length === cc.length + 9) return "+" + d;
    if (d.charAt(0) === "0" && d.length === 10) return "+" + cc + d.slice(1);

    return s;
  }

  /* +27821234567 -> +27 82 123 4567. Grouped only for the country we know;
     anything else is shown as stored rather than chopped into the wrong shape. */
  function formatPhone(v) {
    const s = String(v == null ? "" : v);
    const prefix = "+" + DIAL_CC();
    if (s.slice(0, prefix.length) !== prefix) return s;
    const n = s.slice(prefix.length);
    if (n.length !== 9 || /\D/.test(n)) return s;
    return prefix + " " + n.slice(0, 2) + " " + n.slice(2, 5) + " " + n.slice(5);
  }

  /* ==================================================================
     state
     ================================================================== */

  let ME = { can: [] };
  let S = {
    version: 0, people: [], duties: [], calls: [], sites: [], contacts: [],
    leave: [], overrides: [], escalations: [], rotations: [], lastCaller: "", teamFeed: "",
  };

  const can = c => ME.can.indexOf(c) > -1;
  const person = id => S.people.find(p => p.id === id) || null;
  const personName = id => (person(id) || {}).name || "Removed person";

  /* Every way to reach somebody, in the order to try it. */
  function contactsFor(id) {
    const p = person(id);
    if (!p) return [];
    const out = [];
    if (p.phone) out.push({ kind: "mobile", value: p.phone });
    S.contacts.filter(c => c.personId === id)
      .sort((a, b) => a.position - b.position)
      .forEach(c => out.push({ kind: c.kind, value: c.value }));
    if (p.email) out.push({ kind: "email", value: p.email });
    return out;
  }

  const onLeave = (id, day) =>
    S.leave.some(l => l.personId === id && l.start <= day && l.end >= day);

  /* Duties covering a day, with cover applied: personId is who is actually
     reachable, which is the override's person when one covers that day. */
  function onCall(day, type) {
    return S.duties
      .filter(d => d.start <= day && d.end >= day && (!type || d.type === type))
      .map(d => {
        const ov = S.overrides.find(o => o.dutyId === d.id && o.start <= day && o.end >= day);
        const pid = ov ? ov.personId : d.personId;
        return {
          duty: d, personId: pid, site: d.site, type: d.type,
          coveringFor: ov ? personName(d.personId) : null,
          onLeave: onLeave(pid, day),
        };
      })
      .sort((a, b) => String(a.site || "").localeCompare(String(b.site || "")));
  }

  /* ==================================================================
     writing: diff the working copy and post the difference
     ================================================================== */

  const TABLES = ["people", "duties", "calls", "sites", "contacts", "leave",
    "overrides", "escalations", "rotations"];

  let saving = false;

  /* Two different failures, and they need different words. `reachable` false
     means the server is not answering at all, so what is on screen may already
     be out of date. `unsaved` means it answered and refused, so a change the
     page is showing never landed. Either way this stays up until it is really
     fixed — a toast that fades leaves somebody reading a stale roster at 2am
     with nothing to tell them so. */
  let reachable = true;
  let unsaved = null;

  function showConnection() {
    const el = $("#conn");
    if (reachable && !unsaved) { el.hidden = true; return; }

    el.className = "conn " + (reachable ? "conn-warn" : "conn-bad");
    $("#conn-label").textContent = reachable ? "Not saved" : "No connection";
    $("#conn-text").textContent = reachable
      ? unsaved
      : "The server is not answering. What is on screen may be out of date, and " +
        "nothing you change now will be saved.";
    el.hidden = false;
  }

  function markReachable(ok) {
    if (reachable === ok) return;
    reachable = ok;
    showConnection();
  }

  /* Takes a mutator, works out what changed, and posts it. The version the
     browser last saw goes with it: if the roster moved on, the server
     refuses rather than overwriting somebody else's work. */
  function mutate(label, fn) {
    const before = JSON.parse(JSON.stringify(TABLES.map(t => S[t])));
    fn();
    const ops = [];

    TABLES.forEach((table, i) => {
      const old = before[i];
      const now = S[table];
      const oldById = new Map(old.map(r => [r.id, r]));
      const nowIds = new Set(now.map(r => r.id));

      now.forEach(r => {
        const was = oldById.get(r.id);
        if (!was || JSON.stringify(was) !== JSON.stringify(r)) {
          ops.push({ table: table, op: "put", id: r.id, data: r });
        }
      });
      old.forEach(r => { if (!nowIds.has(r.id)) ops.push({ table: table, op: "del", id: r.id }); });
    });

    render();
    if (!ops.length) return Promise.resolve();

    saving = true;
    return api("POST", "sync", { baseVersion: S.version, label: label, ops: ops })
      .then(res => {
        S.version = res.version;
        saving = false;
        unsaved = null;
        markReachable(true);
        showConnection();
      })
      .catch(err => {
        saving = false;

        if (err.status === 409 && err.data && err.data.state) {
          S = err.data.state;
          unsaved = null;
          render();
          showConnection();
          toast("Somebody else changed the roster first. Reloaded — please redo that change.");
          return;
        }

        /* Said on the banner rather than only in a toast, because the page is
           now showing a change the server does not have. */
        unsaved = '"' + label + '" was not saved: ' + err.message;
        if (err.status === 0) markReachable(false);
        showConnection();
        toast(err.message);
      });
  }

  function load() {
    return api("GET", "bootstrap")
      .then(state => {
        S = state;
        unsaved = null;
        markReachable(true);
        render();
        showConnection();
      })
      .catch(err => {
        if (err.status === 0) markReachable(false);
        showConnection();
        throw err;
      });
  }

  /* ==================================================================
     dialog
     ================================================================== */

  const dlg = $("#dlg");

  /* buttons is [{label, class, onClick}]; onClick returning false keeps the
     dialog open, so a failed save has somewhere to report. */
  function openDialog(title, body, buttons) {
    dlg.innerHTML =
      '<div class="dlg-head"><h2 id="dlg-title">' + esc(title) + "</h2></div>" +
      '<div class="dlg-body"><div class="alert alert-error" id="dlg-error" hidden></div>' +
        body + "</div>" +
      '<div class="dlg-foot" id="dlg-foot"></div>';

    const foot = $("#dlg-foot");
    (buttons || []).forEach(b => {
      if (b.spacer) {
        const s = document.createElement("span");
        s.className = "spacer";
        foot.appendChild(s);
        return;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "btn " + (b.class || "btn-secondary");
      el.textContent = b.label;
      el.addEventListener("click", () => { if (b.onClick() !== false) dlg.close(); });
      foot.appendChild(el);
    });

    dlg.setAttribute("aria-labelledby", "dlg-title");
    dlg.showModal();
    labelTables(dlg);

    /* Into the first field rather than onto the first button, so a dialog
       that exists to be typed into is ready to be typed into. */
    const first = dlg.querySelector(
      ".dlg-body input:not([disabled]):not([readonly]), .dlg-body select:not([disabled]), " +
      ".dlg-body textarea:not([disabled])");
    if (first) first.focus();
  }

  const dialogError = msg => { const e = $("#dlg-error"); e.textContent = msg; e.hidden = false; };

  function confirmDialog(title, message, confirmLabel, onConfirm) {
    openDialog(title, "<p>" + esc(message) + "</p>", [
      { spacer: true },
      { label: "Cancel", onClick: () => true },
      { label: confirmLabel, class: "btn-danger", onClick: () => { onConfirm(); return true; } },
    ]);
  }

  /* ==================================================================
     views
     ================================================================== */

  const VIEWS = {};
  let view = "today";
  let siteFilter = "";

  function numbersHTML(pid) {
    const nums = contactsFor(pid);
    if (!nums.length) return '<span class="text-muted">No number on file</span>';
    return nums.map(c => c.kind === "email"
      ? '<a class="phone" href="mailto:' + esc(c.value) + '">' + esc(c.value) + "</a>"
      : phoneHTML(c.value)).join("");
  }

  function dutyHTML(d) {
    return '<div class="duty" data-type="' + esc(d.type) + '">' +
      '<div class="duty-mark"></div>' +
      '<div class="duty-body">' +
        '<div class="duty-name">' + esc(personName(d.personId)) +
          (d.onLeave ? ' <span class="badge badge-warn">On leave</span>' : "") + "</div>" +
        '<div class="duty-meta">' +
          (d.site ? esc(d.site) + " &middot; " : "") +
          esc(human(d.duty.start)) + " &ndash; " + esc(human(d.duty.end)) +
          (d.coveringFor ? " &middot; covering for " + esc(d.coveringFor) : "") + "</div>" +
        '<div class="duty-nums">' + numbersHTML(d.personId) + "</div>" +
      "</div>" +
      '<div class="duty-actions">' +
        '<span data-need="calls.write"><button class="btn btn-small" type="button" ' +
          'data-log-call="' + esc(d.personId) + '">Log a call</button></span>' +
        '<span data-need="duties.write"><button class="btn btn-small btn-secondary" ' +
          'type="button" data-edit-duty="' + esc(d.duty.id) + '">Edit duty</button></span>' +
        '<span data-need="duties.write"><button class="btn btn-small btn-secondary" ' +
          'type="button" data-cover="' + esc(d.duty.id) + '">' +
          (d.coveringFor ? "Change cover" : "Arrange cover") + "</button></span>" +
      "</div>" +
      "</div>";
  }

  function panelHTML(title, list) {
    return '<div class="card"><div class="card-head"><h2>' + title + "</h2>" +
      '<span class="spacer"></span><span class="text-muted">' + list.length + "</span></div>" +
      (list.length ? list.map(dutyHTML).join("") : '<p class="empty">Nobody is on.</p>') + "</div>";
  }

  /* ---------------- Today ---------------- */

  VIEWS.today = function () {
    const day = today();
    const standby = onCall(day, "standby");
    const onsite = onCall(day, "onsite").filter(d => !siteFilter || d.site === siteFilter);
    const calls = S.calls.filter(c => c.date === day)
      .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));

    const gaps = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(day, i);
      if (!onCall(d, "standby").length) gaps.push(d);
    }

    return '<div class="view-head"><p class="eyebrow">Cover for</p><h1>' +
        esc(humanLong(day)) + "</h1></div>" +

      (gaps.length ? '<div class="alert alert-warn">No standby cover on ' + gaps.length +
        " of the next 14 days: " + gaps.slice(0, 5).map(human).map(esc).join(", ") +
        (gaps.length > 5 ? "&hellip;" : "") + "</div>" : "") +

      (S.sites.length ? '<div class="card"><div class="card-head"><h2>Site</h2>' +
        '<span class="spacer"></span>' +
        '<select id="site-filter" aria-label="Filter the on-site panel by site" ' +
        'style="max-width:220px"><option value="">All sites</option>' +
        S.sites.map(s => '<option value="' + esc(s.name) + '"' +
          (s.name === siteFilter ? " selected" : "") + ">" + esc(s.name) + "</option>").join("") +
        '</select></div><p class="text-muted">Standby cover is not tied to a site, so that ' +
        "panel always shows everyone.</p></div>" : "") +

      '<div class="grid">' + panelHTML("On standby", standby) + panelHTML("On site", onsite) + "</div>" +

      '<div class="card"><div class="card-head"><h2>Calls logged today</h2></div>' +
        (calls.length ? '<div class="table-wrap"><table><thead><tr>' +
          "<th>Time</th><th>Who</th><th>By</th><th>Outcome</th><th>Note</th><th></th>" +
          "</tr></thead><tbody>" +
          calls.map(c => "<tr>" +
            '<td class="mono nowrap">' + esc(c.time || "") + "</td>" +
            "<td>" + esc(personName(c.personId)) + "</td>" +
            "<td>" + esc(c.by || "") + "</td>" +
            '<td><span class="badge ' + outcomeClass(c.outcome) + '">' +
              esc(outcomeLabel(c.outcome)) + "</span></td>" +
            "<td>" + esc(c.note || "") + "</td>" +
            '<td class="nowrap" data-need="calls.write">' +
              '<button class="btn btn-small btn-secondary" type="button" data-edit-call="' +
              esc(c.id) + '">Edit</button></td>' +
            "</tr>").join("") +
          "</tbody></table></div>"
          : '<p class="empty">No calls logged today.</p>') +
      "</div>";
  };

  /* ---------------- Calendar ---------------- */

  let calMonth = new Date().getMonth();
  let calYear = new Date().getFullYear();

  VIEWS.schedule = function () {
    const first = new Date(calYear, calMonth, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));   // back to the Monday

    let cells = "";
    for (let w = 0; w < 6; w++) {
      cells += "<tr>";
      for (let i = 0; i < 7; i++) {
        const cur = new Date(start);
        cur.setDate(start.getDate() + w * 7 + i);
        const key = iso(cur);
        const other = cur.getMonth() !== calMonth;
        const duties = other ? [] : onCall(key);

        /* A clickable <td> is unreachable without a mouse, so the ones that
           open a day are given a button's role, focus and label. */
        cells += '<td class="' + (other ? "other" : "") + (key === today() ? " today" : "") + '"' +
          (other ? "" : ' data-day="' + key + '" role="button" tabindex="0" aria-label="' +
            esc(humanLong(key)) + ", " + duties.length + ' on duty"') + ">" +
          '<span class="daynum">' + cur.getDate() + "</span>" +
          duties.slice(0, 3).map(x => '<span class="pill ' + esc(x.type) + '">' +
            esc(personName(x.personId)) + "</span>").join("") +
          (duties.length > 3 ? '<span class="pill">+' + (duties.length - 3) + "</span>" : "") +
          "</td>";
      }
      cells += "</tr>";
    }

    return '<div class="view-head"><p class="eyebrow">Roster</p><h1>Calendar</h1></div>' +
      '<div class="card"><div class="card-head"><h2>' +
        esc(first.toLocaleDateString(undefined, { month: "long", year: "numeric" })) + "</h2>" +
        '<span class="spacer"></span><div class="cal-nav">' +
          '<button class="btn btn-small btn-secondary" type="button" id="cal-prev">&larr;</button>' +
          '<button class="btn btn-small btn-secondary" type="button" id="cal-today">This month</button>' +
          '<button class="btn btn-small btn-secondary" type="button" id="cal-next">&rarr;</button>' +
        "</div></div>" +
        '<div class="table-wrap"><table class="cal"><thead><tr>' +
          ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            .map(d => "<th>" + d + "</th>").join("") +
        "</tr></thead><tbody>" + cells + "</tbody></table></div>" +
        '<p class="text-muted" style="margin-top:.75rem">Select a day to see who is on.</p>' +
      "</div>";
  };

  function openDay(day) {
    const duties = onCall(day);
    openDialog(humanLong(day),
      duties.length ? duties.map(dutyHTML).join("")
        : '<p class="empty">Nobody is on this day.</p>',
      [{ spacer: true }, { label: "Close", onClick: () => true }]);
  }

  /* ---------------- Directory ---------------- */

  let search = "";

  VIEWS.directory = function () {
    const q = search.toLowerCase();
    const rows = S.people.filter(p => !q ||
      [p.name, p.role, p.phone, p.email].join(" ").toLowerCase().indexOf(q) > -1);
    const duties = onCall(today());

    return '<div class="view-head"><p class="eyebrow">Contacts</p><h1>Directory</h1></div>' +
      '<div class="card"><div class="card-head">' +
        '<input id="dir-search" type="search" placeholder="Search name, role, number&hellip;" ' +
          'aria-label="Search the directory" value="' + esc(search) + '" style="max-width:320px">' +
        '<span class="spacer"></span><span class="text-muted">' +
          rows.length + " of " + S.people.length + "</span>" +
        '<span data-need="data.export"><button class="btn btn-small btn-secondary" type="button" ' +
          'id="dir-export">Download CSV</button></span></div>' +
      (rows.length ? '<div class="table-wrap"><table><thead><tr>' +
        "<th>Name</th><th>Role</th><th>Department</th><th>Site</th>" +
        "<th>Mobile</th><th>Email</th><th>Today</th><th></th>" +
        "</tr></thead><tbody>" +
        rows.map(p => {
          const d = duties.find(x => x.personId === p.id);
          return "<tr><td><strong>" + esc(p.name) + "</strong></td>" +
            "<td>" + esc(p.role || "") + "</td>" +
            "<td>" + esc(p.department || "") + "</td>" +
            "<td>" + esc(p.site || "") + "</td>" +
            '<td class="mono nowrap">' + phoneHTML(p.phone) + "</td>" +
            "<td>" + esc(p.email || "") + "</td>" +
            "<td>" + (d ? '<span class="badge badge-' + esc(d.type) + '">' +
              (d.type === "standby" ? "Standby" : "On site") + "</span>"
              : '<span class="text-muted">&mdash;</span>') + "</td>" +
            '<td class="nowrap" data-need="people.write">' +
              '<button class="btn btn-small btn-secondary" type="button" data-edit-person="' +
                esc(p.id) + '">Edit</button> ' +
              '<button class="btn btn-small btn-secondary" type="button" data-leave="' +
                esc(p.id) + '">Leave</button></td>' +
            "</tr>";
        }).join("") + "</tbody></table></div>"
        : '<p class="empty">Nobody in the directory yet.</p>') +
      "</div>";
  };

  /* ---------------- Sites ---------------- */

  VIEWS.sites = function () {
    return '<div class="view-head"><p class="eyebrow">Places</p><h1>Sites</h1></div>' +
      '<div class="card"><div class="card-head"><h2>Sites</h2><span class="spacer"></span>' +
        '<span data-need="sites.write"><button class="btn btn-small" type="button" id="site-add">' +
          "Add a site</button></span></div>" +
      (S.sites.length ? '<div class="table-wrap"><table><thead><tr>' +
        "<th>Name</th><th>Duties</th><th></th></tr></thead><tbody>" +
        S.sites.map(s => "<tr><td><strong>" + esc(s.name) + "</strong></td>" +
          "<td>" + S.duties.filter(d => d.site === s.name).length + "</td>" +
          '<td class="nowrap" data-need="sites.write">' +
            '<button class="btn btn-small btn-secondary" type="button" data-rename-site="' +
              esc(s.id) + '">Rename</button> ' +
            '<button class="btn btn-small btn-danger" type="button" data-remove-site="' +
              esc(s.id) + '">Remove</button></td></tr>').join("") +
        "</tbody></table></div>"
        : '<p class="empty">No sites yet.</p>') +
      "</div>";
  };

  /* ---------------- Reports ---------------- */

  let repFrom = addDays(today(), -30);
  let repTo = today();

  VIEWS.reports = function () {
    const calls = S.calls.filter(c => c.date >= repFrom && c.date <= repTo);

    const byOutcome = {};
    calls.forEach(c => { const k = c.outcome || ""; byOutcome[k] = (byOutcome[k] || 0) + 1; });

    const byPerson = {};
    calls.forEach(c => { byPerson[c.personId] = (byPerson[c.personId] || 0) + 1; });

    const dutyDays = {};
    S.duties.forEach(d => {
      let cur = d.start > repFrom ? d.start : repFrom;
      const end = d.end < repTo ? d.end : repTo;
      while (cur <= end) {
        dutyDays[d.personId] = (dutyDays[d.personId] || 0) + 1;
        cur = addDays(cur, 1);
      }
    });

    const ids = Object.keys(byPerson).concat(Object.keys(dutyDays))
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => (byPerson[b] || 0) - (byPerson[a] || 0));

    /* Both clocks are stamped by the server, so this figure does not rest on
       whatever a caller's laptop thought the time was. Median rather than
       mean: one call that sat all weekend should not move the number that
       describes a normal night. */
    const answered = calls
      .filter(c => c.loggedAt && c.answeredAt)
      .map(c => (Date.parse(c.answeredAt.replace(" ", "T")) -
                 Date.parse(c.loggedAt.replace(" ", "T"))) / 60000)
      .filter(m => isFinite(m) && m >= 0)
      .sort((a, b) => a - b);

    const median = answered.length
      ? (answered.length % 2
          ? answered[(answered.length - 1) / 2]
          : (answered[answered.length / 2 - 1] + answered[answered.length / 2]) / 2)
      : null;
    const worst = answered.length ? answered[answered.length - 1] : null;
    const unanswered = calls.filter(c => !c.answeredAt).length;

    const mins = m => m == null ? "&mdash;"
      : m < 1 ? "under a minute"
        : m < 60 ? Math.round(m) + " min"
          : Math.floor(m / 60) + "h " + Math.round(m % 60) + "m";

    /* A call belongs to a site when the person it went to was on a duty
       covering that day. Standby has no site, so those fall to "No site". */
    const bySite = {};
    calls.forEach(c => {
      const d = S.duties.find(x => x.personId === c.personId &&
        x.start <= c.date && x.end >= c.date && x.site);
      const key = d ? d.site : "";
      bySite[key] = (bySite[key] || 0) + 1;
    });
    const sites = Object.keys(bySite).sort((a, b) => bySite[b] - bySite[a]);

    return '<div class="view-head"><p class="eyebrow">Service review</p><h1>Reports</h1></div>' +
      '<div class="card"><div class="card-head"><h2>Period</h2><span class="spacer"></span>' +
        '<input type="date" id="rep-from" aria-label="Report period, from" value="' +
          esc(repFrom) + '" style="max-width:170px"> ' +
        '<input type="date" id="rep-to" aria-label="Report period, to" value="' +
          esc(repTo) + '" style="max-width:170px"> ' +
        '<span data-need="data.export"><button class="btn btn-small btn-secondary" type="button" ' +
          'id="rep-export">Download CSV</button></span></div>' +
      '<div class="tiles">' +
        '<div class="tile"><div class="num">' + calls.length +
          '</div><div class="label">Calls</div></div>' +
        '<div class="tile"><div class="num">' + (byOutcome.answered || 0) +
          '</div><div class="label">Answered</div></div>' +
        '<div class="tile"><div class="num">' + (byOutcome.noanswer || 0) +
          '</div><div class="label">No answer</div></div>' +
        '<div class="tile"><div class="num">' + (byOutcome.escalated || 0) +
          '</div><div class="label">Escalated</div></div>' +
      "</div></div>" +

      '<div class="card"><div class="card-head"><h2>Time to answer</h2>' +
        '<span class="spacer"></span><span class="text-muted">' +
        answered.length + " of " + calls.length + " answered</span></div>" +
      '<div class="tiles">' +
        '<div class="tile"><div class="num">' + mins(median) +
          '</div><div class="label">Median</div></div>' +
        '<div class="tile"><div class="num">' + mins(worst) +
          '</div><div class="label">Worst</div></div>' +
        '<div class="tile"><div class="num">' + unanswered +
          '</div><div class="label">Never answered</div></div>' +
      "</div>" +
      '<p class="text-muted" style="margin-top:var(--s3)">Measured from the moment a ' +
        "call was logged to the moment its outcome first said somebody had responded. " +
        "Both times are set by the server, not by the browser.</p>" +
      "</div>" +

      '<div class="card"><div class="card-head"><h2>Load per site</h2></div>' +
        (sites.length ? '<div class="table-wrap"><table><thead><tr>' +
          "<th>Site</th><th>Calls</th><th>Share</th></tr></thead><tbody>" +
          sites.map(s => "<tr><td>" + (s ? esc(s) : '<span class="text-muted">No site ' +
              "(standby)</span>") + "</td><td>" + bySite[s] + "</td><td>" +
            Math.round((bySite[s] / calls.length) * 100) + "%</td></tr>").join("") +
          "</tbody></table></div>"
          : '<p class="empty">Nothing in this period.</p>') +
      "</div>" +

      '<div class="card"><div class="card-head"><h2>Who is carrying it</h2></div>' +
        (ids.length ? '<div class="table-wrap"><table><thead><tr>' +
          "<th>Person</th><th>Calls</th><th>Days on duty</th></tr></thead><tbody>" +
          ids.map(id => "<tr><td>" + esc(personName(id)) + "</td><td>" +
            (byPerson[id] || 0) + "</td><td>" + (dutyDays[id] || 0) + "</td></tr>").join("") +
          "</tbody></table></div>"
          : '<p class="empty">Nothing in this period.</p>') +
      "</div>";
  };

  /* ==================================================================
     Handover
     ==================================================================
     The roster says who is reachable. This says what they are walking into:
     the ticket still open, the site that has been flaky all night, the thing
     three shifts have worked around and nobody has written down.

     Everything here is fetched and written through its own endpoints rather
     than the roster's sync path, because the server stamps every author and
     every timestamp. A handover nobody can be held to is worth less than no
     handover at all. */

  let HUB = null;               /* null until the first fetch returns */
  let handoversOpen = 0;        /* kept current by the version poll */
  let hubFilter = "open";       /* open | all */

  const PRIORITIES = [
    { id: "critical", label: "Critical" },
    { id: "high", label: "High" },
    { id: "normal", label: "Normal" },
    { id: "low", label: "Low" },
  ];

  function loadHub() {
    return api("GET", "hub")
      .then(res => {
        HUB = res;
        handoversOpen = res.openCount;
        render();
      })
      .catch(err => toast(err.message));
  }

  function applyHub(res) {
    if (res && res.state) {
      HUB = res.state;
      handoversOpen = res.state.openCount;
      render();
    }
  }

  /* Paragraphs survive, markup does not: the body is escaped first and only
     then are newlines turned into breaks. */
  function paras(text) {
    if (!text) return "";
    return esc(text).split("\n")
      .map(line => line.trim() === "" ? "" : "<p>" + line + "</p>")
      .join("");
  }

  function whenText(at) {
    if (!at) return "";
    const t = Date.parse(String(at).replace(" ", "T"));
    if (!isFinite(t)) return esc(at);

    const mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    if (mins < 60 * 24) return Math.floor(mins / 60) + "h ago";
    const days = Math.floor(mins / (60 * 24));
    return days === 1 ? "yesterday" : days + " days ago";
  }

  function handoverCard(h) {
    const canWrite = can("handover.write");
    const mine = h.authorUserId && ME && h.authorUserId === ME.id;
    const canClose = canWrite && (mine || can("handover.manage"));

    return '<div class="ho ho-' + esc(h.priority) + " ho-" + esc(h.status) + '">' +
      '<div class="ho-head">' +
        '<span class="badge badge-' + esc(h.priority) + '">' +
          esc((PRIORITIES.find(p => p.id === h.priority) || {}).label || h.priority) + "</span>" +
        (h.ticketRef ? ' <span class="ho-ticket mono">' + esc(h.ticketRef) + "</span>" : "") +
        '<span class="spacer"></span>' +
        (h.status === "open"
          ? '<span class="badge badge-warn">Not picked up</span>'
          : h.status === "acknowledged"
            ? '<span class="badge badge-ok">Picked up by ' + esc(h.acknowledgedBy || "") + "</span>"
            : '<span class="badge badge-quiet">Closed by ' + esc(h.closedBy || "") + "</span>") +
      "</div>" +

      "<h3>" + esc(h.title) + "</h3>" +
      '<p class="ho-meta text-muted">' + esc(h.author) + " &middot; " + whenText(h.createdAt) +
        (h.site ? " &middot; " + esc(h.site) : "") +
        (h.forPerson ? " &middot; for <strong>" + esc(h.forPerson) + "</strong>"
          : " &middot; for whoever is on") + "</p>" +

      (h.body ? '<div class="ho-body">' + paras(h.body) + "</div>" : "") +

      (h.notes.length ? '<div class="ho-notes">' +
        h.notes.map(n => '<div class="ho-note"><p class="ho-meta text-muted">' +
          esc(n.author) + " &middot; " + whenText(n.at) + "</p>" +
          paras(n.body) + "</div>").join("") + "</div>" : "") +

      (canWrite ? '<div class="ho-actions">' +
        (h.status === "open"
          ? '<button class="btn btn-small" type="button" data-ho-ack="' + esc(h.id) +
            '">I have got this</button> ' : "") +
        '<button class="btn btn-small btn-secondary" type="button" data-ho-note="' + esc(h.id) +
          '">Add a note</button> ' +
        (mine || can("handover.manage")
          ? '<button class="btn btn-small btn-secondary" type="button" data-ho-edit="' +
            esc(h.id) + '">Edit</button> ' : "") +
        (canClose
          ? (h.status === "closed"
            ? '<button class="btn btn-small btn-secondary" type="button" data-ho-open="' +
              esc(h.id) + '">Reopen</button>'
            : '<button class="btn btn-small btn-secondary" type="button" data-ho-close="' +
              esc(h.id) + '">Close</button>')
          : "") +
      "</div>" : "") +
      "</div>";
  }

  function shiftReportCard(r) {
    const section = (label, text) => text
      ? '<div class="sr-section"><h4>' + label + "</h4>" + paras(text) + "</div>"
      : "";

    return '<div class="sr">' +
      '<div class="ho-head"><span class="badge badge-standby">' + esc(r.shift) + "</span>" +
        ' <strong>' + esc(humanLong(r.date)) + "</strong>" +
        (r.site ? ' <span class="text-muted">' + esc(r.site) + "</span>" : "") +
        '<span class="spacer"></span><span class="text-muted">' + esc(r.leader) + "</span></div>" +
      section("What the shift got through", r.progress) +
      section("Still hanging over", r.watchItems) +
      section("What would work better", r.optimisations) +
      "</div>";
  }

  VIEWS.handover = function () {
    if (!HUB) {
      loadHub();
      return '<p class="text-muted">Loading the handover&hellip;</p>';
    }

    const all = HUB.handovers;
    const shown = hubFilter === "open" ? all.filter(h => h.status !== "closed") : all;
    const open = all.filter(h => h.status === "open").length;

    return '<div class="view-head"><p class="eyebrow">Shift to shift</p><h1>Handover</h1></div>' +

      '<div class="card"><div class="card-head"><h2>What to look out for</h2>' +
        '<span class="spacer"></span>' +
        '<div class="seg" role="group" aria-label="Which handovers to show">' +
          '<button class="tab' + (hubFilter === "open" ? " active" : "") +
            '" type="button" id="hub-open">Still live</button>' +
          '<button class="tab' + (hubFilter === "all" ? " active" : "") +
            '" type="button" id="hub-all">Everything recent</button>' +
        "</div>" +
        (can("handover.write")
          ? ' <button class="btn btn-small" type="button" id="ho-add">Leave a handover</button>'
          : "") +
      "</div>" +

      (open ? '<div class="alert alert-warn"><b>' + open + " handover" +
        (open === 1 ? " has" : "s have") + " not been picked up.</b> Saying you have got " +
        "something is what turns a note somebody left into a thing somebody owns.</div>" : "") +

      (shown.length
        ? '<div class="ho-list">' + shown.map(handoverCard).join("") + "</div>"
        : '<p class="empty">' + (hubFilter === "open"
          ? "Nothing outstanding. Anything closed in the last 30 days is under " +
            "&ldquo;Everything recent&rdquo;."
          : "Nothing in the last 30 days.") + "</p>") +
      "</div>" +

      '<div class="card"><div class="card-head"><h2>Shift reports</h2>' +
        '<span class="spacer"></span>' +
        (can("shift.report")
          ? '<button class="btn btn-small btn-secondary" type="button" ' +
            'id="sr-add">Post a shift report</button>'
          : "") +
      "</div>" +
      (HUB.shiftReports.length
        ? '<div class="sr-list">' + HUB.shiftReports.map(shiftReportCard).join("") + "</div>"
        : '<p class="empty">No shift reports yet. A shift leader posts one at the end of ' +
          "a shift: what the team got through, what is still hanging over, and what they " +
          "think would work better.</p>") +
      "</div>";
  };

  function openHandover(id) {
    const h = id && HUB ? HUB.handovers.find(x => x.id === id) : null;

    openDialog(h ? "Edit the handover" : "Leave a handover",
      '<div class="row">' +
        '<div class="field"><label for="ho-ticket">Ticket reference</label>' +
          '<input id="ho-ticket" value="' + esc(h ? h.ticketRef : "") + '" ' +
            'placeholder="INC0012345">' +
          '<span class="hint">Whatever the ticket is called in the system you actually ' +
          "use. Optional.</span></div>" +
        '<div class="field"><label for="ho-priority">Priority</label>' +
          '<select id="ho-priority">' +
            PRIORITIES.map(p => '<option value="' + p.id + '"' +
              ((h ? h.priority : "normal") === p.id ? " selected" : "") + ">" +
              p.label + "</option>").join("") +
          "</select></div>" +
      "</div>" +

      '<div class="field"><label for="ho-title">What is it</label>' +
        '<input id="ho-title" value="' + esc(h ? h.title : "") + '" ' +
          'placeholder="Backup job on SITE-DB01 failing since Tuesday">' +
        '<span class="hint">One line somebody skimming at handover will understand.' +
        "</span></div>" +

      '<div class="field"><label for="ho-body">What to look out for</label>' +
        '<textarea id="ho-body" rows="6" placeholder="What has been tried, what to watch ' +
          'for, who has been told, what happens if it goes again.">' +
          esc(h ? h.body : "") + "</textarea></div>" +

      '<div class="row">' +
        '<div class="field"><label for="ho-site">Site</label>' +
          '<select id="ho-site"><option value="">Not site specific</option>' +
            S.sites.map(s => '<option value="' + esc(s.name) + '"' +
              ((h && h.site) === s.name ? " selected" : "") + ">" +
              esc(s.name) + "</option>").join("") +
          "</select></div>" +
        '<div class="field"><label for="ho-for">For</label>' +
          '<select id="ho-for"><option value="">Whoever is on next</option>' +
            S.people.map(p => '<option value="' + esc(p.id) + '"' +
              ((h && h.forPersonId) === p.id ? " selected" : "") + ">" +
              esc(p.name) + "</option>").join("") +
          "</select>" +
          '<span class="hint">Leave this alone unless it genuinely belongs to one ' +
          "person — a handover addressed to nobody is read by everybody." +
          "</span></div>" +
      "</div>",

      [{ spacer: true },
       { label: "Cancel", onClick: () => true },
       { label: h ? "Save" : "Leave it", class: "btn", onClick: () => {
         const title = $("#ho-title").value.trim();
         if (!title) { dialogError("Give it a title."); return false; }

         api("POST", "handover_save", {
           id: h ? h.id : "",
           ticketRef: $("#ho-ticket").value,
           title: title,
           body: $("#ho-body").value,
           priority: $("#ho-priority").value,
           site: $("#ho-site").value,
           forPersonId: $("#ho-for").value,
         }).then(res => {
           dlg.close();
           applyHub(res);
           toast(h ? "Handover updated" : "Handover left for the next shift");
         }, err => dialogError(err.message));
         return false;
       } }]);
  }

  function openHandoverNote(id) {
    const h = HUB ? HUB.handovers.find(x => x.id === id) : null;
    if (!h) return;

    openDialog("Add a note to: " + h.title,
      '<p class="text-muted">Notes are added, never edited or removed — the thread is the ' +
      "record of what was passed on.</p>" +
      '<div class="field"><label for="ho-note">Note</label>' +
        '<textarea id="ho-note" rows="5" placeholder="What you found, what you did, what ' +
        'is still outstanding."></textarea></div>',
      [{ spacer: true },
       { label: "Cancel", onClick: () => true },
       { label: "Add it", class: "btn", onClick: () => {
         const text = $("#ho-note").value.trim();
         if (!text) { dialogError("Nothing to add."); return false; }

         api("POST", "handover_note", { id: id, body: text })
           .then(res => { dlg.close(); applyHub(res); toast("Note added"); },
             err => dialogError(err.message));
         return false;
       } }]);
  }

  function ackHandover(id) {
    api("POST", "handover_ack", { id: id })
      .then(res => { applyHub(res); toast("Yours now — the handover says so."); },
        err => toast(err.message));
  }

  function setHandoverStatus(id, status) {
    api("POST", "handover_status", { id: id, status: status })
      .then(res => { applyHub(res); toast(status === "closed" ? "Closed" : "Reopened"); },
        err => toast(err.message));
  }

  function openShiftReport() {
    /* Today's report for the shift being posted, if there already is one:
       posting again corrects it rather than adding a second account of the
       same night. */
    const today0 = today();
    const existing = shift => (HUB ? HUB.shiftReports.find(
      r => r.date === today0 && r.shift === shift && r.site === "") : null) || null;

    const draw = shift => {
      const r = existing(shift);
      $("#sr-progress").value = r ? r.progress : "";
      $("#sr-watch").value = r ? r.watchItems : "";
      $("#sr-opt").value = r ? r.optimisations : "";
      $("#sr-existing").hidden = !r;
    };

    openDialog("Shift report",
      '<div class="row">' +
        '<div class="field"><label for="sr-date">Date</label>' +
          '<input id="sr-date" type="date" value="' + esc(today0) + '"></div>' +
        '<div class="field"><label for="sr-shift">Shift</label>' +
          '<select id="sr-shift">' +
            ['day', 'night'].map(s => '<option value="' + s + '">' +
              s.charAt(0).toUpperCase() + s.slice(1) + "</option>").join("") +
          "</select></div>" +
        '<div class="field"><label for="sr-site">Site</label>' +
          '<select id="sr-site"><option value="">All sites</option>' +
            S.sites.map(s => '<option value="' + esc(s.name) + '">' +
              esc(s.name) + "</option>").join("") +
          "</select></div>" +
      "</div>" +

      '<div class="alert alert-warn" id="sr-existing" hidden>There is already a report for ' +
      "that shift. Saving will correct it rather than add a second one.</div>" +

      '<div class="field"><label for="sr-progress">What the shift got through</label>' +
        '<textarea id="sr-progress" rows="5" placeholder="Tickets closed, what was ' +
        'deployed, who covered what."></textarea></div>' +

      '<div class="field"><label for="sr-watch">Still hanging over</label>' +
        '<textarea id="sr-watch" rows="4" placeholder="What the next shift inherits. ' +
        'Anything that needs owning should also be its own handover."></textarea></div>' +

      '<div class="field"><label for="sr-opt">What would work better</label>' +
        '<textarea id="sr-opt" rows="4" placeholder="The thing three shifts have worked ' +
        'around. The check that should be automated. The runbook that is wrong."></textarea>' +
        '<span class="hint">Its own box on purpose — a suggestion buried in a status ' +
        "update is a suggestion nobody acts on.</span></div>",

      [{ spacer: true },
       { label: "Cancel", onClick: () => true },
       { label: "Post it", class: "btn", onClick: () => {
         if (!$("#sr-progress").value.trim() && !$("#sr-watch").value.trim() &&
             !$("#sr-opt").value.trim()) {
           dialogError("Fill in at least one section.");
           return false;
         }

         api("POST", "shift_report_save", {
           date: $("#sr-date").value,
           shift: $("#sr-shift").value,
           site: $("#sr-site").value,
           progress: $("#sr-progress").value,
           watchItems: $("#sr-watch").value,
           optimisations: $("#sr-opt").value,
         }).then(res => { dlg.close(); applyHub(res); toast("Shift report posted"); },
           err => dialogError(err.message));
         return false;
       } }]);

    $("#sr-shift").addEventListener("change", () => draw($("#sr-shift").value));
    draw($("#sr-shift").value);
  }

  /* ---------------- Accounts ---------------- */

  let accounts = null;
  let roles = [];

  VIEWS.accounts = function () {
    if (!accounts) {
      api("GET", "admin_users").then(res => {
        accounts = res.users;
        roles = res.roles;
        render();
      }).catch(err => toast(err.message));
      return '<p class="text-muted">Loading accounts&hellip;</p>';
    }

    const dormant = accounts.filter(u => Number(u.is_active) && !u.last_login_at).length;

    return '<div class="view-head"><p class="eyebrow">Access</p><h1>Accounts</h1></div>' +
      '<div class="card"><div class="card-head"><h2>Who may sign in</h2>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-small" type="button" id="acct-add">Add an account</button></div>' +
      (dormant ? '<div class="alert alert-warn">' + dormant + " active account" +
        (dormant === 1 ? " has" : "s have") + " never been signed in to. An account nobody " +
        "uses is one more way in than the team needs — deactivate what is not wanted.</div>" : "") +
      '<div class="table-wrap"><table><thead><tr>' +
        "<th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Authenticator</th>" +
        "<th>Last signed in</th><th></th></tr></thead><tbody>" +
      accounts.map(u => "<tr>" +
        '<td class="mono">' + esc(u.email) + "</td>" +
        "<td>" + esc(u.name) + "</td>" +
        "<td>" + esc(u.role) +
          (u.pinned ? ' <span class="badge badge-config">config</span>' : "") + "</td>" +
        "<td>" + (Number(u.is_active)
          ? (Number(u.must_change_password)
            ? '<span class="badge badge-warn">Must change password</span>'
            : '<span class="badge badge-ok">Active</span>')
          : '<span class="badge badge-quiet">Deactivated</span>') + "</td>" +
        "<td>" + (u.mfa_enrolled
          ? '<span class="badge badge-ok">Set up</span>' +
            (Number(u.mfa_codes_left) === 0
              ? ' <span class="badge badge-warn">no recovery codes</span>'
              : ' <span class="text-muted">' + Number(u.mfa_codes_left) + " codes</span>")
          : '<span class="badge badge-warn">Sets up at next sign-in</span>') + "</td>" +
        '<td class="nowrap">' + lastSeen(u.last_login_at) +
          (u.last_login_ip ? ' <span class="text-muted mono">' + esc(u.last_login_ip) +
            "</span>" : "") + "</td>" +
        '<td class="nowrap"><button class="btn btn-small btn-secondary" type="button" ' +
          'data-edit-account="' + esc(u.id) + '">Edit</button></td>' +
        "</tr>").join("") +
      "</tbody></table></div></div>";
  };

  /* "Never" is the honest answer for a row that predates the column as well as
     for one nobody has used: nothing was recording it, so nothing is known. */
  function lastSeen(at) {
    if (!at) return '<span class="badge badge-quiet">Never</span>';

    const when = Date.parse(String(at).replace(" ", "T"));
    if (!isFinite(when)) return esc(at);

    const days = Math.floor((Date.now() - when) / 86400000);
    const text = days <= 0 ? "Today" : days === 1 ? "Yesterday"
      : days < 30 ? days + " days ago"
        : humanLong(String(at).slice(0, 10));

    return days >= 90
      ? '<span class="badge badge-warn">' + esc(text) + "</span>"
      : esc(text);
  }

  /* ==================================================================
     dialogs
     ================================================================== */

  function openPerson(id) {
    duplicateWarned = false;
    const p = id ? person(id) : null;
    const extra = id ? S.contacts.filter(c => c.personId === id)
      .sort((a, b) => a.position - b.position) : [];

    openDialog(p ? "Edit " + p.name : "Add a person",
      '<div class="field"><label for="f-name">Name</label>' +
        '<input id="f-name" value="' + esc(p ? p.name : "") + '"></div>' +
      '<div class="row">' +
        '<div class="field"><label for="f-role">Role</label>' +
          '<input id="f-role" value="' + esc(p ? p.role : "") + '"></div>' +
        '<div class="field"><label for="f-dept">Department</label>' +
          '<input id="f-dept" value="' + esc(p ? p.department : "") + '"></div>' +
      "</div>" +
      '<div class="row">' +
        '<div class="field"><label for="f-site">Site</label>' +
          '<input id="f-site" list="site-list" value="' + esc(p ? p.site : "") + '">' +
          '<datalist id="site-list">' +
            S.sites.map(s => '<option value="' + esc(s.name) + '">').join("") +
          "</datalist>" +
          '<span class="hint">Where they are normally based. A duty names its own site.</span></div>' +
        '<div class="field"><label for="f-phone">Mobile</label>' +
          '<input id="f-phone" value="' + esc(p ? p.phone : "") + '"></div>' +
      "</div>" +
      '<div class="field"><label for="f-email">Email</label>' +
        '<input id="f-email" type="email" value="' + esc(p ? p.email : "") + '"></div>' +
      '<div class="field"><label for="f-extra">Other numbers</label>' +
        '<textarea id="f-extra" placeholder="One per line">' +
          esc(extra.map(c => c.value).join("\n")) + "</textarea>" +
        '<span class="hint">Tried after the mobile, in this order.</span></div>' +
      '<div class="field"><label for="f-notes">Notes</label>' +
        '<textarea id="f-notes">' + esc(p ? p.notes : "") + "</textarea></div>",
      [
        p ? { label: "Remove", class: "btn-danger",
              onClick: () => { removePerson(p); return true; } } : null,
        { spacer: true },
        { label: "Cancel", onClick: () => true },
        { label: "Save", class: "btn", onClick: () => savePerson(p) },
      ].filter(Boolean));
  }

  /* The same three keys the importer matches on, so adding by hand and
     importing agree about who is already on file. */
  function findDuplicate(name, phone, email, exceptId) {
    const n = String(name || "").trim().toLowerCase();
    const p = normalisePhone(phone);
    const e = String(email || "").trim().toLowerCase();

    return S.people.find(x => x.id !== exceptId && (
      (e && x.email && x.email.trim().toLowerCase() === e) ||
      (p && x.phone && normalisePhone(x.phone) === p) ||
      (n && x.name.trim().toLowerCase() === n)
    )) || null;
  }

  /* Reset each time the dialog opens: a warning about one person must not
     wave through the next one. */
  let duplicateWarned = false;

  function savePerson(p) {
    const name = $("#f-name").value.trim();
    if (!name) { dialogError("A name is required."); return false; }

    /* A warning, not a refusal — two real people can share a name, and the
       person typing knows which case this is. Pressing Save again goes on. */
    if (!duplicateWarned) {
      const clash = findDuplicate(name, $("#f-phone").value, $("#f-email").value,
        p ? p.id : null);
      if (clash) {
        duplicateWarned = true;
        dialogError(esc(clash.name) + " is already on file" +
          (clash.role ? " (" + clash.role + ")" : "") +
          ". Press Save again to add this person anyway, or Cancel and edit the " +
          "existing record instead.");
        return false;
      }
    }

    const id = p ? p.id : uuid();
    const lines = $("#f-extra").value.split("\n").map(s => s.trim()).filter(Boolean);
    const row = {
      id: id, name: name,
      role: $("#f-role").value.trim(),
      department: $("#f-dept").value.trim(),
      site: $("#f-site").value.trim(),
      phone: normalisePhone($("#f-phone").value),
      email: $("#f-email").value.trim(),
      notes: $("#f-notes").value,
      feed: p ? p.feed : "",
    };

    mutate(p ? "Edited " + name : "Added " + name, () => {
      S.people = p ? S.people.map(x => x.id === id ? row : x) : S.people.concat([row]);
      S.contacts = S.contacts.filter(c => c.personId !== id).concat(
        lines.map((v, i) => ({
          id: uuid(), personId: id, kind: "phone", value: normalisePhone(v), position: i,
        })));
    });
    return true;
  }

  function removePerson(p) {
    confirmDialog("Remove " + p.name + "?",
      "Their duties, calls, contacts and leave go with them. This cannot be undone.",
      "Remove", () => {
        mutate("Removed " + p.name, () => {
          S.people = S.people.filter(x => x.id !== p.id);
          S.duties = S.duties.filter(d => d.personId !== p.id);
          S.calls = S.calls.filter(c => c.personId !== p.id);
          S.contacts = S.contacts.filter(c => c.personId !== p.id);
          S.leave = S.leave.filter(l => l.personId !== p.id);
          S.overrides = S.overrides.filter(o => o.personId !== p.id);
        });
      });
  }

  function openDuty(id) {
    if (!S.people.length) { toast("Add somebody to the directory first."); return; }

    const d = id ? S.duties.find(x => x.id === id) : null;
    const sel = (v, cur) => (v === cur ? " selected" : "");

    openDialog(d ? "Edit the duty" : "Add a duty",
      '<div class="field"><label for="d-person">Person</label><select id="d-person">' +
        S.people.map(p => '<option value="' + esc(p.id) + '"' + sel(p.id, d && d.personId) +
          ">" + esc(p.name) + "</option>").join("") +
      "</select></div>" +
      '<div class="row">' +
        '<div class="field"><label for="d-type">Type</label><select id="d-type">' +
          '<option value="standby"' + sel("standby", d && d.type) + ">Standby</option>" +
          '<option value="onsite"' + sel("onsite", d && d.type) + ">On site</option>" +
        "</select></div>" +
        '<div class="field"><label for="d-site">Site</label><select id="d-site">' +
          '<option value=""' + sel("", d ? d.site : null) + ">No site</option>" +
          S.sites.map(s => '<option value="' + esc(s.name) + '"' + sel(s.name, d && d.site) +
            ">" + esc(s.name) + "</option>").join("") +
        "</select></div>" +
      "</div>" +
      '<div class="row">' +
        '<div class="field"><label for="d-start">From</label>' +
          '<input id="d-start" type="date" value="' + esc(d ? d.start : today()) + '"></div>' +
        '<div class="field"><label for="d-end">To</label>' +
          '<input id="d-end" type="date" value="' +
            esc(d ? d.end : addDays(today(), 6)) + '"></div>' +
      "</div>" +
      '<div class="field"><label for="d-note">Note</label>' +
        '<input id="d-note" value="' + esc(d ? d.note : "") + '"></div>' +
      (d && S.overrides.some(o => o.dutyId === d.id)
        ? '<div class="alert alert-warn">Somebody is covering part of this duty. Changing the ' +
          "dates here does not move that cover.</div>" : ""),
      [
        d ? { label: "Remove", class: "btn-danger",
              onClick: () => { removeDuty(d); return true; } } : null,
        { spacer: true },
        { label: "Cancel", onClick: () => true },
        { label: "Save", class: "btn", onClick: () => saveDuty(d) },
      ].filter(Boolean));
  }

  function saveDuty(d) {
    const start = $("#d-start").value;
    const end = $("#d-end").value;
    if (!start || !end) { dialogError("A start and an end date are required."); return false; }
    if (end < start) { dialogError("The end date is before the start date."); return false; }

    const pid = $("#d-person").value;
    const row = {
      id: d ? d.id : uuid(), personId: pid, type: $("#d-type").value,
      start: start, end: end, site: $("#d-site").value, note: $("#d-note").value.trim(),
    };

    mutate((d ? "Edited the duty for " : "Added a duty for ") + personName(pid), () => {
      S.duties = d ? S.duties.map(x => x.id === row.id ? row : x) : S.duties.concat([row]);
    });
    return true;
  }

  function removeDuty(d) {
    const covers = S.overrides.filter(o => o.dutyId === d.id).length;
    confirmDialog("Remove this duty?",
      personName(d.personId) + ", " + human(d.start) + " to " + human(d.end) + "." +
        (covers ? " Any cover arranged on it goes too." : "") +
        " Calls already logged are kept.",
      "Remove", () => {
        mutate("Removed a duty for " + personName(d.personId), () => {
          S.duties = S.duties.filter(x => x.id !== d.id);
          S.overrides = S.overrides.filter(o => o.dutyId !== d.id);
        });
      });
  }

  function openCall(personId, callId) {
    const c = callId ? S.calls.find(x => x.id === callId) : null;
    const pid = c ? c.personId : personId;
    if (!pid) { toast("Add somebody to the directory first."); return; }

    openDialog(c ? "Edit the call" : "Log a call to " + personName(pid),
      '<div class="row">' +
        '<div class="field"><label for="c-date">Date</label>' +
          '<input id="c-date" type="date" value="' + esc(c ? c.date : today()) + '"></div>' +
        '<div class="field"><label for="c-time">Time</label>' +
          '<input id="c-time" type="time" value="' +
            esc(c ? c.time : new Date().toTimeString().slice(0, 5)) + '"></div>' +
      "</div>" +
      '<div class="field"><label for="c-by">Called by</label>' +
        '<input id="c-by" value="' + esc(c ? c.by : (S.lastCaller || ME.name || "")) + '"></div>' +
      '<div class="field"><label for="c-outcome">Outcome</label><select id="c-outcome">' +
        '<option value="">No outcome yet</option>' +
        OUTCOMES.map(o => '<option value="' + o.key + '"' +
          (c && c.outcome === o.key ? " selected" : "") + ">" + o.label + "</option>").join("") +
      "</select></div>" +
      '<div class="field"><label for="c-note">Note</label><textarea id="c-note">' +
        esc(c ? c.note : "") + "</textarea></div>",
      [
        c ? { label: "Delete", class: "btn-danger", onClick: () => {
              mutate("Deleted a call note",
                () => { S.calls = S.calls.filter(x => x.id !== c.id); });
              return true;
            } } : null,
        { spacer: true },
        { label: "Cancel", onClick: () => true },
        { label: "Save", class: "btn", onClick: () => saveCall(c, pid) },
      ].filter(Boolean));
  }

  function saveCall(c, pid) {
    const date = $("#c-date").value;
    if (!date) { dialogError("A date is required."); return false; }

    const by = $("#c-by").value.trim();
    const row = {
      id: c ? c.id : uuid(), personId: pid, date: date,
      time: $("#c-time").value, by: by,
      outcome: $("#c-outcome").value, note: $("#c-note").value,
      loggedAt: c ? c.loggedAt : null, answeredAt: c ? c.answeredAt : null,
    };

    mutate(c ? "Edited a call note" : "Logged a call to " + personName(pid), () => {
      S.calls = c ? S.calls.map(x => x.id === row.id ? row : x) : S.calls.concat([row]);
      S.lastCaller = by;
    });
    return true;
  }

  function openSite(id) {
    const s = id ? S.sites.find(x => x.id === id) : null;
    openDialog(s ? "Rename " + s.name : "Add a site",
      '<div class="field"><label for="s-name">Name</label>' +
        '<input id="s-name" value="' + esc(s ? s.name : "") + '"></div>',
      [{ spacer: true }, { label: "Cancel", onClick: () => true },
       { label: "Save", class: "btn", onClick: () => {
         const name = $("#s-name").value.trim();
         if (!name) { dialogError("A name is required."); return false; }
         mutate(s ? "Renamed a site" : "Added the site " + name, () => {
           if (s) {
             const old = s.name;
             S.sites = S.sites.map(x => x.id === s.id ? { id: s.id, name: name } : x);
             /* A duty names its site as text, so the rename has to follow. */
             S.duties = S.duties.map(d =>
               d.site === old ? Object.assign({}, d, { site: name }) : d);
           } else {
             S.sites = S.sites.concat([{ id: uuid(), name: name }]);
           }
         });
         return true;
       } }]);
  }

  function removeSite(id) {
    const s = S.sites.find(x => x.id === id);
    if (!s) return;
    const used = S.duties.filter(d => d.site === s.name).length;
    confirmDialog("Remove " + s.name + "?",
      used ? used + " duties name this site. They keep the name as text, but it stops being " +
        "offered in the pickers." : "Nothing is using this site.",
      "Remove", () => mutate("Removed the site " + s.name,
        () => { S.sites = S.sites.filter(x => x.id !== id); }));
  }

  function openAccount(u) {
    openDialog(u ? "Edit " + u.email : "Add an account",
      '<div class="field"><label for="a-email">Email</label>' +
        '<input id="a-email" type="email" value="' + esc(u ? u.email : "") + '"' +
          (u ? " disabled" : "") + ">" +
        '<span class="hint">What they sign in with. It cannot be changed afterwards.</span></div>' +
      '<div class="row">' +
        '<div class="field"><label for="a-name">Name</label>' +
          '<input id="a-name" value="' + esc(u ? u.name : "") + '"></div>' +
        '<div class="field"><label for="a-role">Role</label>' +
          '<select id="a-role"' + (u && u.pinned ? " disabled" : "") + ">" +
          roles.map(r => '<option value="' + esc(r) + '"' +
            ((u ? u.role === r : r === "viewer") ? " selected" : "") + ">" +
            esc(r) + "</option>").join("") + "</select></div>" +
      "</div>" +
      (u ? '<div class="field"><label for="a-active">Status</label>' +
            '<select id="a-active"' + (u.pinned ? " disabled" : "") + ">" +
            '<option value="1"' + ((Number(u.is_active) || u.pinned) ? " selected" : "") +
              ">Active</option>" +
            '<option value="0"' + ((!Number(u.is_active) && !u.pinned) ? " selected" : "") +
              ">Deactivated</option></select></div>"
        : '<div class="field"><label for="a-password">Temporary password</label>' +
          '<input id="a-password" type="password" autocomplete="new-password">' +
          '<span class="hint">At least 10 characters, with an uppercase letter, a lowercase ' +
          "letter, a number and a special character. They are asked to change it when they " +
          "first sign in.</span></div>") +
      (u && u.pinned ? '<div class="alert alert-warn">Listed in <b>super_admins</b> in ' +
        "config.php, so this is a permanent superadmin. Role and status are fixed here — " +
        "remove it from that list on the server to change them.</div>" : ""),
      [
        u ? { label: "Reset password", onClick: () => { resetPassword(u); return false; } } : null,
        u && u.mfa_enrolled
          ? { label: "Reset authenticator", onClick: () => { adminResetMfa(u); return false; } }
          : null,
        { spacer: true },
        { label: "Cancel", onClick: () => true },
        { label: "Save", class: "btn", onClick: () => saveAccount(u) },
      ].filter(Boolean));
  }

  /* The way back in for somebody whose authenticator was on a phone they no
     longer have and whose recovery codes went with it.

     This forgets their authenticator; it does not switch the second factor
     off, because there is no off. They set up a new one at their next
     sign-in. Their password is untouched, so doing this does not hand you
     their account — and the history says who did it, which is the point. */
  function adminResetMfa(u) {
    confirmDialog("Reset the authenticator for " + u.email,
      "They will set up a new authenticator the next time they sign in, and their current " +
      "recovery codes stop working. Do this only when you know who you are talking to — " +
      "somebody asking for it is exactly what an attacker holding their password would " +
      "ask for. It is recorded in the history against your name.",
      "Reset it", () => {
        api("POST", "admin_user_mfa_reset", { id: u.id })
          .then(() => { accounts = null; render(); toast("Authenticator reset for " + u.email); },
            err => toast(err.message));
      });
  }

  function saveAccount(u) {
    const name = $("#a-name").value.trim();
    if (!name) { dialogError("A name is required."); return false; }

    const done = msg => { accounts = null; dlg.close(); render(); toast(msg); };
    const fail = err => dialogError(err.message);

    if (u) {
      api("POST", "admin_user_update", {
        id: u.id, name: name, role: $("#a-role").value,
        is_active: $("#a-active").value === "1",
      }).then(() => done("Account updated"), fail);
    } else {
      api("POST", "admin_user_create", {
        email: $("#a-email").value.trim(), name: name,
        role: $("#a-role").value, password: $("#a-password").value,
      }).then(() => done("Account added"), fail);
    }
    return false;   /* held open until the server answers */
  }

  function resetPassword(u) {
    openDialog("Reset the password for " + u.email,
      '<div class="field"><label for="r-password">New password</label>' +
        '<input id="r-password" type="password" autocomplete="new-password">' +
        '<span class="hint">They are asked to change it when they next sign in.</span></div>',
      [{ spacer: true }, { label: "Cancel", onClick: () => true },
       { label: "Reset", class: "btn-danger", onClick: () => {
         api("POST", "admin_user_reset_password",
           { id: u.id, password: $("#r-password").value })
           .then(() => { accounts = null; dlg.close(); render(); toast("Password reset"); },
             err => dialogError(err.message));
         return false;
       } }]);
  }

  function openPassword(forced) {
    openDialog(forced ? "Choose a new password" : "Change your password",
      (forced ? '<div class="alert alert-warn">Somebody else chose your current password. ' +
        "Pick your own before carrying on.</div>" : "") +
      '<div class="field"><label for="p-current">Current password</label>' +
        '<input id="p-current" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="p-new">New password</label>' +
        '<input id="p-new" type="password" autocomplete="new-password">' +
        '<span class="hint">At least 10 characters, with an uppercase letter, a lowercase ' +
        "letter, a number and a special character.</span></div>" +
      '<div class="field"><label for="p-confirm">Confirm</label>' +
        '<input id="p-confirm" type="password" autocomplete="new-password"></div>',
      [{ spacer: true },
       forced ? null : { label: "Cancel", onClick: () => true },
       { label: "Save", class: "btn", onClick: () => {
         api("POST", "change_password", {
           current_password: $("#p-current").value,
           new_password: $("#p-new").value,
           confirm: $("#p-confirm").value,
         }).then(() => { dlg.close(); toast("Password changed"); },
           err => dialogError(err.message));
         return false;
       } }].filter(Boolean));
  }

  /* There was a two-factor dialog here, letting each person turn a second
     factor on or off for their own account. It is gone: every session has
     already passed the second factor, so there is nothing to offer a
     signed-in person. Enrolment happens on the sign-in page, and only a
     superadmin can undo it, from Accounts. */


  /* ==================================================================
     data
     ================================================================== */

  function openHistory() {
    api("GET", "log", { limit: 200 }).then(res => {
      openDialog("History",
        res.entries.length ? '<div class="table-wrap"><table><thead><tr>' +
          "<th>When</th><th>Who</th><th>What</th></tr></thead><tbody>" +
          res.entries.map(e => "<tr>" +
            '<td class="mono nowrap">' + esc(e.at) + "</td>" +
            "<td>" + esc(e.who) + "</td><td>" + esc(e.what) + "</td></tr>").join("") +
          "</tbody></table></div>"
          : '<p class="empty">Nothing recorded yet.</p>',
        [{ spacer: true }, { label: "Close", onClick: () => true }]);
    }).catch(err => toast(err.message));
  }

  /* Rotating replaces the key behind a link, which is the only thing that
     stops a copy somebody kept. Revoking takes the feed away altogether.
     Both are here rather than being a job for whoever has database access,
     because the moment they are needed - somebody has left, a link went to
     the wrong address - is not a moment to go looking for a DBA. */
  function openFeeds() {
    api("GET", "feeds").then(res => {
      const row = (label, url, controls) =>
        '<div class="field"><label>' + esc(label) + "</label>" +
        (url
          ? '<input readonly value="' + esc(url) + '">'
          : '<p class="text-muted" style="margin:0">No feed. Rotating gives them a new one.</p>') +
        (controls ? '<div class="feed-controls">' + controls + "</div>" : "") + "</div>";

      openDialog("Calendar subscriptions",
        "<p>Each link is a password &mdash; anybody holding it can read that calendar. " +
        "Subscribe to it in Outlook rather than downloading it.</p>" +
        (res.canEdit
          ? '<p class="text-muted">Rotating makes a new link and stops the old one working, ' +
            "which is what to do when somebody leaves or a link goes astray. Whoever is " +
            "subscribed to the old one has to subscribe again.</p>"
          : "") +
        row("Everyone", res.team, res.canEdit
          ? '<button class="btn btn-small btn-secondary" type="button" ' +
            'data-feed-rotate="team">Rotate</button>' : "") +
        res.people.map(p => row(p.name, p.url, res.canEdit
          ? '<button class="btn btn-small btn-secondary" type="button" data-feed-rotate="' +
              esc(p.id) + '">Rotate</button> ' +
            (p.url ? '<button class="btn btn-small btn-danger" type="button" data-feed-revoke="' +
              esc(p.id) + '">Revoke</button>' : "")
          : "")).join(""),
        [{ spacer: true }, { label: "Close", onClick: () => true }]);
    }).catch(err => toast(err.message));
  }

  function rotateFeed(id) {
    const team = id === "team";
    confirmDialog(team ? "Rotate the team calendar key" : "Rotate this calendar key",
      "The current link stops working immediately. Anybody subscribed to it — including " +
      (team ? "everybody who uses the team feed" : "the person it belongs to") +
      " — has to subscribe again with the new one.",
      "Rotate", () => {
        api("POST", "feed_rotate", team ? { scope: "team" } : { scope: "person", id: id })
          .then(() => { toast("Key rotated. The old link no longer works."); openFeeds(); },
            err => toast(err.message));
      });
  }

  function revokeFeed(id) {
    confirmDialog("Revoke this calendar feed",
      "The link stops working and no new one is issued until you rotate. Use this when " +
      "somebody has left.",
      "Revoke", () => {
        api("POST", "feed_revoke", { scope: "person", id: id })
          .then(() => { toast("Feed revoked."); openFeeds(); },
            err => toast(err.message));
      });
  }

  /* The CSV is built by the server and fetched as a file, rather than
     assembled here out of state the browser already holds.

     The difference is the audit row. Everyone's numbers and every call note
     are already in this page, so nothing here can stop a determined person
     taking a copy - but the sanctioned way of doing it should be the recorded
     way, and a copy assembled in the browser reaches the server never and so
     is recorded nowhere. */
  function downloadExport(what, params) {
    const qs = new URLSearchParams(params || {});
    qs.set("action", "export");
    qs.set("what", what);

    /* A download rather than a navigation: the server sends it as an
       attachment, so this page stays where it is. */
    window.location.assign("api.php?" + qs.toString());
    toast("Preparing the file… this export is recorded in the history.");
  }

  function exportCalls() {
    downloadExport("calls", { from: repFrom, to: repTo });
  }

  function exportDirectory() {
    confirmDialog("Export the directory",
      "This downloads every person in the directory with all of their numbers, " +
      "and records in the history that you did. Personal contact details leaving " +
      "the system is exactly what that record is for.",
      "Download", () => downloadExport("directory"));
  }

  /* ------------- cover -------------
     The duty is left alone as the record of whose rotation the days are; the
     override says who is actually reachable. Keeping them apart is what stops
     a rotation regenerating over an arrangement somebody made by hand. */

  function openCover(dutyId) {
    const d = S.duties.find(x => x.id === dutyId);
    if (!d) return;
    const existing = S.overrides.find(o => o.dutyId === dutyId) || null;

    openDialog("Cover for " + personName(d.personId),
      '<p class="text-muted">' + esc(personName(d.personId)) + " is on " +
        esc(human(d.start)) + " to " + esc(human(d.end)) +
        ". Cover says who is actually reachable for part of that.</p>" +
      '<div class="field" style="margin-top:var(--s4)">' +
        '<label for="ov-person">Covered by</label><select id="ov-person">' +
        S.people.filter(p => p.id !== d.personId)
          .map(p => '<option value="' + esc(p.id) + '"' +
            (existing && existing.personId === p.id ? " selected" : "") + ">" +
            esc(p.name) + "</option>").join("") +
      "</select></div>" +
      '<div class="row">' +
        '<div class="field"><label for="ov-start">From</label>' +
          '<input id="ov-start" type="date" value="' +
            esc(existing ? existing.start : d.start) + '"></div>' +
        '<div class="field"><label for="ov-end">To</label>' +
          '<input id="ov-end" type="date" value="' +
            esc(existing ? existing.end : d.end) + '"></div>' +
      "</div>" +
      '<div class="field"><label for="ov-note">Note</label>' +
        '<input id="ov-note" value="' + esc(existing ? existing.note : "") + '"></div>',
      [
        existing ? { label: "Remove cover", class: "btn-danger", onClick: () => {
          mutate("Removed cover on a duty",
            () => { S.overrides = S.overrides.filter(o => o.id !== existing.id); });
          return true;
        } } : null,
        { spacer: true },
        { label: "Cancel", onClick: () => true },
        { label: "Save", class: "btn", onClick: () => {
          const start = $("#ov-start").value, end = $("#ov-end").value;
          if (!start || !end) { dialogError("A start and an end date are required."); return false; }
          if (end < start) { dialogError("The end date is before the start date."); return false; }
          if (start < d.start || end > d.end) {
            dialogError("Cover has to sit inside the duty, " +
              human(d.start) + " to " + human(d.end) + "."); return false;
          }
          if (!S.people.some(p => p.id !== d.personId)) {
            dialogError("There is nobody else to cover."); return false;
          }
          const row = {
            id: existing ? existing.id : uuid(), dutyId: dutyId,
            personId: $("#ov-person").value, start: start, end: end,
            note: $("#ov-note").value.trim(),
          };
          mutate("Arranged cover for " + personName(d.personId), () => {
            S.overrides = existing
              ? S.overrides.map(o => o.id === row.id ? row : o)
              : S.overrides.concat([row]);
          });
          return true;
        } },
      ].filter(Boolean));
  }

  /* ------------- leave -------------
     Leave never removes cover on its own. The roster warns instead, because
     deleting a duty when somebody books leave is how a night ends up with
     nobody on it. */

  function openLeave(personId) {
    const p = person(personId);
    if (!p) return;
    const mine = S.leave.filter(l => l.personId === personId)
      .sort((a, b) => a.start.localeCompare(b.start));

    openDialog("Leave for " + p.name,
      (mine.length ? '<div class="table-wrap"><table><thead><tr>' +
        "<th>From</th><th>To</th><th>Reason</th><th></th></tr></thead><tbody>" +
        mine.map(l => "<tr><td>" + esc(human(l.start)) + "</td><td>" + esc(human(l.end)) +
          "</td><td>" + esc(l.reason || "") + "</td>" +
          '<td><button class="btn btn-small btn-danger" type="button" data-drop-leave="' +
          esc(l.id) + '">Remove</button></td></tr>').join("") +
        "</tbody></table></div>"
        : '<p class="empty">No leave booked.</p>') +
      '<div class="row" style="margin-top:var(--s4)">' +
        '<div class="field"><label for="lv-start">From</label>' +
          '<input id="lv-start" type="date" value="' + today() + '"></div>' +
        '<div class="field"><label for="lv-end">To</label>' +
          '<input id="lv-end" type="date" value="' + today() + '"></div>' +
      "</div>" +
      '<div class="field"><label for="lv-reason">Reason</label>' +
        '<input id="lv-reason" placeholder="Annual leave"></div>',
      [{ spacer: true }, { label: "Close", onClick: () => true },
       { label: "Add leave", class: "btn", onClick: () => {
         const start = $("#lv-start").value, end = $("#lv-end").value;
         if (!start || !end) { dialogError("A start and an end date are required."); return false; }
         if (end < start) { dialogError("The end date is before the start date."); return false; }

         const clash = S.duties.filter(d => d.personId === personId &&
           d.start <= end && d.end >= start);

         mutate("Booked leave for " + p.name, () => {
           S.leave = S.leave.concat([{
             id: uuid(), personId: personId, start: start, end: end,
             reason: $("#lv-reason").value.trim(),
           }]);
         });

         if (clash.length) {
           toast(p.name + " is on duty across " + clash.length +
             " of those days — arrange cover.");
         }
         return true;
       } }]);
  }

  /* ------------- escalation -------------
     Who to try after the person on duty does not answer. bin/notify.php reads
     the same chain, so the roster and the notifier cannot disagree. */

  VIEWS.escalation = function () {
    const sites = [""].concat(S.sites.map(s => s.name));

    return '<div class="view-head"><p class="eyebrow">When nobody answers</p>' +
        "<h1>Escalation</h1></div>" +
      '<div class="alert alert-warn">The unanswered-call job emails this chain. ' +
        "With nothing here it runs and tells nobody.</div>" +
      sites.map(site => {
        const chain = S.escalations.filter(e => e.site === site)
          .sort((a, b) => a.position - b.position);
        return '<div class="card"><div class="card-head"><h2>' +
            (site ? esc(site) : "Default chain") + "</h2>" +
            '<span class="spacer"></span>' +
            '<span data-need="sites.write"><button class="btn btn-small" type="button" ' +
              'data-add-esc="' + esc(site) + '">Add a step</button></span></div>' +
          (site ? "" : '<p class="text-muted" style="margin-bottom:var(--s3)">Used when a ' +
            "site has no chain of its own.</p>") +
          (chain.length ? '<div class="table-wrap"><table><thead><tr>' +
            "<th>Order</th><th>Person</th><th>After</th><th></th></tr></thead><tbody>" +
            chain.map((e, i) => "<tr><td>" + (i + 1) + "</td><td>" +
              esc(personName(e.personId)) + "</td><td>" + e.afterMinutes + " min</td>" +
              '<td class="nowrap" data-need="sites.write">' +
                '<button class="btn btn-small btn-secondary" type="button" data-edit-esc="' +
                  esc(e.id) + '">Edit</button> ' +
                '<button class="btn btn-small btn-danger" type="button" data-drop-esc="' +
                  esc(e.id) + '">Remove</button></td></tr>').join("") +
            "</tbody></table></div>"
            : '<p class="empty">No chain set. Nobody is told when a call goes unanswered.</p>') +
          "</div>";
      }).join("");
  };

  function openEscalation(id, site) {
    const e = id ? S.escalations.find(x => x.id === id) : null;
    if (!S.people.length) { toast("Add somebody to the directory first."); return; }
    const at = e ? e.site : site;

    openDialog(e ? "Edit the escalation step" : "Add an escalation step",
      '<div class="field"><label for="es-person">Person</label><select id="es-person">' +
        S.people.map(p => '<option value="' + esc(p.id) + '"' +
          (e && e.personId === p.id ? " selected" : "") + ">" + esc(p.name) +
          "</option>").join("") + "</select></div>" +
      '<div class="row">' +
        '<div class="field"><label for="es-pos">Order</label>' +
          '<input id="es-pos" type="number" min="1" max="99" value="' +
            (e ? e.position : S.escalations.filter(x => x.site === at).length + 1) + '"></div>' +
        '<div class="field"><label for="es-after">Try after</label>' +
          '<input id="es-after" type="number" min="1" max="1440" value="' +
            (e ? e.afterMinutes : 15) + '">' +
          '<span class="hint">Minutes from the call being logged.</span></div>' +
      "</div>",
      [{ spacer: true }, { label: "Cancel", onClick: () => true },
       { label: "Save", class: "btn", onClick: () => {
         const row = {
           id: e ? e.id : uuid(), site: at,
           position: Math.max(1, Number($("#es-pos").value) || 1),
           personId: $("#es-person").value,
           afterMinutes: Math.max(1, Math.min(1440, Number($("#es-after").value) || 15)),
         };
         mutate("Changed the escalation chain", () => {
           S.escalations = e
             ? S.escalations.map(x => x.id === row.id ? row : x)
             : S.escalations.concat([row]);
         });
         return true;
       } }]);
  }

  /* ------------- rotations -------------
     A repeating pattern that writes duty rows, so nobody types the same
     weekend cover in fifty-two times. Generating is a server action: it works
     out the turns and writes the duties in one transaction. */

  VIEWS.rotations = function () {
    return '<div class="view-head"><p class="eyebrow">Repeating cover</p>' +
        "<h1>Rotations</h1></div>" +
      '<div class="card"><div class="card-head"><h2>Patterns</h2>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-small" type="button" id="rot-add">Add a rotation</button></div>' +
      (S.rotations.length ? '<div class="table-wrap"><table><thead><tr>' +
        "<th>Name</th><th>Type</th><th>Site</th><th>Turn</th><th>People</th>" +
        "<th>Generated to</th><th></th></tr></thead><tbody>" +
        S.rotations.map(r => "<tr><td><strong>" + esc(r.name) + "</strong></td>" +
          "<td>" + (r.type === "onsite" ? "On site" : "Standby") + "</td>" +
          "<td>" + esc(r.site || "&mdash;") + "</td>" +
          "<td>" + r.lengthDays + " days</td>" +
          "<td>" + r.members.length + "</td>" +
          "<td>" + esc(r.generatedTo ? human(r.generatedTo) : "never") + "</td>" +
          '<td class="nowrap">' +
            '<button class="btn btn-small btn-secondary" type="button" data-edit-rot="' +
              esc(r.id) + '">Edit</button> ' +
            '<button class="btn btn-small" type="button" data-run-rot="' +
              esc(r.id) + '">Generate</button></td></tr>').join("") +
        "</tbody></table></div>"
        : '<p class="empty">No rotations yet.</p>') +
      "</div>";
  };

  function openRotation(id) {
    const r = id ? S.rotations.find(x => x.id === id) : null;
    if (!S.people.length) { toast("Add somebody to the directory first."); return; }

    openDialog(r ? "Edit " + r.name : "Add a rotation",
      '<div class="field"><label for="rt-name">Name</label>' +
        '<input id="rt-name" value="' + esc(r ? r.name : "") + '"></div>' +
      '<div class="row">' +
        '<div class="field"><label for="rt-type">Type</label><select id="rt-type">' +
          '<option value="standby"' + (r && r.type === "standby" ? " selected" : "") +
            ">Standby</option>" +
          '<option value="onsite"' + (r && r.type === "onsite" ? " selected" : "") +
            ">On site</option></select></div>" +
        '<div class="field"><label for="rt-site">Site</label><select id="rt-site">' +
          '<option value="">No site</option>' +
          S.sites.map(s => '<option value="' + esc(s.name) + '"' +
            (r && r.site === s.name ? " selected" : "") + ">" + esc(s.name) +
            "</option>").join("") + "</select></div>" +
      "</div>" +
      '<div class="row">' +
        '<div class="field"><label for="rt-start">Starts</label>' +
          '<input id="rt-start" type="date" value="' + esc(r ? r.start : today()) + '">' +
          '<span class="hint">Turns are counted from here, so who is up next does not ' +
          "change with the day you generate.</span></div>" +
        '<div class="field"><label for="rt-len">Turn length</label>' +
          '<input id="rt-len" type="number" min="1" max="365" value="' +
            (r ? r.lengthDays : 7) + '"><span class="hint">Days per person.</span></div>' +
      "</div>" +
      '<div class="field"><label for="rt-members">In the rotation, in order</label>' +
        '<select id="rt-members" multiple size="8">' +
        S.people.map(p => '<option value="' + esc(p.id) + '"' +
          (r && r.members.indexOf(p.id) > -1 ? " selected" : "") + ">" +
          esc(p.name) + "</option>").join("") + "</select>" +
        '<span class="hint">Ctrl-click to pick several.</span></div>',
      [
        r ? { label: "Remove", class: "btn-danger", onClick: () => {
          mutate("Removed the rotation " + r.name,
            () => { S.rotations = S.rotations.filter(x => x.id !== r.id); });
          return true;
        } } : null,
        { spacer: true },
        { label: "Cancel", onClick: () => true },
        { label: "Save", class: "btn", onClick: () => {
          const name = $("#rt-name").value.trim();
          if (!name) { dialogError("A name is required."); return false; }
          const members = Array.prototype.slice
            .call($("#rt-members").selectedOptions).map(o => o.value);
          if (!members.length) { dialogError("Pick at least one person."); return false; }

          const row = {
            id: r ? r.id : uuid(), name: name,
            type: $("#rt-type").value, site: $("#rt-site").value,
            start: $("#rt-start").value || today(),
            lengthDays: Math.max(1, Math.min(365, Number($("#rt-len").value) || 7)),
            members: members,
            generatedTo: r ? r.generatedTo : null,
            active: true,
          };
          mutate(r ? "Edited the rotation " + name : "Added the rotation " + name, () => {
            S.rotations = r
              ? S.rotations.map(x => x.id === row.id ? row : x)
              : S.rotations.concat([row]);
          });
          return true;
        } },
      ].filter(Boolean));
  }

  /* Preview first: generating writes real duty rows, and it is easier to
     agree with a list than to undo one. */
  function runRotation(id, weeks) {
    const r = S.rotations.find(x => x.id === id);
    if (!r) return;
    const ahead = Math.max(1, Math.min(104, weeks || 12));

    api("POST", "rotate", { id: id, weeks: ahead, preview: true }).then(res => {
      openDialog("Generate from " + r.name,
        '<div class="field"><label for="rot-weeks">How far ahead</label>' +
          '<select id="rot-weeks" data-rot-weeks="' + esc(id) + '">' +
          [4, 8, 12, 26, 52].map(w => '<option value="' + w + '"' +
            (w === ahead ? " selected" : "") + ">" + w + " weeks</option>").join("") +
          "</select></div>" +
        "<p>Duties this will write, through " + esc(human(res.until)) + ". Duties this " +
          "rotation wrote before are replaced; anything entered by hand is untouched.</p>" +
        (res.planned.length ? '<div class="table-wrap" style="margin-top:var(--s4)">' +
          "<table><thead><tr><th>Person</th><th>From</th><th>To</th></tr></thead><tbody>" +
          res.planned.map(p => "<tr><td>" + esc(p.person) +
            (p.onLeave ? ' <span class="badge badge-warn">on leave</span>' : "") +
            "</td><td>" + esc(human(p.start)) + "</td><td>" + esc(human(p.end)) +
            "</td></tr>").join("") + "</tbody></table></div>"
          : '<p class="empty">Nothing to generate.</p>'),
        [{ spacer: true }, { label: "Cancel", onClick: () => true },
         { label: "Generate " + res.planned.length + " duties", class: "btn", onClick: () => {
           api("POST", "rotate", { id: id, weeks: ahead }).then(done => {
             S = done.state;
             dlg.close();
             render();
             toast("Generated " + done.created + " duties");
           }, err => dialogError(err.message));
           return false;
         } }]);
    }).catch(err => toast(err.message));
  }

  /* ==================================================================
     importing a staff list

     .xlsx is a ZIP of XML, and the browser can already do both halves —
     DecompressionStream for the deflate, DOMParser for the XML. That is why
     there is no SheetJS here: the CSP is script-src 'self', so a library
     from a CDN would be blocked without a word, and vendoring 900KB to read
     four columns is not a trade worth making.
     ================================================================== */

  const colIndex = ref => {
    let n = 0;
    for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  /* Central directory first, so entry offsets and the compression method are
     read rather than guessed at from the local headers. */
  function unzip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 65558; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("That does not look like an .xlsx file.");

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = {};

    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const size = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const cmtLen = dv.getUint16(off + 32, true);
      const local = dv.getUint32(off + 42, true);
      const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));

      /* The local header repeats the name and extra fields, and its extra
         field is often a different length from the central one. */
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtraLen = dv.getUint16(local + 28, true);
      out[name] = {
        method: method,
        raw: new Uint8Array(buf, local + 30 + lNameLen + lExtraLen, size),
      };
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  function inflate(entry) {
    if (entry.method === 0) return Promise.resolve(new TextDecoder().decode(entry.raw));
    if (typeof DecompressionStream !== "function") {
      return Promise.reject(new Error(
        "This browser cannot unpack .xlsx. Save the sheet as CSV and use that instead."));
    }
    const stream = new Blob([entry.raw]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }

  function readXlsx(buf) {
    const files = unzip(buf);
    const sheet = files["xl/worksheets/sheet1.xml"] ||
      files[Object.keys(files).find(n => n.indexOf("xl/worksheets/") === 0)];
    if (!sheet) throw new Error("No worksheet found in that file.");

    const shared = [];
    const strings = files["xl/sharedStrings.xml"];

    return (strings ? inflate(strings) : Promise.resolve(null))
      .then(xml => {
        if (xml) {
          const doc = new DOMParser().parseFromString(xml, "application/xml");
          doc.querySelectorAll("si").forEach(si => shared.push(
            Array.from(si.querySelectorAll("t")).map(t => t.textContent).join("")));
        }
        return inflate(sheet);
      })
      .then(xml => {
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        const rows = [];
        doc.querySelectorAll("row").forEach(r => {
          const cells = [];
          r.querySelectorAll("c").forEach(c => {
            const i = colIndex((c.getAttribute("r") || "A").replace(/[^A-Z]/g, ""));
            const t = c.getAttribute("t");
            let v;
            if (t === "inlineStr") {
              v = Array.from(c.querySelectorAll("t")).map(x => x.textContent).join("");
            } else {
              const node = c.querySelector("v");
              v = node ? node.textContent : "";
              if (t === "s") v = shared[Number(v)] || "";
            }
            cells[i] = String(v).trim();
          });
          rows.push(cells);
        });
        return rows;
      });
  }

  /* CSV and what Excel puts on the clipboard (tab separated). Quotes are
     honoured so a "Smith, John" or an embedded newline survives. */
  function readDelimited(text) {
    const delim = text.indexOf("\t") > -1 && text.indexOf("\t") <
      (text.indexOf(",") < 0 ? Infinity : text.indexOf(",")) ? "\t" : ",";
    const rows = [];
    let row = [], cell = "", quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(cell.trim()); cell = ""; }
      else if (ch === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
      else if (ch !== "\r") cell += ch;
    }
    row.push(cell.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  /* Matched on the heading, not the position — a roster arrives with its
     columns in whatever order the person who built the sheet liked. */
  const HEADINGS = {
    name: ["name", "fullname", "full name", "employee", "person", "staff", "surname and name"],
    site: ["site", "location", "branch", "office", "base"],
    phone: ["phone", "mobile", "cell", "cellphone", "cellnumber", "number", "contact",
            "telephone", "tel", "msisdn", "contactnumber"],
    department: ["department", "dept", "team", "division", "unit", "bu"],
    role: ["role", "title", "jobtitle", "job title", "position", "designation"],
    email: ["email", "e-mail", "mail", "emailaddress"],
  };

  const normalise = s => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

  function mapHeadings(header) {
    const map = {};
    header.forEach((h, i) => {
      const n = normalise(h);
      if (!n) return;
      for (const field of Object.keys(HEADINGS)) {
        if (map[field] !== undefined) continue;
        const want = HEADINGS[field].map(normalise);
        if (want.indexOf(n) > -1 || want.some(w => n.indexOf(w) > -1)) { map[field] = i; break; }
      }
    });
    return map;
  }

  /* Built against the current roster but written nowhere until Import is
     pressed, so the preview is exactly what will happen. */
  function planImport(rows) {
    if (!rows.length) throw new Error("That sheet is empty.");

    const map = mapHeadings(rows[0]);
    if (map.name === undefined) {
      throw new Error("No Name column found. The first row must be the headings.");
    }

    const byName = new Map(S.people.map(p => [p.name.trim().toLowerCase(), p]));
    const byEmail = new Map(S.people.filter(p => p.email)
      .map(p => [p.email.trim().toLowerCase(), p]));
    /* Matched on the normalised number, so the same person written 082… in
       one sheet and +27 82… in the next is recognised rather than duplicated. */
    const byPhone = new Map(S.people.filter(p => p.phone)
      .map(p => [normalisePhone(p.phone), p]));

    const plan = { map: map, add: [], update: [], skipped: 0, sites: new Set(), tidied: 0 };

    rows.slice(1).forEach(r => {
      const at = f => (map[f] === undefined ? "" : String(r[map[f]] || "").trim());
      const name = at("name");
      if (!name) { plan.skipped++; return; }

      const email = at("email");
      const rawPhone = at("phone");
      const phone = normalisePhone(rawPhone);
      if (rawPhone && phone !== rawPhone) plan.tidied++;

      const existing = (email && byEmail.get(email.toLowerCase())) ||
        (phone && byPhone.get(phone)) ||
        byName.get(name.toLowerCase()) || null;

      const site = at("site");
      if (site && !S.sites.some(s => s.name.toLowerCase() === site.toLowerCase())) {
        plan.sites.add(site);
      }

      const row = {
        id: existing ? existing.id : uuid(),
        name: name,
        role: at("role") || (existing ? existing.role : ""),
        department: at("department") || (existing ? existing.department : ""),
        site: site || (existing ? existing.site : ""),
        phone: phone || (existing ? existing.phone : ""),
        email: email || (existing ? existing.email : ""),
        notes: existing ? existing.notes : "",
        feed: existing ? existing.feed : "",
      };

      (existing ? plan.update : plan.add).push(row);
    });

    return plan;
  }

  function openImport() {
    openDialog("Import people from a spreadsheet",
      "<p>The first row must be the column headings. <b>Name</b> is required; " +
      "<b>Site</b>, <b>Phone</b>, <b>Department</b>, <b>Role</b> and <b>Email</b> are " +
      "picked up when they are there, in any order.</p>" +
      '<div class="field" style="margin-top:1rem">' +
        '<label for="imp-file">Excel or CSV file</label>' +
        '<input id="imp-file" type="file" accept=".xlsx,.csv,text/csv">' +
        '<span class="hint">.xlsx is read directly. Older .xls is not — save it as ' +
        ".xlsx or CSV first.</span></div>" +
      '<div class="field"><label for="imp-paste">&hellip;or paste the rows from Excel</label>' +
        '<textarea id="imp-paste" placeholder="Name&#9;Site&#9;Phone&#9;Department" ' +
        'style="min-height:110px;font-family:var(--mono);font-size:.75rem"></textarea></div>' +
      '<div id="imp-preview"></div>',
      [{ spacer: true }, { label: "Cancel", onClick: () => true },
       { label: "Preview", class: "btn", onClick: () => { previewImport(); return false; } }]);

    $("#imp-file").addEventListener("change", () => previewImport());
  }

  let importPlan = null;

  function previewImport() {
    const file = $("#imp-file").files[0];
    const pasted = $("#imp-paste").value.trim();

    const rowsPromise = file
      ? (/\.csv$/i.test(file.name)
          ? file.text().then(readDelimited)
          : file.arrayBuffer().then(readXlsx))
      : Promise.resolve(pasted ? readDelimited(pasted) : null);

    rowsPromise.then(rows => {
      if (!rows) { dialogError("Choose a file, or paste some rows."); return; }
      importPlan = planImport(rows);
      showPreview();
    }).catch(err => dialogError(err.message));
  }

  function showPreview() {
    const p = importPlan;
    const found = Object.keys(p.map).map(f => f[0].toUpperCase() + f.slice(1));
    const sample = p.add.concat(p.update).slice(0, 8);

    $("#dlg-error").hidden = true;
    $("#imp-preview").innerHTML =
      '<div class="alert alert-success" style="margin-top:1rem">' +
        "Matched columns: <b>" + esc(found.join(", ")) + "</b>.<br>" +
        "<b>" + p.add.length + "</b> to add, <b>" + p.update.length + "</b> to update" +
        (p.sites.size ? ", <b>" + p.sites.size + "</b> new site(s)" : "") +
        (p.skipped ? ", " + p.skipped + " row(s) skipped with no name" : "") + "." +
        (p.tidied ? "<br>" + p.tidied + " phone number(s) tidied to +" + DIAL_CC() +
          " form." : "") +
      "</div>" +
      (sample.length ? '<div class="table-wrap"><table><thead><tr>' +
        "<th>Name</th><th>Department</th><th>Site</th><th>Phone</th></tr></thead><tbody>" +
        sample.map(r => "<tr><td>" + esc(r.name) + "</td><td>" + esc(r.department) +
          "</td><td>" + esc(r.site) + '</td><td class="mono">' + esc(formatPhone(r.phone)) +
          "</td></tr>").join("") +
        "</tbody></table></div>" +
        (p.add.length + p.update.length > 8
          ? '<p class="text-muted">…and ' + (p.add.length + p.update.length - 8) +
            " more.</p>" : "")
        : "");

    const foot = $("#dlg-foot");
    foot.innerHTML = "";
    [{ spacer: true },
     { label: "Cancel", onClick: () => true },
     { label: "Import " + (p.add.length + p.update.length) + " people", class: "btn",
       onClick: () => { commitImport(); return true; } }].forEach(b => {
      if (b.spacer) {
        const s = document.createElement("span");
        s.className = "spacer";
        foot.appendChild(s);
        return;
      }
      const el = document.createElement("button");
      el.type = "button";
      el.className = "btn " + (b.class || "btn-secondary");
      el.textContent = b.label;
      el.disabled = !(p.add.length + p.update.length);
      el.addEventListener("click", () => { if (b.onClick() !== false) dlg.close(); });
      foot.appendChild(el);
    });
  }

  function commitImport() {
    const p = importPlan;
    if (!p) return;

    mutate("Imported " + p.add.length + " new and " + p.update.length +
      " updated people from a spreadsheet", () => {
      /* Sites first: a person naming one that does not exist yet is the
         common case in a fresh sheet. Only when this account may write them —
         the server refuses the whole change set otherwise. */
      if (can("sites.write")) {
        p.sites.forEach(name => { S.sites = S.sites.concat([{ id: uuid(), name: name }]); });
      }

      const changed = new Map(p.add.concat(p.update).map(r => [r.id, r]));
      S.people = S.people.map(x => changed.get(x.id) || x)
        .concat(p.add.filter(r => !S.people.some(x => x.id === r.id)));
    });

    importPlan = null;
    toast("Imported " + (p.add.length + p.update.length) + " people");
  }

  /* ==================================================================
     chrome
     ================================================================== */

  const TABS = [
    { id: "today", label: "Today" },
    { id: "handover", label: "Handover", need: "handover.read", badge: () => handoversOpen },
    { id: "schedule", label: "Calendar" },
    { id: "directory", label: "Directory" },
    { id: "sites", label: "Sites" },
    { id: "rotations", label: "Rotations", need: "rotations.write" },
    { id: "escalation", label: "Escalation" },
    { id: "reports", label: "Reports", need: "reports.read" },
    { id: "accounts", label: "Accounts", need: "users.write" },
  ];

  function drawSidebar() {
    const nav = $("#sidebar");
    const add = [
      can("calls.write") ? '<button class="btn" type="button" id="go-call">Log a call</button>' : "",
      can("handover.write") ? '<button class="btn btn-secondary" type="button" ' +
        'id="go-handover">Leave a handover</button>' : "",
      can("shift.report") ? '<button class="btn btn-secondary" type="button" ' +
        'id="go-shift">Shift report</button>' : "",
      can("duties.write") ? '<button class="btn btn-secondary" type="button" id="go-duty">Add duty</button>' : "",
      can("people.write") ? '<button class="btn btn-secondary" type="button" id="go-person">Add person</button>' : "",
      can("people.write") ? '<button class="btn btn-secondary" type="button" id="go-import">Import people</button>' : "",
    ].join("");

    const data = [
      can("data.export") ? '<button class="tab" type="button" id="go-feeds">Calendar links</button>' : "",
      can("history.read") ? '<button class="tab" type="button" id="go-history">History</button>' : "",
      '<button class="tab" type="button" id="go-print">Print</button>',
    ].join("");

    nav.innerHTML =
      '<div class="views" role="tablist" aria-orientation="vertical" aria-label="Views">' +
        TABS.filter(t => !t.need || can(t.need))
          .map(t => {
            /* A count in the tab, so an open handover is visible from
               whichever view somebody happens to be sitting on. */
            const n = t.badge ? t.badge() : 0;
            return '<button class="tab' + (t.id === view ? " active" : "") +
              '" type="button" role="tab" id="tab-' + t.id + '" data-view="' + t.id + '"' +
              ' aria-selected="' + (t.id === view) + '"' +
              ' aria-controls="content"' +
              ' tabindex="' + (t.id === view ? "0" : "-1") + '">' + t.label +
              (n ? ' <span class="tab-count" aria-label="' + n +
                ' waiting">' + n + "</span>" : "") + "</button>";
          }).join("") +
      "</div>" +
      (add ? '<div class="sidebar-sep"></div><p class="sidebar-label" id="lbl-add">Add</p>' +
        '<div role="group" aria-labelledby="lbl-add">' + add + "</div>" : "") +
      '<div class="sidebar-spacer"></div><div class="sidebar-sep"></div>' +
      '<p class="sidebar-label" id="lbl-data">Data</p>' +
      '<div role="group" aria-labelledby="lbl-data">' + data + "</div>";

    nav.hidden = false;
  }

  /* Tables are built as HTML strings all over this file; setting scope here
     rather than in every template keeps it from being forgotten in one. */
  function labelTables(root) {
    root.querySelectorAll("th").forEach(th => th.setAttribute("scope", "col"));
  }

  /* The whole page is built by one function, so an exception inside a view
     would otherwise leave a blank screen with no way to navigate off it. The
     sidebar is drawn first and separately for the same reason: whatever the
     view does, there is always a way out of it. */
  function render() {
    try {
      drawSidebar();
    } catch (err) {
      console.error("sidebar failed", err);
    }

    const content = $("#content");
    content.setAttribute("aria-labelledby", "tab-" + view);

    try {
      content.innerHTML = (VIEWS[view] || VIEWS.today)();
      labelTables(content);
    } catch (err) {
      console.error("view failed: " + view, err);
      content.innerHTML =
        '<div class="alert alert-error"><b>This view could not be drawn.</b><br>' +
        esc(err && err.message ? err.message : String(err)) +
        "<br><br>The data is safe — nothing has been changed. Try another view, " +
        "or reload. If it keeps happening, the details are in the browser console." +
        "</div>";
    }
  }

  function applyAccount(me) {
    ME = me;
    ME.can = me.can || [];

    /* Cleared before adding: otherwise whatever the last account could do
       stays on the body. */
    Array.prototype.slice.call(document.body.classList).forEach(c => {
      if (c.indexOf("can-") === 0) document.body.classList.remove(c);
    });
    ME.can.forEach(c => document.body.classList.add("can-" + c.replace(/\./g, "-")));

    $("#header-user-name").textContent = me.name || me.user || "Account";
    $("#header-user-name").title = me.user + " — " + me.role +
      (me.pinned ? " (set in config.php)" : "");
    $("#header-user").hidden = false;
  }

  /* ==================================================================
     events
     ================================================================== */

  $("#btn-signout").addEventListener("click", () => {
    const done = () => { api.forgetCsrf(); window.location.replace("login.html?out=1"); };
    api("POST", "logout").then(done, done);
  });

  $("#btn-password").addEventListener("click", () => openPassword(false));

  $("#conn-retry").addEventListener("click", () => {
    $("#conn-retry").disabled = true;
    load()
      .then(() => toast("Reloaded from the server"))
      .catch(err => toast(err.message))
      .then(() => { $("#conn-retry").disabled = false; });
  });

  const CLICKABLE = "[data-view],[data-day],[data-dial],[data-log-call],[data-edit-call]," +
    "[data-edit-person],[data-edit-duty],[data-cover],[data-leave],[data-drop-leave]," +
    "[data-rename-site],[data-remove-site],[data-edit-account]," +
    "[data-add-esc],[data-edit-esc],[data-drop-esc],[data-edit-rot],[data-run-rot]," +
    "[data-feed-rotate],[data-feed-revoke],[data-mfa-reset]," +
    "[data-ho-ack],[data-ho-note],[data-ho-edit],[data-ho-close],[data-ho-open]," +
    "#go-call,#go-duty,#go-person,#go-import,#go-feeds,#go-history,#go-print," +
    "#go-handover,#go-shift,#ho-add,#sr-add,#hub-open,#hub-all," +
    "#cal-prev,#cal-next,#cal-today,#site-add,#acct-add,#rep-export,#dir-export,#rot-add";

  /* One listener rather than rebinding after every render. */
  document.addEventListener("click", e => {
    const el = e.target.closest ? e.target.closest(CLICKABLE) : null;
    if (!el) return;
    const attr = n => el.getAttribute(n);

    if (attr("data-view")) { view = attr("data-view"); render(); return; }

    /* No preventDefault: the anchor's own sip: href is what dials, and the
       click's user activation is what browsers require before handing the
       page to an external protocol. This only arms the fallback. */
    if (attr("data-dial")) { armDial(attr("data-dial")); return; }

    if (attr("data-day")) { openDay(attr("data-day")); return; }
    if (attr("data-log-call")) { openCall(attr("data-log-call"), null); return; }
    if (attr("data-edit-call")) { openCall(null, attr("data-edit-call")); return; }
    if (attr("data-edit-person")) { openPerson(attr("data-edit-person")); return; }
    if (attr("data-edit-duty")) { openDuty(attr("data-edit-duty")); return; }
    if (attr("data-cover")) { openCover(attr("data-cover")); return; }
    if (attr("data-leave")) { openLeave(attr("data-leave")); return; }
    if (attr("data-drop-leave")) {
      const id = attr("data-drop-leave");
      const l = S.leave.find(x => x.id === id);
      if (l) {
        const pid = l.personId;
        mutate("Removed leave for " + personName(pid),
          () => { S.leave = S.leave.filter(x => x.id !== id); });
        dlg.close();
        openLeave(pid);
      }
      return;
    }
    if (attr("data-add-esc")) { openEscalation(null, attr("data-add-esc")); return; }
    if (attr("data-edit-esc")) { openEscalation(attr("data-edit-esc"), null); return; }
    if (attr("data-drop-esc")) {
      const id = attr("data-drop-esc");
      mutate("Removed an escalation step",
        () => { S.escalations = S.escalations.filter(x => x.id !== id); });
      return;
    }
    if (attr("data-edit-rot")) { openRotation(attr("data-edit-rot")); return; }
    if (attr("data-run-rot")) { runRotation(attr("data-run-rot"), 12); return; }
    if (attr("data-rename-site")) { openSite(attr("data-rename-site")); return; }
    if (attr("data-remove-site")) { removeSite(attr("data-remove-site")); return; }
    if (attr("data-edit-account")) {
      const u = (accounts || []).find(x => x.id === attr("data-edit-account"));
      if (u) openAccount(u);
      return;
    }
    if (attr("data-feed-rotate")) { rotateFeed(attr("data-feed-rotate")); return; }
    if (attr("data-feed-revoke")) { revokeFeed(attr("data-feed-revoke")); return; }
    if (attr("data-mfa-reset")) {
      const u = (accounts || []).find(x => x.id === attr("data-mfa-reset"));
      if (u) adminResetMfa(u);
      return;
    }
    if (attr("data-ho-ack")) { ackHandover(attr("data-ho-ack")); return; }
    if (attr("data-ho-note")) { openHandoverNote(attr("data-ho-note")); return; }
    if (attr("data-ho-edit")) { openHandover(attr("data-ho-edit")); return; }
    if (attr("data-ho-close")) { setHandoverStatus(attr("data-ho-close"), "closed"); return; }
    if (attr("data-ho-open")) { setHandoverStatus(attr("data-ho-open"), "open"); return; }

    switch (el.id) {
      case "go-call": openCall(S.people.length ? S.people[0].id : null, null); break;
      case "go-duty": openDuty(null); break;
      case "go-person": openPerson(null); break;
      case "go-import": openImport(); break;
      case "go-feeds": openFeeds(); break;
      case "go-history": openHistory(); break;
      case "go-print": window.print(); break;
      case "go-handover": openHandover(null); break;
      case "go-shift": openShiftReport(); break;
      case "ho-add": openHandover(null); break;
      case "sr-add": openShiftReport(); break;
      case "hub-open": hubFilter = "open"; render(); break;
      case "hub-all": hubFilter = "all"; render(); break;
      case "site-add": openSite(null); break;
      case "rot-add": openRotation(null); break;
      case "acct-add": openAccount(null); break;
      case "rep-export": exportCalls(); break;
      case "dir-export": exportDirectory(); break;
      case "cal-prev":
        calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } render(); break;
      case "cal-next":
        calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } render(); break;
      case "cal-today":
        calMonth = new Date().getMonth(); calYear = new Date().getFullYear(); render(); break;
    }
  });

  /* A role of button or tab is a promise about the keyboard, so it has to be
     kept: Enter and Space open a calendar day, and the arrow keys walk the
     tablist the way a real one behaves. */
  document.addEventListener("keydown", e => {
    const day = e.target.closest ? e.target.closest("[data-day]") : null;
    if (day && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openDay(day.getAttribute("data-day"));
      return;
    }

    const tab = e.target.closest ? e.target.closest('[role="tab"]') : null;
    if (!tab) return;

    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    const step = keys[e.key];
    if (!step && e.key !== "Home" && e.key !== "End") return;

    e.preventDefault();
    const tabs = Array.prototype.slice.call(document.querySelectorAll('#sidebar [role="tab"]'));
    const at = tabs.indexOf(tab);
    const next = e.key === "Home" ? tabs[0]
      : e.key === "End" ? tabs[tabs.length - 1]
        : tabs[(at + step + tabs.length) % tabs.length];

    if (next) { view = next.getAttribute("data-view"); render(); $("#tab-" + view).focus(); }
  });

  /* Re-rendering replaces the box, so the caret has to be put back. */
  document.addEventListener("input", e => {
    if (e.target.id !== "dir-search") return;
    search = e.target.value;
    render();
    const box = $("#dir-search");
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  });

  document.addEventListener("change", e => {
    if (e.target.id === "site-filter") { siteFilter = e.target.value; render(); return; }

    /* Redrawing the preview with a different horizon is a fresh round trip,
       so the select re-enters runRotation rather than filtering in place. */
    if (e.target.id === "rot-weeks") {
      dlg.close();
      runRotation(e.target.getAttribute("data-rot-weeks"), Number(e.target.value));
      return;
    }

    /* An inverted range silently reports on nothing, which reads as "we had a
       quiet month". The dates are swapped instead, and it says so. */
    if (e.target.id === "rep-from" || e.target.id === "rep-to") {
      if (e.target.id === "rep-from") repFrom = e.target.value;
      else repTo = e.target.value;

      if (repFrom && repTo && repFrom > repTo) {
        const t = repFrom; repFrom = repTo; repTo = t;
        toast("Those dates were the wrong way round, so they have been swapped.");
      }
      render();
    }
  });

  /* Ring through the softphone — MicroSIP, on the sip: scheme it registers on
     Windows — falling back to the clipboard if nothing took the number. 1.5s
     so the browser's "Open MicroSIP?" prompt has time to be answered, and
     hasFocus() catches the case where it never blurred us. */
  function armDial(num) {
    const app = dial().scheme === "sip" ? "MicroSIP" : "The dialler";

    let handedOff = false;
    const note = () => { handedOff = true; };
    window.addEventListener("blur", note);
    document.addEventListener("visibilitychange", note);

    setTimeout(() => {
      window.removeEventListener("blur", note);
      document.removeEventListener("visibilitychange", note);
      if (handedOff || !document.hasFocus()) return;

      /* navigator.clipboard is undefined on plain HTTP, so this has to be
         checked rather than relied on to reject — the number is still worth
         showing when it cannot be copied. */
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        toast(app + " did not open. The number is " + num + ".");
        return;
      }
      navigator.clipboard.writeText(num).then(
        () => toast(app + " did not open. " + num + " copied instead."),
        () => toast(app + " did not open. The number is " + num + "."));
    }, 1500);
  }

  /* ==================================================================
     boot
     ================================================================== */

  api("GET", "me").then(res => {
    if (!res.authenticated) { window.location.replace("login.html"); return; }

    applyAccount(res.user);

    return load().then(() => {
      if (ME.mustChangePassword) openPassword(true);

      /* The roster is shared, so a copy left open goes stale. Poll the
         version and reload only when it has actually moved. */
      setInterval(() => {
        if (saving) return;
        api("GET", "version")
          .then(v => {
            markReachable(true);

            /* The open-handover count rides along on the same poll, so the
               nav can say something is waiting without anybody opening the
               tab. Redrawn only when the number actually changes. */
            if (typeof v.handoversOpen === "number" && v.handoversOpen !== handoversOpen) {
              handoversOpen = v.handoversOpen;
              if (!dlg.open) {
                if (view === "handover") { loadHub(); } else { drawSidebar(); }
              }
            }

            /* Not while a dialog is open: reloading under somebody's hands
               would replace the roster they are part-way through editing. */
            if (v.version !== S.version && !dlg.open) load();
          })
          .catch(err => { if (err.status === 0) markReachable(false); });
      }, 20000);
    });
  }).catch(err => {
    $("#content").innerHTML = '<div class="alert alert-error">' + esc(err.message) + "</div>";
  });
})();
