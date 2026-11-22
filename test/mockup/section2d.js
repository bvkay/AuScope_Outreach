/**
 * @fileoverview Viewer for 2D section models: every field drawn as its own panel, one above the
 * other, at true scale. The panels share one distance axis, one time slider and one view, so a
 * zoom or a move in one is followed by the rest.
 *
 * viewer3d.js opens this when a scene's volumes are one cell thick. Each panel is a plain 2D
 * canvas; nothing here uses WebGL.
 *
 * Needs window.MATEKit (viewkit.js), whose file comment explains physical, stored and raw values.
 */
window.MATESection = (() => {
  'use strict';

  const {RAW_MAX, esc, fetchVolume, formatNumber, dropCrowdedLabels, niceTicks, rampStops, ValueScale} = window.MATEKit;

  /** Space left of a panel for the depth numbers and title, in CSS pixels. */
  const MARGIN_LEFT_PX = 72;
  /** Space right of a panel, in CSS pixels. */
  const MARGIN_RIGHT_PX = 18;
  /** Space above and below a panel's picture, in CSS pixels; room for half a line of text. */
  const MARGIN_Y_PX = 9;
  /** Height of the distance axis under the last panel, in CSS pixels. */
  const X_AXIS_HEIGHT_PX = 46;
  /** Steps in a colour ramp once it is worked out. */
  const RAMP_STEPS = 1024;
  /** Closest zoom, as a multiple of the whole section. */
  const MAX_ZOOM = 40;
  /** Zoom per notch of the wheel. */
  const ZOOM_STEP = 1.2;
  /** Time between steps while playing, in milliseconds. */
  const PLAY_INTERVAL_MS = 900;
  const TICK_FONT = '13px Arial';
  const TITLE_FONT = 'bold 15px Arial';
  const TICK_COLOUR = '#333333';
  const TITLE_COLOUR = '#282572';

  /**
   * The part of the section on show: distances along it and depths below its top, in km.
   * @typedef {{x0: number, x1: number, d0: number, d1: number}}
   */
  let Window;

  /**
   * @param {string} html Markup with a single root element.
   * @return {!HTMLElement} That element.
   */
  const build = (html) => {
    const holder = document.createElement('template');
    holder.innerHTML = html.trim();
    return /** @type {!HTMLElement} */ (holder.content.firstElementChild);
  };

  /**
   * Sizes a canvas for sharp drawing and returns its context, scaled so drawing is in CSS pixels.
   * @param {!HTMLCanvasElement} canvas The canvas.
   * @param {number} width Width in CSS pixels.
   * @param {number} height Height in CSS pixels.
   * @return {!CanvasRenderingContext2D} The context, cleared.
   */
  const prepare = (canvas, width, height) => {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return context;
  };

  /** @param {number} v A tick value. @return {string} The value without rounding noise. */
  const tickText = (v) => String(+v.toPrecision(6));

  /**
   * One field: its picture, depth axis, legend and colour settings.
   */
  class Panel {
    /**
     * @param {!Object} field The field's entry in the scene.
     * @param {string} rampOptions Markup of the colour ramp choices.
     */
    constructor(field, rampOptions) {
      /** @const {!Object} */
      this.field = field;
      /** @const {!ValueScale} */
      this.scale = new ValueScale();
      /** @type {boolean} Whether the panel is on show. */
      this.shown = true;
      /** @private {?{meta: !Object, raw: !Uint16Array}} The volume drawn. */
      this.volume_ = null;
      /** @private {number} Lower colour limit, stored. */
      this.low_ = 0;
      /** @private {number} Upper colour limit, stored. */
      this.high_ = 1;
      /** @private @const {!Uint32Array} Colour of every raw value, as canvas pixels. */
      this.colours_ = new Uint32Array(RAW_MAX + 1);
      /** @private @const {!HTMLCanvasElement} The whole section, one pixel per cell. */
      this.picture_ = document.createElement('canvas');

      const unit = field.unit ? ` <span class="unit">(${esc(field.unit)})</span>` : '';
      /** @const {!HTMLElement} The panel as it appears beside the controls. */
      this.figure = build(`
        <figure class="sec-panel">
          <figcaption><b>${esc(field.label)}${unit}</b>
            <div class="sec-legend"><div class="ramp"></div><div class="ticks"></div></div>
          </figcaption>
          <canvas></canvas>
        </figure>`);
      /** @const {!HTMLCanvasElement} */
      this.canvas = this.figure.querySelector('canvas');
      /** @const {!HTMLElement} The field's block in the control panel. */
      this.controls = build(`
        <div class="grp sec-field">
          <div class="line2"><label><input type="checkbox" data-role="shown" checked> <b>${esc(field.label)}</b></label></div>
          <div class="line2"><input class="num" data-role="min" aria-label="${esc(field.label)}, lowest value coloured">
            <span>to</span><input class="num" data-role="max" aria-label="${esc(field.label)}, highest value coloured">
            <span class="unit">${esc(field.unit || '')}</span></div>
          <div class="line2"><select data-role="ramp" aria-label="${esc(field.label)}, colour scale">${rampOptions}</select></div>
          <div class="line2"><label><input type="checkbox" data-role="reverse"> Reverse</label></div>
          <p class="err" data-role="error"></p>
        </div>`);
    }

    /**
     * @param {string} role Value of a control's data-role.
     * @return {!HTMLElement} That control.
     * @private
     */
    control_(role) {
      return this.controls.querySelector(`[data-role="${role}"]`);
    }

    /**
     * Calls back when the visitor changes a colour setting or shows or hides the field.
     * @param {function()} onColour Called after a change of limits, ramp or direction.
     * @param {function()} onShown Called after the field is shown or hidden.
     */
    listen(onColour, onShown) {
      ['min', 'max', 'ramp', 'reverse'].forEach((role) => {
        this.control_(role).addEventListener('change', () => { if (this.applyColours()) onColour(); });
      });
      this.control_('shown').addEventListener('change', (e) => {
        this.shown = e.target.checked;
        this.figure.hidden = !this.shown;
        onShown();
      });
    }

    /** Puts the colour controls back to the field's own settings. Does nothing before a volume is set. */
    resetColours() {
      if (!this.volume_) return;
      const {field, scale} = this;
      this.control_('min').value = formatNumber(field.vmin != null ? field.vmin : scale.physicalAt(0));
      this.control_('max').value = formatNumber(field.vmax != null ? field.vmax : scale.physicalAt(1));
      this.control_('ramp').value = field.cmap || 'Viridis (matplotlib)';
      this.control_('reverse').checked = !!field.reverse;
      this.applyColours();
    }

    /**
     * Sets the volume to draw.
     * @param {{meta: !Object, raw: !Uint16Array}} volume The field at the time on show.
     */
    setVolume(volume) {
      const first = !this.volume_;
      this.volume_ = volume;
      this.scale.setStorage(volume.meta);
      if (first) this.resetColours();
      else this.paint_();
    }

    /**
     * Reads the colour controls and recolours the picture and legend.
     * @return {boolean} False if the limits are not usable; nothing is changed then.
     */
    applyColours() {
      const {scale} = this;
      const min = Number(this.control_('min').value);
      const max = Number(this.control_('max').value);
      const error = this.control_('error');
      if (!scale.isValid(min) || !scale.isValid(max)) {
        error.textContent = scale.isLog ? 'Use numbers above zero.' : 'Use numbers.';
        return false;
      }
      if (min >= max) {
        error.textContent = 'The first value must be below the second.';
        return false;
      }
      error.textContent = '';
      this.low_ = scale.toStored(min);
      this.high_ = scale.toStored(max);

      let stops = rampStops(this.control_('ramp').value);
      if (this.control_('reverse').checked) stops = stops.map(([at, r, g, b]) => [1 - at, r, g, b]).reverse();
      this.fillColours_(stops);
      this.drawLegend_(stops);
      this.paint_();
      return true;
    }

    /**
     * Works out the colour of every raw value. Raw 0, "no value", stays see-through.
     * @param {!Array<!Array<number>>} stops Ramp stops as [fraction, r, g, b].
     * @private
     */
    fillColours_(stops) {
      const ramp = new Uint32Array(RAMP_STEPS);
      let n = 0;
      for (let step = 0; step < RAMP_STEPS; step++) {
        const at = step / (RAMP_STEPS - 1);
        while (n < stops.length - 2 && at > stops[n + 1][0]) n++;
        const [a, b] = [stops[n], stops[n + 1]];
        const mix = Math.min(1, Math.max(0, (at - a[0]) / (b[0] - a[0] || 1)));
        const channel = (c) => Math.round((a[c] + mix * (b[c] - a[c])) * 255);
        // Canvas pixels are stored alpha, blue, green, red from the high byte down.
        ramp[step] = (255 << 24 | channel(3) << 16 | channel(2) << 8 | channel(1)) >>> 0;
      }
      const low = this.scale.toRaw(this.low_);
      const span = this.scale.toRaw(this.high_) - low;
      this.colours_[0] = 0;
      for (let raw = 1; raw <= RAW_MAX; raw++) {
        const at = Math.min(1, Math.max(0, (raw - low) / span));
        this.colours_[raw] = ramp[Math.round(at * (RAMP_STEPS - 1))];
      }
    }

    /**
     * @param {!Array<!Array<number>>} stops Ramp stops as [fraction, r, g, b].
     * @private
     */
    drawLegend_(stops) {
      const {scale} = this;
      const css = stops.map(([at, r, g, b]) =>
        `rgb(${[r, g, b].map((v) => Math.round(v * 255)).join(',')}) ${(at * 100).toFixed(1)}%`);
      this.figure.querySelector('.ramp').style.background = `linear-gradient(90deg,${css.join(',')})`;
      const ticks = this.figure.querySelector('.ticks');
      ticks.innerHTML = scale.ticks(this.low_, this.high_).map((v) =>
        `<span style="left:${((v - this.low_) / (this.high_ - this.low_) * 100).toFixed(1)}%">${formatNumber(scale.toPhysical(v))}</span>`).join('');
      dropCrowdedLabels(ticks);
    }

    /**
     * Colours the whole section into the off-screen picture. The file's first row is the
     * deepest, so rows are written bottom-up.
     * @private
     */
    paint_() {
      if (!this.volume_) return;
      const {meta, raw} = this.volume_;
      const [nx, , nz] = meta.dims;
      this.picture_.width = nx;
      this.picture_.height = nz;
      const context = this.picture_.getContext('2d');
      const image = context.createImageData(nx, nz);
      const pixels = new Uint32Array(image.data.buffer);
      for (let k = 0; k < nz; k++) {
        const from = k * nx;
        const to = (nz - 1 - k) * nx;
        for (let i = 0; i < nx; i++) pixels[to + i] = this.colours_[raw[from + i]];
      }
      context.putImageData(image, 0, 0);
    }

    /**
     * Draws the part of the section on show, with its outline and depth axis.
     * @param {!Window} view The part on show.
     * @param {number} width Width of the panel in CSS pixels.
     * @return {number} Width of the picture itself in CSS pixels, without the margins.
     */
    draw(view, width) {
      if (!this.volume_) return 0;
      const [length, , depth] = this.volume_.meta.extent_km;
      const plotWidth = width - MARGIN_LEFT_PX - MARGIN_RIGHT_PX;
      const plotHeight = Math.round(plotWidth * (view.d1 - view.d0) / (view.x1 - view.x0));
      const context = prepare(this.canvas, width, plotHeight + 2 * MARGIN_Y_PX);
      const picture = this.picture_;

      context.imageSmoothingEnabled = false;
      context.drawImage(picture,
          view.x0 / length * picture.width, view.d0 / depth * picture.height,
          (view.x1 - view.x0) / length * picture.width, (view.d1 - view.d0) / depth * picture.height,
          MARGIN_LEFT_PX, MARGIN_Y_PX, plotWidth, plotHeight);
      context.strokeStyle = TITLE_COLOUR;
      context.strokeRect(MARGIN_LEFT_PX + 0.5, MARGIN_Y_PX + 0.5, plotWidth - 1, plotHeight - 1);

      context.font = TICK_FONT;
      context.fillStyle = TICK_COLOUR;
      context.textAlign = 'right';
      context.textBaseline = 'middle';
      niceTicks(view.d0, view.d1).forEach((d) => {
        const y = MARGIN_Y_PX + (d - view.d0) / (view.d1 - view.d0) * plotHeight;
        context.fillRect(MARGIN_LEFT_PX - 5, Math.round(y), 5, 1);
        context.fillText(d === 0 ? '0' : tickText(-d), MARGIN_LEFT_PX - 9, y);
      });
      context.font = TITLE_FONT;
      context.fillStyle = TITLE_COLOUR;
      context.textAlign = 'center';
      context.save();
      context.translate(14, MARGIN_Y_PX + plotHeight / 2);
      context.rotate(-Math.PI / 2);
      context.fillText(this.volume_.meta.axes[2], 0, 0);
      context.restore();
      return plotWidth;
    }
  }

  /**
   * The stacked panels, their shared view and time, and the controls beside them.
   */
  class SectionViewer {
    /**
     * @param {!Object} scene The scene entry; its fields are drawn top to bottom in order.
     * @param {!HTMLElement} mount Element that holds the 3D viewer's panel and picture, which
     *     are hidden.
     */
    constructor(scene, mount) {
      /** @private @const {!Object} */
      this.scene_ = scene;
      /** @private @const {!Map<string, !Promise<{meta: !Object, raw: !Uint16Array}>>} */
      this.volumes_ = new Map();
      /** @private {number} Index of the time step on show. */
      this.time_ = scene.times ? scene.times.length - 1 : 0;
      /** @private {number} Counts requests, so a slow one cannot overwrite a newer one. */
      this.request_ = 0;
      /** @private {?number} Timer while playing. */
      this.playing_ = null;
      /** @private {?Array<number>} Length and depth of the section in km, once known. */
      this.size_ = null;
      /** @private {string} Title of the distance axis, once known. */
      this.distanceTitle_ = '';
      /** @private {?Window} */
      this.view_ = null;

      const rampOptions = mount.querySelector('#cmap').innerHTML;
      /** @private @const {!Array<!Panel>} */
      this.panels_ = scene.fields.map((field) => new Panel(field, rampOptions));

      const times = scene.times || [];
      /** @private @const {!HTMLElement} */
      this.side_ = build(`
        <aside class="cp sec-cp" aria-label="Section controls">
          <div class="cp-data" ${times.length ? '' : 'hidden'}>
            <div class="line2"><span class="label">Time</span><output class="push" data-role="time"></output></div>
            <div class="line2"><button class="btn ghost" type="button" data-role="play">Play</button>
              <input type="range" min="0" max="${times.length - 1}" step="1" value="${this.time_}" data-role="slider" aria-label="Time step"></div>
          </div>
          <div class="sec-fields"></div>
          <div class="cp-foot">
            <button class="btn ghost" type="button" data-role="reset-colours" title="Put every field's colours back to how this model opens">Model colours</button>
            <button class="btn ghost" type="button" data-role="reset-view" title="Show the whole section again">Whole section</button>
          </div>
        </aside>`);
      /** @private @const {!HTMLElement} */
      this.main_ = build(`
        <div class="sec">
          <div class="sec-panels"></div>
          <canvas class="sec-xaxis"></canvas>
          <p class="sec-msg" role="status"></p>
          <p class="hint">Drag to move · scroll to zoom · double-click to refit · all panels move together</p>
        </div>`);
      this.panels_.forEach((panel) => {
        this.side_.querySelector('.sec-fields').append(panel.controls);
        this.main_.querySelector('.sec-panels').append(panel.figure);
      });
      [...mount.children].forEach((child) => { child.hidden = true; });
      mount.append(this.side_, this.main_);
      this.bind_();
    }

    /**
     * @param {string} role Value of a control's data-role.
     * @return {!HTMLElement} That control.
     * @private
     */
    control_(role) {
      return this.side_.querySelector(`[data-role="${role}"]`);
    }

    /**
     * Loads and draws the opening time step.
     * @return {!Promise<void>}
     */
    open() {
      new ResizeObserver(() => this.draw_()).observe(this.main_.querySelector('.sec-panels'));
      return this.showTime_(this.time_);
    }

    /**
     * Connects the controls and the mouse.
     * @private
     */
    bind_() {
      this.panels_.forEach((panel) => {
        panel.listen(() => this.draw_(), () => this.showTime_(this.time_));
        this.bindMouse_(panel.canvas);
      });
      this.control_('slider').addEventListener('input', (e) => this.showTime_(+e.target.value));
      this.control_('play').addEventListener('click', () => this.togglePlay_());
      this.control_('reset-colours').addEventListener('click', () => {
        this.panels_.forEach((panel) => panel.resetColours());
        this.draw_();
      });
      this.control_('reset-view').addEventListener('click', () => this.setView_(this.wholeView_()));
    }

    /**
     * Lets the visitor zoom with the wheel, move by dragging and refit with a double-click.
     * @param {!HTMLCanvasElement} canvas A panel's canvas.
     * @private
     */
    bindMouse_(canvas) {
      let last = null;
      const plotWidth = () => canvas.clientWidth - MARGIN_LEFT_PX - MARGIN_RIGHT_PX;
      canvas.addEventListener('pointerdown', (e) => {
        last = [e.clientX, e.clientY];
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!last || !this.view_) return;
        const kmPerPixel = (this.view_.x1 - this.view_.x0) / plotWidth();
        const dx = (last[0] - e.clientX) * kmPerPixel;
        const dy = (last[1] - e.clientY) * kmPerPixel;
        last = [e.clientX, e.clientY];
        const v = this.view_;
        this.setView_({x0: v.x0 + dx, x1: v.x1 + dx, d0: v.d0 + dy, d1: v.d1 + dy});
      });
      ['pointerup', 'pointercancel'].forEach((type) => canvas.addEventListener(type, () => { last = null; }));
      canvas.addEventListener('wheel', (e) => {
        if (!this.view_) return;
        e.preventDefault();
        const box = canvas.getBoundingClientRect();
        const v = this.view_;
        const kmPerPixel = (v.x1 - v.x0) / plotWidth();
        const x = v.x0 + (e.clientX - box.left - MARGIN_LEFT_PX) * kmPerPixel;
        const d = v.d0 + (e.clientY - box.top - MARGIN_Y_PX) * kmPerPixel;
        const factor = e.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        this.setView_({
          x0: x + (v.x0 - x) * factor, x1: x + (v.x1 - x) * factor,
          d0: d + (v.d0 - d) * factor, d1: d + (v.d1 - d) * factor,
        });
      }, {passive: false});
      canvas.addEventListener('dblclick', () => this.setView_(this.wholeView_()));
    }

    /**
     * @return {!Window} The view of the whole section.
     * @private
     */
    wholeView_() {
      return {x0: 0, x1: this.size_[0], d0: 0, d1: this.size_[1]};
    }

    /**
     * Changes the part on show, kept inside the section, no wider than it and no closer than
     * MAX_ZOOM. The shape of the view never changes, so the scale stays true.
     * @param {!Window} wanted The part asked for.
     * @private
     */
    setView_(wanted) {
      const [length, depth] = this.size_;
      const width = Math.min(length, Math.max(length / MAX_ZOOM, wanted.x1 - wanted.x0));
      const height = width * depth / length;
      const centreX = (wanted.x0 + wanted.x1) / 2;
      const centreD = (wanted.d0 + wanted.d1) / 2;
      const x0 = Math.min(length - width, Math.max(0, centreX - width / 2));
      const d0 = Math.min(depth - height, Math.max(0, centreD - height / 2));
      this.view_ = {x0, x1: x0 + width, d0, d1: d0 + height};
      this.draw_();
    }

    /**
     * @param {!Panel} panel A panel.
     * @param {number} index A time step.
     * @return {!Promise<{meta: !Object, raw: !Uint16Array}>} That field at that time.
     * @private
     */
    load_(panel, index) {
      const {times} = this.scene_;
      const stem = times ? panel.field.stem.replace('{t}', times[index].id) : panel.field.stem;
      if (!this.volumes_.has(stem)) {
        const request = fetchVolume(stem);
        request.catch(() => this.volumes_.delete(stem));   // a failed load may be tried again
        this.volumes_.set(stem, request);
      }
      return this.volumes_.get(stem);
    }

    /**
     * Shows a time step in every panel on show.
     * @param {number} index The time step.
     * @return {!Promise<void>} Settles once it is drawn, or once a newer request has replaced it.
     * @private
     */
    async showTime_(index) {
      const request = ++this.request_;
      const message = this.main_.querySelector('.sec-msg');
      const shown = this.panels_.filter((panel) => panel.shown);
      try {
        const volumes = await Promise.all(shown.map((panel) => this.load_(panel, index)));
        if (request !== this.request_) return;
        this.time_ = index;
        if (!this.size_ && volumes.length) {
          const [length, , depth] = volumes[0].meta.extent_km;
          this.size_ = [length, depth];
          this.distanceTitle_ = volumes[0].meta.axes[0];
          this.view_ = this.wholeView_();
        }
        shown.forEach((panel, n) => panel.setVolume(volumes[n]));
        if (this.scene_.times) {
          this.control_('slider').value = index;
          this.control_('time').textContent = this.scene_.times[index].label;
        }
        message.textContent = '';
        this.draw_();
      } catch (error) {
        if (request !== this.request_) return;
        message.textContent = `This time step could not be shown: ${error.message}`;
        console.error(error);
      }
    }

    /**
     * Starts or stops stepping through time. The next step waits for the one before to be drawn.
     * @private
     */
    togglePlay_() {
      const button = this.control_('play');
      if (this.playing_ !== null) {
        clearTimeout(this.playing_);
        this.playing_ = null;
        button.textContent = 'Play';
        return;
      }
      button.textContent = 'Pause';
      const step = async () => {
        await this.showTime_((this.time_ + 1) % this.scene_.times.length);
        if (this.playing_ !== null) this.playing_ = setTimeout(step, PLAY_INTERVAL_MS);
      };
      this.playing_ = setTimeout(step, 0);
    }

    /**
     * Redraws every panel on show and the distance axis under them.
     * @private
     */
    draw_() {
      const view = this.view_;
      const holder = this.main_.querySelector('.sec-panels');
      const axis = this.main_.querySelector('.sec-xaxis');
      const shown = this.panels_.filter((panel) => panel.shown);
      const width = holder.clientWidth;
      axis.hidden = !view || !shown.length || !width;
      if (axis.hidden) return;
      let plotWidth = 0;
      shown.forEach((panel) => { plotWidth = panel.draw(view, width) || plotWidth; });

      const context = prepare(axis, width, X_AXIS_HEIGHT_PX);
      context.font = TICK_FONT;
      context.fillStyle = TICK_COLOUR;
      context.textAlign = 'center';
      context.textBaseline = 'top';
      niceTicks(view.x0, view.x1).forEach((x) => {
        const at = MARGIN_LEFT_PX + (x - view.x0) / (view.x1 - view.x0) * plotWidth;
        context.fillRect(Math.round(at), 0, 1, 5);
        context.fillText(tickText(x), at, 8);
      });
      context.font = TITLE_FONT;
      context.fillStyle = TITLE_COLOUR;
      context.fillText(this.distanceTitle_, MARGIN_LEFT_PX + plotWidth / 2, 27);
    }
  }

  /**
   * Opens the section viewer in place of the 3D viewer.
   * @param {{scene: !Object, mount: !HTMLElement}} options The scene, and the element that holds
   *     the 3D viewer.
   * @return {!Promise<void>} Settles once the opening time step is drawn.
   */
  const open = ({scene, mount}) => new SectionViewer(scene, mount).open();

  return {open};
})();
