/* ============================================================
   app.js — a camera that follows one packet left→right along a
   gently sloping track. The packet is a big blob of concentric
   colour rings (area ∝ bytes); a new ring grows in as it passes
   each layer node. Tap the blob to inspect the real headers.
   ============================================================ */
(function () {
  "use strict";
  const D = window.OSI;
  const NODES = D.nodes;
  const ORDER = D.ORDER;                 // canonical layer stack, inner → outer
  const MAXP = NODES.length - 1;
  const SVGNS = "http://www.w3.org/2000/svg";
  const depth = function (i) { return NODES[i].n - 1; };   // 0 = L7, 5 = overlay
  function depthAt(p) {
    const i0 = Math.floor(p), i1 = Math.min(MAXP, i0 + 1);
    return depth(i0) + (depth(i1) - depth(i0)) * (p - i0);
  }

  const stage = document.getElementById("stage");
  const scene = document.getElementById("scene");
  const trackPath = document.getElementById("track-path");
  const blobG = document.getElementById("blob");
  const nodesWrap = document.getElementById("nodes");
  const hit = document.getElementById("blob-hit");

  // progress runs 0 .. MAXP (continuous). 0 = at the client, MAXP = fully wrapped.
  let progress = 0;
  const circles = [];        // pooled SVG circles for the blob rings
  let cssColor = {};         // resolved layer colours

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
    return {
      w: w, h: h,
      ax: w * 0.44,                       // shared x anchor (stations pass over the blob)
      stationY: h * 0.20,                 // the current station rides here, above the blob
      blobY: h * 0.66,                    // the big ring blob sits fixed, lower-centre
      spx: Math.max(w * 0.84, 340),       // horizontal spacing between stations
      trackGap: Math.min(h * 0.11, 80),   // vertical drop per layer of depth (the valley)
      R: Math.max(80, 0.25 * Math.min(w, h))
    };
  }

  // Which rings are on the packet at position p, inner→outer. Because the layer
  // stacks are nested prefixes, this handles both directions: descending, the
  // next layer grows in (weight = frac); ascending, the outermost shrinks out
  // (weight = 1 − frac); across the flat bottom, nothing changes.
  function layersAt(p) {
    const iA = Math.floor(p), iB = Math.min(MAXP, iA + 1), frac = p - iA;
    const nA = NODES[iA].n, nB = NODES[iB].n, base = Math.min(nA, nB);
    const out = [];
    for (let k = 0; k < base; k++) out.push({ color: ORDER[k].color, bytes: ORDER[k].bytes });
    if (nB > nA && frac > 0.002) out.push({ color: ORDER[base].color, bytes: ORDER[base].bytes * frac, partial: true });
    else if (nA > nB && (1 - frac) > 0.002) out.push({ color: ORDER[base].color, bytes: ORDER[base].bytes * (1 - frac), partial: true });
    return out;
  }

  function ensureCircles(n) {
    while (circles.length < n) {
      const c = document.createElementNS(SVGNS, "circle");
      blobG.appendChild(c);
      circles.push(c);
    }
  }

  // ---------- render ----------
  function render() {
    const g = geom();

    // stations ride the valley: deeper layers sit lower. We keep the *current*
    // station at g.stationY, so the track tilts down on the way in and up on the
    // way out around the fixed packet.
    const dNow = depthAt(progress);
    let d = "";
    NODES.forEach(function (n, i) {
      const x = g.ax + (i - progress) * g.spx;
      const y = g.stationY + (depth(i) - dNow) * g.trackGap;
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      const el = nodeEls[i];
      el.style.transform = "translate(" + x + "px," + y + "px)";
      const onScreen = x > -160 && x < g.w + 160;
      el.style.opacity = onScreen ? "1" : "0";
      el.classList.toggle("active", Math.abs(i - progress) < 0.5);
    });
    trackPath.setAttribute("d", d);

    // blob rings — outer radius of each layer so its AREA ∝ its bytes
    const layers = layersAt(progress);
    let total = 0;
    layers.forEach(function (l) { total += l.bytes; });
    let cum = 0;
    const rings = layers.map(function (l) {
      cum += l.bytes;
      return { color: l.color, r: g.R * Math.sqrt(cum / total), partial: l.partial };
    });
    // draw outermost first so the bright core lands on top
    rings.sort(function (a, b) { return b.r - a.r; });
    ensureCircles(rings.length);
    circles.forEach(function (c, i) {
      if (i < rings.length) {
        const ring = rings[i];
        c.setAttribute("cx", g.ax); c.setAttribute("cy", g.blobY);
        c.setAttribute("r", Math.max(0, ring.r).toFixed(1));
        c.setAttribute("fill", "var(" + ring.color + ")");
        // the freshly-arriving (outermost, partial) ring gets a bright edge
        if (ring.partial && i === 0) { c.setAttribute("stroke", "#ffffff"); c.setAttribute("stroke-width", "2"); c.setAttribute("stroke-opacity", "0.8"); }
        else { c.removeAttribute("stroke"); }
        c.style.display = "";
      } else {
        c.style.display = "none";
      }
    });

    // tap target sized to the blob
    hit.style.width = hit.style.height = (g.R * 2) + "px";
    hit.style.transform = "translate(" + (g.ax - g.R) + "px," + (g.blobY - g.R) + "px)";

    // dots
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
