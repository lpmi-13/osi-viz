/* ============================================================
   app.js — state, rendering, and all controls.
   Depends on window.OSI (data.js).
   ============================================================ */
(function () {
  "use strict";
  const D = window.OSI;
  const $ = function (sel) { return document.querySelector(sel); };

  // ---------- geometry ----------
  const LX = 22, RX = 78, TY = 26, BY = 66, UNDER = 80;
  // Each step belongs to a segment 1-6 of the round-trip path. The block travels
  // the U forward (request, 1→3) and, on a round trip, back again (response, 4→6).
  const SEG = {
    1: [[LX, TY], [LX, BY]],       // request: down the client (left) leg
    2: [[LX, UNDER], [RX, UNDER]], // request: across the underlay →
    3: [[RX, BY], [RX, TY]],       // request: up the server (right) leg
    4: [[RX, TY], [RX, BY]],       // response: down the server (right) leg
    5: [[RX, UNDER], [LX, UNDER]], // response: across the underlay ←
    6: [[LX, BY], [LX, TY]]        // response: up the client (left) leg
  };
  function computeAnchors(steps) {
    return steps.map(function (s) {
      const st = SEG[s.seg][0], en = SEG[s.seg][1], f = s.frac;
      return { x: st[0] + (en[0] - st[0]) * f, y: st[1] + (en[1] - st[1]) * f };
    });
  }

  // ---------- state ----------
  const state = {
    mode: "explore",
    tls: true, crossNode: true, roundTrip: false, handshake: false,
    highlightReaders: false, showTool: false, reduceMotion: false,
    playing: false, speed: 1, progress: 0, _last: 0,
    payload: D.newPayload(),
    responsePayload: D.newResponse(),
    steps: [], anchors: [],
    scenario: null, broken: false, revealed: false, lastIdx: -1
  };
  function payloadFor(step) {
    if (step.ctl) return { bytes: 0, text: step.ctl, ctl: true };
    return step.dir === "resp" ? state.responsePayload : state.payload;
  }

  // ---------- element refs ----------
  const stage = $("#stage");
  const block = $("#block");
  const shellEls = {};
  ["vxlan", "ip", "tcp", "tls", "http", "body"].forEach(function (k) {
    shellEls[k] = block.querySelector('[data-layer="' + k + '"]');
  });
  const coreText = block.querySelector(".core-text");
  const readerCallout = $("#reader-callout");
  const failBurst = $("#failure-burst");
  const podSend = $("#pod-send"), podRecv = $("#pod-recv");
  const podSendState = $("#pod-send-state"), podRecvState = $("#pod-recv-state");
  const uProgress = $("#u-progress");
  const uLen = uProgress.getTotalLength();
  uProgress.style.strokeDasharray = uLen;

  const live = $("#live");

  // ---------- step building ----------
  function rebuildSteps(keepRatio) {
    const ratio = keepRatio ? state.progress : 0;
    if (state.mode === "explore") {
      state.steps = D.buildSteps({ tls: state.tls, crossNode: state.crossNode, roundTrip: state.roundTrip, handshake: state.handshake });
      state.broken = false;
    } else {
      const sc = state.scenario;
      const all = D.buildSteps(sc.opts);
      let cut = all.length - 1;
      for (let i = 0; i < all.length; i++) { if (all[i].id === sc.breakId) { cut = i; break; } }
      state.steps = all.slice(0, cut + 1);
      state.broken = true;
      state.tls = sc.opts.tls; state.crossNode = sc.opts.crossNode;
      state.payload = { bytes: sc.payload.bytes, text: sc.payload.text };
    }
    state.anchors = computeAnchors(state.steps);
    state.progress = Math.min(1, Math.max(0, ratio));
    state.lastIdx = -1;
  }

  function N() { return state.steps.length; }
  function stepFloat() { return state.progress * (N() - 1); }
  function currentIdx() { return Math.round(stepFloat()); }

  // ---------- byte / purity maths ----------
  function bytesFor(layer, pb) { return layer === "body" ? pb : D.SIZES[layer]; }
  function purity(shells, pb) {
    let total = 0;
    shells.forEach(function (l) { total += bytesFor(l, pb); });
    return { total: total, signalPct: (pb / total) * 100 };
  }

  // ---------- rendering ----------
  function render() {
    const steps = state.steps, n = N();
    const sf = stepFloat();
    const i0 = Math.max(0, Math.floor(sf));
    const i1 = Math.min(n - 1, i0 + 1);
    const f = sf - i0;
    const a0 = state.anchors[i0], a1 = state.anchors[i1];
    const x = a0.x + (a1.x - a0.x) * f;
    const y = a0.y + (a1.y - a0.y) * f;
    block.style.left = x + "%";
    block.style.top = y + "%";

    const idx = currentIdx();
    const step = steps[idx];
    const meta = D.STEP[step.id];
    const atBreak = state.broken && idx === n - 1;
    // A failed operation never completes, so the packet stays in the state it
    // entered the breaking step in (still wrapped / still sealed).
    const shellStep = (atBreak && idx > 0) ? steps[idx - 1] : step;
    const outer = shellStep.shells[shellStep.shells.length - 1];
    const pl = payloadFor(step);

    // shells present / fields / dim / cipher
    ["vxlan", "ip", "tcp", "tls", "http", "body"].forEach(function (layer) {
      const el = shellEls[layer];
      const present = shellStep.shells.indexOf(layer) !== -1;
      el.classList.toggle("present", present);
      const dim = state.highlightReaders && present && layer !== outer;
      el.classList.toggle("dimmed", dim);
      if (layer !== "body") {
        const fEl = el.querySelector(":scope > .fields");
        if (fEl) fEl.textContent = present && D.FIELDS[layer] ? D.FIELDS[layer](shellStep) : "";
      }
    });
    coreText.textContent = pl.text;
    block.classList.toggle("ciphered", shellStep.ciphered && !pl.ctl);
    block.classList.toggle("control", !!pl.ctl);

    // endpoints — the left leg is always the client, the right leg the server
    podSend.classList.toggle("active", step.leg === "L");
    podRecv.classList.toggle("active", step.leg === "R");

    // TCP connection-state badges (only while the handshake is in play)
    if (state.handshake) {
      const st = step.state || { c: "ESTABLISHED", s: "ESTABLISHED" };
      podSendState.hidden = false; podRecvState.hidden = false;
      podSendState.textContent = st.c; podRecvState.textContent = st.s;
    } else {
      podSendState.hidden = true; podRecvState.hidden = true;
    }

    // reader callout
    if (state.highlightReaders && !(state.broken && idx === n - 1)) {
      readerCallout.hidden = false;
      readerCallout.innerHTML = "<b>" + meta.reader.who + "</b> reads: " + meta.reader.sees;
      let cx = x, cy = y, tf = "translate(-50%,-100%)";
      if (step.leg === "L") { cx = x + 9; tf = "translate(0,-50%)"; }
      else if (step.leg === "R") { cx = x - 9; tf = "translate(-100%,-50%)"; }
      else { cy = y - 13; }
      readerCallout.style.left = cx + "%";
      readerCallout.style.top = cy + "%";
      readerCallout.style.transform = tf;
    } else {
      readerCallout.hidden = true;
    }

    // failure burst
    if (atBreak) {
      failBurst.hidden = false;
      failBurst.style.left = x + "%";
      failBurst.style.top = y + "%";
      failBurst.innerHTML = '<span class="bolt">⚡</span>' + (state.scenario ? state.scenario.failLabel : "drop");
      block.style.opacity = 0.45;
    } else {
      failBurst.hidden = true;
      block.style.opacity = 1;
    }

    // u-progress
    uProgress.style.strokeDashoffset = uLen * (1 - state.progress);

    renderPanel(step, meta, idx, n, atBreak, shellStep, pl);

    // scrubber + labels
    const scrubber = $("#scrubber");
    if (document.activeElement !== scrubber) scrubber.value = Math.round(state.progress * 1000);
    $("#scrub-label").textContent = "Step " + (idx + 1) + " / " + n;

    // announce on step change
    if (idx !== state.lastIdx) {
      const p = purity(shellStep.shells, pl.bytes);
      live.textContent = "Step " + (idx + 1) + " of " + n + ". " + meta.title +
        ". Signal purity " + Math.round(p.signalPct) + " percent.";
      state.lastIdx = idx;
    }
  }

  function renderPanel(step, meta, idx, n, atBreak, shellStep, pl) {
    $("#step-layer-chip").textContent = meta.chip;
    const phaseLabel = step.phase === "hs" ? " · handshake"
      : step.dir === "resp" ? " · response"
      : ((state.roundTrip || state.handshake) ? " · request" : "");
    $("#step-counter").textContent = "Step " + (idx + 1) + " / " + n + phaseLabel;
    $("#step-title").textContent = meta.title;
    $("#step-why").textContent = meta.why;

    // purity (reflects the packet's actual on-wire state)
    const p = purity(shellStep.shells, pl.bytes);
    const sig = Math.round(p.signalPct);
    $("#purity-pct").textContent = sig + "%";
    $("#purity-signal").textContent = sig + "%";
    $("#purity-meta").textContent = (100 - sig) + "%";
    $("#purity-bytes").textContent = p.total.toLocaleString() + " bytes total · " +
      pl.bytes.toLocaleString() + " B payload";
    $("#purity-meter").style.background =
      "conic-gradient(var(--l-body) 0% " + sig + "%, var(--muted-2) " + sig + "% 100%)";

    // stack bar (outer→inner reading, but drawn body-first)
    const bar = $("#stack-bar");
    bar.innerHTML = "";
    const order = shellStep.shells.slice(); // inner→outer
    order.forEach(function (layer) {
      const seg = document.createElement("span");
      const b = bytesFor(layer, pl.bytes);
      seg.style.width = (b / p.total * 100) + "%";
      seg.style.background = "var(" + D.LAYERS[layer].varColor + ")";
      seg.title = D.LAYERS[layer].name + ": " + b.toLocaleString() + " B";
      bar.appendChild(seg);
    });

    // anatomy (outer→inner)
    const list = $("#anatomy-list");
    list.innerHTML = "";
    shellStep.shells.slice().reverse().forEach(function (layer) {
      const L = D.LAYERS[layer];
      const li = document.createElement("li");
      if (layer === "body") li.className = "is-body";
      const isCtl = layer === "body" && pl.ctl;
      const name = isCtl ? "Control" : L.name;
      const desc = isCtl ? pl.text + " flag — no data" : L.desc;
      li.innerHTML =
        '<span class="swatch" style="background:var(' + L.varColor + ')"></span>' +
        '<span><span class="aname">' + name + '</span> ' +
        '<span class="adesc">— ' + desc + '</span></span>' +
        '<span class="abytes">' + bytesFor(layer, pl.bytes).toLocaleString() + ' B</span>';
      list.appendChild(li);
    });

    // tool output
    const toolCard = $("#tool-card");
    if (state.showTool) {
      toolCard.hidden = false;
      let t = meta.tool;
      if (atBreak && state.scenario) t = state.scenario.tool;
      let out = t.out;
      if ((step.id === "body" || step.id === "r-body") && !out) {
        out = pl.text + "\n\n# " + pl.bytes.toLocaleString() + " bytes of actual intent";
      }
      $("#tool-cmd").textContent = "$ " + t.cmd;
      $("#tool-out").textContent = out || "";
    } else {
      toolCard.hidden = true;
    }

    // diagnose verdict
    if (state.mode === "diagnose") {
      const verdict = $("#verdict");
      if (state.revealed || atBreak) {
        const v = state.scenario.verdict, t = state.scenario.tool;
        verdict.hidden = false;
        verdict.innerHTML =
          "<h4>Diagnosis</h4>" +
          '<p class="sym">Symptom: ' + v.symptom + "</p>" +
          "<p>" + v.cause + "</p>" +
          '<p class="fix">Fix: ' + v.fix + "</p>" +
          '<div class="term"><div class="term-cmd">$ ' + t.cmd + '</div><pre class="term-out">' +
          escapeHtml(t.out) + "</pre></div>";
      } else {
        verdict.hidden = true;
      }
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
  }

  // ---------- progress control ----------
  function setProgress(p) {
    state.progress = Math.min(1, Math.max(0, p));
    render();
  }
  function gotoStep(i) {
    const n = N();
    i = Math.min(n - 1, Math.max(0, i));
    setProgress(n > 1 ? i / (n - 1) : 0);
  }
  function stepBy(dir) { pause(); gotoStep(currentIdx() + dir); }

  // ---------- playback ----------
  function loop(ts) {
    if (!state.playing) return;
    if (!state._last) state._last = ts;
    const dt = (ts - state._last) / 1000;
    state._last = ts;
    const n = N();
    const rate = (0.9 * state.speed) / Math.max(1, n - 1);
    let np = state.progress + dt * rate;
    if (np >= 1) { np = 1; state.playing = false; updatePlayBtn(); }
    setProgress(np);
    if (state.playing) requestAnimationFrame(loop);
  }
  function play() {
    if (state.progress >= 1) state.progress = 0;
    state.playing = true; state._last = 0; updatePlayBtn();
    requestAnimationFrame(loop);
  }
  function pause() { if (state.playing) { state.playing = false; updatePlayBtn(); } }
  function updatePlayBtn() { $("#btn-play").textContent = state.playing ? "⏸" : "▶"; }

  // ---------- mode / scenario ----------
  function setMode(mode) {
    state.mode = mode;
    $("#mode-explore").setAttribute("aria-selected", mode === "explore");
    $("#mode-diagnose").setAttribute("aria-selected", mode === "diagnose");
    $("#diagnose-card").hidden = mode !== "diagnose";

    const scenarioDriven = mode === "diagnose";
    ["tg-tls", "tg-cross", "tg-roundtrip", "tg-handshake", "btn-newpacket"].forEach(function (id) {
      $("#" + id).disabled = scenarioDriven;
    });

    if (mode === "diagnose") {
      if (!state.scenario) loadScenario(D.SCENARIOS[0].key);
      else loadScenario(state.scenario.key);
    } else {
      state.payload = D.newPayload();
      rebuildSteps(false);
      syncToggles();
      render();
    }
  }

  function loadScenario(key) {
    const sc = D.SCENARIOS.filter(function (s) { return s.key === key; })[0];
    state.scenario = sc;
    state.revealed = false;
    rebuildSteps(false);
    syncToggles();
    buildQuiz();
    $("#verdict").hidden = true;
    render();
  }

  function buildQuiz() {
    const q = state.scenario.quiz;
    const wrap = $("#quiz-options");
    wrap.innerHTML = "";
    q.options.forEach(function (opt) {
      const b = document.createElement("button");
      b.className = "quiz-opt";
      b.textContent = opt;
      b.addEventListener("click", function () {
        if (state.revealed) return;
        Array.prototype.forEach.call(wrap.children, function (c) {
          if (c.textContent === q.answer) c.classList.add("correct");
        });
        if (opt !== q.answer) b.classList.add("wrong");
        state.revealed = true;
        render();
      });
      wrap.appendChild(b);
    });
    $("#quiz").hidden = false;
  }

  function syncToggles() {
    $("#tg-tls").setAttribute("aria-pressed", state.tls);
    $("#tg-cross").setAttribute("aria-pressed", state.crossNode);
    $("#tg-roundtrip").setAttribute("aria-pressed", state.roundTrip);
    $("#tg-handshake").setAttribute("aria-pressed", state.handshake);
    $("#tg-readers").setAttribute("aria-pressed", state.highlightReaders);
    $("#tg-tool").setAttribute("aria-pressed", state.showTool);
    $("#tg-motion").setAttribute("aria-pressed", state.reduceMotion);
  }

  // ---------- wiring ----------
  function bind() {
    $("#btn-first").addEventListener("click", function () { stepBy(-currentIdx()); });
    $("#btn-last").addEventListener("click", function () { pause(); gotoStep(N() - 1); });
    $("#btn-prev").addEventListener("click", function () { stepBy(-1); });
    $("#btn-next").addEventListener("click", function () { stepBy(1); });
    $("#btn-play").addEventListener("click", function () { state.playing ? pause() : play(); });

    $("#scrubber").addEventListener("input", function (e) {
      pause(); setProgress(parseInt(e.target.value, 10) / 1000);
    });
    $("#speed").addEventListener("change", function (e) { state.speed = parseFloat(e.target.value); });

    // toggles
    $("#tg-tls").addEventListener("click", function () {
      state.tls = !state.tls; syncToggles(); rebuildSteps(true); render();
    });
    $("#tg-cross").addEventListener("click", function () {
      state.crossNode = !state.crossNode; syncToggles(); rebuildSteps(true); render();
    });
    $("#tg-roundtrip").addEventListener("click", function () {
      state.roundTrip = !state.roundTrip; syncToggles(); rebuildSteps(true); render();
    });
    $("#tg-handshake").addEventListener("click", function () {
      state.handshake = !state.handshake; syncToggles(); rebuildSteps(true); render();
    });
    $("#tg-readers").addEventListener("click", function () {
      state.highlightReaders = !state.highlightReaders; syncToggles(); render();
    });
    $("#tg-tool").addEventListener("click", function () {
      state.showTool = !state.showTool; syncToggles(); render();
    });
    $("#tg-motion").addEventListener("click", function () {
      state.reduceMotion = !state.reduceMotion;
      document.body.classList.toggle("reduce-motion", state.reduceMotion);
      syncToggles();
    });
    $("#btn-newpacket").addEventListener("click", function () {
      state.payload = D.newPayload(); state.responsePayload = D.newResponse(); render();
    });

    // modes
    $("#mode-explore").addEventListener("click", function () { setMode("explore"); });
    $("#mode-diagnose").addEventListener("click", function () { setMode("diagnose"); });
    $("#scenario-select").addEventListener("change", function (e) { loadScenario(e.target.value); });

    $("#quiz-reveal").addEventListener("click", function () { state.revealed = true; render(); });

    // block click → draw attention to anatomy
    block.addEventListener("click", function () {
      const card = document.querySelector(".anatomy-card");
      card.scrollIntoView({ behavior: state.reduceMotion ? "auto" : "smooth", block: "nearest" });
      card.animate([{ boxShadow: "0 0 0 2px var(--accent)" }, { boxShadow: "0 0 0 0 transparent" }],
        { duration: 700 });
    });

    // wheel = advance (horizontal or vertical), the requested scroll interaction
    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      pause();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setProgress(state.progress + d * 0.0009);
    }, { passive: false });

    // touch: horizontal swipe advances; vertical is left to the page (touch-action: pan-y)
    let tx = null, ty = null, tp = 0, swiping = false;
    stage.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) { tx = null; return; }
      tx = e.touches[0].clientX; ty = e.touches[0].clientY; tp = state.progress; swiping = false;
    }, { passive: true });
    stage.addEventListener("touchmove", function (e) {
      if (tx === null) return;
      const dx = e.touches[0].clientX - tx;
      const dy = e.touches[0].clientY - ty;
      if (!swiping) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) { swiping = true; pause(); }
        else if (Math.abs(dy) > 8) { tx = null; return; } // vertical → let the page scroll
        else return;
      }
      e.preventDefault();
      setProgress(tp + dx / (stage.clientWidth || 320));
    }, { passive: false });
    stage.addEventListener("touchend", function () { tx = null; swiping = false; }, { passive: true });

    // keyboard
    document.addEventListener("keydown", function (e) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); stepBy(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); stepBy(-1); }
      else if (e.key === " ") { e.preventDefault(); state.playing ? pause() : play(); }
      else if (e.key === "Home") { e.preventDefault(); pause(); gotoStep(0); }
      else if (e.key === "End") { e.preventDefault(); pause(); gotoStep(N() - 1); }
    });

    // help dialog
    const dlg = $("#help-dialog");
    function openHelp() { dlg.hidden = false; $("#help-start").focus(); }
    function closeHelp() { dlg.hidden = true; stage.focus(); }
    $("#help-btn").addEventListener("click", openHelp);
    $("#help-close").addEventListener("click", closeHelp);
    $("#help-start").addEventListener("click", closeHelp);
    dlg.addEventListener("click", function (e) { if (e.target === dlg) closeHelp(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !dlg.hidden) closeHelp(); });
  }

  // ---------- init ----------
  function init() {
    // honour OS reduced-motion preference on first load
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      state.reduceMotion = true;
      document.body.classList.add("reduce-motion");
    }
    // position decorative lane guides by their data-y
    document.querySelectorAll(".lane").forEach(function (l) { l.style.top = l.dataset.y + "%"; });
    // populate scenario select
    const sel = $("#scenario-select");
    D.SCENARIOS.forEach(function (s) {
      const o = document.createElement("option");
      o.value = s.key; o.textContent = s.label; sel.appendChild(o);
    });
    bind();
    rebuildSteps(false);
    syncToggles();
    render();
    // first-run guide
    $("#help-dialog").hidden = false;
  }

  document.addEventListener("DOMContentLoaded", init);
})();
