/**
 * @fileoverview What the model viewers share: reading volumes, the value conversions, colour
 * ramps and number formatting. Used by viewer3d.js (3D models) and section2d.js (2D sections).
 *
 * A volume is a .json header and a .u16 file of 16-bit values, written by the scripts in tools/.
 * Three kinds of value are used throughout:
 *   - physical: what the visitor reads and types, such as 100 ohm metres;
 *   - stored:   the physical value, or its log10 for fields stored as logs;
 *   - raw:      the 16-bit number in the file. 0 means "no value"; 1 to 65535 span the stored
 *               range given in the volume's header.
 *
 * Needs the vtk.js global, for its named colour ramps only.
 */
window.MATEKit = (() => {
  'use strict';

  /** Largest raw value. */
  const RAW_MAX = 65535;
  /** Least space between two numbers under the colour legend, in pixels. */
  const LABEL_GAP_PX = 6;

  /**
   * @typedef {{dims: !Array<number>, spacing_km: !Array<number>, extent_km: !Array<number>,
   *     scale: {lo: number, hi: number}, log: (boolean|undefined), axes: (!Array<string>|undefined)}}
   */
  let VolumeMeta;

  /**
   * Colour ramps defined here, as [fraction, hex] stops. Any other name is a vtk.js preset.
   * "ryb" has red at the low end, so conductive (low resistivity) is red.
   * @const {!Object<string, !Array<!Array<number|string>>>}
   */
  const RAMPS = {
    mt: [[0, '#7a0403'], [.125, '#d93806'], [.25, '#f9a41b'], [.42, '#e8e86a'], [.54, '#7fd67f'],
      [.71, '#2fa3d9'], [.875, '#3a4fc4'], [1, '#30123b']],
    ryb: [[0, '#a50026'], [.125, '#d73027'], [.25, '#f46d43'], [.375, '#fdae61'], [.5, '#ffffbf'],
      [.625, '#abd9e9'], [.75, '#74add1'], [.875, '#4575b4'], [1, '#313695']],
  };

  /**
   * Escapes text for use in HTML.
   * @param {*} text Value to escape.
   * @return {string} The escaped text.
   */
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  /**
   * Fetches a JSON file.
   * @param {string} url Address of the file.
   * @return {!Promise<*>} The parsed content.
   * @throws {Error} If the server does not return the file.
   */
  const fetchJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} could not be loaded (${response.status})`);
    return response.json();
  };

  /**
   * Reads one volume.
   * @param {string} stem File name without extension, inside volumes/.
   * @return {!Promise<{meta: !VolumeMeta, raw: !Uint16Array}>} Its header and raw values.
   * @throws {Error} If a file is missing or its size does not match the header.
   */
  const fetchVolume = async (stem) => {
    const meta = /** @type {!VolumeMeta} */ (await fetchJson(`volumes/${stem}.json`));
    const response = await fetch(`volumes/${stem}.u16`);
    if (!response.ok) throw new Error(`volumes/${stem}.u16 could not be loaded (${response.status})`);
    const raw = new Uint16Array(await response.arrayBuffer());
    const [nx, ny, nz] = meta.dims;
    if (raw.length !== nx * ny * nz) {
      throw new Error(`${stem}: ${raw.length} values, but the header says ${nx} × ${ny} × ${nz}`);
    }
    return {meta, raw};
  };

  /**
   * Formats a number to three significant figures, in exponent form when very large or small.
   * @param {number} v The number.
   * @return {string} The text.
   */
  const formatNumber = (v) => {
    const size = Math.abs(v);
    if (size === 0 || (size < 1e5 && size >= 1e-2)) return String(+v.toPrecision(3));
    return v.toExponential(1).replace('.0e', 'e');
  };

  /**
   * Removes the middle labels of a row that would touch a label already kept. The first and
   * last labels always stay.
   * @param {!HTMLElement} row Element whose children are the labels, in order.
   */
  const dropCrowdedLabels = (row) => {
    const labels = [...row.children];
    const kept = [labels[0], labels[labels.length - 1]].map((label) => label.getBoundingClientRect());
    labels.slice(1, -1).forEach((label) => {
      const box = label.getBoundingClientRect();
      const crowded = kept.some((other) => box.left < other.right + LABEL_GAP_PX && other.left < box.right + LABEL_GAP_PX);
      if (crowded) label.remove();
      else kept.push(box);
    });
  };

  /**
   * Picks round tick values across a range, aiming for about three steps.
   * @param {number} a Low end.
   * @param {number} b High end.
   * @return {!Array<number>} Tick values within the range.
   */
  const niceTicks = (a, b) => {
    const rough = (b - a) / 3;
    let step = Math.pow(10, Math.floor(Math.log10(rough)));
    const ratio = rough / step;
    step *= ratio >= 5 ? 5 : ratio >= 2 ? 2 : 1;
    const ticks = [];
    for (let t = Math.ceil(a / step - 1e-9) * step; t <= b + 1e-9; t += step) ticks.push(+t.toPrecision(12));
    return ticks;
  };

  /**
   * @param {string} hex Colour as "#rrggbb".
   * @return {!Array<number>} Red, green and blue, each 0 to 1.
   */
  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255);

  /**
   * @param {string} name Key of RAMPS, or a vtk.js preset name.
   * @return {!Array<!Array<number>>} The ramp's stops as [fraction, r, g, b], colours 0 to 1.
   * @throws {Error} If no ramp has that name.
   */
  const rampStops = (name) => {
    if (RAMPS[name]) return RAMPS[name].map(([at, hex]) => [at, ...hexToRgb(hex)]);
    const preset = vtk.Rendering.Core.vtkColorTransferFunction.vtkColorMaps.getPresetByName(name);
    if (!preset) throw new Error(`unknown colour ramp "${name}"`);
    const p = preset.RGBPoints;
    const first = p[0];
    const last = p[p.length - 4];
    const stops = [];
    for (let n = 0; n < p.length; n += 4) stops.push([(p[n] - first) / (last - first), p[n + 1], p[n + 2], p[n + 3]]);
    return stops;
  };

  /**
   * The conversions between physical, stored and raw values for one field.
   */
  class ValueScale {
    constructor() {
      /** @private {number} */
      this.lo_ = 0;
      /** @private {number} */
      this.hi_ = 1;
      /** @type {boolean} Whether the field is stored as log10. */
      this.isLog = true;
    }

    /** @param {!VolumeMeta} meta Header of the volume on show. */
    setStorage(meta) {
      this.lo_ = meta.scale.lo;
      this.hi_ = meta.scale.hi;
      this.isLog = meta.log !== false;
    }

    /**
     * @param {number} stored A stored value.
     * @return {number} The raw value (not rounded).
     */
    toRaw(stored) {
      return 1 + (stored - this.lo_) / (this.hi_ - this.lo_) * (RAW_MAX - 1);
    }

    /**
     * @param {number} physical A physical value.
     * @return {number} The stored value.
     */
    toStored(physical) {
      return this.isLog ? Math.log10(physical) : physical;
    }

    /**
     * @param {number} stored A stored value.
     * @return {number} The physical value.
     */
    toPhysical(stored) {
      return this.isLog ? Math.pow(10, stored) : stored;
    }

    /**
     * @param {number} fraction Position in the stored range, 0 to 1.
     * @return {number} The physical value there.
     */
    physicalAt(fraction) {
      return this.toPhysical(this.lo_ + fraction * (this.hi_ - this.lo_));
    }

    /**
     * @param {number} physical A typed value.
     * @return {boolean} Whether it can be shown on this scale.
     */
    isValid(physical) {
      return isFinite(physical) && (!this.isLog || physical > 0);
    }

    /**
     * Picks legend ticks at their true place: the two limits, plus every power of ten between
     * them (log fields) or the midpoint (linear fields). The caller leaves out any that do not
     * fit.
     * @param {number} low Lower limit, stored.
     * @param {number} high Upper limit, stored.
     * @return {!Array<number>} Tick positions, stored.
     */
    ticks(low, high) {
      if (!this.isLog) return [low, (low + high) / 2, high];
      const decades = [];
      for (let d = Math.ceil(low + 1e-9); d < high - 1e-9; d++) decades.push(d);
      return [low, ...decades, high];
    }
  }

  return {RAW_MAX, esc, fetchJson, fetchVolume, formatNumber, dropCrowdedLabels, niceTicks, rampStops, ValueScale};
})();
