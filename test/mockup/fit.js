/* Model fit for an inversion: how well the model's predicted response matches the measured data.
   Reads one fit file (written by tools/make_fit.py) and draws, under the viewer:
     - the run's headline numbers
     - the sites from above, coloured by RMS
     - RMS for every site and period
     - observed and predicted curves for the chosen site
   Choosing a site here marks it in the 3D viewer, and clicking a site in the viewer chooses it here.
   Only Geotools (RLM-3D) packages have a fit file so far. */
window.MATEFit = (function () {
  var NS = 'http://www.w3.org/2000/svg';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var el = function (tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  // RMS colour: two hues either side of a neutral grey at 1, on a log scale from 0.5 to 2.
  // Blue = fitted more closely than the errors, red = fitted worse.
  var LOW = [43, 108, 176], MID = [232, 231, 227], HIGH = [192, 57, 43];
  var rmsRGB = function (v) {
    if (v == null || !isFinite(v)) return [255, 255, 255];
    var t = Math.max(-1, Math.min(1, Math.log(v) / Math.LN2)), end = t < 0 ? LOW : HIGH, a = Math.abs(t);
    return MID.map(function (m, i) { return Math.round(m + (end[i] - m) * a); });
  };
  var css = function (c) { return 'rgb(' + c.join(',') + ')'; };
  var SERIES = ['#3F88C8', '#CE348A'];           // first and second component on the curves
  var MEASURES = [['total', 'All components'], ['zxy', 'Zxy'], ['zyx', 'Zyx'], ['zxx', 'Zxx'], ['zyy', 'Zyy']];
  var NAME = { zxx: 'Zxx', zxy: 'Zxy', zyx: 'Zyx', zyy: 'Zyy' };

  var num = function (v, d) { return v == null ? '–' : (+v).toFixed(d == null ? 2 : d); };
  var period = function (f) { var T = 1 / f; return (T >= 100 ? T.toFixed(0) : +T.toPrecision(2)) + ' s'; };
  var natural = function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); };

  var tip = null;
  var showTip = function (e, html) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'fit-tip'; document.body.appendChild(tip); }
    tip.innerHTML = html; tip.hidden = false;
    var w = tip.offsetWidth, x = e.clientX + 14;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    tip.style.left = Math.max(4, x) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
  };
  var hideTip = function () { if (tip) tip.hidden = true; };
  var hover = function (node, html) {
    node.addEventListener('pointermove', function (e) { showTip(e, typeof html === 'function' ? html() : html); });
    node.addEventListener('pointerleave', hideTip);
  };

  async function init(o) {
    var F = await (await fetch(o.url)).json();
    var box = $('fit'), ids = Object.keys(F.sites).sort(natural), pos = {};
    o.sites.forEach(function (s) { pos[s.id] = s; });
    var label = function (id) { return F.sites[id].label || id; };
    var freqs = F.freqs_hz, nf = freqs.length, fl = F.error_floors_percent;
    var chosen = ids[0], measure = 'total', pair = 'off';
    var worst = ids.slice().sort(function (a, b) { return F.sites[b].rms.total - F.sites[a].rms.total; })[0];
    var totals = ids.map(function (id) { return F.sites[id].rms.total; }).sort(function (a, b) { return a - b; });
    var floorText = (fl.zxy === fl.zyx ? 'Zxy, Zyx ' + fl.zxy + ' %' : 'Zxy ' + fl.zxy + ' %, Zyx ' + fl.zyx + ' %') + ' · ' +
      (fl.zxx === fl.zyy ? 'Zxx, Zyy ' + fl.zxx + ' %' : 'Zxx ' + fl.zxx + ' %, Zyy ' + fl.zyy + ' %');

    box.innerHTML =
      '<h2>Model fit</h2>' +
      '<p class="lead2">How closely the response predicted by the model matches the measured data. An RMS of 1 means the misfit is the same size as the data errors; above 1 is a looser fit, below 1 a closer one.</p>' +
      '<div class="fit-stats">' +
        '<div><b>' + num(F.nrms_final) + '</b><span>overall RMS</span></div>' +
        '<div><b>' + F.iterations + '</b><span>iterations</span></div>' +
        '<div><b>' + F.n_sites + '</b><span>sites</span></div>' +
        '<div><b>' + nf + '</b><span>periods, ' + period(freqs[0]) + ' to ' + period(freqs[nf - 1]) + '</span></div>' +
        '<div><b>' + num(totals[0]) + ' – ' + num(totals[totals.length - 1]) + '</b><span>RMS range across sites</span></div>' +
        '<div><b style="font-size:14px;line-height:1.7">' + esc(floorText) + '</b><span>error floors</span></div>' +
      '</div>' +
      '<div class="fit-bar"><label>Colour sites by RMS of <select id="fit-measure" aria-label="Colour sites by">' +
        MEASURES.map(function (m) { return '<option value="' + m[0] + '">' + m[1] + '</option>'; }).join('') + '</select></label>' +
        '<span class="fit-key">0.5<i style="background:linear-gradient(90deg,' + css(LOW) + ',' + css(MID) + ',' + css(HIGH) + ')"></i>2 &nbsp;(grey = 1)</span></div>' +
      '<div class="fit-grid">' +
        '<figure><figcaption>Sites from above <small>· click a site</small></figcaption><svg id="fit-map" role="img" aria-label="Map of sites coloured by RMS"></svg></figure>' +
        '<figure><figcaption>RMS at every site and period <small>· all components</small></figcaption><svg id="fit-heat" role="img" aria-label="RMS for every site and period"></svg></figure>' +
      '</div>' +
      '<div class="fit-site">' +
        '<div class="fit-bar" style="margin-bottom:0"><h3 id="fit-title"></h3>' +
          '<label>Site <select id="fit-pick" aria-label="Site">' + ids.map(function (id) { return '<option value="' + esc(id) + '">' + esc(label(id)) + '</option>'; }).join('') + '</select></label>' +
          '<label>Show <select id="fit-pair" aria-label="Components"><option value="off">Zxy and Zyx</option><option value="diag">Zxx and Zyy</option></select></label>' +
          '<button class="btn ghost" id="fit-worst" type="button" style="padding:5px 12px;font-size:12.5px">Go to the worst-fitted site</button></div>' +
        '<div class="fit-chips" id="fit-chips"></div>' +
        '<div class="fit-grid">' +
          '<figure><figcaption>Apparent resistivity <small>· Ω·m</small></figcaption><svg id="fit-rho" role="img" aria-label="Observed and predicted apparent resistivity"></svg></figure>' +
          '<figure><figcaption>Phase <small>· degrees</small></figcaption><svg id="fit-phs" role="img" aria-label="Observed and predicted phase"></svg></figure>' +
        '</div>' +
        '<div class="fit-legend" id="fit-legend"></div>' +
      '</div>' +
      '<p class="note">RMS depends on the error floors chosen for a run, so it describes this model and should not be used to rank models against each other. ' +
        'Totals and the site-and-period values are the inversion code\'s own (' + esc(F.code) + '); the values for single components were worked out from the same observed and predicted files. ' +
        'Curves are in the impedance axes used by the inversion (rotation ' + num(F.rotation_deg, 0) + '°). ' +
        '<a href="' + esc(o.url) + '" download>Download the fit data (JSON)</a></p>';
    box.hidden = false;

    // ── sites from above ──
    var map = $('fit-map'), xs = ids.map(function (id) { return pos[id].x; }), ys = ids.map(function (id) { return pos[id].y; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var MW = 460, pad = 34, k = (MW - 2 * pad) / (x1 - x0), MH = Math.round((y1 - y0) * k + 2 * pad);
    map.setAttribute('viewBox', '0 0 ' + MW + ' ' + MH);
    var px = function (x) { return pad + (x - x0) * k; }, py = function (y) { return MH - pad - (y - y0) * k; };
    el('text', { x: MW - 6, y: 14, 'text-anchor': 'end' }, map).textContent = 'N ↑';
    var barKm = Math.pow(10, Math.floor(Math.log10((x1 - x0) / 3)));
    el('line', { x1: pad, x2: pad + barKm * k, y1: MH - 10, y2: MH - 10, stroke: '#6C757D', 'stroke-width': 2 }, map);
    el('text', { x: pad + barKm * k + 6, y: MH - 6 }, map).textContent = barKm + ' km';
    var dots = {};
    ids.forEach(function (id) {
      var g = el('g', { 'class': 'hit' }, map);
      dots[id] = el('circle', { cx: px(pos[id].x), cy: py(pos[id].y), r: 8.5, stroke: '#4a4f55', 'stroke-width': 0.8 }, g);
      el('circle', { cx: px(pos[id].x), cy: py(pos[id].y), r: 13, fill: 'transparent' }, g);
      g.addEventListener('click', function () { choose(id, true); });
      hover(g, function () { return 'Site <b>' + esc(label(id)) + '</b> · RMS <b>' + num(F.sites[id].rms[measure]) + '</b>' + (measure === 'total' ? '' : ' (' + NAME[measure] + ')'); });
    });
    var mark = el('circle', { r: 12.5, fill: 'none', stroke: '#282572', 'stroke-width': 2.5, 'pointer-events': 'none' }, map);

    // ── every site and period ──
    var heat = $('fit-heat'), HL = 26, HT = 4, HB = 30, cw = (MW - HL - 6) / nf, ch = 5.6, HH = HT + ids.length * ch + HB;
    heat.setAttribute('viewBox', '0 0 ' + MW + ' ' + HH.toFixed(0));
    var lastLine = '';
    ids.forEach(function (id, r) {
      var line = label(id).replace(/\d.*$/, '');
      if (line !== lastLine) { el('text', { x: HL - 6, y: HT + r * ch + 9, 'text-anchor': 'end' }, heat).textContent = line; lastLine = line; }
      F.sites[id].by_period.forEach(function (v, c) {
        var cell = el('rect', { x: (HL + c * cw).toFixed(2), y: (HT + r * ch).toFixed(2), width: (cw - 0.6).toFixed(2), height: (ch - 0.6).toFixed(2), fill: css(rmsRGB(v)), 'class': 'hit' }, heat);
        cell.addEventListener('click', function () { choose(id, true); });
        hover(cell, 'Site <b>' + esc(label(id)) + '</b> · ' + period(freqs[c]) + ' · RMS <b>' + num(v) + '</b>');
      });
    });
    freqs.forEach(function (f, c) {
      var lg = Math.log10(1 / f);
      if (Math.abs(lg - Math.round(lg)) < 0.02) el('text', { x: HL + (c + 0.5) * cw, y: HH - 16, 'text-anchor': 'middle' }, heat).textContent = period(f);
    });
    el('text', { x: HL + nf * cw / 2, y: HH - 2, 'text-anchor': 'middle' }, heat).textContent = 'Period (short = shallow, long = deep)';
    var rowMark = el('rect', { x: HL - 2, width: nf * cw + 3.4, height: ch + 1.4, fill: 'none', stroke: '#282572', 'stroke-width': 1.6, 'pointer-events': 'none' }, heat);

    // ── curves for the chosen site ──
    var CW = 460, CH = 270, L = 46, R = 10, T = 8, Bm = 34;
    var logT = freqs.map(function (f) { return Math.log10(1 / f); }), tx0 = Math.floor(Math.min.apply(null, logT) + 1e-9), tx1 = Math.ceil(Math.max.apply(null, logT) - 1e-9);
    var X = function (lt) { return L + (lt - tx0) / (tx1 - tx0) * (CW - L - R); };
    var pow = function (e) { return e < -2 || e > 3 ? '1e' + e : String(+Math.pow(10, e).toPrecision(1)); };

    var frame = function (svg, lo, hi, ticks, fmt) {
      svg.textContent = ''; svg.setAttribute('viewBox', '0 0 ' + CW + ' ' + CH);
      var Y = function (v) { return T + (hi - v) / (hi - lo) * (CH - T - Bm); };
      ticks.forEach(function (v) {
        el('line', { x1: L, x2: CW - R, y1: Y(v), y2: Y(v), stroke: '#E4E6E9', 'stroke-width': 1 }, svg);
        el('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
      });
      for (var e = tx0; e <= tx1; e++) {
        el('line', { x1: X(e), x2: X(e), y1: T, y2: CH - Bm, stroke: '#E4E6E9', 'stroke-width': 1 }, svg);
        el('text', { x: X(e), y: CH - Bm + 15, 'text-anchor': 'middle' }, svg).textContent = pow(e);
      }
      el('text', { x: (L + CW - R) / 2, y: CH - 3, 'text-anchor': 'middle' }, svg).textContent = 'Period (s)';
      el('rect', { x: L, y: T, width: CW - L - R, height: CH - T - Bm, fill: 'none', stroke: '#CED4DA' }, svg);
      return Y;
    };

    // apparent resistivity and phase from Z (EDI field units), with one-sigma bars from the variance
    var curve = function (z, f, k, second, isObs) {
      var re = z.re[k], im = z.im[k];
      if (re == null || im == null) return null;
      var mag = Math.hypot(re, im), rho = 0.2 / f * mag * mag, ph = Math.atan2(im, re) * 180 / Math.PI;
      if (pair === 'off' && second) ph = Math.atan2(-im, -re) * 180 / Math.PI;      // Zyx sits in the opposite quadrant
      var out = { rho: rho, ph: ph };
      if (isObs && z.var && z.var[k] > 0) { var sd = Math.sqrt(z.var[k]); out.dRho = 0.4 / f * mag * sd; out.dPh = Math.min(90, sd / mag * 180 / Math.PI); }
      return out;
    };

    var drawCurves = function () {
      var s = F.sites[chosen], comps = pair === 'off' ? ['zxy', 'zyx'] : ['zxx', 'zyy'];
      var data = comps.map(function (c, n) {
        return { c: c, col: SERIES[n],
          obs: freqs.map(function (f, k) { return curve(s.obs[c], f, k, n === 1, true); }),
          prd: freqs.map(function (f, k) { return curve(s.prd[c], f, k, n === 1, false); }) };
      });
      var all = [];
      data.forEach(function (d) { d.obs.concat(d.prd).forEach(function (p) { if (p) all.push(p); }); });
      var lr = all.map(function (p) { return Math.log10(p.rho); }), r0 = Math.floor(Math.min.apply(null, lr)), r1 = Math.ceil(Math.max.apply(null, lr));
      if (r1 === r0) r1 = r0 + 1;
      var rt = []; for (var e = r0; e <= r1; e++) rt.push(e);
      var p0 = 0, p1 = 90, pt = [0, 15, 30, 45, 60, 75, 90];
      if (pair !== 'off' || all.some(function (p) { return p.ph < 0 || p.ph > 90; })) { p0 = -180; p1 = 180; pt = [-180, -90, 0, 90, 180]; }

      [['fit-rho', r0, r1, rt, pow, function (p) { return Math.log10(p.rho); }, function (p) { return p.dRho == null ? null : [Math.log10(Math.max(p.rho - p.dRho, p.rho * 1e-3)), Math.log10(p.rho + p.dRho)]; }, function (p) { return +p.rho.toPrecision(3) + ' Ω·m'; }],
       ['fit-phs', p0, p1, pt, String, function (p) { return p.ph; }, function (p) { return p.dPh == null ? null : [p.ph - p.dPh, p.ph + p.dPh]; }, function (p) { return p.ph.toFixed(1) + '°'; }]
      ].forEach(function (c) {
        var svg = $(c[0]), Y = frame(svg, c[1], c[2], c[3], c[4]), val = c[5], bar = c[6], say = c[7];
        var clamp = function (v) { return Math.max(c[1], Math.min(c[2], v)); };
        data.forEach(function (d) {
          var path = '';
          d.prd.forEach(function (p, k) { if (p) path += (path ? 'L' : 'M') + X(logT[k]).toFixed(1) + ' ' + Y(clamp(val(p))).toFixed(1); });
          el('path', { d: path, fill: 'none', stroke: d.col, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
        });
        data.forEach(function (d) {
          d.obs.forEach(function (p, k) {
            if (!p) return;
            var x = X(logT[k]), y = Y(clamp(val(p))), b = bar(p);
            if (b) el('line', { x1: x, x2: x, y1: Y(clamp(b[0])), y2: Y(clamp(b[1])), stroke: d.col, 'stroke-width': 1.2 }, svg);
            el('circle', { cx: x, cy: y, r: 4, fill: d.col, stroke: '#fff', 'stroke-width': 1.5 }, svg);
            var hit = el('circle', { cx: x, cy: y, r: 10, fill: 'transparent' }, svg);
            hover(hit, NAME[d.c] + ' · ' + period(freqs[k]) + '<br>observed <b>' + say(p) + '</b><br>predicted <b>' + (d.prd[k] ? say(d.prd[k]) : '–') + '</b>');
          });
        });
      });

      $('fit-legend').innerHTML = comps.map(function (c, n) {
        return '<span><i class="dot" style="background:' + SERIES[n] + '"></i>' + NAME[c] + ' observed, with error</span>' +
               '<span><i class="ln" style="background:' + SERIES[n] + '"></i>' + NAME[c] + ' predicted</span>';
      }).join('');
      $('fit-title').textContent = 'Site ' + label(chosen);
      $('fit-chips').innerHTML = [['total', 'All'], ['zxx', 'Zxx'], ['zxy', 'Zxy'], ['zyx', 'Zyx'], ['zyy', 'Zyy']].map(function (m) {
        return '<span>' + m[1] + ' RMS <b>' + num(s.rms[m[0]]) + '</b></span>';
      }).join('') + '<span>' + s.n + ' data</span>';
    };

    var paint = function () {
      var rgb = {};
      ids.forEach(function (id) { rgb[id] = rmsRGB(F.sites[id].rms[measure]); dots[id].setAttribute('fill', css(rgb[id])); });
      o.api.colour(rgb);
    };
    var choose = function (id, tell3d) {
      if (!F.sites[id]) return;
      chosen = id; $('fit-pick').value = id;
      mark.setAttribute('cx', px(pos[id].x)); mark.setAttribute('cy', py(pos[id].y));
      rowMark.setAttribute('y', (HT + ids.indexOf(id) * ch - 1).toFixed(2));
      drawCurves();
      if (tell3d) o.api.select(id);
    };

    $('fit-measure').addEventListener('change', function () { measure = this.value; paint(); });
    $('fit-pick').addEventListener('change', function () { choose(this.value, true); });
    $('fit-pair').addEventListener('change', function () { pair = this.value; drawCurves(); });
    $('fit-worst').addEventListener('click', function () { choose(worst, true); });
    o.api.onPick = function (id) { choose(id, false); };

    paint(); choose(chosen, true);
    window.__fit = { data: F, choose: choose, state: function () { return { chosen: chosen, measure: measure, pair: pair }; }, rmsRGB: rmsRGB, curve: function (id, c, k, obs) { return curve(F.sites[id][obs ? 'obs' : 'prd'][c], freqs[k], k, c === 'zyx', obs); } };
  }

  return { init: init };
})();
