/*
 * Property pricing module for "ارزش املاک" — adjustment model calibrated on Divar listings.
 * Works in Node (CommonJS) and in the browser (window.PropertyPricing). No dependencies.
 *
 *   const P = require('./pricing.js');
 *   const model = require('./out/pricing_model.json');
 *   const r = P.estimate(model, nearbyListings, { lat, lng, area, age, rooms, elevator, parking, corner });
 *
 * nearbyListings: array of { lat, lng, pricePerM2, area, age, rooms, elevator, parking, corner?, urgent?, barter? }
 *   (age = currentYear - builtYear; booleans may be 0/1/true/false). Pass ALL listings of the city (or a bbox
 *   around the point, >= a few hundred) — the module picks the k nearest itself.
 *
 * Returns { pricePerM2, totalPrice, low, high, base, adjustment, dmaxKm, confidence, breakdown, warnings }
 * All values are asking-price based (toman). Multiply by model.ask_to_deal_factor if you calibrate one on real deals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PropertyPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toXY(m, lat, lng) {
    const p = m.smoother.projection;
    return [(lng - p.lng0) * 111.32 * Math.cos(p.lat0 * Math.PI / 180), (lat - p.lat0) * 110.57];
  }

  // pandas.cut semantics: right-closed intervals (lo, hi]; first bin also contains lo
  function areaBeta(m, area) {
    const bins = m.area_bins;
    for (const b of bins) if (area > b.lo && area <= b.hi) return b;
    return area <= bins[0].hi ? bins[0] : bins[bins.length - 1];
  }
  function ageBeta(m, age) {
    const a = Math.max(0, Math.round(age));
    for (const b of m.age_bins) if (a >= b.lo && a <= b.hi) return b;
    return m.age_bins[m.age_bins.length - 1];
  }
  function roomsBeta(m, rooms) {
    const r = Math.max(0, Math.min(4, Math.round(rooms)));
    if (r <= 1) return { key: 'rooms_le1', beta: m.rooms.le1.beta_log };
    if (r === 2) return { key: 'rooms_2', beta: 0 };
    if (r === 3) return { key: 'rooms_3', beta: m.rooms.r3.beta_log };
    return { key: 'rooms_4plus', beta: m.rooms.r4plus.beta_log };
  }
  const flag = v => (v === true || v === 1 || v === '1') ? 1 : 0;

  // sum of beta over features that differ from the reference property (log scale)
  function logAdjustment(m, x, withControls) {
    const a = areaBeta(m, x.area), g = ageBeta(m, x.age), r = roomsBeta(m, x.rooms);
    const parts = [
      { key: 'area_' + a.label, beta: a.beta_log },
      { key: 'age_' + g.label, beta: g.beta_log },
      { key: r.key, beta: r.beta },
      { key: 'no_elevator', beta: (1 - flag(x.elevator)) * m.features.no_elevator.beta_log },
      { key: 'no_parking', beta: (1 - flag(x.parking)) * m.features.no_parking.beta_log },
      { key: 'corner', beta: flag(x.corner) * m.features.corner.beta_log }
    ];
    if (withControls) {
      parts.push({ key: 'urgent', beta: flag(x.urgent) * m.listing_controls.urgent_sale.beta_log });
      parts.push({ key: 'barter', beta: flag(x.barter) * m.listing_controls.barter.beta_log });
    }
    return { total: parts.reduce((s, p) => s + p.beta, 0), parts };
  }

  // price/m2 a listing would have if it were the reference property (log scale)
  function normalisedLog(m, l) { return Math.log(l.pricePerM2) - logAdjustment(m, l, true).total; }

  // tricube-weighted mean of the k nearest pool values (identical to the Python reference).
  // Uses quickselect (O(n)) instead of sorting the whole pool; only the k winners are sorted.
  function smooth(m, prep, q, skipIndex) {
    const k = m.smoother.k, xs = prep.xs, ys = prep.ys, vals = prep.vals, n = vals.length, d = new Float64Array(n);
    for (let i = 0; i < n; i++) { const dx = xs[i] - q[0], dy = ys[i] - q[1]; d[i] = Math.sqrt(dx * dx + dy * dy); }
    if (skipIndex >= 0 && skipIndex < n) d[skipIndex] = Infinity;
    const cnt = skipIndex >= 0 && skipIndex < n ? n - 1 : n, kk = Math.min(k, cnt);
    if (kk < Math.max(5, Math.floor(k / 3))) return { value: NaN, dmax: NaN };
    const idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
    let lo = 0, hi = n - 1; const target = kk - 1;
    while (lo < hi) {
      const pv = d[idx[(lo + hi) >> 1]]; let i = lo, j = hi;
      while (i <= j) {
        while (d[idx[i]] < pv) i++;
        while (d[idx[j]] > pv) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (target <= j) hi = j; else if (target >= i) lo = i; else break;
    }
    const sel = Array.prototype.slice.call(idx.subarray(0, kk)).sort((a, b) => d[a] - d[b]);
    const dmax = d[sel[kk - 1]] * 1.0001 + 1e-9;
    let sw = 0, sv = 0;
    for (const i of sel) {
      let w = Math.pow(1 - Math.pow(d[i] / dmax, 3), 3); if (w <= 0) w = 1e-6;
      sw += w; sv += w * vals[i];
    }
    return { value: sv / sw, dmax };
  }

  function prepare(model, listings) {
    const n = listings.length, xs = new Float64Array(n), ys = new Float64Array(n), vals = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = toXY(model, listings[i].lat, listings[i].lng); xs[i] = p[0]; ys[i] = p[1]; vals[i] = normalisedLog(model, listings[i]); }
    return { xs, ys, vals };
  }

  /**
   * @param model     parsed pricing_model.json
   * @param listings  nearby listings (see header). Pass `prepared` (from prepare()) for repeated queries.
   * @param input     { lat, lng, area, age, rooms, elevator, parking, corner }
   * @param opts      { prepared, skipIndex (testing only), askToDeal }
   */
  function estimate(model, listings, input, opts) {
    opts = opts || {};
    const warnings = [];
    const prep = opts.prepared || prepare(model, listings);
    const q = toXY(model, input.lat, input.lng);
    const s = opts.smoothed || smooth(model, prep, q, opts.skipIndex === undefined ? -1 : opts.skipIndex);
    if (!isFinite(s.value)) return { error: 'NOT_ENOUGH_LISTINGS', warnings: ['not enough nearby listings'] };
    const lr = model.valid_input_range.area_m2;
    if (input.area < lr[0] || input.area > lr[1]) warnings.push(`area outside calibrated range ${lr[0]}-${lr[1]} m2`);
    const adj = logAdjustment(model, input, false);
    const logPred = s.value + adj.total;
    const cr = model.confidence_rules;
    const confidence = s.dmax <= cr.dense_km ? 'dense' : (s.dmax <= cr.mid_km ? 'mid' : 'sparse');
    if (s.dmax > cr.low_confidence_if_dmax_km_above) warnings.push(`few listings nearby (k-th neighbour ${s.dmax.toFixed(1)} km away): low confidence`);
    const band = model.interval_log_residual_A[confidence];
    const f = (opts.askToDeal !== undefined ? opts.askToDeal : model.ask_to_deal_factor);
    const price = Math.exp(logPred) * f;
    const out = {
      pricePerM2: price,
      low: Math.exp(logPred + band.q10) * f,      // 80 % interval from cross-validated residuals
      high: Math.exp(logPred + band.q90) * f,
      base: Math.exp(s.value) * f,                // reference property (100 m2, new, 2 rooms, elevator+parking) at this point
      adjustment: Math.exp(adj.total),
      dmaxKm: s.dmax, confidence, warnings,
      breakdown: adj.parts.filter(p => Math.abs(p.beta) > 1e-12).map(p => ({ key: p.key, pct: (Math.exp(p.beta) - 1) * 100 })),
      _logPred: logPred, _logBase: s.value
    };
    if (input.area > 0) { out.totalPrice = price * input.area; out.totalLow = out.low * input.area; out.totalHigh = out.high * input.area; }
    return out;
  }

  /**
   * Fallback when listing attributes are NOT available, only the raw average price/m2 the app shows today
   * (arithmetic mean of nearby listings). Less accurate than estimate() — see validation.B_raw_base.
   */
  function estimateFromRawAverage(model, rawAvgPricePerM2, input, opts) {
    opts = opts || {};
    const adj = logAdjustment(model, input, false);
    const logPred = Math.log(rawAvgPricePerM2) + adj.total + model.mode_B_log_offset;
    const band = model.interval_log_residual_B.all;
    const f = (opts.askToDeal !== undefined ? opts.askToDeal : model.ask_to_deal_factor);
    const price = Math.exp(logPred) * f;
    return { pricePerM2: price, low: Math.exp(logPred + band.q10) * f, high: Math.exp(logPred + band.q90) * f,
             totalPrice: input.area > 0 ? price * input.area : undefined, adjustment: Math.exp(adj.total + model.mode_B_log_offset), _logPred: logPred };
  }

  function smoothAt(model, prep, lat, lng) { return smooth(model, prep, toXY(model, lat, lng), -1); }

  return { smoothAt, estimate, estimateFromRawAverage, prepare, normalisedLog, logAdjustment, toXY };
});
