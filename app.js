/* ============================================================
   app.js — OSI Viz. A static "encapsulation anatomy": every layer
   wrapping one request is shown at once, coloured consistently, each
   with a plain-language caption. A proportion bar shows how little of
   what's on the wire is the real data. Prev / Next (or ← →) step through
   the client wrapping the request and the server unwrapping it; tap any
   layer to expand its real header fields.
   ============================================================ */
(function () {
  "use strict";
  const D = window.OSI;
  const NODES = D.nodes;                  // 12 steps: client wrap → wire → server unwrap
  const FORMATS = D.formats;              // static header-field layouts
  const LNAME = D.names;                  // short layer names ({app:'body', ...})
  let REQ = D.defaultRequest();
  let ORDER = REQ.ORDER;                  // six layers, inner → outer
  const MAXSTEP = NODES.length - 1;       // 11
  const FULL = ORDER.length - 1;          // 5 — fully wrapped (the default landing)

  // layer → OSI-ish number (app & HTTP both L7; TLS L6; TCP L4; IP L3; VXLAN L2)
  const LAYERNUM = { app: "L7", http: "L7", tls: "L6", tcp: "L4", ip: "L3", vxlan: "L2" };

  const esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  const clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  const $ = function (id) { return document.getElementById(id); };

  const stage = $("stage"), reqLabel = $("req-label");
  const epClient = $("ep-client"), epServer = $("ep-server");
  const phaseTag = $("phase-tag"), phaseNode = $("phase-node");
  const propBar = $("prop-bar"), propStat = $("prop-stat"), stackEl = $("stack");

  let step = FULL;
  let playTimer = null;

  function presentAt(s) { return ORDER.slice(0, NODES[s].n); }        // inner → outer
  function layerByKey(key) { for (let i = 0; i < ORDER.length; i++) if (ORDER[i].key === key) return ORDER[i]; return null; }

  function phaseAt(s) {
    if (s === 0) return { word: "at the client", side: "client" };
    if (s <= 5) return { word: "wrapping", side: "client" };
    if (s === 6) return { word: "on the wire", side: "wire" };
    if (s === MAXSTEP) return { word: "delivered", side: "server" };
    return { word: "unwrapping", side: "server" };
  }

  // ---------- build the fixed scaffolding once (one row + one bar segment
  //            per layer, outermost → core). Content is refreshed per request. ----------
  const KEYS = ORDER.map(function (l) { return l.key; }).reverse();   // [vxlan,ip,tcp,tls,http,app]
  const rowEls = {}, segEls = {};

  KEYS.forEach(function (key) {
    const row = document.createElement("div");
    row.className = "lrow";
    row.innerHTML =
      '<div class="lrow-clip"><div class="lrow-card">' +
        '<button class="lrow-head" aria-expanded="false">' +
          '<span class="lrow-sw"></span>' +
          '<span class="lrow-main"><span class="lrow-name"></span><span class="lrow-cap"></span></span>' +
          '<span class="lrow-bytes"></span>' +
          '<span class="lrow-chev" aria-hidden="true">▸</span>' +
        '</button>' +
        '<div class="lrow-detail"><div class="lrow-detail-in"></div></div>' +
      '</div></div>';
    stackEl.appendChild(row);
    rowEls[key] = row;
    row.querySelector(".lrow-head").addEventListener("click", function () { toggleRow(key); });

    const seg = document.createElement("div");
    seg.className = "seg" + (key === "app" ? " core" : "");
    propBar.appendChild(seg);
    segEls[key] = seg;
  });

  const dots = NODES.map(function (n, i) {
    const b = document.createElement("button");
    b.className = "pdot";
    b.setAttribute("aria-label", "Step " + (i + 1) + " of " + (MAXSTEP + 1) + ": " + n.name);
    b.addEventListener("click", function () { goTo(i); });
    $("progress-dots").appendChild(b);
    return b;
  });

  // ---------- per-request content (bytes, captions, colours, detail) ----------
  function headerDiagram(l) {
    const fmt = FORMATS[l.key];
    let html = '<div class="hf" style="--a:var(' + l.color + ')">';
    html += '<div class="hf-title">' + esc(fmt.name) + " · " + l.bytes + " bytes</div>";
    if (fmt.text) {
      html += l.fields.map(function (f, i) { return '<div class="hf-line' + (i === 0 ? " hf-line-req" : "") + '">' + esc(f) + "</div>"; }).join("");
    } else {
      fmt.rows.forEach(function (row) {
        html += '<div class="hf-row">';
        row.cells.forEach(function (cell) {
          let body = '<span class="hf-l">' + esc(cell.label) + "</span>";
          if (cell.flags) body += '<span class="hf-flags">' + cell.flags.map(function (fl) { return '<span title="' + esc(fl) + '">' + esc(fl).split("").join("<br>") + "</span>"; }).join("") + "</span>";
          else if (cell.sub) body += '<span class="hf-s">' + esc(cell.sub) + "</span>";
          html += '<div class="hf-c' + (cell.variable ? " hf-var" : "") + '" style="flex:' + cell.w + '">' + body + "</div>";
        });
        html += "</div>";
      });
    }
    return html + "</div>";
  }

  function layerDetail(l) {
    let html = '<div class="ld-fields">' + l.fields.map(function (f) { return '<div class="ld-field">' + esc(f) + "</div>"; }).join("") + "</div>";
    if (l.key !== "app" && FORMATS[l.key]) html += headerDiagram(l);   // the raw data core has no header
    html += '<div class="term"><div class="term-cmd">' + esc("$ " + l.tool.cmd) + '</div><pre class="term-out">' + esc(l.tool.out) + "</pre></div>";
    return html;
  }

  function applyRequest() {
    KEYS.forEach(function (key) {
      const l = layerByKey(key), row = rowEls[key];
      row.style.setProperty("--c", "var(" + l.color + ")");
      row.querySelector(".lrow-name").innerHTML =
        (key === "app" ? "Data" : esc(LNAME[key])) + ' <b class="lnum">' + LAYERNUM[key] + "</b>";
      row.querySelector(".lrow-cap").textContent = l.caption;
      row.querySelector(".lrow-bytes").textContent = l.bytes + " B";
      row.querySelector(".lrow-detail-in").innerHTML = layerDetail(l);
      segEls[key].style.setProperty("--c", "var(" + l.color + ")");
      setRowOpen(key, false);
    });
  }

  // ---------- render one step ----------
  function render() {
    const present = presentAt(step);
    const here = {};
    present.forEach(function (l) { here[l.key] = true; });
    const total = present.reduce(function (s, l) { return s + l.bytes; }, 0);
    const dataBytes = layerByKey("app").bytes;
    const node = NODES[step], ph = phaseAt(step), outer = present[present.length - 1];

    // journey strip
    epClient.classList.toggle("active", ph.side === "client");
    epServer.classList.toggle("active", ph.side === "server");
    phaseTag.textContent = ph.word;
    phaseTag.style.background = "var(" + outer.color + ")";
    phaseNode.innerHTML = node.icon + " <b>" + esc(node.name) + '</b> <span class="ps">' + esc(node.sub) + "</span>";

    // proportion bar
    KEYS.forEach(function (key) {
      const l = layerByKey(key);
      const w = here[key] && total > 0 ? (l.bytes / total * 100) : 0;
      segEls[key].style.width = w.toFixed(2) + "%";
    });

    // ratio readout
    const pct = total > 0 ? Math.round(dataBytes / total * 100) : 0;
    if (present.length === 1) propStat.innerHTML = "Just the data so far — <b>" + dataBytes + " B</b>, nothing wrapped yet.";
    else if (dataBytes === 0) propStat.innerHTML = "<b>0 B</b> of <b>" + total + " B</b> is your data — this request is pure envelope.";
    else propStat.innerHTML = "<b>" + dataBytes + " B</b> of <b>" + total + " B</b> on the wire is your data — just <b>" + pct + "%</b>.";

    // stack + dots
    KEYS.forEach(function (key) { rowEls[key].classList.toggle("present", !!here[key]); });
    dots.forEach(function (dot, i) { dot.classList.toggle("done", i <= step); dot.classList.toggle("current", i === step); });
    $("prev").disabled = step === 0;
    $("next").disabled = step === MAXSTEP;
  }

  // ---------- expand / collapse a layer ----------
  function setRowOpen(key, open) {
    rowEls[key].classList.toggle("open", open);
    rowEls[key].querySelector(".lrow-head").setAttribute("aria-expanded", open ? "true" : "false");
  }
  function toggleRow(key) { setRowOpen(key, !rowEls[key].classList.contains("open")); }

  // ---------- navigation ----------
  function goTo(s) { stopPlay(); step = clamp(s, 0, MAXSTEP); render(); }
  function stepBy(d) { goTo(step + d); }
  function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; $("replay").classList.remove("playing"); } }
  function replay() {
    stopPlay();
    step = 0; render();
    $("replay").classList.add("playing");
    playTimer = setInterval(function () {
      if (step >= FULL) { stopPlay(); return; }
      step += 1; render();
    }, 850);
  }
  $("prev").addEventListener("click", function () { stepBy(-1); });
  $("next").addEventListener("click", function () { stepBy(1); });
  $("replay").addEventListener("click", replay);

  // ---------- request label + generator ----------
  function updateReqLabel() {
    reqLabel.innerHTML =
      '<span class="req-method">' + esc(REQ.method) + "</span>" +
      '<span class="req-path">' + esc(REQ.path) + "</span>" +
      '<span class="req-body">' + (REQ.hasBody ? "with body" : "no body") + "</span>";
    reqLabel.classList.remove("pulse"); void reqLabel.offsetWidth; reqLabel.classList.add("pulse");
  }
  function setRequest(req) {
    stopPlay();
    REQ = req; ORDER = req.ORDER;
    updateReqLabel(); applyRequest();
    step = FULL; render();
  }
  $("new-req").addEventListener("click", function () { setRequest(D.randomRequest()); });

  // ---------- guide ----------
  const help = $("help"), helpStart = $("help-start");
  function openHelp(firstRun) { helpStart.hidden = !firstRun; help.hidden = false; }
  function closeHelp() { help.hidden = true; stage.focus(); }
  $("help-btn").addEventListener("click", function () { openHelp(false); });
  $("help-close").addEventListener("click", closeHelp);
  helpStart.addEventListener("click", closeHelp);

  // ---------- keyboard: ← → step, Home/End jump, Esc closes the guide ----------
  document.addEventListener("keydown", function (e) {
    if (!help.hidden) { if (e.key === "Escape") closeHelp(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); stepBy(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); stepBy(-1); }
    else if (e.key === "Home") { e.preventDefault(); goTo(0); }
    else if (e.key === "End") { e.preventDefault(); goTo(MAXSTEP); }
  });

  // ---------- init ----------
  updateReqLabel();
  applyRequest();
  render();
  openHelp(true);
})();
