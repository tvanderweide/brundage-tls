// viewer.js - Brundage TLS snow-depth viewer (DOM side). Pure logic is in core.js.
(function () {
  "use strict";
  const C = window.TLSCore;
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";

  let index = null, scans = [], times = [], cur = -1, token = 0;
  let current = null;                          // {tag, raw, w, h} of the scan on screen
  const cache = new Map();                     // tag -> Promise<{raw, w, h}>
  let dmin = 0, dmax = 1, greyFilled = false, autoRange = true;
  let selected = null;                         // [col, row] of the clicked cell
  const view = { scale: 1, tx: 0, ty: 0, fitted: false };
  const colCanvas = document.createElement("canvas");
  let colBuf = null;

  // ---------------------------------------------------------------- loading
  function showError(msg) {
    const e = $("error");
    e.textContent = msg;
    e.hidden = false;
  }

  // Banner when the last export is STALE_H or more hours old; rechecked while the page is open.
  const STALE_H = 18;
  function checkStale() {
    if (!index || !scans.length) return;
    const b = $("stale");
    b.hidden = !C.isStale(index.export_utc, Date.now(), STALE_H);
    if (!b.hidden) {
      const when = !Number.isNaN(C.parseUtc(index.export_utc))
        ? `${C.formatTime(index.export_utc.replace("Z", ""))} UTC` : "an unknown time";
      b.textContent = `Last update ${when}; the data may be out of date.`;
    }
  }

  // Read exact bytes: no colour-space conversion, no premultiplication where supported.
  async function readBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const blob = await res.blob();
    let img;
    if (window.createImageBitmap) {
      img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    } else {
      img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
    }
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    ctx.drawImage(img, 0, 0);
    return { raw: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
  }

  function getScan(i) {
    const s = scans[i];
    if (!cache.has(s.tag)) {
      const p = readBytes(s.url);
      p.catch(() => cache.delete(s.tag));
      cache.set(s.tag, p);
    }
    return cache.get(s.tag);
  }

  function pruneCache() {
    const keep = new Set([cur - 1, cur, cur + 1].filter((i) => i >= 0 && i < scans.length).map((i) => scans[i].tag));
    for (const k of cache.keys()) if (!keep.has(k)) cache.delete(k);
  }

  async function show(i) {
    if (!scans.length) return;
    const shown = current ? scans.findIndex((s) => s.tag === current.tag) : -1;
    cur = Math.max(0, Math.min(scans.length - 1, i));
    const my = ++token;
    $("error").hidden = true;
    updateControls();
    $("loading").hidden = false;
    try {
      const d = await getScan(cur);
      if (my !== token) return;                // a newer request has taken over
      current = { tag: scans[cur].tag, ...d };
      if (autoRange) applyAutoRange(); else recolour();
      if (!view.fitted) fit();
      draw();
      updateReadout();
      $("loading").hidden = true;
      for (const j of [cur - 1, cur + 1]) if (j >= 0 && j < scans.length) getScan(j).catch(() => {});
      pruneCache();
    } catch (e) {
      if (my !== token) return;
      $("loading").hidden = true;
      const failed = scans[cur].tag;
      if (shown >= 0) { cur = shown; updateControls(); }   // controls back to the map on screen
      showError(`Could not load scan ${failed}: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- map drawing
  function recolour() {
    if (!current) return;
    if (colCanvas.width !== current.w || colCanvas.height !== current.h) {
      colCanvas.width = current.w; colCanvas.height = current.h;
      colBuf = null;
    }
    if (!colBuf) colBuf = new ImageData(current.w, current.h);
    C.colourise(current.raw, colBuf.data, index.encoding.mm_offset, dmin, dmax, greyFilled);
    colCanvas.getContext("2d").putImageData(colBuf, 0, 0);
  }

  function canvasSize() {
    const cv = $("map"), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return { cssW: r.width, cssH: r.height, dpr };
  }

  // Bounding box of cells with data (alpha 255) in the scan on screen, plus a small margin.
  function dataBox() {
    const { raw, w, h } = current;
    let c0 = w, c1 = -1, r0 = h, r1 = -1;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (raw[(r * w + c) * 4 + 3] === 255) {
          if (c < c0) c0 = c; if (c > c1) c1 = c;
          if (r < r0) r0 = r; if (r > r1) r1 = r;
        }
      }
    }
    if (c1 < 0) return [0, 0, w, h];
    const m = 10;
    return [Math.max(0, c0 - m), Math.max(0, r0 - m), Math.min(w, c1 + 1 + m), Math.min(h, r1 + 1 + m)];
  }

  function fit() {
    if (!current) return;
    const { cssW, cssH } = canvasSize();
    const [c0, r0, c1, r1] = dataBox();
    view.scale = Math.min(cssW / (c1 - c0), cssH / (r1 - r0));
    view.tx = (cssW - (c1 - c0) * view.scale) / 2 - c0 * view.scale;
    view.ty = (cssH - (r1 - r0) * view.scale) / 2 - r0 * view.scale;
    view.fitted = true;
  }

  function draw() {
    const cv = $("map"), ctx = cv.getContext("2d"), { dpr } = canvasSize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!current) return;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
    ctx.drawImage(colCanvas, 0, 0);
    if (selected) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = view.tx + (selected[0] + 0.5) * view.scale, y = view.ty + (selected[1] + 0.5) * view.scale;
      const r = Math.max(6, view.scale);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#000";
      ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - r + 2, y - r + 2, 2 * r - 4, 2 * r - 4);
    }
  }

  function zoomAt(factor, x, y) {
    const s = Math.max(0.05, Math.min(64, view.scale * factor));
    const k = s / view.scale;
    view.tx = x - (x - view.tx) * k;
    view.ty = y - (y - view.ty) * k;
    view.scale = s;
    draw();
  }

  function cellAt(x, y) {
    if (!current) return null;
    const col = Math.floor((x - view.tx) / view.scale), row = Math.floor((y - view.ty) / view.scale);
    if (col < 0 || row < 0 || col >= current.w || row >= current.h) return null;
    return [col, row];
  }

  // ---------------------------------------------------------------- pointer input
  function setupPointer() {
    const cv = $("map"), pts = new Map();
    let moved = 0, pinch = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, pos(e));
      moved = 0;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      }
    });
    cv.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pos(e), q = pts.get(e.pointerId);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        view.tx += p[0] - q[0]; view.ty += p[1] - q[1];
        moved += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
        draw();
      } else if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch.d > 0) zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch.d = d;
        moved += 10;
      }
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pos(e);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (e.type === "pointerup" && moved < 5 && pts.size === 0) {
        selected = cellAt(p[0], p[1]);
        updateReadout();
        draw();
      }
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = pos(e);
      zoomAt(e.deltaY < 0 ? 1.25 : 0.8, p[0], p[1]);
    }, { passive: false });

    const centre = () => { const r = cv.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
    $("zoomIn").addEventListener("click", () => zoomAt(1.5, ...centre()));
    $("zoomOut").addEventListener("click", () => zoomAt(1 / 1.5, ...centre()));
    $("zoomFit").addEventListener("click", () => { fit(); draw(); });
    let rt = null;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { fit(); draw(); drawChart(); }, 100);
    });
  }

  // ---------------------------------------------------------------- panel
  const fmtM = (v, d = 3) => (v === null || v === undefined ? "–" : `${v.toFixed(d)} m`);
  const fmtPct = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)}%`);

  function updateControls() {
    const s = scans[cur];
    $("slider").value = String(cur);
    $("scanTime").textContent = `${C.formatTime(s.scanner_time)}`;
    $("picker").value = s.scanner_time.slice(0, 16);
    $("prev").disabled = cur <= 0;
    $("next").disabled = cur >= scans.length - 1;
    const st = $("stats");
    st.replaceChildren();
    const rows = [["Median depth", fmtM(s.median_depth_m)], ["Spread (NMAD)", fmtM(s.nmad_depth_m)],
      ["Measured coverage", fmtPct(s.coverage)], ["With interpolated", fmtPct(s.filled_coverage)],
      ["Storm scan", s.storm ? "yes" : "no"], ["Scan", s.tag]];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k; dd.textContent = v;
      st.append(dt, dd);
    }
    drawChart();
  }

  function updateReadout() {
    const el = $("readout");
    if (!selected || !current) return;
    const [col, row] = selected;
    const [x, y] = C.pixelToMap(col, row, index.grid.transform);
    const k = (row * current.w + col) * 4, r = current.raw;
    const p = C.decodePixel(r[k], r[k + 1], r[k + 2], r[k + 3], index.encoding.mm_offset);
    const where = `(E ${x.toFixed(2)}, N ${y.toFixed(2)})`;
    if (!p) { el.textContent = `No data\n${where}`; return; }
    const how = p.scanFilled && p.refFilled ? ", interpolated scan and reference surfaces"
      : p.scanFilled ? ", interpolated scan surface" : p.refFilled ? ", interpolated reference surface" : " Snow Depth";
    el.textContent = `${p.depth.toFixed(3)} m${how}\n${where}`;   // two lines (.readout: pre-line)
  }

  function setRange(a, b) {
    dmin = a; dmax = b;
    $("dmin").value = String(a); $("dmax").value = String(b);
    $("legMin").textContent = `${a.toFixed(2)} m`;
    $("legMid").textContent = `${((a + b) / 2).toFixed(2)} m`;
    $("legMax").textContent = `${b.toFixed(2)} m`;
    $("legUnder").textContent = `below ${a.toFixed(2)} m`;
    const lc = $("legendBar"), ctx = lc.getContext("2d");
    for (let i = 0; i < lc.width; i++) {
      const c = C.colourFor(a + (b - a) * (i / (lc.width - 1)), a, b);
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.fillRect(i, 0, 1, lc.height);
    }
    recolour();
    draw();
  }

  // Range from the display percentiles of the scan on screen, rounded outward to 1 cm.
  function applyAutoRange() {
    if (!current) return;
    const [pLo, pHi] = index.display.auto_percentiles;
    const r = C.percentileRange(current.raw, index.encoding.mm_offset, pLo, pHi);
    if (!r) { recolour(); return; }
    let a = Math.floor(r[0] * 100) / 100, b = Math.ceil(r[1] * 100) / 100;
    if (b <= a) b = a + 0.01;
    setRange(a, b);
  }

  function setupPanel() {
    $("slider").max = String(scans.length - 1);
    $("slider").addEventListener("input", (e) => show(+e.target.value));
    $("prev").addEventListener("click", () => show(cur - 1));
    $("next").addEventListener("click", () => show(cur + 1));
    const pk = $("picker");
    pk.min = scans[0].scanner_time.slice(0, 16);
    pk.max = scans[scans.length - 1].scanner_time.slice(0, 16);
    pk.addEventListener("change", () => {
      const i = C.nearestScan(times, pk.value);
      if (i >= 0) show(i);
    });
    const onRange = () => {
      const a = parseFloat($("dmin").value), b = parseFloat($("dmax").value);
      if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
        autoRange = false;                        // a typed range stays fixed across scans
        $("autoRange").checked = false;
        setRange(a, b);
      } else { $("dmin").value = String(dmin); $("dmax").value = String(dmax); }
    };
    $("dmin").addEventListener("change", onRange);
    $("dmax").addEventListener("change", onRange);
    $("autoRange").addEventListener("change", (e) => {
      autoRange = e.target.checked;
      if (autoRange) applyAutoRange();
    });
    const [pLo, pHi] = index.display.auto_percentiles;
    $("autoLabel").textContent = `Auto: middle ${100 - pLo - (100 - pHi)}% of each scan (${pLo}–${pHi}%)`;
    $("greyFilled").addEventListener("change", (e) => { greyFilled = e.target.checked; recolour(); draw(); });
    document.addEventListener("keydown", (e) => {
      if (e.target.closest && e.target.closest("input, button, select, textarea")) return;
      if (e.key === "ArrowLeft") show(cur - 1);
      if (e.key === "ArrowRight") show(cur + 1);
    });
    const sw = (id, c) => { $(id).style.background = `rgb(${c[0]},${c[1]},${c[2]})`; };
    sw("swUnder", C.UNDER); sw("swOver", C.OVER); sw("swFilled", C.FILLED_GREY);
    $("chartNote").textContent = `Each point is one scan: ${index.chart_note}. Open circles are storm scans. Click the chart to open the nearest scan.`;
  }

  // ---------------------------------------------------------------- chart
  function el(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  let chartX = null;
  function drawChart() {
    const svg = $("chart");
    const W = Math.max(280, svg.getBoundingClientRect().width), H = 240;
    const m = { l: 48, r: 12, t: 10, b: 28 };
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    if (!scans.length) return;
    const xs = times.map(C.timeKey);
    const vals = scans.map((s) => s.median_depth_m);
    const ok = vals.filter((v) => v !== null);
    const x0 = xs[0], x1 = xs.length > 1 ? xs[xs.length - 1] : xs[0] + 86400;
    let y0 = Math.min(0, ...ok), y1 = Math.max(0.1, ...ok);
    const step = niceStep(y1 - y0, 4);
    y0 = Math.floor(y0 / step) * step; y1 = Math.ceil(y1 / step) * step;
    const X = (t) => m.l + (t - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
    const Y = (v) => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
    chartX = { X, x0, x1, m, W };

    for (let v = y0; v <= y1 + step / 2; v += step) {
      svg.append(el("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: "axis" }));
      svg.append(el("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }, `${v.toFixed(step < 0.1 ? 2 : 1)} m`));
    }
    const day = 86400, nDays = (x1 - x0) / day, every = Math.max(1, Math.ceil(nDays / Math.max(1, (W - m.l - m.r) / 70)));
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (let t = Math.ceil(x0 / day) * day, k = 0; t <= x1; t += day, k++) {
      if (k % every) continue;
      const d = new Date(t * 1000);
      svg.append(el("line", { x1: X(t), x2: X(t), y1: H - m.b, y2: H - m.b + 4, class: "axis" }));
      svg.append(el("text", { x: X(t), y: H - 8, "text-anchor": "middle" }, `${months[d.getUTCMonth()]} ${d.getUTCDate()}`));
    }

    // Line through the scans; a scan with no median breaks it.
    let path = "", pen = "M";
    scans.forEach((s, i) => {
      if (vals[i] === null) { pen = "M"; return; }
      path += `${pen}${X(xs[i]).toFixed(1)},${Y(vals[i]).toFixed(1)}`;
      pen = "L";
    });
    svg.append(el("path", { d: path, class: "series" }));
    scans.forEach((s, i) => {
      if (vals[i] === null) return;
      svg.append(el("circle", { cx: X(xs[i]), cy: Y(vals[i]), r: 3, class: s.storm ? "pt storm" : "pt" }));
    });
    if (cur >= 0) {
      svg.append(el("line", { x1: X(xs[cur]), x2: X(xs[cur]), y1: m.t, y2: H - m.b, class: "curline" }));
      if (vals[cur] !== null) svg.append(el("circle", { cx: X(xs[cur]), cy: Y(vals[cur]), r: 6, class: "cur" }));
    }
  }

  function setupChart() {
    $("chart").addEventListener("click", (e) => {
      if (!chartX) return;
      const svg = $("chart"), r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (chartX.W / r.width);
      const t = chartX.x0 + (px - chartX.m.l) / (chartX.W - chartX.m.l - chartX.m.r) * (chartX.x1 - chartX.x0);
      let best = 0, bd = Infinity;
      times.forEach((s, i) => { const d = Math.abs(C.timeKey(s) - t); if (d < bd) { bd = d; best = i; } });
      show(best);
    });
  }

  // ---------------------------------------------------------------- start
  async function start() {
    try {
      const res = await fetch("index.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
      index = await res.json();
    } catch (e) {
      $("status").textContent = "";
      showError(`Could not load the scan list: ${e.message}`);
      return;
    }
    scans = index.scans;
    times = scans.map((s) => s.scanner_time);
    $("status").textContent = scans.length
      ? `${scans.length} scans · latest ${C.formatTime(index.latest_scan)} · exported ${C.formatTime(index.export_utc.replace("Z", ""))} UTC`
      : "No scans yet";
    if (!scans.length) return;
    checkStale();
    setInterval(checkStale, 10 * 60 * 1000);

    try {
      const s = await readBytes(index.sentinel.url);
      if (!C.sentinelOk(s.raw, index.sentinel.values)) throw new Error("pixel values changed by the browser");
    } catch (e) {
      showError(`This browser does not read the depth images exactly (${e.message}), so depths are not shown. Try a current Chrome, Edge or Firefox.`);
      return;
    }

    setupPointer();
    setupPanel();
    setupChart();
    setRange(index.display.min_m, index.display.max_m);    // until the first scan sets its own
    show(scans.length - 1);
  }

  start();
})();
