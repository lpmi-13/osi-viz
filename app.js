/* ============================================================
   app.js — a camera that follows one packet along a U-shaped path:
   down the client's stack, across the underlay, up the server's.
   The packet is a big box of nested colour squares (area ∝ bytes);
   each layer's square SNAPS in/out as the packet reaches its node.
   Tap the box to inspect the real headers.
   ============================================================ */
(function () {
  "use strict";
  const D = window.OSI;
  const NODES = D.nodes;
  const ORDER = D.ORDER;                 // canonical layer stack, inner → outer
  const MAXP = NODES.length - 1;
  const SVGNS = "http://www.w3.org/2000/svg";
  const uShape = function (s) { return 4 * s * (1 - s); };  // 0 at ends, 1 at the bottom of the U

  const stage = document.getElementById("stage");
  const scene = document.getElementById("scene");
  const trackPath = document.getElementById("track-path");
  const blobG = document.getElementById("blob");
  const nodesWrap = document.getElementById("nodes");
  const hit = document.getElementById("blob-hit");

  // progress runs 0 .. MAXP (continuous). 0 = client L7, MAXP = server L7.
  let progress = 0;
  const rects = [];          // pooled SVG rects for the nested-square box

  // ---------- build nodes + progress dots ----------
  const nodeEls = NODES.map(function (n) {
    const el = document.createElement("div");
    el.className = "node";
    el.style.color = "var(" + ORDER[n.n - 1].color + ")";   // node colour = its outermost layer
    el.innerHTML =
      '<div class="node-icon">' + n.icon + "</div>" +
      '<div class="node-name">' + n.name + "</div>" +
      '<div class="node-sub">' + n.sub + "</div>";
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
  function geom() {
    const w = stage.clientWidth, h = stage.clientHeight;
    const R = Math.max(74, 0.2 * Math.min(w, h));       // half the max square's side
    const gap = R + 96;                                 // the box hangs this far below its station
    const uTop = 14;                                    // station Y at the U's rim (the L7 ends)
    const uDip = Math.max(90, Math.min(h * 0.30, h - 84 - uTop - gap - R));  // depth of the U (clamped to fit)
    return { w: w, h: h, ax: w * 0.46, spx: Math.max(w * 0.9, 340), R: R, gap: gap, uTop: uTop, uDip: uDip };
  }

  // Which squares are on the packet at position p, inner→outer. Discrete: the
  // layer count is whatever node the packet has reached (floor), so a square
  // snaps in (descending) or out (ascending) exactly at each node — it does not
  // grow gradually along the wire.
  function layersAt(p) {
    const n = NODES[Math.min(MAXP, Math.max(0, Math.floor(p)))].n;
    const out = [];
    for (let k = 0; k < n; k++) out.push({ color: ORDER[k].color, bytes: ORDER[k].bytes });
    return out;
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

    // stations sit on the U (absolute Y). The camera follows X only, so the
    // packet visibly dips to the bottom of the U and climbs back up.
    NODES.forEach(function (n, i) {
      const x = g.ax + (i - progress) * g.spx;
      const y = g.uTop + uShape(i / MAXP) * g.uDip;
      const el = nodeEls[i];
      el.style.transform = "translate(" + x + "px," + y + "px)";
      el.style.opacity = (x > -180 && x < g.w + 180) ? "1" : "0";
      el.classList.toggle("active", Math.abs(i - progress) < 0.5);
    });

    // the U track: sample the curve densely across the visible window
    let d = "", first = true;
    const t0 = Math.max(0, progress - 2.6), t1 = Math.min(MAXP, progress + 2.6);
    for (let t = t0; t <= t1 + 1e-6; t += 0.08) {
      const tt = Math.min(t1, t);
      const x = g.ax + (tt - progress) * g.spx;
      const y = g.uTop + uShape(tt / MAXP) * g.uDip;
      d += (first ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      first = false;
    }
    trackPath.setAttribute("d", d);

    // the box follows the U (group transform = immediate); the nested squares
    // only change size when a layer snaps at a node.
    const cy = g.uTop + uShape(progress / MAXP) * g.uDip + g.gap;
    blobG.setAttribute("transform", "translate(" + g.ax.toFixed(1) + " " + cy.toFixed(1) + ")");

    const layers = layersAt(progress);
    let total = 0; layers.forEach(function (l) { total += l.bytes; });
    let cum = 0;
    const sq = layers.map(function (l) { cum += l.bytes; return { color: l.color, hs: g.R * Math.sqrt(cum / total) }; });
    sq.sort(function (a, b) { return b.hs - a.hs; });   // outermost (largest) first
    ensureRects(sq.length);
    rects.forEach(function (r, i) {
      if (i < sq.length) {
        const hs = sq[i].hs;
        r.setAttribute("x", (-hs).toFixed(1));
        r.setAttribute("y", (-hs).toFixed(1));
        r.setAttribute("width", (hs * 2).toFixed(1));
        r.setAttribute("height", (hs * 2).toFixed(1));
        r.setAttribute("rx", Math.min(15, hs * 0.16).toFixed(1));
        r.setAttribute("fill", "var(" + sq[i].color + ")");
        r.style.display = "";
      } else { r.style.display = "none"; }
    });

    // tap target (square) tracks the box
    hit.style.width = hit.style.height = (g.R * 2) + "px";
    hit.style.transform = "translate(" + (g.ax - g.R) + "px," + (cy - g.R) + "px)";

    dots.forEach(function (dot, i) {
      dot.classList.toggle("done", i <= progress + 0.01);
      dot.classList.toggle("current", Math.round(progress) === i);
    });
  }

  function setProgress(p) {
    progress = Math.min(MAXP, Math.max(0, p));
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
      const e = 1 - Math.pow(1 - k, 3);           // ease-out cubic
      setProgress(start + (target - start) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    })(t0);
  }
  function stopTween() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

  // ---------- input: scroll / swipe drive left→right travel ----------
  stage.addEventListener("wheel", function (e) {
    e.preventDefault();
    stopTween();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    setProgress(progress + delta / 620);          // ~one node per 620px of scroll
  }, { passive: false });

  let tStartX = 0, tStartY = 0, tStartP = 0, touching = false, moved = 0;
  stage.addEventListener("touchstart", function (e) {
    if (e.touches.length !== 1) return;
    touching = true; moved = 0; tStartP = progress;
    tStartX = e.touches[0].clientX; tStartY = e.touches[0].clientY;
    stopTween();
  }, { passive: true });
  stage.addEventListener("touchmove", function (e) {
    if (!touching) return;
    const dx = e.touches[0].clientX - tStartX;
    const dy = e.touches[0].clientY - tStartY;
    const move = Math.abs(dx) >= Math.abs(dy) ? -dx : -dy;   // swipe left/up → forward
    moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
    e.preventDefault();
    setProgress(tStartP + move / (geom().spx * 0.7));
  }, { passive: false });
  stage.addEventListener("touchend", function () { touching = false; }, { passive: true });

  // keyboard
  stage.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); tweenTo(Math.round(progress) + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); tweenTo(Math.round(progress) - 1); }
    else if (e.key === "Home") { e.preventDefault(); tweenTo(0); }
    else if (e.key === "End") { e.preventDefault(); tweenTo(MAXP); }
  });

  // ---------- inspector (tap the blob) ----------
  const detail = document.getElementById("detail");
  function openDetail() {
    const nAt = NODES[Math.round(progress)].n;          // layers on the packet here
    const present = ORDER.slice(0, nAt);                // inner → outer
    let bytes = 0; present.forEach(function (l) { bytes += l.bytes; });

    document.getElementById("detail-sub").textContent =
      "frame · " + bytes + " bytes on the wire · " + present.length + " layer" + (present.length > 1 ? "s" : "");

    // Wireshark-style nested dissection, outermost header first.
    let tree = "", indent = "";
    present.slice().reverse().forEach(function (l) {
      tree += indent + "▸ " + l.decode + "\n";
      l.fields.forEach(function (f) { tree += indent + "    " + f + "\n"; });
      indent += "  ";
    });
    document.getElementById("detail-decode").textContent = tree.replace(/\n$/, "");

    const outer = present[present.length - 1];
    document.getElementById("detail-cmd").textContent = "$ " + outer.tool.cmd;
    document.getElementById("detail-out").textContent = outer.tool.out;

    detail.hidden = false;
  }
  function closeDetail() { detail.hidden = true; stage.focus(); }

  let hitMoved = false, hitStart = 0;
  hit.addEventListener("pointerdown", function (e) { hitStart = e.clientX + e.clientY; hitMoved = false; });
  hit.addEventListener("pointermove", function (e) { if (Math.abs(e.clientX + e.clientY - hitStart) > 8) hitMoved = true; });
  hit.addEventListener("click", function () { if (!hitMoved) openDetail(); });
  hit.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });
  document.getElementById("detail-close").addEventListener("click", closeDetail);
  detail.addEventListener("click", function (e) { if (e.target === detail) closeDetail(); });

  // ---------- guide ----------
  const help = document.getElementById("help");
  function closeHelp() { help.hidden = true; stage.focus(); }
  document.getElementById("help-btn").addEventListener("click", function () { help.hidden = false; });
  document.getElementById("help-close").addEventListener("click", closeHelp);
  document.getElementById("help-start").addEventListener("click", closeHelp);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { if (!detail.hidden) closeDetail(); else if (!help.hidden) closeHelp(); }
  });

  // ---------- init ----------
  window.addEventListener("resize", render);
  render();
  help.hidden = false;
})();
