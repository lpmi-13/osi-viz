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

  // layer → OSI-ish number (app & HTTP both L7; TLS L6; TCP L4; IP L3; VXLAN L2)
  const LAYERNUM = { app: "L7", http: "L7", tls: "L6", tcp: "L4", ip: "L3", vxlan: "L2" };

  const esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  const clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  const $ = function (id) { return document.getElementById(id); };

  const stage = $("stage"), reqLabel = $("req-label");
  const epClient = $("ep-client"), epServer = $("ep-server");
  const phaseTag = $("phase-tag"), phaseNode = $("phase-node");
  const propStat = $("prop-stat"), stackEl = $("stack");
  const propGrid = $("prop-grid"), gridCells = $("grid-cells"), gridFrame = $("grid-frame"), gridClipRect = $("grid-clip-rect");

  // boxy byte-grid (like the favicon): 50 bytes/row, bottom-anchored, right → left,
  // growing up; area ∝ bytes. The box hugs its rows, so it grows as layers pile on.
  const SVGNS = "http://www.w3.org/2000/svg";
  const GRID_ROW = 50, GRID_W = 200, GROW = 24, GBW = GRID_W / GRID_ROW, MAX_ROWS = 7;
  const GRID_DUR = 440;
  const gcellPool = [];
  const easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let gridN = presentAt(0).length;        // layer count of the last settled grid
  let gridRaf = null;

  let step = 0;                           // start at the origin: the app's data, unwrapped
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
  const rowEls = {};

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
  });

  // ---------- boxy byte-grid ----------
  // Cells are laid out once at fixed positions (bottom-anchored, 50 bytes/row,
  // right → left). A viewBox "window" reveals the bottom `winH` of that layout,
  // so the box height can be eased *continuously* — no row-by-row jumping.
  function boxH(layers) {
    let t = 0; layers.forEach(function (l) { t += l.bytes; });
    return Math.min(MAX_ROWS, Math.max(1, Math.ceil(t / GRID_ROW))) * GROW;      // cap at 7 rows
  }
  function layoutCells(layers, animIdx, animBytes, fixedH) {
    const bAt = function (i) { return i === animIdx ? animBytes : layers[i].bytes; };
    const fullH = fixedH == null ? boxH(layers) : fixedH, cells = [];
    let off = 0;
    layers.forEach(function (l, i) {
      let b = off; const e = off + bAt(i);
      while (b < e) {
        const row = Math.floor(b / GRID_ROW), p = b % GRID_ROW;
        const runEnd = Math.min(e, (row + 1) * GRID_ROW), run = runEnd - b;
        cells.push({ x: GRID_W - (p + run) * GBW, y: fullH - (row + 1) * GROW, w: run * GBW, color: l.color });
        b = runEnd;
      }
      off = e;
    });
    return { cells: cells, fullH: fullH };
  }
  function paintCells(cells) {
    while (gcellPool.length < cells.length) {
      const r = document.createElementNS(SVGNS, "rect");
      r.setAttribute("stroke", "rgba(6,10,22,.85)"); r.setAttribute("stroke-width", "0.8");
      gridCells.appendChild(r); gcellPool.push(r);
    }
    gcellPool.forEach(function (r, k) {
      if (k >= cells.length) { r.style.display = "none"; return; }
      const c = cells[k];
      r.setAttribute("x", c.x.toFixed(2)); r.setAttribute("y", c.y.toFixed(2));
      r.setAttribute("width", Math.max(0, c.w).toFixed(2)); r.setAttribute("height", GROW.toFixed(2));
      r.setAttribute("fill", "var(" + c.color + ")");
      r.style.display = "";
    });
  }
  function setWindow(fullH, winH) {
    const minY = fullH - winH;
    propGrid.setAttribute("viewBox", "0 " + minY.toFixed(2) + " " + GRID_W + " " + winH.toFixed(2));
    const fy = (minY + 0.75).toFixed(2), fh = (winH - 1.5).toFixed(2);
    gridFrame.setAttribute("y", fy); gridFrame.setAttribute("height", fh);
    gridClipRect.setAttribute("y", fy); gridClipRect.setAttribute("height", fh);
  }
  function drawGrid(layers) {                       // settled: full window
    const lay = layoutCells(layers);
    paintCells(lay.cells);
    setWindow(lay.fullH, lay.fullH);
  }

  // Animate the box when a single layer is added/removed; snap on jumps / reduced motion.
  function updateGrid(present) {
    const n = present.length;
    if (gridRaf) { cancelAnimationFrame(gridRaf); gridRaf = null; }
    if (reduceMotion || Math.abs(n - gridN) !== 1) { gridN = n; drawGrid(present); return; }
    const dir = n > gridN ? "in" : "out";
    const drawn = dir === "in" ? present : ORDER.slice(0, n + 1);   // 'out' keeps the leaving layer visible
    const idx = dir === "in" ? n - 1 : n;
    const full = drawn[idx].bytes;
    const fullH = boxH(drawn);
    const startH = dir === "in" ? boxH(ORDER.slice(0, n - 1)) : fullH;
    const endH = dir === "in" ? fullH : boxH(present);
    gridN = n;
    const t0 = performance.now();
    (function frame(now) {
      const e = easeOutCubic(Math.min(1, (now - t0) / GRID_DUR));
      const lay = layoutCells(drawn, idx, full * (dir === "in" ? e : 1 - e), fullH);
      paintCells(lay.cells);
      setWindow(lay.fullH, startH + (endH - startH) * e);
      if (e < 1) gridRaf = requestAnimationFrame(frame);
      else { gridRaf = null; drawGrid(present); }
    })(t0);
  }

  // the journey rail's stops (client → down the stack → underlay → up → server)
  const railDots = Array.prototype.slice.call(document.querySelectorAll(".rdot"));
  railDots.forEach(function (dot) {
    dot.addEventListener("click", function () { goTo(parseInt(dot.dataset.step, 10)); });
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
      // the data core isn't one of the OSI layers, so it gets no L-number badge
      row.querySelector(".lrow-name").innerHTML =
        (key === "app" ? "Data" : esc(LNAME[key]) + ' <b class="lnum">' + LAYERNUM[key] + "</b>") +
        (l.tag ? '<span class="lrow-tag">' + esc(l.tag) + "</span>" : "");
      row.querySelector(".lrow-cap").textContent = l.caption;
      row.querySelector(".lrow-bytes").textContent = l.bytes + " B";
      row.querySelector(".lrow-detail-in").innerHTML = layerDetail(l);
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

    // boxy byte-grid (animates when a single layer is added/removed)
    updateGrid(present);

    // ratio readout
    const pct = total > 0 ? Math.round(dataBytes / total * 100) : 0;
    if (present.length === 1) propStat.innerHTML = "Just the data so far — <b>" + dataBytes + " B</b>, nothing wrapped yet.";
    else if (dataBytes === 0) propStat.innerHTML = "<b>0 B</b> of <b>" + total + " B</b> is your data — this request is pure envelope.";
    else propStat.innerHTML = "<b>" + dataBytes + " B</b> of <b>" + total + " B</b> on the wire is your data — just <b>" + pct + "%</b>.";

    // stack rows
    KEYS.forEach(function (key) { rowEls[key].classList.toggle("present", !!here[key]); });

    // journey rail: current stop coloured by the current layer, earlier stops done
    railDots.forEach(function (dot, i) {
      const cur = i === step;
      dot.classList.toggle("current", cur);
      dot.classList.toggle("done", i < step);
      dot.setAttribute("r", cur ? "6.5" : "4.5");
      dot.style.fill = cur ? "var(" + outer.color + ")" : "";
    });

    $("prev").disabled = step === 0;
    $("next").disabled = step === MAXSTEP;
  }

  // ---------- expand / collapse a layer ----------
  function setRowOpen(key, open) {
    rowEls[key].classList.toggle("open", open);
    rowEls[key].querySelector(".lrow-head").setAttribute("aria-expanded", open ? "true" : "false");
  }
  function toggleRow(key) {
    const shouldOpen = !rowEls[key].classList.contains("open");
    if (shouldOpen) KEYS.forEach(function (otherKey) { if (otherKey !== key) setRowOpen(otherKey, false); });
    setRowOpen(key, shouldOpen);
  }

  // ---------- navigation ----------
  function goTo(s) { stopPlay(); step = clamp(s, 0, MAXSTEP); render(); }
  function stepBy(d) { goTo(step + d); }
  function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = null; $("replay").classList.remove("playing"); } }
  function replay() {                       // walk the whole path: wrap, wire, unwrap
    stopPlay();
    step = 0; render();
    $("replay").classList.add("playing");
    playTimer = setInterval(function () {
      if (step >= MAXSTEP) { stopPlay(); return; }
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
    render();               // keep the reader's position on the path
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
