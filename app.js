/* ============================================================
   app.js — a camera that follows one request along a U-shaped path:
   down the client's stack, across the underlay, up the server's.
   The data is a big byte-grid box (each header's area ∝ its bytes);
   each layer's block flies in/out as the data reaches its node.
   Tap the box to inspect the real headers.
   ============================================================ */
(function () {
  "use strict";
  const D = window.OSI;
  const NODES = D.nodes;
  let REQ = D.defaultRequest();          // current request being visualised
  let ORDER = REQ.ORDER;                 // its six-layer stack, inner → outer
  const FORMATS = D.formats;             // static header-field layouts
  const LNAME = D.names;                 // short layer names for the data field
  const MAXP = NODES.length - 1;
  const SVGNS = "http://www.w3.org/2000/svg";
  const uShape = function (s) { return 4 * s * (1 - s); };  // 0 at ends, 1 at the bottom of the U

  const stage = document.getElementById("stage");
  const trackPath = document.getElementById("track-path");
  const blobG = document.getElementById("blob");
  const nodesWrap = document.getElementById("nodes");
  const hit = document.getElementById("blob-hit");
  const bound = document.getElementById("blob-bound");

  const easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };
  const esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  // progress runs 0 .. MAXP (continuous). 0 = client L7, MAXP = server L7.
  let progress = 0;
  const rects = [];          // pooled SVG rects for the byte-grid cells

  // header fly-in / fly-out animation (decoupled from scroll speed)
  const ANIM_DUR = 480;
  let anim = null;           // { idx, dir:'in'|'out', t0, layers }
  let animRaf = null;
  let lastCount = 1;

  // ---------- build nodes + progress dots ----------
  const nodeEls = NODES.map(function (n) {
    const el = document.createElement("div");
    el.className = "node";
    const col = "var(" + ORDER[n.n - 1].color + ")";        // node colour = its outermost layer
    el.style.color = col;
    el.style.setProperty("--nc", col);                      // for the layer badge fill
    el.innerHTML =
      '<div class="node-icon">' + esc(n.icon) +
        (n.layer ? '<span class="node-layer">' + esc(n.layer) + "</span>" : "") + "</div>" +
      '<div class="node-name-row"><span class="node-swatch"></span><span class="node-name">' + esc(n.name) + "</span></div>" +
      '<div class="node-sub">' + esc(n.sub) + "</div>";
    nodesWrap.appendChild(el);
    return el;
  });

  const dots = NODES.map(function (n, i) {
    const b = document.createElement("button");
    b.className = "pdot";
    b.setAttribute("aria-label", "Go to " + n.name);
    b.addEventListener("click", function () { tweenTo(i); });
    document.getElementById("progress-dots").appendChild(b);
    return b;
  });

  // ---------- geometry ----------
  // The camera follows the packet: the box stays fixed on screen while the
  // nodes stream past, spread far apart (so ≤2 are ever visible). The U is
  // conveyed by the track tilting down on the way in and up on the way out.
  function geom() {
    const w = stage.clientWidth, h = stage.clientHeight;
    const R = Math.max(52, 0.14 * Math.min(w, h));      // scale of the packet grid
    const boxY = h * 0.6;                               // the packet sits fixed here
    const gap = R + 104;                                // the current station rides this far above it
    const spx = Math.max(w * 0.62, 300);                // wide spacing → at most 2 nodes on screen
    const vScale = spx * 4.6;                           // vertical scale → keeps the slope ~45°
    return { w: w, h: h, R: R, ax: w * 0.42, boxY: boxY, stationBaseY: boxY - gap, gap: gap, spx: spx, vScale: vScale };
  }

  // Which layers are on the packet at position p, inner→outer. Discrete: the
  // layer count is whatever node the packet has reached (floor).
  function layersAt(p) {
    const n = NODES[Math.min(MAXP, Math.max(0, Math.floor(p)))].n;
    const out = [];
    for (let k = 0; k < n; k++) out.push({ color: ORDER[k].color, bytes: ORDER[k].bytes });
    return out;
  }

  // Byte-grid geometry: 60 bytes per row, bottom row first, right → left,
  // wrapping to the row above. Anchored at the bottom (the data row is fixed),
  // so adding a layer only piles rows on top — existing cells never move.
  const ROW = 60;
  function computeRegions(layers, R) {
    const W = R * 2.4, rowH = R * 0.42, byteW = W / ROW, anchor = R * 0.9;
    let total = 0; layers.forEach(function (l) { total += l.bytes; });
    const rows = Math.max(1, Math.ceil(total / ROW));
    const regions = [];
    let off = 0;
    layers.forEach(function (l, li) {
      let b = off; const e = off + l.bytes;
      while (b < e) {
        const row = Math.floor(b / ROW), posInRow = b % ROW;
        const runEnd = Math.min(e, (row + 1) * ROW), runLen = runEnd - b;
        const xRight = W / 2 - posInRow * byteW;
        regions.push({ x: xRight - runLen * byteW, y: anchor - (row + 1) * rowH, w: runLen * byteW, h: rowH, color: l.color, li: li });
        b = runEnd;
      }
      off = e;
    });
    return { regions: regions, W: W, rowH: rowH, rows: rows, anchor: anchor };
  }

  function ensureRects(n) {
    while (rects.length < n) {
      const r = document.createElementNS(SVGNS, "rect");
      blobG.appendChild(r);
      rects.push(r);
    }
  }

  // ---------- render ----------
  function render() {
    const g = geom();
    const dNow = uShape(progress / MAXP);

    // stations tilt around the fixed box: the current one stays at stationBaseY,
    // those ahead/behind sit lower/higher by their depth on the U.
    NODES.forEach(function (n, i) {
      const x = g.ax + (i - progress) * g.spx;
      const y = g.stationBaseY + (uShape(i / MAXP) - dNow) * g.vScale;
      const el = nodeEls[i];
      el.style.transform = "translate(" + x + "px," + y + "px)";
      el.style.opacity = (x > -200 && x < g.w + 200) ? "1" : "0";
      el.classList.toggle("active", Math.abs(i - progress) < 0.5);
    });

    // the U track: sample the curve densely across the visible window
    let d = "", first = true;
    const t0 = Math.max(0, progress - 1.4), t1 = Math.min(MAXP, progress + 1.4);
    for (let t = t0; t <= t1 + 1e-6; t += 0.05) {
      const tt = Math.min(t1, t);
      const x = g.ax + (tt - progress) * g.spx;
      const y = g.stationBaseY + (uShape(tt / MAXP) - dNow) * g.vScale;
      d += (first ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      first = false;
    }
    trackPath.setAttribute("d", d);

    // the box is fixed on screen; the group transform is immediate.
    const cy = g.boxY;
    blobG.setAttribute("transform", "translate(" + g.ax.toFixed(1) + " " + cy.toFixed(1) + ")");

    // decide what to draw + the animation parameter p (0 = at screen centre, 1 = home)
    let drawLayers, animIdx = -1, ap = 1;
    if (anim) {
      const k = easeOutCubic(Math.min(1, (performance.now() - anim.t0) / ANIM_DUR));
      drawLayers = anim.layers; animIdx = anim.idx;
      ap = anim.dir === "in" ? k : (1 - k);
    } else {
      drawLayers = layersAt(progress);
    }
    const cr = computeRegions(drawLayers, g.R);
    const scx = g.w / 2 - g.ax, scy = g.h / 2 - cy;   // screen centre, in group-local coords

    ensureRects(cr.regions.length);
    rects.forEach(function (r, i) {
      if (i >= cr.regions.length) { r.style.display = "none"; return; }
      const rg = cr.regions[i];
      let x = rg.x, y = rg.y, w = rg.w, hh = rg.h, op = 1;
      if (rg.li === animIdx) {                        // this layer flies in/out from the middle
        const gcx = rg.x + rg.w / 2, gcy = rg.y + rg.h / 2;
        const sc = 0.25 + 0.75 * ap;
        w = rg.w * sc; hh = rg.h * sc;
        x = (scx + (gcx - scx) * ap) - w / 2;
        y = (scy + (gcy - scy) * ap) - hh / 2;
        op = ap;
      }
      r.setAttribute("x", x.toFixed(1)); r.setAttribute("y", y.toFixed(1));
      r.setAttribute("width", Math.max(0, w).toFixed(1)); r.setAttribute("height", Math.max(0, hh).toFixed(1));
      r.setAttribute("rx", "0"); r.setAttribute("fill", "var(" + rg.color + ")");
      r.setAttribute("fill-opacity", op.toFixed(2));
      r.setAttribute("stroke", "rgba(6,10,22,.85)"); r.setAttribute("stroke-width", "1.5");
      r.style.display = "";
    });

    // dashed frosted bounding box, sized to the settled grid (60-byte rows wide).
    // While idle, drawLayers is already the settled set, so reuse cr.
    const settled = anim ? computeRegions(layersAt(progress), g.R) : cr;
    const pad = 7, gridTop = settled.anchor - settled.rows * settled.rowH;
    bound.style.width = (settled.W + 2 * pad) + "px";
    bound.style.height = (settled.rows * settled.rowH + 2 * pad) + "px";
    bound.style.transform = "translate(" + (g.ax - settled.W / 2 - pad) + "px," + (cy + gridTop - pad) + "px)";

    // tap target covers the grid
    const gridH = settled.rows * settled.rowH;
    hit.style.width = settled.W + "px";
    hit.style.height = gridH + "px";
    hit.style.transform = "translate(" + (g.ax - settled.W / 2) + "px," + (cy + gridTop) + "px)";

    dots.forEach(function (dot, i) {
      dot.classList.toggle("done", i <= progress + 0.01);
      dot.classList.toggle("current", Math.round(progress) === i);
    });
  }

  // ---------- header fly-in / fly-out animation ----------
  function startAnim(newCount, dir) {
    const layers = dir === "in" ? layersAt(progress) : ORDER.slice(0, newCount + 1).map(function (l) { return { color: l.color, bytes: l.bytes }; });
    const idx = dir === "in" ? newCount - 1 : newCount;   // the layer that appears/disappears
    anim = { idx: idx, dir: dir, t0: performance.now(), layers: layers };
    if (!animRaf) animRaf = requestAnimationFrame(animLoop);
  }
  function animLoop() {
    render();
    if (anim && performance.now() - anim.t0 < ANIM_DUR) { animRaf = requestAnimationFrame(animLoop); }
    else { anim = null; animRaf = null; render(); }
  }

  function setProgress(p) {
    progress = Math.min(MAXP, Math.max(0, p));
    const c = layersAt(progress).length;
    if (c !== lastCount) { startAnim(c, c > lastCount ? "in" : "out"); lastCount = c; }
    render();
  }

  // ---------- tween (keyboard / dot jumps) ----------
  let raf = null;
  function tweenTo(target) {
    target = Math.min(MAXP, Math.max(0, target));
    if (raf) cancelAnimationFrame(raf);
    const start = progress, t0 = performance.now(), dur = 420;
    (function step(now) {
      const k = Math.min(1, (now - t0) / dur);
      setProgress(start + (target - start) * easeOutCubic(k));
      if (k < 1) raf = requestAnimationFrame(step);
    })(t0);
  }
  function stopTween() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  // ---------- input: scroll / swipe drive left→right travel ----------
  stage.addEventListener("wheel", function (e) {
    e.preventDefault();
    stopTween();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    setProgress(progress + delta / 1500);         // slower: ~one node per 1500px of scroll
  }, { passive: false });

  let tStartX = 0, tStartY = 0, tStartP = 0, touching = false;
  stage.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) return;
    touching = true; tStartP = progress;
    tStartX = e.touches[0].clientX; tStartY = e.touches[0].clientY;
    stopTween();
  }, { passive: true });
  stage.addEventListener("touchmove", function (e) {
    if (!touching) return;
    const dx = e.touches[0].clientX - tStartX;
    const dy = e.touches[0].clientY - tStartY;
    const move = Math.abs(dx) >= Math.abs(dy) ? -dx : -dy;   // swipe left/up → forward
    e.preventDefault();
    setProgress(tStartP + move / 260);            // slower: ~260px of swipe per node
  }, { passive: false });
  stage.addEventListener("touchend", function () { touching = false; }, { passive: true });

  // keyboard
  stage.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); tweenTo(Math.round(progress) + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); tweenTo(Math.round(progress) - 1); }
    else if (e.key === "Home") { e.preventDefault(); tweenTo(0); }
    else if (e.key === "End") { e.preventDefault(); tweenTo(MAXP); }
  });

  // ---------- inspector (tap the data) ----------
  const detail = document.getElementById("detail");
  const pagerTrack = document.getElementById("pager-track");
  const pgtabs = [document.getElementById("pgtab-0"), document.getElementById("pgtab-1")];
  const detailSub = document.getElementById("detail-sub");
  const detailDecode = document.getElementById("detail-decode");
  const detailCmd = document.getElementById("detail-cmd");
  const detailOut = document.getElementById("detail-out");
  const detailHeaders = document.getElementById("detail-headers");

  function setPage(pg) {
    pagerTrack.style.transform = "translateX(" + (-pg * 50) + "%)";
    pgtabs.forEach(function (t, i) { t.setAttribute("aria-selected", i === pg); });
  }

  // Build the header-anatomy diagram for the outermost present layer.
  function dataField(bytes, sub) {
    return '<div class="hf-data"><div class="hf-data-t">Data<span class="b">' + bytes + ' bytes</span></div>' +
      '<div class="hf-data-s">' + sub + "</div></div>";
  }
  function headerAnatomy(present) {
    const outer = present[present.length - 1];
    const inner = present.slice(0, -1);
    const innerBytes = inner.reduce(function (s, l) { return s + l.bytes; }, 0);
    const innerNames = inner.slice().reverse().map(function (l) { return LNAME[l.key]; }).join(" · ");

    // the Client node's outermost "layer" is the raw body — no protocol header
    if (outer.key === "app") {
      return '<p class="hf-note">This is the raw <b>application data</b> — the request body the app is sending, before any protocol header is wrapped around it.</p>' +
        dataField(outer.bytes, outer.bytes ? "the JSON body itself" : "no body — this request carries none");
    }

    const fmt = FORMATS[outer.key];
    // top schematic — Header | Data, sized in proportion (echoes the RFC diagrams)
    let html = '<div class="hf-split" style="--a:var(' + outer.color + ')">' +
      '<div class="hf-split-h" style="flex:' + Math.max(1, outer.bytes) + '">' + esc(LNAME[outer.key]) + ' header<span>' + outer.bytes + ' B</span></div>' +
      '<div class="hf-split-d" style="flex:' + Math.max(1, innerBytes) + '">Data<span>' + innerBytes + ' B</span></div>' +
      '</div>';

    html += '<div class="hf" style="--a:var(' + outer.color + ')">';
    html += '<div class="hf-title">' + esc(fmt.name) + ' · ' + outer.bytes + ' bytes</div>';
    if (fmt.text) {
      html += outer.fields.map(function (f, i) {
        return '<div class="hf-line' + (i === 0 ? " hf-line-req" : "") + '">' + esc(f) + "</div>";
      }).join("");
    } else {
      fmt.rows.forEach(function (row) {
        html += '<div class="hf-row">';
        row.cells.forEach(function (cell) {
          let body = '<span class="hf-l">' + esc(cell.label) + "</span>";
          if (cell.flags) body += '<span class="hf-flags">' + cell.flags.map(function (fl) { return '<span title="' + fl + '">' + fl.split("").join("<br>") + "</span>"; }).join("") + "</span>";
          else if (cell.sub) body += '<span class="hf-s">' + esc(cell.sub) + "</span>";
          html += '<div class="hf-c' + (cell.variable ? " hf-var" : "") + '" style="flex:' + cell.w + '">' + body + "</div>";
        });
        html += "</div>";
      });
    }
    html += "</div>";

    // the unified, collapsed data field
    const desc = innerBytes === 0 ? "no encapsulated data — this request has an empty body"
      : "everything inside the " + LNAME[outer.key] + " header, collapsed: " + innerNames;
    html += dataField(innerBytes, desc);
    return html;
  }

  function openDetail() {
    const nAt = NODES[Math.round(progress)].n;          // layers on the packet here
    const present = ORDER.slice(0, nAt);                // inner → outer
    let bytes = 0; present.forEach(function (l) { bytes += l.bytes; });

    detailSub.textContent =
      "frame · " + bytes + " bytes on the wire · " + present.length + " layer" + (present.length > 1 ? "s" : "");

    // Page 1 — Wireshark-style nested dissection, outermost header first.
    let tree = "", indent = "";
    present.slice().reverse().forEach(function (l) {
      tree += indent + "▸ " + l.decode + "\n";
      l.fields.forEach(function (f) { tree += indent + "    " + f + "\n"; });
      indent += "  ";
    });
    detailDecode.textContent = tree.replace(/\n$/, "");
    const outer = present[present.length - 1];
    detailCmd.textContent = "$ " + outer.tool.cmd;
    detailOut.textContent = outer.tool.out;

    // Page 2 — the anatomy of the OUTERMOST header, with everything inside
    // collapsed into one unified "Data" field.
    detailHeaders.innerHTML = headerAnatomy(present);

    setPage(0);
    detail.hidden = false;
    // the routing panes scroll horizontally (long tcpdump / decode lines);
    // always reopen scrolled fully left, whatever a previous open left behind
    detailDecode.scrollLeft = 0;
    detailOut.scrollLeft = 0;
  }
  function closeDetail() { detail.hidden = true; stage.focus(); }

  // Pages switch on tab clicks only. We deliberately do NOT swipe between
  // them: the routing page scrolls horizontally (long tcpdump / decode lines),
  // and a horizontal swipe there should scroll that content, not flip pages.
  pgtabs.forEach(function (t, i) { t.addEventListener("click", function () { setPage(i); }); });

  let hitMoved = false, hitStart = 0;
  hit.addEventListener("pointerdown", function (e) { hitStart = e.clientX + e.clientY; hitMoved = false; });
  hit.addEventListener("pointermove", function (e) { if (Math.abs(e.clientX + e.clientY - hitStart) > 8) hitMoved = true; });
  hit.addEventListener("click", function () { if (!hitMoved) openDetail(); });
  hit.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  detail.addEventListener("click", function (e) { if (e.target === detail) closeDetail(); });

  // ---------- request generator ----------
  const reqLabel = document.getElementById("req-label");
  function updateReqLabel() {
    reqLabel.innerHTML =
      '<span class="req-method">' + esc(REQ.method) + '</span>' +
      '<span class="req-path">' + esc(REQ.path) + '</span>' +
      '<span class="req-body">' + (REQ.hasBody ? "with body" : "no body") + '</span>';
    reqLabel.classList.remove("pulse");
    void reqLabel.offsetWidth;          // restart the highlight animation
    reqLabel.classList.add("pulse");
  }
  function setRequest(req) {
    REQ = req; ORDER = req.ORDER;
    updateReqLabel();
    // restart the journey at the client so the new request tells its story
    stopTween();
    anim = null; if (animRaf) { cancelAnimationFrame(animRaf); animRaf = null; }
    progress = 0; lastCount = layersAt(0).length;
    if (!detail.hidden) closeDetail();
    render();
  }
  document.getElementById("new-req").addEventListener("click", function () {
    setRequest(D.randomRequest());
  });

  // ---------- guide ----------
  const help = document.getElementById("help");
  const helpStart = document.getElementById("help-start");
  // Start button only makes sense on the first-run guide; when reopened from
  // the "?" button the reader is already moving, so a Close (✕) is enough.
  function openHelp(firstRun) { helpStart.hidden = !firstRun; help.hidden = false; }
  function closeHelp() { help.hidden = true; stage.focus(); }
  document.getElementById("help-btn").addEventListener("click", function () { openHelp(false); });
  document.getElementById("help-close").addEventListener("click", closeHelp);
  helpStart.addEventListener("click", closeHelp);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { if (!detail.hidden) closeDetail(); else if (!help.hidden) closeHelp(); }
  });

  // ---------- init ----------
  window.addEventListener("resize", render);
  updateReqLabel();
  render();
  openHelp(true);
})();
