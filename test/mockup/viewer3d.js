/**
 * @fileoverview Model viewer for the mockup. One page serves every model:
 * model-3d.html?scene=<name>.
 *
 * A scene (volumes/scenes.json) lists a model's fields, time steps, sites and saved views. Each
 * field and time step is a small uniform volume written by the scripts in tools/: a .json header
 * and a .u16 file of 16-bit values. A volume whose middle dimension is 1 is a 2D section.
 *
 * Three kinds of value are used throughout:
 *   - physical: what the visitor reads and types, such as 100 ohm metres;
 *   - stored:   the physical value, or its log10 for fields stored as logs;
 *   - raw:      the 16-bit number in the file. 0 means "no value"; 1 to 65535 span the stored
 *               range given in the volume's header.
 *
 * Layout of this file: constants and helpers, then one class per part of the picture (Stage,
 * ColourScale, Slices, Walls, SolidBody, Surfaces, BoxAxes, SiteLayer, Compass, Camera), then
 * Viewer, which reads the page's controls and drives the parts.
 *
 * Needs the vtk.js global. Hands the site layer to window.MATEFit (fit.js) when the scene has a
 * model-fit file.
 */
(() => {
  'use strict';

  const Core = vtk.Rendering.Core;
  const DataModel = vtk.Common.DataModel;
  const {vtkDataArray} = vtk.Common.Core;
  const {vtkImageMarchingCubes, vtkOutlineFilter} = vtk.Filters.General;
  const {vtkOrientationMarkerWidget} = vtk.Interaction.Widgets;

  /** Largest raw value; also what "no value" voxels of a 3D volume are redrawn as. */
  const RAW_MAX = 65535;
  /** Raw values of a 2D section below this are drawn see-through, so real values are kept above it. */
  const RAW_2D_FLOOR = 80;
  /** Marks a voxel as outside the solid body. */
  const OUTSIDE = -1e9;
  /** Most extra surfaces a visitor may ask for. */
  const MAX_SURFACES = 6;
  /** Height above the top of the model at which sites are drawn, in km. */
  const SITE_HEIGHT_KM = 0.05;
  /** How close to a site a click must land to choose it, in CSS pixels. */
  const PICK_RADIUS_PX = 14;
  /** Pointer travel beyond which a press counts as a drag, not a click, in CSS pixels. */
  const CLICK_SLOP_PX = 4;
  /** Time between steps while playing, in milliseconds. */
  const PLAY_INTERVAL_MS = 900;

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
   * Set views as [direction from the model towards the viewer, up direction].
   * @const {!Object<string, !Array<!Array<number>>>}
   */
  const VIEW_DIRECTIONS = {
    oblique: [[-1, -1.5, 0.9], [0, 0, 1]],
    above: [[0, 0, 1], [0, 1, 0]],
    south: [[0, -1, 0], [0, 0, 1]],
    north: [[0, 1, 0], [0, 0, 1]],
    east: [[1, 0, 0], [0, 0, 1]],
    west: [[-1, 0, 0], [0, 0, 1]],
  };

  /**
   * Extent controls: [input id, axis (0 east, 1 north, 2 up), crop key, +1 if measured from the low end].
   * @const {!Array<!Array<string|number>>}
   */
  const CUTS = [
    ['cut-w', 0, 'i0', 1], ['cut-e', 0, 'i1', -1], ['cut-s', 1, 'j0', 1],
    ['cut-n', 1, 'j1', -1], ['cut-b', 2, 'k0', 1], ['cut-t', 2, 'k1', -1],
  ];

  /** Compass arrow colours (east, north, up), the AusMT data colours. */
  const ARROW_RGB = [[234, 30, 49], [89, 143, 57], [63, 136, 200]];

  /**
   * @typedef {{dims: !Array<number>, spacing_km: !Array<number>, extent_km: !Array<number>,
   *     scale: {lo: number, hi: number}, log: (boolean|undefined), axes: (!Array<string>|undefined)}}
   */
  let VolumeMeta;

  /**
   * A loaded volume. gap marks the voxels with no value (3D only; null when there are none).
   * @typedef {{meta: !VolumeMeta, raw: !Uint16Array, gap: ?Uint8Array}}
   */
  let Volume;

  /**
   * First and last voxel on show along each axis.
   * @typedef {{i0: number, i1: number, j0: number, j1: number, k0: number, k1: number}}
   */
  let Crop;

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
   * Shows or hides an element, if the page has it.
   * @param {string} id Element id.
   * @param {boolean} on Whether to show it.
   */
  const show = (id, on) => {
    const element = $(id);
    if (element) element.hidden = !on;
  };

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
   * Formats a number to three significant figures, in exponent form when very large or small.
   * @param {number} v The number.
   * @return {string} The text.
   */
  const formatNumber = (v) => {
    const size = Math.abs(v);
    return (size !== 0 && (size >= 1e5 || size < 1e-2)) ? v.toExponential(1) : String(+v.toPrecision(3));
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
   * Splits typed text into numbers.
   * @param {string} text Values separated by commas, semicolons or spaces.
   * @return {!Array<number>} The values; NaN where an entry is not a number.
   */
  const parseNumberList = (text) => text.split(/[,;\s]+/).filter(Boolean).map(Number);

  /**
   * @param {string} name Scalar array name.
   * @param {!ArrayBufferView} values The values.
   * @param {number} components Values per point.
   * @return {!Object} A vtkDataArray.
   */
  const dataArray = (name, values, components) => vtkDataArray.newInstance({name, values, numberOfComponents: components});

  /**
   * Loads volumes on demand and keeps them.
   */
  class VolumeStore {
    constructor() {
      /** @private @const {!Map<string, !Promise<!Volume>>} */
      this.loading_ = new Map();
    }

    /**
     * @param {string} stem File name without extension, inside volumes/.
     * @return {!Promise<!Volume>} The volume. A request already under way is shared.
     */
    load(stem) {
      if (!this.loading_.has(stem)) {
        const request = VolumeStore.fetch_(stem);
        request.catch(() => this.loading_.delete(stem));   // a failed load may be tried again
        this.loading_.set(stem, request);
      }
      return this.loading_.get(stem);
    }

    /**
     * @param {string} stem File name without extension.
     * @return {!Promise<!Volume>} The volume, with "no value" voxels prepared for drawing.
     * @private
     */
    static async fetch_(stem) {
      const meta = /** @type {!VolumeMeta} */ (await fetchJson(`volumes/${stem}.json`));
      const response = await fetch(`volumes/${stem}.u16`);
      if (!response.ok) throw new Error(`volumes/${stem}.u16 could not be loaded (${response.status})`);
      const raw = new Uint16Array(await response.arrayBuffer());
      const [nx, ny, nz] = meta.dims;
      if (raw.length !== nx * ny * nz) {
        throw new Error(`${stem}: ${raw.length} values, but the header says ${nx} × ${ny} × ${nz}`);
      }
      let gap = null;
      if (ny !== 1) {
        // 3D: remember where there is no value (above the ground surface), then draw those
        // voxels as the top of the scale so slices are not left with holes.
        for (let n = 0; n < raw.length; n++) {
          if (raw[n] !== 0) continue;
          if (!gap) gap = new Uint8Array(raw.length);
          gap[n] = 1;
          raw[n] = RAW_MAX;
        }
      } else {
        // 2D: gaps stay 0 and are drawn see-through. That cut-off is not sharp, so real values
        // are kept clear of it (80 of 65535 is 0.1 % of the range).
        for (let n = 0; n < raw.length; n++) {
          if (raw[n] !== 0 && raw[n] < RAW_2D_FLOOR) raw[n] = RAW_2D_FLOOR;
        }
      }
      return {meta, raw, gap};
    }
  }

  /**
   * The render window and the part of the model on show. Every other part draws from it.
   *
   * Cutting in from a side shrinks the crop box; slices, solid, surfaces and axes all follow.
   * Vertical exaggeration stretches every registered actor upward.
   */
  class Stage {
    /**
     * @param {!HTMLElement} container Element the picture is drawn into.
     * @param {!Volume} volume First volume; fixes the grid for the scene.
     */
    constructor(container, volume) {
      const {meta} = volume;
      /** @const {!Array<number>} Voxels along east, north and up. */
      this.dims = meta.dims.slice();
      /** @const {!Array<number>} Voxel size in km. */
      this.spacing = meta.spacing_km.slice();
      /** @const {number} Height of the whole model in km. */
      this.depthKm = meta.extent_km[2];
      /** @const {boolean} */
      this.is2d = this.dims[1] === 1;
      /** @type {!Volume} */
      this.volume = volume;
      /** @type {!Crop} */
      this.crop = this.fullCrop();
      /** @type {!Array<number>} Voxels on show along each axis. */
      this.cropDims = this.dims.slice();
      /** @type {!Array<number>} Bounds of the part on show, in km. */
      this.bounds = [0, 0, 0, 0, 0, 0];
      /** @type {!Array<number>} Centre of the part on show, in km. */
      this.centre = [0, 0, 0];
      /** @type {number} Vertical exaggeration. */
      this.exaggeration = 1;

      /** @const {!Object} vtkImageData holding the part on show. */
      this.image = DataModel.vtkImageData.newInstance();
      this.image.setSpacing(this.spacing[0], this.is2d ? 1 : this.spacing[1], this.spacing[2]);

      /** @const {!Object} */
      this.window = vtk.Rendering.Misc.vtkGenericRenderWindow.newInstance({background: [1, 1, 1]});
      this.window.setContainer(container);
      this.window.resize();
      /** @const {!Object} */
      this.renderer = this.window.getRenderer();
      /** @const {!Object} */
      this.renderWindow = this.window.getRenderWindow();
      /** @const {!Object} */
      this.camera = this.renderer.getActiveCamera();
      /** @private @const {!Set<!Object>} Actors that stretch with the exaggeration. */
      this.scaled_ = new Set();

      this.setVolume(volume);
      new ResizeObserver(() => {
        this.window.resize();
        this.render();
      }).observe(container);
    }

    /** @return {!Crop} The crop box of the whole model. */
    fullCrop() {
      const [nx, ny, nz] = this.dims;
      return {i0: 0, i1: nx - 1, j0: 0, j1: ny - 1, k0: 0, k1: nz - 1};
    }

    /** @return {boolean} Whether the whole model is on show. */
    isUncut() {
      return this.cropDims.every((n, axis) => n === this.dims[axis]);
    }

    /**
     * @param {number} i Voxel east of the crop's west side.
     * @param {number} j Voxel north of the crop's south side.
     * @param {number} k Voxel above the crop's base.
     * @return {number} Index of that voxel in the whole volume.
     */
    indexOf(i, j, k) {
      const [nx, ny] = this.dims;
      return this.crop.i0 + i + nx * (this.crop.j0 + j + ny * (this.crop.k0 + k));
    }

    /**
     * Puts a volume on show, keeping the current crop.
     * @param {!Volume} volume Volume on the scene's grid.
     * @throws {Error} If the volume's grid differs from the scene's.
     */
    setVolume(volume) {
      if (volume.meta.dims.some((n, axis) => n !== this.dims[axis])) {
        throw new Error('this field is on a different grid from the first one');
      }
      this.volume = volume;
      this.fillImage_();
    }

    /**
     * Changes the part of the model on show.
     * @param {!Crop} crop The new crop box.
     */
    setCrop(crop) {
      this.crop = crop;
      this.fillImage_();
    }

    /**
     * Copies the cropped part of the volume into the image and updates bounds and centre.
     * @private
     */
    fillImage_() {
      const [nx, ny, nz] = this.dims;
      const {crop, spacing} = this;
      const {raw} = this.volume;
      const cx = crop.i1 - crop.i0 + 1;
      const cy = crop.j1 - crop.j0 + 1;
      const cz = crop.k1 - crop.k0 + 1;
      this.cropDims = [cx, cy, cz];
      let values = raw;
      if (cx !== nx || cy !== ny || cz !== nz) {
        values = new Uint16Array(cx * cy * cz);
        for (let z = 0; z < cz; z++) {
          for (let y = 0; y < cy; y++) {
            const from = this.indexOf(0, y, z);
            values.set(raw.subarray(from, from + cx), cx * (y + cy * z));
          }
        }
      }
      this.image.setDimensions(cx, cy, cz);
      // z = 0 stays at the top of the whole model, whatever is cut away.
      this.image.setOrigin(crop.i0 * spacing[0], this.is2d ? 0 : crop.j0 * spacing[1], -this.depthKm + crop.k0 * spacing[2]);
      this.image.getPointData().setScalars(dataArray('v', values, 1));
      this.image.modified();
      const b = this.image.getBounds();
      this.bounds = b;
      this.centre = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
    }

    /**
     * Adds an actor to the picture.
     * @param {!Object} actor A vtk actor.
     * @param {boolean=} stretches Whether it follows the vertical exaggeration. Default true.
     */
    add(actor, stretches = true) {
      this.renderer.addActor(actor);
      if (stretches) {
        this.scaled_.add(actor);
        actor.setScale(1, 1, this.exaggeration);
      }
    }

    /** @param {!Object} actor An actor added with add(). */
    remove(actor) {
      this.renderer.removeActor(actor);
      this.scaled_.delete(actor);
    }

    /** @param {number} factor Vertical exaggeration; 1 is true scale. */
    setExaggeration(factor) {
      this.exaggeration = factor;
      this.scaled_.forEach((actor) => actor.setScale(1, 1, factor));
    }

    /**
     * @param {number} x East, km.
     * @param {number} y North, km.
     * @param {number} z Up, km, before exaggeration.
     * @return {!Array<number>} Position in canvas pixels, origin bottom left.
     */
    toCanvas(x, y, z) {
      return this.window.getApiSpecificRenderWindow().worldToDisplay(x, y, z * this.exaggeration, this.renderer);
    }

    /** Fits the whole picture in the window without changing the viewing direction. */
    reframe() {
      this.renderer.resetCamera();
      this.renderer.resetCameraClippingRange();
      this.render();
    }

    /** Redraws the picture. */
    render() {
      this.renderWindow.render();
    }
  }

  /**
   * The colour scale: a named ramp stretched between two limits, and the conversions between
   * physical, stored and raw values for the field on show.
   */
  class ColourScale {
    constructor() {
      /** @const {!Object} vtkColorTransferFunction over raw values. */
      this.transfer = Core.vtkColorTransferFunction.newInstance();
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
     * Stretches a ramp between two limits.
     * @param {number} low Lower limit, stored.
     * @param {number} high Upper limit, stored.
     * @param {string} rampName Key of RAMPS, or a vtk.js preset name.
     * @param {boolean} reversed Whether to run the ramp backwards.
     * @return {!Array<!Array<number>>} The stops used, as [fraction, r, g, b].
     */
    apply(low, high, rampName, reversed) {
      let stops = ColourScale.ramp_(rampName);
      if (reversed) stops = stops.map(([at, r, g, b]) => [1 - at, r, g, b]).reverse();
      this.transfer.removeAllPoints();
      stops.forEach(([at, r, g, b]) => this.transfer.addRGBPoint(this.toRaw(low + at * (high - low)), r, g, b));
      return stops;
    }

    /**
     * @param {number} raw A raw value.
     * @param {!Array<number>} out Receives red, green and blue, each 0 to 1.
     */
    colourOfRaw(raw, out) {
      this.transfer.getColor(raw, out);
    }

    /**
     * @param {number} stored A stored value.
     * @return {!Array<number>} Its colour, darkened a little so a lit surface does not wash out.
     */
    surfaceColour(stored) {
      const c = [0, 0, 0];
      this.transfer.getColor(this.toRaw(stored), c);
      return c.map((v) => v * 0.85);
    }

    /**
     * Picks legend ticks at their true place: the two limits, plus powers of ten (log fields)
     * or the midpoint (linear fields).
     * @param {number} low Lower limit, stored.
     * @param {number} high Upper limit, stored.
     * @return {!Array<number>} Tick positions, stored.
     */
    ticks(low, high) {
      const span = high - low;
      if (!this.isLog) return [low, (low + high) / 2, high];
      let decades = [];
      for (let d = Math.ceil(low + 1e-9); d < high - 1e-9; d++) {
        if (d - low > 0.14 * span && high - d > 0.14 * span) decades.push(d);   // clear of the end labels
      }
      if (decades.length > 3) {
        const every = Math.ceil(decades.length / 3);
        decades = decades.filter((_, n) => n % every === 0);
      }
      return [low, ...decades, high];
    }

    /**
     * @param {string} name Ramp name.
     * @return {!Array<!Array<number>>} Stops as [fraction, r, g, b].
     * @private
     */
    static ramp_(name) {
      if (RAMPS[name]) return RAMPS[name].map(([at, hex]) => [at, ...hexToRgb(hex)]);
      const preset = Core.vtkColorTransferFunction.vtkColorMaps.getPresetByName(name);
      if (!preset) throw new Error(`unknown colour ramp "${name}"`);
      const p = preset.RGBPoints;
      const first = p[0];
      const last = p[p.length - 4];
      const stops = [];
      for (let n = 0; n < p.length; n += 4) stops.push([(p[n] - first) / (last - first), p[n + 1], p[n + 2], p[n + 3]]);
      return stops;
    }
  }

  /**
   * Three flat sections through the model, one across each axis, showing the model's own cells
   * unsmoothed. A 2D section uses only the middle one.
   */
  class Slices {
    /**
     * @param {!Stage} stage The stage.
     * @param {!ColourScale} scale The colour scale.
     */
    constructor(stage, scale) {
      /** @private @const {!Stage} */
      this.stage_ = stage;
      /** @private @const {!Object<string, {mapper: !Object, actor: !Object}>} */
      this.byAxis_ = {};
      ['i', 'j', 'k'].forEach((axis) => {
        const mapper = Core.vtkImageMapper.newInstance();
        mapper.setInputData(stage.image);
        const actor = Core.vtkImageSlice.newInstance();
        actor.setMapper(mapper);
        const property = actor.getProperty();
        property.setRGBTransferFunction(0, scale.transfer);
        property.setUseLookupTableScalarRange(true);
        property.setInterpolationTypeToNearest();
        if (stage.is2d) {
          // See-through where there is no value (raw 0), solid from RAW_2D_FLOOR up.
          const opacity = DataModel.vtkPiecewiseFunction.newInstance();
          opacity.addPoint(0, 0);
          opacity.addPoint(30, 0);
          opacity.addPoint(RAW_2D_FLOOR - 1, 1);
          opacity.addPoint(RAW_MAX, 1);
          property.setPiecewiseFunction(0, opacity);
        }
        stage.add(actor);
        this.byAxis_[axis] = {mapper, actor};
      });
    }

    /**
     * Places and shows one section.
     * @param {string} axis 'i' (across east), 'j' (across north) or 'k' (level).
     * @param {number} index Voxel in the whole model; moved into the part on show if outside it.
     * @param {boolean} visible Whether to draw it.
     * @param {number} opacity 0 to 1.
     */
    set(axis, index, visible, opacity) {
      const n = 'ijk'.indexOf(axis);
      const first = this.stage_.crop[`${axis}0`];
      const local = Math.max(0, Math.min(this.stage_.cropDims[n] - 1, index - first));
      const {mapper, actor} = this.byAxis_[axis];
      mapper[`set${axis.toUpperCase()}Slice`](local);
      actor.setVisibility(visible);
      actor.getProperty().setOpacity(opacity);
    }
  }

  /**
   * Walls and floor (3D): the six outer faces of the part on show, coloured by the model. A face
   * turned towards the viewer is not drawn, so from any side you look into the box and see the
   * far walls and the floor behind whatever is inside.
   */
  class Walls {
    /**
     * @param {!Stage} stage The stage.
     * @param {!ColourScale} scale The colour scale.
     */
    constructor(stage, scale) {
      /** @private @const {!Stage} */
      this.stage_ = stage;
      /** @private @const {!ColourScale} */
      this.scale_ = scale;
      /** @private @const {!Object} */
      this.poly_ = DataModel.vtkPolyData.newInstance();
      const mapper = Core.vtkMapper.newInstance();
      mapper.setInputData(this.poly_);
      mapper.setScalarModeToUsePointData();
      mapper.setColorModeToDirectScalars();
      /** @const {!Object} */
      this.actor = Core.vtkActor.newInstance();
      this.actor.setMapper(mapper);
      const property = this.actor.getProperty();
      property.setFrontfaceCulling(true);
      property.setBackfaceCulling(false);
      property.setAmbient(1);     // flat colour: the walls are a backdrop, not a lit object
      property.setDiffuse(0);
      property.setSpecular(0);
      this.actor.setVisibility(false);
      stage.add(this.actor);
    }

    /**
     * Rebuilds the faces. Needed when the data, the colours or the extent change.
     */
    update() {
      const stage = this.stage_;
      const [cx, cy, cz] = stage.cropDims;
      const {raw} = stage.volume;
      const origin = stage.image.getOrigin();
      const sp = stage.spacing;
      const nPoints = 2 * (cy * cz + cx * cz + cx * cy);
      const nQuads = 2 * ((cy - 1) * (cz - 1) + (cx - 1) * (cz - 1) + (cx - 1) * (cy - 1));
      const points = new Float32Array(nPoints * 3);
      const colours = new Uint8Array(nPoints * 3);
      const quads = new Uint32Array(nQuads * 5);
      const rgb = [0, 0, 0];
      let p = 0;
      let q = 0;

      /**
       * Adds one face as a grid of points and quads.
       * @param {number} nu Points along the face's first direction.
       * @param {number} nv Points along its second direction.
       * @param {function(number, number): !Array<number>} voxelAt Maps a face position to [i, j, k] in the crop.
       * @param {boolean} flip Reverses the winding, so that every face looks outward.
       */
      const face = (nu, nv, voxelAt, flip) => {
        const base = p;
        for (let v = 0; v < nv; v++) {
          for (let u = 0; u < nu; u++) {
            const [i, j, k] = voxelAt(u, v);
            const value = raw[stage.indexOf(i, j, k)];
            points.set([origin[0] + i * sp[0], origin[1] + j * sp[1], origin[2] + k * sp[2]], 3 * p);
            if (value) {
              this.scale_.colourOfRaw(value, rgb);
              colours.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255], 3 * p);
            } else {
              colours.set([255, 255, 255], 3 * p);     // no value: white
            }
            p++;
          }
        }
        for (let v = 0; v < nv - 1; v++) {
          for (let u = 0; u < nu - 1; u++) {
            const a = base + u + nu * v;
            const b = a + 1;
            const d = a + nu;
            const e = d + 1;
            quads.set(flip ? [4, a, d, e, b] : [4, a, b, e, d], 5 * q);
            q++;
          }
        }
      };
      face(cy, cz, (u, v) => [0, u, v], true);            // west
      face(cy, cz, (u, v) => [cx - 1, u, v], false);      // east
      face(cx, cz, (u, v) => [u, 0, v], false);           // south
      face(cx, cz, (u, v) => [u, cy - 1, v], true);       // north
      face(cx, cy, (u, v) => [u, v, 0], true);            // floor
      face(cx, cy, (u, v) => [u, v, cz - 1], false);      // top

      this.poly_.getPoints().setData(points, 3);
      this.poly_.getPolys().setData(quads);
      this.poly_.getPointData().setScalars(dataArray('rgb', colours, 3));
      this.poly_.modified();
    }
  }

  /**
   * Solid body (3D): everything between a minimum and a maximum value, closed off where it meets
   * the edge of the part on show.
   *
   * Built on a copy of the volume with one extra voxel all round that counts as "outside", so
   * the surface is capped at the box instead of left open.
   */
  class SolidBody {
    /**
     * @param {!Stage} stage The stage.
     * @param {!ColourScale} scale The colour scale.
     */
    constructor(stage, scale) {
      /** @private @const {!Stage} */
      this.stage_ = stage;
      /** @private @const {!ColourScale} */
      this.scale_ = scale;
      /** @private @const {!Object} Padded image of signed "how far inside the range" values. */
      this.image_ = DataModel.vtkImageData.newInstance();
      this.image_.setSpacing(...stage.spacing);
      /** @private {!Float32Array} */
      this.values_ = new Float32Array(0);
      this.resize();
      const surface = vtkImageMarchingCubes.newInstance({contourValue: 0, computeNormals: true, mergePoints: true});
      surface.setInputData(this.image_);
      const mapper = Core.vtkMapper.newInstance();
      mapper.setInputConnection(surface.getOutputPort());
      mapper.setScalarVisibility(false);
      /** @const {!Object} */
      this.actor = Core.vtkActor.newInstance();
      this.actor.setMapper(mapper);
      stage.add(this.actor);
    }

    /**
     * Sizes the padded image to the part on show. Call after the extent changes, before update().
     */
    resize() {
      const stage = this.stage_;
      const [cx, cy, cz] = stage.cropDims;
      const sp = stage.spacing;
      this.image_.setDimensions(cx + 2, cy + 2, cz + 2);
      this.image_.setOrigin((stage.crop.i0 - 1) * sp[0], (stage.crop.j0 - 1) * sp[1], -stage.depthKm + (stage.crop.k0 - 1) * sp[2]);
      // Filled straight away: the window may draw before the first body is worked out.
      this.values_ = new Float32Array((cx + 2) * (cy + 2) * (cz + 2)).fill(OUTSIDE);
      this.image_.getPointData().setScalars(dataArray('g', this.values_, 1));
      this.image_.modified();
    }

    /**
     * Works out the body for a range of values.
     * @param {number} rawMin Lowest raw value inside; -Infinity for no lower limit.
     * @param {number} rawMax Highest raw value inside; Infinity for no upper limit.
     * @param {number} belowKm The body is only drawn deeper than this.
     * @return {number} The fraction of the part on show that is inside, 0 to 1.
     */
    update(rawMin, rawMax, belowKm) {
      const stage = this.stage_;
      const [cx, cy, cz] = stage.cropDims;
      const nz = stage.dims[2];
      const {raw, gap} = stage.volume;
      const values = this.values_;
      const px = cx + 2;
      const py = cy + 2;
      let inside = 0;
      values.fill(OUTSIDE);
      for (let z = 0; z < cz; z++) {
        if ((nz - 1 - (stage.crop.k0 + z)) * stage.spacing[2] < belowKm) continue;
        for (let y = 0; y < cy; y++) {
          const from = stage.indexOf(0, y, z);
          const to = 1 + px * (y + 1 + py * (z + 1));
          for (let x = 0; x < cx; x++) {
            if (gap && gap[from + x]) continue;                   // no value here: never part of the body
            const v = raw[from + x];
            const depthInside = Math.min(v - rawMin, rawMax - v);   // positive inside the range
            values[to + x] = depthInside;
            if (depthInside > 0) inside++;
          }
        }
      }
      this.image_.getPointData().setScalars(dataArray('g', values, 1));
      this.image_.modified();
      return inside / (cx * cy * cz);
    }

    /** @param {number} stored Stored value whose colour the body takes. */
    setColourAt(stored) {
      this.actor.getProperty().setColor(...this.scale_.surfaceColour(stored));
    }
  }

  /**
   * Extra surfaces through the model at typed values (3D).
   */
  class Surfaces {
    /**
     * @param {!Stage} stage The stage.
     * @param {!ColourScale} scale The colour scale.
     */
    constructor(stage, scale) {
      /** @private @const {!Stage} */
      this.stage_ = stage;
      /** @private @const {!ColourScale} */
      this.scale_ = scale;
      /** @private {!Array<{actor: !Object, value: number}>} */
      this.items_ = [];
    }

    /**
     * Replaces the surfaces.
     * @param {!Array<number>} values Physical values, one surface each.
     */
    set(values) {
      this.items_.forEach(({actor}) => this.stage_.remove(actor));
      this.items_ = values.map((value) => {
        const stored = this.scale_.toStored(value);
        const surface = vtkImageMarchingCubes.newInstance({
          contourValue: this.scale_.toRaw(stored), computeNormals: true, mergePoints: true,
        });
        surface.setInputData(this.stage_.image);
        const mapper = Core.vtkMapper.newInstance();
        mapper.setInputConnection(surface.getOutputPort());
        mapper.setScalarVisibility(false);
        const actor = Core.vtkActor.newInstance();
        actor.setMapper(mapper);
        this.stage_.add(actor);
        return {actor, value};
      });
      this.recolour();
    }

    /** Takes each surface's colour from the scale again. Call after the scale changes. */
    recolour() {
      this.items_.forEach(({actor, value}) => {
        actor.getProperty().setColor(...this.scale_.surfaceColour(this.scale_.toStored(value)));
      });
    }

    /** @param {number} opacity 0 to 1, for every surface. */
    setOpacity(opacity) {
      this.items_.forEach(({actor}) => actor.getProperty().setOpacity(opacity));
    }
  }

  /**
   * The outline of the part on show, and axes with distances in kilometres.
   *
   * The box is stretched upward by the exaggeration, while the depth labels still read true km.
   */
  class BoxAxes {
    /**
     * @param {!Stage} stage The stage.
     * @param {!Array<string>} names Axis titles: east, north, up.
     */
    constructor(stage, names) {
      /** @private @const {!Stage} */
      this.stage_ = stage;

      const outline = vtkOutlineFilter.newInstance();
      outline.setInputData(stage.image);
      const mapper = Core.vtkMapper.newInstance();
      mapper.setInputConnection(outline.getOutputPort());
      /** @const {!Object} */
      this.outline = Core.vtkActor.newInstance();
      this.outline.setMapper(mapper);
      this.outline.getProperty().setColor(0.16, 0.15, 0.45);
      stage.add(this.outline);

      // Built with extend() rather than newInstance(): newInstance() returns a locked object,
      // and two of its steps are replaced below.
      /** @const {!Object} vtkCubeAxesActor. */
      this.axes = {};
      Core.vtkCubeAxesActor.extend(this.axes, {}, {generateTicks: (bounds) => this.ticks_(bounds)});
      // Label one edge per axis, not every outer edge. The library marks each edge it would
      // label with 1; all but the first for each axis are changed to 2, "draw the line, no text".
      const EDGE_AXIS = [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2];
      const labelEdges = this.axes.updateTextData;
      this.axes.updateTextData = (faces, edges, ticks, strings) => {
        const seen = [false, false, false];
        const chosen = Array.from(edges);
        for (let n = 0; n < 12; n++) {
          if (chosen[n] !== 1) continue;
          if (seen[EDGE_AXIS[n]]) chosen[n] = 2;
          else seen[EDGE_AXIS[n]] = true;
        }
        return labelEdges(faces, chosen, ticks, strings);
      };
      this.axes.setDataBounds(stage.bounds);      // before anything is drawn
      this.axes.setCamera(stage.camera);
      this.axes.setAxisLabels(stage.is2d ? [names[0], '', names[2]] : names);
      this.axes.setTickTextStyle({fontColor: '#333333', fontSize: 13, fontFamily: 'Arial'});
      this.axes.setAxisTextStyle({fontColor: '#282572', fontSize: 15, fontStyle: 'bold', fontFamily: 'Arial'});
      this.axes.getProperty().setColor(0.62, 0.64, 0.68);
      stage.add(this.axes, false);
    }

    /** Fits the axes to the part on show and the exaggeration. Call after either changes. */
    fit() {
      const b = this.stage_.bounds;
      const ve = this.stage_.exaggeration;
      this.axes.setDataBounds([b[0], b[1], b[2], b[3], b[4] * ve, b[5] * ve]);
    }

    /**
     * @param {!Array<number>} bounds Drawn bounds, with the exaggeration applied.
     * @return {{ticks: !Array<!Array<number>>, tickStrings: !Array<!Array<string>>}} Tick
     *     positions as drawn, and labels in true kilometres.
     * @private
     */
    ticks_(bounds) {
      const ve = this.stage_.exaggeration;
      const km = [niceTicks(bounds[0], bounds[1]), niceTicks(bounds[2], bounds[3]), niceTicks(bounds[4] / ve, bounds[5] / ve)];
      const thousands = (v) => String(+v.toPrecision(6)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return {
        ticks: [km[0], km[1], km[2].map((v) => v * ve)],
        tickStrings: km.map((axis) => axis.map(thousands)),
      };
    }
  }

  /**
   * Observation sites on top of the model.
   *
   * Sites are plain dark points, or tinted by a colour per site supplied from outside (fit.js
   * uses this to show how well the model fits each one). A larger point under the chosen site
   * marks it. Clicking a site chooses it.
   */
  class SiteLayer {
    /**
     * @param {!Stage} stage The stage.
     * @param {!Array<{id: string, x: number, y: number}>} sites Sites, positions in km.
     * @param {!HTMLElement} container Element that receives the clicks.
     */
    constructor(stage, sites, container) {
      /** @private @const {!Stage} */
      this.stage_ = stage;
      /** @private @const {!Array<{id: string, x: number, y: number}>} */
      this.sites_ = sites;
      /** @private {!Array<number>} Indices into sites_ of those inside the part on show. */
      this.shown_ = [];
      /** @private {?Object<string, !Array<number>>} RGB (0 to 255) by site id. */
      this.colours_ = null;
      /** @private {boolean} */
      this.tinted_ = false;
      /** @private {?number} Index of the chosen site. */
      this.chosen_ = null;
      /** @type {?function(string)} Called with the id of a site the visitor clicks. */
      this.onPick = null;

      /** @private @const {!Object} */
      this.points_ = DataModel.vtkPolyData.newInstance();
      const mapper = Core.vtkMapper.newInstance();
      mapper.setInputData(this.points_);
      mapper.setScalarModeToUsePointData();
      mapper.setColorModeToDirectScalars();
      /** @private @const {!Object} */
      this.actor_ = Core.vtkActor.newInstance();
      this.actor_.setMapper(mapper);

      /** @private @const {!Object} */
      this.ring_ = DataModel.vtkPolyData.newInstance();
      const ringMapper = Core.vtkMapper.newInstance();
      ringMapper.setInputData(this.ring_);
      /** @private @const {!Object} */
      this.ringActor_ = Core.vtkActor.newInstance();
      this.ringActor_.setMapper(ringMapper);
      this.ringActor_.getProperty().setPointSize(18);
      this.ringActor_.getProperty().setColor(0.157, 0.145, 0.447);

      this.place();
      stage.add(this.ringActor_);
      stage.add(this.actor_);
      this.listenForClicks_(container);
    }

    /** @return {number} How many sites there are in all. */
    get total() {
      return this.sites_.length;
    }

    /** @return {!Array<string>} Ids of the sites inside the part on show. */
    shownIds() {
      return this.shown_.map((n) => this.sites_[n].id);
    }

    /**
     * Rebuilds the points. Call after the extent changes.
     */
    place() {
      const b = this.stage_.bounds;
      const topOnShow = this.stage_.crop.k1 === this.stage_.dims[2] - 1;
      this.shown_ = [];
      if (topOnShow) {
        this.sites_.forEach((s, n) => {
          if (s.x >= b[0] && s.x <= b[1] && s.y >= b[2] && s.y <= b[3]) this.shown_.push(n);
        });
      }
      const count = this.shown_.length;
      const points = new Float32Array(count * 3);
      const cells = new Uint32Array(count * 2);
      const colours = new Uint8Array(count * 3);
      const tint = this.tinted_ && !!this.colours_;
      this.shown_.forEach((siteIndex, n) => {
        const site = this.sites_[siteIndex];
        points.set([site.x, site.y, SITE_HEIGHT_KM], 3 * n);
        cells.set([1, n], 2 * n);
        colours.set((tint && this.colours_[site.id]) || [13, 13, 13], 3 * n);
      });
      this.points_.getPoints().setData(points, 3);
      this.points_.getVerts().setData(cells);
      this.points_.getPointData().setScalars(dataArray('rgb', colours, 3));
      this.points_.modified();
      this.actor_.getProperty().setPointSize(tint ? 11 : 6);

      const marked = this.chosen_ != null && this.shown_.includes(this.chosen_) ? this.sites_[this.chosen_] : null;
      // The ring sits just under the site's own point.
      this.ring_.getPoints().setData(new Float32Array(marked ? [marked.x, marked.y, SITE_HEIGHT_KM - 0.02] : []), 3);
      this.ring_.getVerts().setData(new Uint32Array(marked ? [1, 0] : []));
      this.ring_.modified();
    }

    /**
     * Supplies a colour per site.
     * @param {?Object<string, !Array<number>>} byId RGB (0 to 255) by site id.
     */
    colour(byId) {
      this.colours_ = byId;
      this.place();
      this.stage_.render();
    }

    /** @param {boolean} on Whether to draw sites in the supplied colours. */
    setTinted(on) {
      this.tinted_ = on;
      this.place();
    }

    /** @param {string} id Site to mark as chosen. */
    select(id) {
      const n = this.sites_.findIndex((s) => s.id === id);
      this.chosen_ = n < 0 ? null : n;
      this.place();
      this.stage_.render();
    }

    /** @param {boolean} on Whether to draw the sites. */
    setVisible(on) {
      this.actor_.setVisibility(on);
      this.ringActor_.setVisibility(on);
    }

    /**
     * Chooses the nearest site when the visitor clicks (not drags) close to one.
     * @param {!HTMLElement} container Element that receives the pointer events.
     * @private
     */
    listenForClicks_(container) {
      let pressedAt = null;
      container.addEventListener('pointerdown', (e) => { pressedAt = [e.clientX, e.clientY]; }, true);
      container.addEventListener('pointerup', (e) => {
        if (!pressedAt || !this.actor_.getVisibility()) return;
        if (Math.hypot(e.clientX - pressedAt[0], e.clientY - pressedAt[1]) > CLICK_SLOP_PX) return;
        const canvas = this.stage_.window.getApiSpecificRenderWindow().getCanvas();
        const box = canvas.getBoundingClientRect();
        const perCssPixel = canvas.width / box.width;
        const x = (e.clientX - box.left) * perCssPixel;
        const y = (box.bottom - e.clientY) * perCssPixel;
        let nearest = null;
        let nearestDistance = PICK_RADIUS_PX * perCssPixel;
        this.shown_.forEach((n) => {
          const site = this.sites_[n];
          const at = this.stage_.toCanvas(site.x, site.y, SITE_HEIGHT_KM);
          const distance = Math.hypot(at[0] - x, at[1] - y);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = site;
          }
        });
        if (!nearest) return;
        this.select(nearest.id);
        if (this.onPick) this.onPick(nearest.id);
      }, true);
    }
  }

  /**
   * The direction marker in the corner: a labelled cube, three arrows, or nothing.
   */
  class Compass {
    /**
     * @param {!Stage} stage The stage.
     * @param {!Array<string>} labels Face labels for +east, -east, +north, -north.
     */
    constructor(stage, labels) {
      /** @private @const {!Object} */
      this.cube_ = Core.vtkAnnotatedCubeActor.newInstance();
      this.cube_.setDefaultStyle({
        text: '', fontStyle: 'bold', fontFamily: 'Arial', fontColor: 'white',
        fontSizeScale: (resolution) => resolution / 2.4,
        faceColor: '#282572', faceRotation: 0, edgeThickness: 0.08, edgeColor: 'white', resolution: 300,
      });
      this.cube_.setXPlusFaceProperty({text: labels[0]});
      this.cube_.setXMinusFaceProperty({text: labels[1]});
      this.cube_.setYPlusFaceProperty({text: labels[2]});
      this.cube_.setYMinusFaceProperty({text: labels[3]});
      this.cube_.setZPlusFaceProperty({text: 'UP', faceColor: '#3F88C8'});
      this.cube_.setZMinusFaceProperty({text: 'DN', faceColor: '#6C757D'});

      /** @private @const {!Object} */
      this.arrows_ = Core.vtkAxesActor.newInstance();
      this.arrows_.setXConfig({color: ARROW_RGB[0]});
      this.arrows_.setYConfig({color: ARROW_RGB[1]});
      this.arrows_.setZConfig({color: ARROW_RGB[2]});
      this.arrows_.update();

      /** @private @const {!Object} */
      this.widget_ = vtkOrientationMarkerWidget.newInstance({actor: this.cube_, interactor: stage.renderWindow.getInteractor()});
      this.widget_.setEnabled(true);
      this.widget_.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT);
      this.widget_.setViewportSize(0.16);
      this.widget_.setMinPixelSize(90);
      this.widget_.setMaxPixelSize(130);
    }

    /** @param {string} mode 'cube', 'arrows' or 'off'. */
    setMode(mode) {
      this.widget_.setEnabled(false);
      if (mode === 'off') return;
      this.widget_.setActor(mode === 'arrows' ? this.arrows_ : this.cube_);
      this.widget_.setEnabled(true);
      this.widget_.updateMarkerOrientation();
    }

    /** Turns the marker to match the camera. Call after the camera is moved by code. */
    follow() {
      this.widget_.updateMarkerOrientation();
    }
  }

  /**
   * Set viewing directions.
   */
  class Camera {
    /**
     * @param {!Stage} stage The stage.
     * @param {!Compass} compass The direction marker, kept in step with the camera.
     */
    constructor(stage, compass) {
      /** @private @const {!Stage} */
      this.stage_ = stage;
      /** @private @const {!Compass} */
      this.compass_ = compass;
      /** @private @const {!Object<string, !Array<!Array<number>>>} */
      this.directions_ = Object.assign({}, VIEW_DIRECTIONS);
      /** @type {?string} The set view in use; null once the visitor has turned the model. */
      this.current = null;
      /** @type {number} Degrees above level for the four side views. */
      this.tilt = 0;
    }

    /**
     * @param {string} name A view name.
     * @return {boolean} Whether that view exists.
     */
    has(name) {
      return name in this.directions_;
    }

    /**
     * Defines the view named 'custom'.
     * @param {!Array<number>} from Direction [east, north, up] from the model towards the viewer.
     */
    setCustom(from) {
      this.directions_.custom = [from, [0, 0, 1]];
    }

    /** @param {number} degrees Angle of view of the lens. */
    setViewAngle(degrees) {
      this.stage_.camera.setViewAngle(degrees);
    }

    /**
     * Looks at the model from a set direction and fits it in the window.
     * @param {string} name A view name.
     * @param {boolean=} keepTilt Keep the current tilt. By default the tilt is cleared.
     */
    look(name, keepTilt = false) {
      const stage = this.stage_;
      const [direction, up] = this.directions_[name];
      const [cx, cy] = stage.centre;
      const cz = stage.centre[2] * stage.exaggeration;
      let from = direction;
      if (!keepTilt) this.tilt = 0;
      if (this.tilt && direction[2] === 0) {
        const t = this.tilt * Math.PI / 180;
        from = [direction[0] * Math.cos(t), direction[1] * Math.cos(t), Math.sin(t)];
      }
      this.current = name;
      stage.camera.setFocalPoint(cx, cy, cz);
      stage.camera.setPosition(cx + from[0], cy + from[1], cz + from[2]);
      stage.camera.setViewUp(...up);
      stage.renderer.resetCamera();
      if (stage.is2d) stage.camera.zoom(1.2);
      stage.renderer.resetCameraClippingRange();
      this.compass_.follow();
      stage.render();
    }
  }

  /**
   * Fills in the model's record around the viewer: title, authors, text tabs, citation, links.
   * @param {!Object} scene The scene entry.
   * @param {!Object} record The model's record from volumes/records.json. Its snapshot,
   *     overview, model, meta and citation fields are HTML written by tools/fetch_records.py.
   * @param {string} sceneName The scene's key.
   */
  const renderRecord = (scene, record, sceneName) => {
    document.title = `${scene.short} — M@TE (mockup)`;
    $('crumb').textContent = record.slug;
    $('title').textContent = record.title;
    $('byline').innerHTML = `<b>${esc(record.creators.join(', '))}</b> · ${esc(scene.year)}`;
    $('r-snapshot').innerHTML = record.snapshot;
    ['overview', 'model', 'meta'].forEach((key) => { $(`r-${key}`).innerHTML = record[key]; });
    $('r-cite').innerHTML = record.citation;
    $('r-copy').addEventListener('click', (e) => {
      const button = e.currentTarget;
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText($('r-cite').textContent).then(() => {
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = 'Copy citation'; }, 1500);
      });
    });
    if (record.data_url) {
      $('r-get').insertAdjacentHTML('beforeend', `<a class="btn" href="${esc(record.data_url)}">Model files at NCI</a>`);
    }
    if (record.repo) {
      $('r-get').insertAdjacentHTML('beforeend', `<a class="btn ghost" href="${esc(record.repo)}">M@TE record on GitHub</a>`);
    }
    $('r-dois').innerHTML = record.dois.map((d) =>
      `<div><dt>${esc(d.label)}</dt><dd class="mono"><a href="https://doi.org/${esc(d.doi)}">${esc(d.doi)}</a></dd></div>`).join('');
    $('r-creators').innerHTML = record.creators.map((c) => `<li>${esc(c)}</li>`).join('');
    $('tags').innerHTML = record.tags.map((t) => `<li>${esc(t)}</li>`).join('');
    $('rtabs').addEventListener('click', (e) => {
      const chosen = e.target.closest('button');
      if (!chosen) return;
      [...$('rtabs').children].forEach((tab) => {
        tab.setAttribute('aria-selected', tab === chosen);
        $(`r-${tab.dataset.p}`).hidden = tab !== chosen;
      });
    });
    // Links to the other pilot models stay in the mockup this page was opened from.
    const variant = (location.search.match(/[?&]v=\w+/) || [''])[0].replace('?', '&');
    document.querySelectorAll('.scene-links a').forEach((a) => {
      a.href = `model-3d.html?scene=${a.dataset.s}${variant}`;
      if (a.dataset.s === sceneName) a.setAttribute('aria-current', 'true');
    });
  };

  /**
   * Reads the page's controls and drives the parts of the picture.
   *
   * Everything a visitor can change has a default in the scene file ("defaults", plus each
   * field's own scale, solid and surfaces), so a model opens looking the way its author chose,
   * and "Model defaults" brings that back. A scene can also carry several named views ("views"),
   * each a full set of the same settings.
   */
  class Viewer {
    /**
     * @param {!Object} scene The scene entry.
     * @param {!VolumeStore} store Loader for the scene's volumes.
     * @param {!Volume} volume The first volume.
     * @param {?Array<{id: string, x: number, y: number}>} sites The scene's sites, if any.
     */
    constructor(scene, store, volume, sites) {
      /** @private @const {!Object} */
      this.scene_ = scene;
      /** @private @const {!VolumeStore} */
      this.store_ = store;
      /** @private {number} Index of the field on show. */
      this.field_ = 0;
      /** @private {number} Index of the time step on show. */
      this.time_ = scene.times ? scene.times.length - 1 : 0;
      /** @private {?Object} Field settings from a saved view; cleared when the visitor picks a field. */
      this.fieldOverride_ = null;
      /** @private {number} Counts volume requests, so a slow one cannot overwrite a newer one. */
      this.request_ = 0;
      /** @private {?number} Timer id while playing. */
      this.timer_ = null;
      /** @private {{ok: boolean, text: string}} Whether a solid body is defined, and its size as text. */
      this.body_ = {ok: false, text: ''};
      /** @private @const {!Array<!Object>} The opening view, then the scene's saved views. */
      this.presets_ = [{name: scene.defaultsName || 'Opening view', defaults: scene.defaults || {}, field: null}]
          .concat(scene.views || []);

      const names = volume.meta.axes || ['East (km)', 'North (km)', 'Depth (km)'];
      const compassLabels = scene.compass || ['E', 'W', 'N', 'S'];
      /** @private @const {!Stage} */
      this.stage_ = new Stage($('view'), volume);
      /** @private @const {boolean} */
      this.is2d_ = this.stage_.is2d;
      /** @private @const {!ColourScale} */
      this.scale_ = new ColourScale();
      this.scale_.setStorage(volume.meta);
      // The order parts are made in is the order they are drawn in.
      /** @private @const {!Slices} */
      this.slices_ = new Slices(this.stage_, this.scale_);
      /** @private @const {?Walls} */
      this.walls_ = this.is2d_ ? null : new Walls(this.stage_, this.scale_);
      /** @private @const {?SolidBody} */
      this.solid_ = this.is2d_ ? null : new SolidBody(this.stage_, this.scale_);
      /** @private @const {!BoxAxes} */
      this.box_ = new BoxAxes(this.stage_, names);
      /** @private @const {?SiteLayer} */
      this.sites_ = sites ? new SiteLayer(this.stage_, sites, $('view')) : null;
      /** @private @const {?Surfaces} */
      this.surfaces_ = this.is2d_ ? null : new Surfaces(this.stage_, this.scale_);
      /** @private @const {!Compass} */
      this.compass_ = new Compass(this.stage_, compassLabels);
      /** @private @const {!Camera} */
      this.camera_ = new Camera(this.stage_, this.compass_);

      this.setUpPage_(names, compassLabels);
      this.bindControls_();
    }

    /** @return {?SiteLayer} The site layer, for fit.js. */
    get siteLayer() {
      return this.sites_;
    }

    /**
     * Applies the opening view. Call once after construction.
     * @return {!Promise<void>}
     */
    async open() {
      this.noteExtent_();
      this.updateSiteCount_();
      await this.applyPreset_();
    }

    /**
     * @return {string} File stem of the field and time step on show.
     * @private
     */
    stem_() {
      const field = this.scene_.fields[this.field_];
      return this.scene_.times ? field.stem.replace('{t}', this.scene_.times[this.time_].id) : field.stem;
    }

    /**
     * Sets the parts of the page that depend on the scene but never change afterwards.
     * @param {!Array<string>} names Axis titles.
     * @param {!Array<string>} compassLabels Labels for +east, -east, +north, -north.
     * @private
     */
    setUpPage_(names, compassLabels) {
      const scene = this.scene_;
      const [nx, ny, nz] = this.stage_.dims;
      const is2d = this.is2d_;

      $('field').innerHTML = scene.fields.map((f, n) => `<option value="${n}">${esc(f.label)}</option>`).join('');
      $('preset').innerHTML = this.presets_.map((p, n) => `<option value="${n}">${esc(p.name)}</option>`).join('');
      show('field-row', scene.fields.length > 1);
      show('preset-row', this.presets_.length > 1);
      show('time-row', !!scene.times);
      document.querySelector('.cp-data').hidden = scene.fields.length <= 1 && !scene.times && !(scene.views && scene.views.length);
      if (scene.times) {
        $('t').max = scene.times.length - 1;
        $('t').value = this.time_;
        $('t-o').textContent = scene.times[this.time_].label;
      }

      // A 2D section has no slices, volume, walls or north-south cuts, and one set view.
      ['tab-slices', 'tab-volume', 'walls-tick', 'cut-s-row', 'cut-n-row'].forEach((id) => show(id, !is2d));
      show('sites-tick', !!this.sites_);
      show('sitefit-tick', !!(this.sites_ && scene.fit));
      [...$('views').children].forEach((button) => {
        if (is2d) button.hidden = button.dataset.v !== 'south';
        if (scene.viewNames && scene.viewNames[button.dataset.v]) button.textContent = scene.viewNames[button.dataset.v];
      });
      if (!is2d) {
        const plain = (title) => title.replace(/\s*\(.*\)/, '').toLowerCase();
        $('k').max = nz - 1;
        $('i').max = nx - 1;
        $('j').max = ny - 1;
        $('i-name').textContent = `Section across ${plain(names[0])}`;
        $('j-name').textContent = `Section across ${plain(names[1])}`;
      }

      // Name the sides the way this model names them.
      const SIDE = {W: 'West', E: 'East', S: 'South', N: 'North'};
      [['cut-w-l', 1], ['cut-e-l', 0], ['cut-s-l', 3], ['cut-n-l', 2]].forEach(([id, n]) => {
        $(id).textContent = SIDE[compassLabels[n]] || `${compassLabels[n]} side`;
      });
      $('arrow-key').innerHTML = [compassLabels[0], compassLabels[2], 'up']
          .map((label, n) => `<i style="background:rgb(${ARROW_RGB[n].join(',')})"></i>${esc(label)}`).join('');
    }

    /**
     * Connects the page's controls.
     * @private
     */
    bindControls_() {
      const on = (ids, type, handler) => ids.forEach((id) => $(id).addEventListener(type, handler));
      const stage = this.stage_;

      on(['k', 'i', 'j', 'on-k', 'on-i', 'on-j', 'op-k', 'op-i', 'op-j', 'on-solid', 's-op', 'surf-op',
        'on-sites', 'on-axes', 'on-outline'], 'input', () => this.sync_());
      on(['cmap', 'rev', 'vmin', 'vmax'], 'change', () => this.rescale_());
      on(['s-min-on', 's-max-on', 's-min', 's-max', 's-below'], 'change', () => {
        this.updateBody_();
        this.sync_();
      });
      on(['surf'], 'change', () => {
        this.updateSurfaces_();
        this.sync_();
      });
      on(['on-walls'], 'input', () => {
        this.updateWalls_();
        this.sync_();
      });
      on(['on-sitefit'], 'input', () => {
        if (!this.sites_) return;
        this.sites_.setTinted($('on-sitefit').checked);
        stage.render();
      });
      on(['ve'], 'change', () => {
        this.setExaggeration_(+$('ve').value);
        if (this.camera_.current) this.look_(this.camera_.current);
        else stage.reframe();
      });
      on(['compass'], 'change', () => {
        this.setCompass_();
        stage.render();
      });
      on(['vreset'], 'click', () => {
        // Brings back the field's own scale, solid and surfaces, so all three are worked out again.
        this.fieldOverride_ = null;
        this.useField_(false);
        if (!this.applyScale_()) return;
        this.updateWalls_();
        this.updateBody_();
        this.updateSurfaces_();
        this.sync_();
      });

      on(['field'], 'change', () => {
        this.field_ = +$('field').value;
        this.fieldOverride_ = null;
        this.showVolume_(false);
      });
      if (this.scene_.times) {
        on(['t'], 'input', () => this.showTime_(+$('t').value));
        on(['play'], 'click', () => this.togglePlay_());
      }

      on(CUTS.map((cut) => cut[0]), 'change', () => this.applyCut_());
      on(['cut-reset'], 'click', () => {
        CUTS.forEach((cut) => { $(cut[0]).value = 0; });
        this.applyCut_();
      });

      $('views').addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (button) this.look_(button.dataset.v);
      });
      // Turning the model by hand leaves whichever set view was in use.
      $('view').addEventListener('pointerdown', () => {
        this.camera_.current = null;
        this.markView_();
      });

      on(['preset'], 'change', () => this.applyPreset_());
      on(['to-defaults'], 'click', () => {
        $('preset').value = 0;
        this.applyPreset_();
      });
      on(['copy-settings'], 'click', (e) => this.copySettings_(e.currentTarget));

      $('tabs').addEventListener('click', (e) => {
        const chosen = e.target.closest('button');
        if (!chosen) return;
        [...$('tabs').children].forEach((tab) => {
          tab.setAttribute('aria-selected', tab === chosen);
          $(`pane-${tab.dataset.p}`).hidden = tab !== chosen;
        });
      });

      // Full screen takes the whole viewer, control panel included.
      on(['full'], 'click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else $('app').requestFullscreen();
      });
      document.addEventListener('fullscreenchange', () => {
        $('full').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
      });
    }

    /**
     * Reads a percentage control.
     * @param {string} id Input id.
     * @return {number} Opacity from 0.05 to 1; 1 if the box is empty or not a number.
     * @private
     */
    opacity_(id) {
      const text = $(id).value;
      const percent = text !== '' && isFinite(+text) ? +text : 100;
      return Math.min(1, Math.max(0.05, percent / 100));
    }

    /**
     * Looks from a set view and shows which one is in use.
     * @param {string} name A view name.
     * @param {boolean=} keepTilt Keep the current tilt.
     * @private
     */
    look_(name, keepTilt = false) {
      this.camera_.look(name, keepTilt);
      this.markView_();
    }

    /**
     * Presses the button of the set view in use, and releases the others.
     * @private
     */
    markView_() {
      [...$('views').children].forEach((button) => {
        button.setAttribute('aria-pressed', button.dataset.v === this.camera_.current);
      });
    }

    /**
     * Applies the typed colour limits, ramp and direction, and redraws the legend.
     * @return {boolean} False if the limits are not usable; nothing is changed then.
     * @private
     */
    applyScale_() {
      const scale = this.scale_;
      const vmin = +$('vmin').value;
      const vmax = +$('vmax').value;
      const ok = $('vmin').value !== '' && $('vmax').value !== '' && scale.isValid(vmin) && scale.isValid(vmax) && vmin < vmax;
      if (!ok) {
        $('verr').textContent = scale.isLog ? 'Enter two positive numbers, smallest first.' : 'Enter two numbers, smallest first.';
        return false;
      }
      $('verr').textContent = '';
      const low = scale.toStored(vmin);
      const high = scale.toStored(vmax);
      const stops = scale.apply(low, high, $('cmap').value, $('rev').checked);
      const cssStops = stops.map(([at, r, g, b]) =>
        `rgb(${[r, g, b].map((v) => Math.round(v * 255)).join(',')}) ${(at * 100).toFixed(1)}%`);
      $('ramp').style.background = `linear-gradient(90deg,${cssStops.join(',')})`;
      $('ticks').innerHTML = scale.ticks(low, high).map((v) =>
        `<span style="left:${((v - low) / (high - low) * 100).toFixed(1)}%">${formatNumber(scale.toPhysical(v))}</span>`).join('');
      return true;
    }

    /**
     * Applies a change of colour scale to everything coloured by it.
     * @private
     */
    rescale_() {
      if (!this.applyScale_()) return;
      this.updateWalls_();
      this.colourBody_();
      if (this.surfaces_) this.surfaces_.recolour();
      this.sync_();
    }

    /**
     * Rebuilds the walls, if they are on show.
     * @private
     */
    updateWalls_() {
      if (this.walls_ && $('on-walls').checked) this.walls_.update();
    }

    /**
     * Reads the solid body's range.
     * @return {{useMin: boolean, useMax: boolean, min: number, max: number, error: string}}
     * @private
     */
    bodyRange_() {
      const scale = this.scale_;
      const useMin = $('s-min-on').checked;
      const useMax = $('s-max-on').checked;
      const min = +$('s-min').value;
      const max = +$('s-max').value;
      const badMin = useMin && ($('s-min').value === '' || !scale.isValid(min));
      const badMax = useMax && ($('s-max').value === '' || !scale.isValid(max));
      const badOrder = useMin && useMax && !(min < max);
      let error = '';
      if (badMin || badMax || badOrder) error = useMin && useMax ? 'Minimum must be below maximum.' : 'Enter a valid value.';
      return {useMin, useMax, min, max, error};
    }

    /**
     * Works out the solid body from its controls.
     * @private
     */
    updateBody_() {
      if (!this.solid_) return;
      const scale = this.scale_;
      const range = this.bodyRange_();
      $('s-err').textContent = range.error;
      this.body_.ok = !range.error && (range.useMin || range.useMax);
      if (!this.body_.ok) return;
      const rawMin = range.useMin ? scale.toRaw(scale.toStored(range.min)) : -Infinity;
      const rawMax = range.useMax ? scale.toRaw(scale.toStored(range.max)) : Infinity;
      const belowKm = Math.max(0, +$('s-below').value || 0);
      const fraction = this.solid_.update(rawMin, rawMax, belowKm);
      this.body_.text = `${(100 * fraction).toFixed(1)} % of the ${this.stage_.isUncut() ? 'model' : 'part shown'}`;
      this.colourBody_();
    }

    /**
     * Colours the solid body from the middle of its range.
     * @private
     */
    colourBody_() {
      if (!this.solid_ || !this.body_.ok) return;
      const scale = this.scale_;
      const {useMin, useMax, min, max} = this.bodyRange_();
      const stored = useMin && useMax ? (scale.toStored(min) + scale.toStored(max)) / 2 : scale.toStored(useMin ? min : max);
      this.solid_.setColourAt(stored);
    }

    /**
     * Rebuilds the extra surfaces from the typed values.
     * @private
     */
    updateSurfaces_() {
      if (!this.surfaces_) return;
      const values = parseNumberList($('surf').value);
      let error = '';
      if (values.length > MAX_SURFACES) error = 'Six values at most.';
      else if (values.some((v) => !this.scale_.isValid(v))) error = 'Use numbers separated by commas.';
      $('surf-err').textContent = error;
      this.surfaces_.set(error ? [] : values);
    }

    /**
     * @param {number} factor Vertical exaggeration.
     * @private
     */
    setExaggeration_(factor) {
      this.stage_.setExaggeration(factor);
      this.box_.fit();
      $('ve-note').textContent = factor === 1 ? 'True scale.' :
        `Heights are drawn ${factor} times taller than widths. Depth labels stay true.`;
    }

    /**
     * Shows the direction marker chosen in its menu.
     * @private
     */
    setCompass_() {
      const mode = $('compass').value;
      this.compass_.setMode(mode);
      $('arrow-key').hidden = mode !== 'arrows';
    }

    /**
     * Applies every control that only shows, hides, moves or fades something, then redraws.
     * @private
     */
    sync_() {
      const stage = this.stage_;
      const [nx, ny, nz] = stage.dims;
      const sp = stage.spacing;
      const checked = (id) => $(id).checked;
      if (this.is2d_) {
        this.slices_.set('i', 0, false, 1);
        this.slices_.set('k', 0, false, 1);
        this.slices_.set('j', 0, true, 1);
      } else {
        const bodyOn = checked('on-solid') && this.body_.ok;
        this.solid_.actor.setVisibility(bodyOn);
        this.solid_.actor.getProperty().setOpacity(this.opacity_('s-op'));
        $('s-o').textContent = bodyOn ? this.body_.text : '';
        this.surfaces_.setOpacity(this.opacity_('surf-op'));
        ['i', 'j', 'k'].forEach((axis) => {
          this.slices_.set(axis, +$(axis).value, checked(`on-${axis}`), this.opacity_(`op-${axis}`));
        });
        const km = (voxels, axis) => (voxels * sp[axis]).toFixed(sp[axis] < 1 ? 1 : 0);
        $('k-o').textContent = `${km(nz - 1 - $('k').value, 2)} km deep`;
        $('i-o').textContent = `${km(+$('i').value, 0)} km`;
        $('j-o').textContent = `${km(+$('j').value, 1)} km`;
        this.walls_.actor.setVisibility(checked('on-walls'));
      }
      if (this.sites_) this.sites_.setVisible(checked('on-sites'));
      this.box_.axes.setVisibility(checked('on-axes'));
      this.box_.outline.setVisibility(checked('on-outline'));
      stage.render();
    }

    /**
     * Takes the range, units and (unless kept) the default settings of the field on show.
     * @param {boolean} keepLimits Leave the visitor's scale, solid and surface settings alone.
     * @private
     */
    useField_(keepLimits) {
      const scale = this.scale_;
      const field = Object.assign({}, this.scene_.fields[this.field_], this.fieldOverride_ || {});
      const unit = field.unit || '';
      scale.setStorage(this.stage_.volume.meta);
      $('scale-title').textContent = field.label + (unit ? ` (${unit})` : '');
      document.querySelectorAll('.unit').forEach((e) => { e.textContent = unit; });
      if (keepLimits) return;
      const solid = field.solid || {};
      $('vmin').value = formatNumber(field.vmin != null ? field.vmin : scale.physicalAt(0));
      $('vmax').value = formatNumber(field.vmax != null ? field.vmax : scale.physicalAt(1));
      $('cmap').value = field.cmap || 'mt';
      $('rev').checked = !!field.reverse;
      $('s-min-on').checked = solid.min != null;
      $('s-max-on').checked = solid.max != null;
      $('s-min').value = formatNumber(solid.min != null ? solid.min : scale.physicalAt(0.25));
      $('s-max').value = formatNumber(solid.max != null ? solid.max : scale.physicalAt(0.75));
      $('s-below').value = solid.below_km || 0;
      $('surf').value = (field.surfaces || []).join(', ');
    }

    /**
     * Loads and shows the field and time step currently chosen.
     * @param {boolean} keepLimits As for useField_().
     * @return {!Promise<void>}
     * @private
     */
    async showVolume_(keepLimits) {
      const request = ++this.request_;
      $('busy').hidden = false;
      try {
        const volume = await this.store_.load(this.stem_());
        if (request !== this.request_) return;      // a newer request has taken over
        this.stage_.setVolume(volume);
        this.useField_(keepLimits);
        this.applyScale_();
        this.updateWalls_();
        this.updateBody_();
        this.updateSurfaces_();
        this.box_.fit();
        this.sync_();
      } catch (error) {
        console.error(error);       // the picture stays on the last volume that loaded
      } finally {
        if (request === this.request_) $('busy').hidden = true;
      }
    }

    /**
     * @param {number} index Time step to show.
     * @private
     */
    showTime_(index) {
      this.time_ = index;
      $('t').value = index;
      $('t-o').textContent = this.scene_.times[index].label;
      this.showVolume_(true);
    }

    /**
     * Starts or stops stepping through time.
     * @private
     */
    togglePlay_() {
      if (this.timer_) {
        clearInterval(this.timer_);
        this.timer_ = null;
        $('play').textContent = 'Play';
        return;
      }
      $('play').textContent = 'Pause';
      this.timer_ = setInterval(() => this.showTime_((this.time_ + 1) % this.scene_.times.length), PLAY_INTERVAL_MS);
    }

    /**
     * Writes the size of the part on show.
     * @private
     */
    noteExtent_() {
      const km = this.stage_.cropDims.map((n, axis) => (n - 1) * this.stage_.spacing[axis]);
      const sides = (this.is2d_ ? [km[0], km[2]] : km).map((v) => v.toFixed(v < 100 ? 1 : 0));
      $('cut-o').textContent = `Showing ${sides.join(' × ')} km`;
    }

    /**
     * Writes how many sites are on show.
     * @private
     */
    updateSiteCount_() {
      if (!this.sites_) return;
      const shown = this.sites_.shownIds().length;
      $('n-sites').textContent = `(${shown}${shown < this.sites_.total ? ` of ${this.sites_.total}` : ''})`;
    }

    /**
     * Cuts the model in from its sides by the typed distances.
     * @private
     */
    applyCut_() {
      const stage = this.stage_;
      const crop = stage.fullCrop();
      let error = '';
      CUTS.forEach(([id, axis, key, fromLow]) => {
        if (this.is2d_ && axis === 1) return;
        const km = $(id).value === '' ? 0 : +$(id).value;
        if (!isFinite(km) || km < 0) {
          error = 'Use zero or a positive distance.';
          return;
        }
        const voxels = Math.round(km / stage.spacing[axis]);
        crop[key] = fromLow > 0 ? voxels : stage.dims[axis] - 1 - voxels;
      });
      const tooThin = crop.i1 - crop.i0 < 1 || (!this.is2d_ && crop.j1 - crop.j0 < 1) || crop.k1 - crop.k0 < 1;
      if (!error && tooThin) error = 'Those cuts leave nothing to show.';
      $('cut-err').textContent = error;
      if (error) return;

      stage.setCrop(crop);
      if (this.solid_) this.solid_.resize();
      if (this.sites_) this.sites_.place();
      this.updateSiteCount_();
      this.updateWalls_();
      this.updateBody_();
      this.box_.fit();
      this.noteExtent_();
      this.sync_();
      if (this.camera_.current) this.look_(this.camera_.current, true);
      else stage.reframe();
    }

    /**
     * Applies the saved view chosen in the menu: the opening view or one of the scene's own.
     * @return {!Promise<void>}
     * @private
     */
    async applyPreset_() {
      const scene = this.scene_;
      const stage = this.stage_;
      const [nx, ny, nz] = stage.dims;
      const sp = stage.spacing;
      const preset = this.presets_[+$('preset').value] || this.presets_[0];
      const d = preset.defaults || {};
      const slices = d.slices || {};
      const shows = d.show || {};
      const cut = d.cut || {};
      const or = (value, fallback) => (value != null ? value : fallback);
      const clampIndex = (value, count) => Math.max(0, Math.min(count - 1, Math.round(+value) || 0));

      this.fieldOverride_ = preset.field || null;
      this.field_ = clampIndex(d.field, scene.fields.length);
      $('field').value = this.field_;
      if (scene.times) {
        this.time_ = clampIndex(or(d.time, scene.times.length - 1), scene.times.length);
        $('t').value = this.time_;
        $('t-o').textContent = scene.times[this.time_].label;
      }
      $('ve').value = String(d.ve || 1);
      $('on-outline').checked = shows.outline !== false;
      $('on-axes').checked = shows.axes !== false;
      $('on-sites').checked = shows.sites !== false;
      $('on-sitefit').checked = !!shows.siteFit;
      $('on-walls').checked = !!shows.walls;
      $('compass').value = d.marker || 'cube';
      [['cut-w', 'w'], ['cut-e', 'e'], ['cut-s', 's'], ['cut-n', 'n'], ['cut-t', 't'], ['cut-b', 'b']]
          .forEach(([id, key]) => { $(id).value = cut[key] || 0; });
      if (!this.is2d_) {
        $('k').value = slices.depth_km != null ? nz - 1 - Math.round(slices.depth_km / sp[2]) : Math.round(nz * 0.85);
        $('i').value = slices.x_km != null ? Math.round(slices.x_km / sp[0]) : Math.round(nx / 2);
        $('j').value = slices.y_km != null ? Math.round(slices.y_km / sp[1]) : Math.round(ny / 2);
        $('on-k').checked = slices.showDepth !== false;
        $('on-i').checked = !!slices.showX;
        $('on-j').checked = slices.showY !== false;
        $('op-k').value = or(slices.opacityDepth, 100);
        $('op-i').value = or(slices.opacityX, 100);
        $('op-j').value = or(slices.opacityY, 100);
        $('on-solid').checked = d.showSolid !== false;
        $('s-op').value = or(d.solidOpacity, 100);
        $('surf-op').value = or(d.surfaceOpacity, 50);
      }
      if (this.sites_) this.sites_.setTinted($('on-sitefit').checked);

      await this.showVolume_(false);        // brings the field's own scale, solid and surfaces
      this.setExaggeration_(+$('ve').value);
      this.setCompass_();
      this.applyCut_();
      this.camera_.tilt = +d.tilt || 0;
      this.camera_.setViewAngle(+d.viewAngle || 30);
      let view = this.is2d_ ? 'south' : 'oblique';
      if (!this.is2d_ && d.from) {
        this.camera_.setCustom(d.from);
        view = 'custom';
      } else if (!this.is2d_ && this.camera_.has(d.view)) {
        view = d.view;
      }
      this.look_(view, true);
    }

    /**
     * Gathers the current settings in the form the scene file takes, for whoever sets a model up.
     * @return {!Object} A "defaults" block and a "field" block.
     * @private
     */
    settings_() {
      const [, , nz] = this.stage_.dims;
      const sp = this.stage_.spacing;
      const checked = (id) => $(id).checked;
      const num = (id) => +$(id).value;
      const km = (voxels, axis) => +(voxels * sp[axis]).toFixed(2);
      const defaults = {
        field: this.field_,
        view: this.camera_.current || 'oblique',
        ve: this.stage_.exaggeration,
        marker: $('compass').value,
        show: {outline: checked('on-outline'), axes: checked('on-axes'), sites: checked('on-sites'),
          siteFit: checked('on-sitefit'), walls: checked('on-walls')},
        cut: {w: num('cut-w'), e: num('cut-e'), s: num('cut-s'), n: num('cut-n'), t: num('cut-t'), b: num('cut-b')},
      };
      const field = {
        label: this.scene_.fields[this.field_].label,
        vmin: num('vmin'), vmax: num('vmax'), cmap: $('cmap').value, reverse: checked('rev'),
      };
      if (this.scene_.times) defaults.time = this.time_;
      if (!this.is2d_) {
        defaults.slices = {
          depth_km: km(nz - 1 - num('k'), 2), x_km: km(num('i'), 0), y_km: km(num('j'), 1),
          showDepth: checked('on-k'), showX: checked('on-i'), showY: checked('on-j'),
          opacityDepth: num('op-k'), opacityX: num('op-i'), opacityY: num('op-j'),
        };
        defaults.showSolid = checked('on-solid');
        defaults.solidOpacity = num('s-op');
        defaults.surfaceOpacity = num('surf-op');
        field.solid = {};
        if (checked('s-min-on')) field.solid.min = num('s-min');
        if (checked('s-max-on')) field.solid.max = num('s-max');
        if (num('s-below') > 0) field.solid.below_km = num('s-below');
        field.surfaces = parseNumberList($('surf').value);
      }
      return {defaults, field};
    }

    /**
     * Copies the current settings to the clipboard.
     * @param {!HTMLElement} button The button pressed; shows "Copied" for a moment.
     * @private
     */
    copySettings_(button) {
      const done = () => {
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = 'Copy settings'; }, 1500);
      };
      const text = JSON.stringify(this.settings_(), null, 1);
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))).then(done, done);
    }
  }

  /**
   * Starts the page: reads the scene named in the address, fills in the record and opens the viewer.
   * @return {!Promise<void>}
   */
  const start = async () => {
    const message = $('msg');
    try {
      const name = (location.search.match(/[?&]scene=([\w-]+)/) || [])[1] || 'vulcan';
      const [scenes, records] = await Promise.all([fetchJson('volumes/scenes.json'), fetchJson('volumes/records.json')]);
      const scene = scenes[name];
      if (!scene) throw new Error(`unknown scene "${name}"`);
      if (!scene.fields || !scene.fields.length) throw new Error(`scene "${name}" lists no fields`);
      if (!records[name]) throw new Error(`no record for scene "${name}"`);
      renderRecord(scene, records[name], name);

      const store = new VolumeStore();
      const first = scene.fields[0];
      const firstStem = scene.times ? first.stem.replace('{t}', scene.times[scene.times.length - 1].id) : first.stem;
      const [volume, siteFile] = await Promise.all([
        store.load(firstStem),
        scene.sites ? fetchJson(`volumes/${scene.sites}`) : null,
      ]);
      const sites = siteFile ? siteFile.sites : null;
      const viewer = new Viewer(scene, store, volume, sites);
      await viewer.open();
      message.remove();
      if (scene.fit && viewer.siteLayer && window.MATEFit) {
        window.MATEFit.init({url: `volumes/${scene.fit}`, sites, layer: viewer.siteLayer});
      }
    } catch (error) {
      message.textContent = `The viewer could not start: ${error.message}`;
      console.error(error);
    }
  };

  start();
})();
