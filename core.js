// core.js - pure functions of the Brundage TLS snow-depth viewer (no DOM).
// Loaded by index.html as a plain script (window.TLSCore) and by test_viewer.mjs through require().
(function (root) {
  "use strict";

  // Pixel format written by production/make_web.py: R high byte, G low byte of depth in mm +
  // offset; B bit 0 scan surface filled, bit 1 reference filled; A 255 data, 0 no data.
  function decodePixel(r, g, b, a, mmOffset) {
    if (a !== 255) return null;
    return { depth: ((r * 256 + g) - mmOffset) / 1000, scanFilled: (b & 1) === 1, refFilled: (b & 2) === 2 };
  }

  // Scanner-clock strings "YYYY-MM-DDTHH:MM[:SS]" carry no time zone. They are turned into
  // seconds with Date.UTC only as an ordering coordinate, so the visitor's zone never applies.
  function timeKey(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s || "");
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  }

  // Index of the scan nearest to target; times sorted ascending; a tie goes to the earlier scan.
  function nearestScan(times, target) {
    const t = timeKey(target);
    if (!times.length || Number.isNaN(t)) return -1;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(timeKey(times[i]) - t);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  function formatTime(s) {
    return s ? s.replace("T", " ") : "";
  }

  // Colour map: viridis stops; below min and above max get their own colours.
  const STOPS = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
    [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
  const UNDER = [112, 22, 74];                 // dark red-purple: below the range
  const OVER = [253, 186, 116];                // light orange: above the range
  const FILLED_GREY = [120, 120, 120];         // darker grey: interpolated, when greyed out

  function colourFor(depth, min, max) {
    if (depth < min) return UNDER;
    if (depth > max) return OVER;
    const x = max > min ? (depth - min) / (max - min) : 0;
    const p = x * (STOPS.length - 1), i = Math.min(Math.floor(p), STOPS.length - 2), f = p - i;
    const a = STOPS[i], b = STOPS[i + 1];
    return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)];
  }

  // Fill an RGBA output buffer (display colours) from the encoded scan bytes.
  function colourise(src, out, mmOffset, min, max, greyFilled) {
    for (let k = 0; k < src.length; k += 4) {
      const p = decodePixel(src[k], src[k + 1], src[k + 2], src[k + 3], mmOffset);
      if (!p) { out[k + 3] = 0; continue; }
      const c = greyFilled && (p.scanFilled || p.refFilled) ? FILLED_GREY : colourFor(p.depth, min, max);
      out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2]; out[k + 3] = 255;
    }
    return out;
  }

  // Depth range [lo, hi] (m) between the pLo and pHi percentiles of the cells with data, from a
  // histogram of the encoded 1 mm values (exact to 1 mm). null when the scan has no data.
  function percentileRange(src, mmOffset, pLo, pHi) {
    const hist = new Uint32Array(65536);
    let n = 0;
    for (let k = 0; k < src.length; k += 4) {
      if (src[k + 3] !== 255) continue;
      hist[src[k] * 256 + src[k + 1]]++;
      n++;
    }
    if (!n) return null;
    const at = (p) => {
      const target = Math.max(1, Math.ceil((p / 100) * n));
      let c = 0;
      for (let v = 0; v < 65536; v++) { c += hist[v]; if (c >= target) return (v - mmOffset) / 1000; }
      return (65535 - mmOffset) / 1000;
    };
    return [at(pLo), at(pHi)];
  }

  // Centre of web cell (col, row) in map coordinates; t = affine [a, b, c, d, e, f] with
  // x = a*col + b*row + c, y = d*col + e*row + f (rasterio order).
  function pixelToMap(col, row, t) {
    const c = col + 0.5, r = row + 0.5;
    return [t[0] * c + t[1] * r + t[2], t[3] * c + t[4] * r + t[5]];
  }

  // Sentinel check: bytes read back from the canvas must equal what make_web.py wrote.
  function sentinelExpected(values) {
    const n = values.length, out = [];
    for (let i = 0; i < n; i++) out.push(values[i], values[(i + 2) % n], values[(i + 4) % n], 255);
    return out;
  }

  function sentinelOk(bytes, values) {
    const want = sentinelExpected(values);
    if (bytes.length < want.length) return false;
    for (let i = 0; i < want.length; i++) if (bytes[i] !== want[i]) return false;
    return true;
  }

  // True when the export time "YYYY-MM-DDTHH:MM:SSZ" (UTC) is at least `hours` old at nowMs, or
  // when any input is missing or invalid (fail safe: better a needless banner than a silent gap).
  function isStale(exportUtc, nowMs, hours) {
    const t = parseUtc(exportUtc);
    if (Number.isNaN(t) || !Number.isFinite(nowMs) || !(hours > 0)) return true;
    return nowMs - t >= hours * 3600 * 1000;
  }

  // "YYYY-MM-DDTHH:MM:SSZ" -> ms since 1970, or NaN for any other shape or an impossible date
  // (Date.UTC would silently roll month 13 into the next year, so the parts are round-tripped).
  function parseUtc(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s || "");
    if (!m) return NaN;
    const p = m.slice(1).map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]));
    const back = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(),
      d.getUTCMinutes(), d.getUTCSeconds()];
    return back.every((v, i) => v === p[i]) ? d.getTime() : NaN;
  }

  const api = { decodePixel, timeKey, nearestScan, formatTime, colourFor, colourise, percentileRange, pixelToMap,
    sentinelExpected, sentinelOk, isStale, parseUtc, UNDER, OVER, FILLED_GREY, STOPS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TLSCore = api;
})(typeof window !== "undefined" ? window : globalThis);
