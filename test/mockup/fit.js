/**
 * @fileoverview Model fit for an inversion: how well the model's predicted response matches the
 * measured data.
 *
 * Reads one fit file (written by tools/make_fit.py) and draws, under the viewer:
 *   - the run's headline numbers;
 *   - the sites from above, coloured by RMS;
 *   - RMS for every site and period;
 *   - observed and predicted curves for the chosen site.
 * Choosing a site here marks it in the 3D viewer, and clicking a site in the viewer chooses it
 * here. Only Geotools (RLM-3D) packages have a fit file so far.
 *
 * Exposes window.MATEFit.init(), called by viewer3d.js.
 */
window.MATEFit = (() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * RMS colours: two hues either side of a neutral grey at 1, on a log scale from 0.5 to 2.
   * Blue is fitted more closely than the errors, red is fitted worse.
   */
  const RMS_LOW = [43, 108, 176];
  const RMS_MID = [232, 231, 227];
  const RMS_HIGH = [192, 57, 43];

  /** MT convention: xy as red circles, yx as blue squares. xx and yy follow the same pairing. */
  const SERIES_COLOURS = ['#EA1E31', '#3F88C8'];
  const COMPONENT_NAME = {zxx: 'Zxx', zxy: 'Zxy', zyx: 'Zyx', zyy: 'Zyy'};
  /** What the sites can be coloured by: [key in the fit file, menu label]. */
  const MEASURES = [['total', 'All components'], ['zxy', 'Zxy'], ['zyx', 'Zyx'], ['zxx', 'Zxx'], ['zyy', 'Zyy']];
  /** Component pairs that can be plotted: menu value to the two components. */
  const PAIRS = {off: ['zxy', 'zyx'], diag: ['zxx', 'zyy']};

  /** Chart geometry, in SVG units. Every chart is CHART_WIDTH wide and scales to its column. */
  const CHART_WIDTH = 460;
  const MAP_PAD = 34;
  const HEAT = {left: 26, top: 4, bottom: 30, rowHeight: 5.6};
  const CURVE = {height: 270, left: 46, right: 10, top: 8, bottom: 34};

  /**
   * @param {string} id Element id.
   * @return {?HTMLElement} The element.
   */
  const $ = (id) => document.getElementById(id);

  /**
   * Escapes text for use in HTML.
   * @param {*} text Value to escape.
   * @return {string} The escaped text.
   */
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  /**
   * Makes an SVG element.
   * @param {string} tag Element name.
   * @param {!Object<string, (string|number)>} attrs Attributes.
   * @param {!Element=} parent Element to append it to.
   * @return {!SVGElement} The new element.
   */
  const svg = (tag, attrs, parent) => {
    const element = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((name) => element.setAttribute(name, attrs[name]));
    if (parent) parent.appendChild(element);
    return element;
  };

  /**
   * @param {?number} rms An RMS value.
   * @return {!Array<number>} Its colour as RGB, 0 to 255. White for no value.
   */
  const rmsColour = (rms) => {
    if (rms == null || !isFinite(rms)) return [255, 255, 255];
    const t = Math.max(-1, Math.min(1, Math.log(rms) / Math.LN2));
    const end = t < 0 ? RMS_LOW : RMS_HIGH;
    return RMS_MID.map((mid, n) => Math.round(mid + (end[n] - mid) * Math.abs(t)));
  };

  /**
   * @param {!Array<number>} rgb Red, green and blue, 0 to 255.
   * @return {string} The colour for CSS.
   */
  const cssRgb = (rgb) => `rgb(${rgb.join(',')})`;

  /**
   * @param {?number} v A number.
   * @param {number=} places Decimal places. Default 2.
   * @return {string} The number as text, or a dash for no value.
   */
  const fixed = (v, places = 2) => (v == null ? '–' : (+v).toFixed(places));

  /**
   * @param {number} hz A frequency.
   * @return {string} Its period, such as "0.01 s" or "1000 s".
   */
  const periodLabel = (hz) => {
    const seconds = 1 / hz;
    return `${seconds >= 100 ? seconds.toFixed(0) : +seconds.toPrecision(2)} s`;
  };

  /**
   * @param {number} exponent A power of ten.
   * @return {string} Its axis label, such as "0.01", "100" or "1e4".
   */
  const decadeLabel = (exponent) => (exponent < -2 || exponent > 3 ? `1e${exponent}` : String(+Math.pow(10, exponent).toPrecision(1)));

  /**
   * A small box that follows the pointer over chart marks.
   */
  class Tooltip {
    constructor() {
      /** @private {?HTMLElement} Made on first use. */
      this.box_ = null;
    }

    /**
     * Shows text for a mark while the pointer is over it.
     * @param {!Element} node The mark.
     * @param {string|function(): string} html The text, or a function giving the text now.
     */
    attach(node, html) {
      node.addEventListener('pointermove', (e) => this.show_(e, typeof html === 'function' ? html() : html));
      node.addEventListener('pointerleave', () => this.hide_());
    }

    /**
     * @param {!PointerEvent} e The pointer event.
     * @param {string} html What to show.
     * @private
     */
    show_(e, html) {
      if (!this.box_) {
        this.box_ = document.createElement('div');
        this.box_.className = 'fit-tip';
        document.body.appendChild(this.box_);
      }
      this.box_.innerHTML = html;
      this.box_.hidden = false;
      const width = this.box_.offsetWidth;
      let left = e.clientX + 14;
      if (left + width > window.innerWidth - 8) left = e.clientX - width - 14;    // flip to the pointer's left
      this.box_.style.left = `${Math.max(4, left)}px`;
      this.box_.style.top = `${e.clientY + 14}px`;
    }

    /** @private */
    hide_() {
      if (this.box_) this.box_.hidden = true;
    }
  }

  /**
   * The model-fit section of the page.
   */
  class FitPanel {
    /**
     * @param {!Object} fit Content of the fit file.
     * @param {!Array<{id: string, x: number, y: number}>} sites Site positions in km.
     * @param {!Object} layer The viewer's site layer: colour(byId), select(id) and an onPick property.
     * @param {string} url Address of the fit file, for the download link.
     */
    constructor(fit, sites, layer, url) {
      /** @private @const {!Object} */
      this.fit_ = fit;
      /** @private @const {!Object} */
      this.layer_ = layer;
      /** @private @const {!Object<string, {x: number, y: number}>} */
      this.position_ = {};
      sites.forEach((s) => { this.position_[s.id] = s; });
      /** @private @const {!Array<string>} Site ids in natural order (A2 before A10). */
      this.ids_ = Object.keys(fit.sites)
          .filter((id) => this.position_[id])
          .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
      const unplaced = Object.keys(fit.sites).length - this.ids_.length;
      if (unplaced) console.warn(`Model fit: ${unplaced} site(s) have no position and are left out.`);
      if (!this.ids_.length) throw new Error('the fit file has no site with a position');
      /** @private @const {!Array<number>} */
      this.freqs_ = fit.freqs_hz;
      /** @private @const {!Array<number>} log10 of each period. */
      this.logPeriods_ = this.freqs_.map((hz) => Math.log10(1 / hz));
      /** @private {string} Site whose curves are drawn. */
      this.chosen_ = this.ids_[0];
      /** @private {string} Key of MEASURES the sites are coloured by. */
      this.measure_ = 'total';
      /** @private {string} Key of PAIRS on the curve charts. */
      this.pair_ = 'off';
      /** @private @const {!Tooltip} */
      this.tip_ = new Tooltip();
      /** @private @const {!Object<string, !SVGElement>} Map dot by site id. */
      this.dots_ = {};
      /** @private {?SVGElement} Ring round the chosen site on the map. */
      this.mapMark_ = null;
      /** @private {?SVGElement} Box round the chosen site's row. */
      this.rowMark_ = null;
      /** @private {function(number): number} Map x in km to SVG units; set by drawMap_(). */
      this.mapX_ = (x) => x;
      /** @private {function(number): number} Map y in km to SVG units; set by drawMap_(). */
      this.mapY_ = (y) => y;

      this.build_(url);
      this.drawMap_();
      this.drawHeat_();
      this.bind_();
      this.paint_();
      this.choose(this.chosen_, false);     // nothing is marked in the 3D view until a site is picked
    }

    /**
     * @param {string} id A site id.
     * @return {string} The name to show for it.
     * @private
     */
    label_(id) {
      return this.fit_.sites[id].label || id;
    }

    /**
     * Writes the section's markup.
     * @param {string} url Address of the fit file.
     * @private
     */
    build_(url) {
      const fit = this.fit_;
      const freqs = this.freqs_;
      const floors = fit.error_floors_percent;
      const totals = this.ids_.map((id) => fit.sites[id].rms.total).sort((a, b) => a - b);
      const pairText = (a, b) => (floors[a] === floors[b] ?
        `${COMPONENT_NAME[a]}, ${COMPONENT_NAME[b]} ${floors[a]} %` :
        `${COMPONENT_NAME[a]} ${floors[a]} %, ${COMPONENT_NAME[b]} ${floors[b]} %`);
      const stat = (value, caption) => `<div><b>${value}</b><span>${caption}</span></div>`;
      const option = ([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`;
      const figure = (id, title, note, label) =>
        `<figure><figcaption>${title} <small>· ${note}</small></figcaption><svg id="${id}" role="img" aria-label="${label}"></svg></figure>`;

      const box = $('fit');
      box.innerHTML =
        '<div class="fit-head"><h2>Model fit</h2>' +
          '<button class="btn ghost" id="fit-toggle" type="button" aria-expanded="false" aria-controls="fit-body">Show sites and curves</button></div>' +
        '<div class="fit-stats">' +
          stat(fixed(fit.nrms_final), 'overall RMS') +
          stat(fit.iterations, 'iterations') +
          stat(fit.n_sites, 'sites') +
          stat(freqs.length, `periods, ${periodLabel(freqs[0])} to ${periodLabel(freqs[freqs.length - 1])}`) +
          stat(`${fixed(totals[0])} – ${fixed(totals[totals.length - 1])}`, 'RMS range across sites') +
          `<div><b class="fit-floors">${esc(`${pairText('zxy', 'zyx')} · ${pairText('zxx', 'zyy')}`)}</b><span>error floors</span></div>` +
        '</div>' +
        '<div id="fit-body" hidden>' +
          '<div class="fit-bar"><label>Colour sites by RMS of <select id="fit-measure" aria-label="Colour sites by">' +
            MEASURES.map(option).join('') + '</select></label>' +
            `<span class="fit-key">0.5<i style="background:linear-gradient(90deg,${cssRgb(RMS_LOW)},${cssRgb(RMS_MID)},${cssRgb(RMS_HIGH)})"></i>2 &nbsp;(grey = 1)</span></div>` +
          '<div class="fit-grid">' +
            figure('fit-map', 'Sites from above', 'click a site', 'Map of sites coloured by RMS') +
            figure('fit-heat', 'RMS at every site and period', 'all components', 'RMS for every site and period') +
          '</div>' +
          '<div class="fit-site">' +
            '<div class="fit-bar fit-bar-site"><h3 id="fit-title"></h3>' +
              '<label>Site <select id="fit-pick" aria-label="Site">' + this.ids_.map((id) => option([id, this.label_(id)])).join('') + '</select></label>' +
              '<label>Show <select id="fit-pair" aria-label="Components"><option value="off">Zxy and Zyx</option><option value="diag">Zxx and Zyy</option></select></label></div>' +
            '<div class="fit-chips" id="fit-chips"></div>' +
            '<div class="fit-grid">' +
              figure('fit-rho', 'Apparent resistivity', 'Ω·m', 'Observed and predicted apparent resistivity') +
              figure('fit-phs', 'Phase', 'degrees', 'Observed and predicted phase') +
            '</div>' +
            '<div class="fit-legend" id="fit-legend"></div>' +
          '</div>' +
          `<p class="note"><a href="${esc(url)}" download>Download the fit data (JSON)</a></p>` +
        '</div>';
      box.hidden = false;
    }

    /**
     * Connects the section's controls and the viewer's site clicks.
     * @private
     */
    bind_() {
      $('fit-toggle').addEventListener('click', () => this.setOpen($('fit-toggle').getAttribute('aria-expanded') !== 'true'));
      $('fit-measure').addEventListener('change', () => {
        this.measure_ = $('fit-measure').value;
        this.paint_();
      });
      $('fit-pick').addEventListener('change', () => this.choose($('fit-pick').value, true));
      $('fit-pair').addEventListener('change', () => {
        this.pair_ = $('fit-pair').value;
        this.drawCurves_();
      });
      this.layer_.onPick = (id) => {
        this.choose(id, false);
        this.setOpen(true);
      };
    }

    /**
     * Opens or closes the detailed part of the section.
     * @param {boolean} open Whether to show the sites and curves.
     */
    setOpen(open) {
      $('fit-body').hidden = !open;
      $('fit-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
      $('fit-toggle').textContent = open ? 'Hide sites and curves' : 'Show sites and curves';
    }

    /**
     * Chooses the site whose curves are drawn.
     * @param {string} id A site id; ignored if the fit file does not have it.
     * @param {boolean} tellViewer Whether to mark the site in the 3D viewer as well.
     */
    choose(id, tellViewer) {
      if (!this.ids_.includes(id)) return;
      this.chosen_ = id;
      $('fit-pick').value = id;
      this.mapMark_.setAttribute('cx', this.mapX_(this.position_[id].x));
      this.mapMark_.setAttribute('cy', this.mapY_(this.position_[id].y));
      this.rowMark_.setAttribute('y', (HEAT.top + this.ids_.indexOf(id) * HEAT.rowHeight - 1).toFixed(2));
      this.drawCurves_();
      if (tellViewer) this.layer_.select(id);
    }

    /**
     * Colours the sites, here and in the 3D viewer, by the chosen measure.
     * @private
     */
    paint_() {
      const byId = {};
      this.ids_.forEach((id) => {
        byId[id] = rmsColour(this.fit_.sites[id].rms[this.measure_]);
        this.dots_[id].setAttribute('fill', cssRgb(byId[id]));
      });
      this.layer_.colour(byId);
    }

    /**
     * Draws the sites from above, with north up and a scale bar.
     * @private
     */
    drawMap_() {
      const map = $('fit-map');
      const xs = this.ids_.map((id) => this.position_[id].x);
      const ys = this.ids_.map((id) => this.position_[id].y);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const spanX = Math.max(...xs) - x0 || 1;
      const perKm = (CHART_WIDTH - 2 * MAP_PAD) / spanX;
      const height = Math.round((Math.max(...ys) - y0) * perKm + 2 * MAP_PAD);
      this.mapX_ = (x) => MAP_PAD + (x - x0) * perKm;
      this.mapY_ = (y) => height - MAP_PAD - (y - y0) * perKm;

      map.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${height}`);
      svg('text', {x: CHART_WIDTH - 6, y: 14, 'text-anchor': 'end'}, map).textContent = 'N ↑';
      const barKm = Math.pow(10, Math.floor(Math.log10(spanX / 3)));
      svg('line', {x1: MAP_PAD, x2: MAP_PAD + barKm * perKm, y1: height - 10, y2: height - 10, stroke: '#6C757D', 'stroke-width': 2}, map);
      svg('text', {x: MAP_PAD + barKm * perKm + 6, y: height - 6}, map).textContent = `${barKm} km`;

      this.ids_.forEach((id) => {
        const cx = this.mapX_(this.position_[id].x);
        const cy = this.mapY_(this.position_[id].y);
        const group = svg('g', {'class': 'hit'}, map);
        this.dots_[id] = svg('circle', {cx, cy, r: 8.5, stroke: '#4a4f55', 'stroke-width': 0.8}, group);
        svg('circle', {cx, cy, r: 13, fill: 'transparent'}, group);     // a larger target to click
        group.addEventListener('click', () => this.choose(id, true));
        this.tip_.attach(group, () => {
          const which = this.measure_ === 'total' ? '' : ` (${COMPONENT_NAME[this.measure_]})`;
          return `Site <b>${esc(this.label_(id))}</b> · RMS <b>${fixed(this.fit_.sites[id].rms[this.measure_])}</b>${which}`;
        });
      });
      this.mapMark_ = svg('circle', {r: 12.5, fill: 'none', stroke: '#282572', 'stroke-width': 2.5, 'pointer-events': 'none'}, map);
    }

    /**
     * Draws RMS for every site (rows) and period (columns).
     * @private
     */
    drawHeat_() {
      const heat = $('fit-heat');
      const freqs = this.freqs_;
      const {left, top, bottom, rowHeight} = HEAT;
      const colWidth = (CHART_WIDTH - left - 6) / freqs.length;
      const height = top + this.ids_.length * rowHeight + bottom;
      heat.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${height.toFixed(0)}`);

      let lastLine = '';
      this.ids_.forEach((id, row) => {
        // One label per survey line: the site name up to its first digit.
        const line = this.label_(id).replace(/\d.*$/, '');
        if (line !== lastLine) {
          svg('text', {x: left - 6, y: top + row * rowHeight + 9, 'text-anchor': 'end'}, heat).textContent = line;
          lastLine = line;
        }
        this.fit_.sites[id].by_period.forEach((rms, col) => {
          const cell = svg('rect', {
            x: (left + col * colWidth).toFixed(2), y: (top + row * rowHeight).toFixed(2),
            width: (colWidth - 0.6).toFixed(2), height: (rowHeight - 0.6).toFixed(2),
            fill: cssRgb(rmsColour(rms)), 'class': 'hit',
          }, heat);
          cell.addEventListener('click', () => this.choose(id, true));
          this.tip_.attach(cell, `Site <b>${esc(this.label_(id))}</b> · ${periodLabel(freqs[col])} · RMS <b>${fixed(rms)}</b>`);
        });
      });
      // Label the periods that fall on a power of ten.
      this.logPeriods_.forEach((logT, col) => {
        if (Math.abs(logT - Math.round(logT)) >= 0.02) return;
        svg('text', {x: left + (col + 0.5) * colWidth, y: height - 16, 'text-anchor': 'middle'}, heat).textContent = periodLabel(freqs[col]);
      });
      svg('text', {x: left + freqs.length * colWidth / 2, y: height - 2, 'text-anchor': 'middle'}, heat).textContent =
        'Period (short = shallow, long = deep)';
      this.rowMark_ = svg('rect', {
        x: left - 2, width: freqs.length * colWidth + 3.4, height: rowHeight + 1.4,
        fill: 'none', stroke: '#282572', 'stroke-width': 1.6, 'pointer-events': 'none',
      }, heat);
    }

    /**
     * Converts one impedance value to apparent resistivity and phase.
     * @param {{re: !Array<?number>, im: !Array<?number>, var: (!Array<?number>|undefined)}} z One
     *     component of the impedance tensor, in EDI field units (mV/km/nT).
     * @param {number} k Index of the frequency.
     * @param {boolean} oppositeQuadrant Turn the phase by 180 degrees, as for Zyx.
     * @param {boolean} withErrors Add one-sigma bars from the variance.
     * @return {?{rho: number, ph: number, dRho: (number|undefined), dPh: (number|undefined)}}
     *     Resistivity in ohm metres and phase in degrees, or null where there is no datum.
     * @private
     */
    curvePoint_(z, k, oppositeQuadrant, withErrors) {
      const re = z.re[k];
      const im = z.im[k];
      if (re == null || im == null) return null;
      const hz = this.freqs_[k];
      const size = Math.hypot(re, im);
      const sign = oppositeQuadrant ? -1 : 1;
      const point = {
        rho: 0.2 / hz * size * size,
        ph: Math.atan2(sign * im, sign * re) * 180 / Math.PI,
      };
      if (withErrors && z.var && z.var[k] > 0) {
        const sigma = Math.sqrt(z.var[k]);
        point.dRho = 0.4 / hz * size * sigma;
        point.dPh = Math.min(90, sigma / size * 180 / Math.PI);
      }
      return point;
    }

    /**
     * Clears a curve chart and draws its grid, period axis and frame.
     * @param {!Element} chart The chart's svg element.
     * @param {number} low Value at the bottom of the chart.
     * @param {number} high Value at the top.
     * @param {!Array<number>} ticks Values to rule and label.
     * @param {function(number): string} format Label for a tick.
     * @return {{x: function(number): number, y: function(number): number}} Scales from
     *     log10 period and from value to SVG units.
     * @private
     */
    drawFrame_(chart, low, high, ticks, format) {
      const {height, left, right, top, bottom} = CURVE;
      const t0 = Math.floor(Math.min(...this.logPeriods_) + 1e-9);
      const t1 = Math.ceil(Math.max(...this.logPeriods_) - 1e-9);
      const x = (logT) => left + (logT - t0) / (t1 - t0) * (CHART_WIDTH - left - right);
      const y = (v) => top + (high - v) / (high - low) * (height - top - bottom);
      chart.textContent = '';
      chart.setAttribute('viewBox', `0 0 ${CHART_WIDTH} ${height}`);
      ticks.forEach((v) => {
        svg('line', {x1: left, x2: CHART_WIDTH - right, y1: y(v), y2: y(v), stroke: '#E4E6E9', 'stroke-width': 1}, chart);
        svg('text', {x: left - 6, y: y(v) + 4, 'text-anchor': 'end'}, chart).textContent = format(v);
      });
      for (let e = t0; e <= t1; e++) {
        svg('line', {x1: x(e), x2: x(e), y1: top, y2: height - bottom, stroke: '#E4E6E9', 'stroke-width': 1}, chart);
        svg('text', {x: x(e), y: height - bottom + 15, 'text-anchor': 'middle'}, chart).textContent = decadeLabel(e);
      }
      svg('text', {x: (left + CHART_WIDTH - right) / 2, y: height - 3, 'text-anchor': 'middle'}, chart).textContent = 'Period (s)';
      svg('rect', {x: left, y: top, width: CHART_WIDTH - left - right, height: height - top - bottom, fill: 'none', stroke: '#CED4DA'}, chart);
      return {x, y};
    }

    /**
     * Draws observed and predicted curves, the legend and the RMS figures for the chosen site.
     * @private
     */
    drawCurves_() {
      const site = this.fit_.sites[this.chosen_];
      const components = PAIRS[this.pair_];
      const offDiagonal = this.pair_ === 'off';
      const series = components.map((component, n) => {
        const points = (z, withErrors) => this.freqs_.map((_, k) => this.curvePoint_(z, k, offDiagonal && n === 1, withErrors));
        return {component, second: n === 1, colour: SERIES_COLOURS[n], observed: points(site.obs[component], true), predicted: points(site.prd[component], false)};
      });
      const all = series.flatMap((s) => s.observed.concat(s.predicted)).filter(Boolean);

      // Resistivity: whole decades round the data. Phase: 0 to 90 where everything fits, else a full turn.
      const logRho = all.map((p) => Math.log10(p.rho));
      const r0 = all.length ? Math.floor(Math.min(...logRho)) : 0;
      const r1 = Math.max(r0 + 1, all.length ? Math.ceil(Math.max(...logRho)) : 1);
      const rhoTicks = Array.from({length: r1 - r0 + 1}, (_, n) => r0 + n);
      const fullTurn = !offDiagonal || all.some((p) => p.ph < 0 || p.ph > 90);
      const charts = [{
        id: 'fit-rho', low: r0, high: r1, ticks: rhoTicks, format: decadeLabel,
        value: (p) => Math.log10(p.rho),
        bar: (p) => (p.dRho == null ? null : [Math.log10(Math.max(p.rho - p.dRho, p.rho * 1e-3)), Math.log10(p.rho + p.dRho)]),
        say: (p) => `${+p.rho.toPrecision(3)} Ω·m`,
      }, {
        id: 'fit-phs', low: fullTurn ? -180 : 0, high: fullTurn ? 180 : 90,
        ticks: fullTurn ? [-180, -90, 0, 90, 180] : [0, 15, 30, 45, 60, 75, 90], format: String,
        value: (p) => p.ph,
        bar: (p) => (p.dPh == null ? null : [p.ph - p.dPh, p.ph + p.dPh]),
        say: (p) => `${p.ph.toFixed(1)}°`,
      }];

      charts.forEach((c) => {
        const chart = $(c.id);
        const {x, y} = this.drawFrame_(chart, c.low, c.high, c.ticks, c.format);
        const inRange = (v) => Math.max(c.low, Math.min(c.high, v));
        // Predicted: lines, drawn first so the observed marks sit on top.
        series.forEach((s) => {
          let path = '';
          s.predicted.forEach((p, k) => {
            if (p) path += `${path ? 'L' : 'M'}${x(this.logPeriods_[k]).toFixed(1)} ${y(inRange(c.value(p))).toFixed(1)}`;
          });
          svg('path', {d: path, fill: 'none', stroke: s.colour, 'stroke-width': 2, 'stroke-linejoin': 'round'}, chart);
        });
        // Observed: a mark with its error bar, and a larger unseen target for the tooltip.
        series.forEach((s) => {
          s.observed.forEach((p, k) => {
            if (!p) return;
            const px = x(this.logPeriods_[k]);
            const py = y(inRange(c.value(p)));
            const bar = c.bar(p);
            if (bar) svg('line', {x1: px, x2: px, y1: y(inRange(bar[0])), y2: y(inRange(bar[1])), stroke: s.colour, 'stroke-width': 1.2}, chart);
            if (s.second) svg('rect', {x: px - 3.6, y: py - 3.6, width: 7.2, height: 7.2, fill: s.colour, stroke: '#fff', 'stroke-width': 1.5}, chart);
            else svg('circle', {cx: px, cy: py, r: 4, fill: s.colour, stroke: '#fff', 'stroke-width': 1.5}, chart);
            const target = svg('circle', {cx: px, cy: py, r: 10, fill: 'transparent'}, chart);
            const predicted = s.predicted[k] ? c.say(s.predicted[k]) : '–';
            this.tip_.attach(target, `${COMPONENT_NAME[s.component]} · ${periodLabel(this.freqs_[k])}<br>observed <b>${c.say(p)}</b><br>predicted <b>${predicted}</b>`);
          });
        });
      });

      $('fit-legend').innerHTML = series.map((s) =>
        `<span><i class="dot${s.second ? ' sq' : ''}" style="background:${s.colour}"></i>${COMPONENT_NAME[s.component]} observed, with error</span>` +
        `<span><i class="ln" style="background:${s.colour}"></i>${COMPONENT_NAME[s.component]} predicted</span>`).join('');
      $('fit-title').textContent = `Site ${this.label_(this.chosen_)}`;
      $('fit-chips').innerHTML = [['total', 'All'], ['zxx', 'Zxx'], ['zxy', 'Zxy'], ['zyx', 'Zyx'], ['zyy', 'Zyy']]
          .map(([key, name]) => `<span>${name} RMS <b>${fixed(site.rms[key])}</b></span>`).join('') + `<span>${site.n} data</span>`;
    }
  }

  /**
   * Loads a fit file and draws the model-fit section.
   * @param {{url: string, sites: !Array<{id: string, x: number, y: number}>, layer: !Object}} options
   *     url: address of the fit file. sites: site positions in km. layer: the viewer's site layer.
   * @return {!Promise<void>} Settles when the section is drawn. A fit file that cannot be read
   *     leaves the section hidden and logs why.
   */
  const init = async ({url, sites, layer}) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} could not be loaded (${response.status})`);
      new FitPanel(await response.json(), sites, layer, url);
    } catch (error) {
      console.error('Model fit not shown:', error);
    }
  };

  return {init};
})();
