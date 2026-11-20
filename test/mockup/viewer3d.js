/* Model viewer for the mockup. One page, many models: model-3d.html?scene=<name>.
   A scene (volumes/scenes.json) lists the model's fields and time steps; each is a small uniform
   volume made by the scripts in tools/. A volume whose middle dimension is 1 is a 2D section. */
(async function () {
  var $ = function (id) { return document.getElementById(id); };
  var Core = vtk.Rendering.Core, DM = vtk.Common.DataModel, msg = $('msg');
  var show = function (id, on) { var e = $(id); if (e) e.hidden = !on; };
  try {
    var name = (location.search.match(/[?&]scene=([\w-]+)/) || [])[1] || 'vulcan';
    var scenes = await (await fetch('volumes/scenes.json')).json();
    var sc = scenes[name]; if (!sc) throw new Error('unknown scene "' + name + '"');

    // ── the model's full record, below the viewer ──
    var rec = (await (await fetch('volumes/records.json')).json())[name];
    document.title = sc.short + ' — M@TE (mockup)';
    $('crumb').textContent = rec.slug;
    $('title').textContent = rec.title;
    $('byline').innerHTML = '<b>' + rec.creators.join(', ') + '</b> · ' + sc.year;
    $('r-snapshot').innerHTML = rec.snapshot;
    ['overview', 'model', 'meta'].forEach(function (k) { $('r-' + k).innerHTML = rec[k]; });
    $('r-cite').innerHTML = rec.citation;
    $('r-copy').onclick = function () { var b = this; navigator.clipboard.writeText($('r-cite').textContent).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy citation'; }, 1500); }); };
    if (rec.data_url) $('r-get').insertAdjacentHTML('beforeend', '<a class="btn" href="' + rec.data_url + '">Model files at NCI</a>');
    if (rec.repo) $('r-get').insertAdjacentHTML('beforeend', '<a class="btn ghost" href="' + rec.repo + '">M@TE record on GitHub</a>');
    $('r-dois').innerHTML = rec.dois.map(function (d) { return '<div><dt>' + d.label + '</dt><dd class="mono"><a href="https://doi.org/' + d.doi + '">' + d.doi + '</a></dd></div>'; }).join('');
    $('r-creators').innerHTML = rec.creators.map(function (c) { return '<li>' + c + '</li>'; }).join('');
    $('tags').innerHTML = rec.tags.map(function (t) { return '<li>' + t + '</li>'; }).join('');
    $('rtabs').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      [].forEach.call(this.children, function (t) { t.setAttribute('aria-selected', t === b); $('r-' + t.dataset.p).hidden = t !== b; });
    });
    // the model links keep whichever mockup and footer you are in
    var carry = (location.search.match(/[?&](?:v|f)=[\w]+/g) || []).map(function (p) { return '&' + p.slice(1); }).join('');
    [].forEach.call(document.querySelectorAll('.scene-links a'), function (a) { a.href = 'model-3d.html?scene=' + a.dataset.s + carry; if (a.dataset.s === name) a.setAttribute('aria-current', 'true'); });

    // ── volumes: fetched on demand, kept once loaded ──
    var cache = {};
    var load = async function (stem) {
      if (cache[stem]) return cache[stem];
      var meta = await (await fetch('volumes/' + stem + '.json')).json();
      var raw = new Uint16Array(await (await fetch('volumes/' + stem + '.u16')).arrayBuffer());
      var gap = null;
      if (meta.dims[1] !== 1) {
        // 3D: 0 means "no value" (above the ground surface). Remember where, then show those
        // voxels as the top of the scale so slices are not left with holes.
        for (var n = 0; n < raw.length; n++) if (raw[n] === 0) { if (!gap) gap = new Uint8Array(raw.length); gap[n] = 1; raw[n] = 65535; }
      } else {
        // 2D: gaps stay 0 and are drawn see-through. The cut-off is not sharp, so real values are
        // kept clear of it (raw 80 of 65535 = 0.1 % of the range).
        for (var k = 0; k < raw.length; k++) if (raw[k] !== 0 && raw[k] < 80) raw[k] = 80;
      }
      return (cache[stem] = { meta: meta, raw: raw, gap: gap });
    };
    var fi = 0, ti = sc.times ? sc.times.length - 1 : 0;
    var stemOf = function () { var f = sc.fields[fi]; return sc.times ? f.stem.replace('{t}', sc.times[ti].id) : f.stem; };
    var vol = await load(stemOf()), meta = vol.meta;
    var nx = meta.dims[0], ny = meta.dims[1], nz = meta.dims[2], sp = meta.spacing_km, is2d = ny === 1;
    var axisNames = meta.axes || ['East (km)', 'North (km)', 'Depth (km)'];
    var lo, hi, isLog, unit;
    var toRaw = function (stored) { return 1 + (stored - lo) / (hi - lo) * 65534; };
    var toStored = function (phys) { return isLog ? Math.log10(phys) : phys; };
    var toPhys = function (stored) { return isLog ? Math.pow(10, stored) : stored; };
    var fmt = function (v) { var a = Math.abs(v); return (a !== 0 && (a >= 1e5 || a < 1e-2)) ? v.toExponential(1) : String(+v.toPrecision(3)); };
    var physOk = function (v) { return isFinite(v) && (!isLog || v > 0); };

    var image = DM.vtkImageData.newInstance();
    image.setSpacing(sp[0], is2d ? 1 : sp[1], sp[2]);    // kilometres
    // The part of the model on show, as first and last voxel along each axis. Cutting in from a
    // side shrinks this box, and everything (slices, solid, surfaces, axes) is drawn from it.
    var cr = { i0: 0, i1: nx - 1, j0: 0, j1: ny - 1, k0: 0, k1: nz - 1 }, cx, cy, cz, B, C, curRaw = vol.raw;
    var setData = function (raw) {
      curRaw = raw;
      cx = cr.i1 - cr.i0 + 1; cy = cr.j1 - cr.j0 + 1; cz = cr.k1 - cr.k0 + 1;
      var sub = raw;
      if (cx !== nx || cy !== ny || cz !== nz) {
        sub = new Uint16Array(cx * cy * cz);
        for (var z = 0; z < cz; z++) for (var y = 0; y < cy; y++) {
          var s0 = cr.i0 + nx * (y + cr.j0 + ny * (z + cr.k0));
          sub.set(raw.subarray(s0, s0 + cx), cx * (y + cy * z));
        }
      }
      image.setDimensions(cx, cy, cz);
      image.setOrigin(cr.i0 * sp[0], is2d ? 0 : cr.j0 * sp[1], -meta.extent_km[2] + cr.k0 * sp[2]);   // z = 0 stays at the top of the whole model
      image.getPointData().setScalars(vtk.Common.Core.vtkDataArray.newInstance({ name: 'v', numberOfComponents: 1, values: sub }));
      image.modified();
      B = image.getBounds(); C = [(B[0] + B[1]) / 2, (B[2] + B[3]) / 2, (B[4] + B[5]) / 2];
    };
    setData(vol.raw);

    var grw = vtk.Rendering.Misc.vtkGenericRenderWindow.newInstance({ background: [1, 1, 1] });
    grw.setContainer($('view')); grw.resize();
    var ren = grw.getRenderer(), win = grw.getRenderWindow(), cam = ren.getActiveCamera();
    var scaled = [];        // everything that stretches with vertical exaggeration

    // ── colour scale: a named ramp stretched between two typed limits ──
    var MT = [[0, '#7a0403'], [.125, '#d93806'], [.25, '#f9a41b'], [.42, '#e8e86a'], [.54, '#7fd67f'], [.71, '#2fa3d9'], [.875, '#3a4fc4'], [1, '#30123b']];
    // red - yellow - blue: red at the low end, so conductive (low resistivity) is red
    var RYB = [[0, '#a50026'], [.125, '#d73027'], [.25, '#f46d43'], [.375, '#fdae61'], [.5, '#ffffbf'], [.625, '#abd9e9'], [.75, '#74add1'], [.875, '#4575b4'], [1, '#313695']];
    var hex2rgb = function (h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; }); };
    var ramp = function (n) {
      if (n === 'mt' || n === 'ryb') return (n === 'mt' ? MT : RYB).map(function (s) { return [s[0]].concat(hex2rgb(s[1])); });
      var p = Core.vtkColorTransferFunction.vtkColorMaps.getPresetByName(n).RGBPoints, out = [], a = p[0], b = p[p.length - 4];
      for (var i = 0; i < p.length; i += 4) out.push([(p[i] - a) / (b - a), p[i + 1], p[i + 2], p[i + 3]]);
      return out;
    };
    var ctf = Core.vtkColorTransferFunction.newInstance();
    var css = function (c) { return 'rgb(' + c.slice(1).map(function (v) { return Math.round(v * 255); }).join(',') + ')'; };
    var applyScale = function () {
      var vmin = +$('vmin').value, vmax = +$('vmax').value;
      var ok = $('vmin').value !== '' && $('vmax').value !== '' && physOk(vmin) && physOk(vmax) && vmin < vmax;
      if (!ok) { $('verr').textContent = isLog ? 'Enter two positive numbers, smallest first.' : 'Enter two numbers, smallest first.'; return false; }
      $('verr').textContent = '';
      var a = toStored(vmin), b = toStored(vmax);
      var stops = ramp($('cmap').value);
      if ($('rev').checked) stops = stops.map(function (s) { return [1 - s[0], s[1], s[2], s[3]]; }).reverse();
      ctf.removeAllPoints();
      stops.forEach(function (s) { ctf.addRGBPoint(toRaw(a + s[0] * (b - a)), s[1], s[2], s[3]); });
      $('ramp').style.background = 'linear-gradient(90deg,' + stops.map(function (s) { return css(s) + ' ' + (s[0] * 100).toFixed(1) + '%'; }).join(',') + ')';
      // ticks at their true place: the two limits, plus powers of ten (log) or the midpoint (linear)
      var t = [a];
      if (isLog) { for (var d = Math.ceil(a + 1e-9); d < b - 1e-9; d++) if (d - a > 0.14 * (b - a) && b - d > 0.14 * (b - a)) t.push(d); if (t.length > 4) t = [a].concat(t.slice(1).filter(function (_, i, arr) { return i % Math.ceil(arr.length / 3) === 0; })); }
      else t.push((a + b) / 2);
      t.push(b);
      $('ticks').innerHTML = t.map(function (v) { return '<span style="left:' + ((v - a) / (b - a) * 100).toFixed(1) + '%">' + fmt(toPhys(v)) + '</span>'; }).join('');
      return true;
    };
    var colourAt = function (stored, actor) { var c = [0, 0, 0]; ctf.getColor(toRaw(stored), c); actor.getProperty().setColor(c[0] * 0.85, c[1] * 0.85, c[2] * 0.85); };

    // ── slices ──
    var slices = {};
    ['i', 'j', 'k'].forEach(function (ax) {
      var mapper = Core.vtkImageMapper.newInstance(); mapper.setInputData(image);
      var actor = Core.vtkImageSlice.newInstance(); actor.setMapper(mapper);
      actor.getProperty().setRGBTransferFunction(0, ctf);
      actor.getProperty().setUseLookupTableScalarRange(true);
      actor.getProperty().setInterpolationTypeToNearest();     // the model's own cells, unsmoothed
      if (is2d) { var op = DM.vtkPiecewiseFunction.newInstance(); op.addPoint(0, 0); op.addPoint(30, 0); op.addPoint(79, 1); op.addPoint(65535, 1); actor.getProperty().setPiecewiseFunction(0, op); }
      ren.addActor(actor); scaled.push(actor);
      slices[ax] = { mapper: mapper, actor: actor };
    });
    var setSlice = { i: function (v) { slices.i.mapper.setISlice(v); }, j: function (v) { slices.j.mapper.setJSlice(v); }, k: function (v) { slices.k.mapper.setKSlice(v); } };

    // ── solid body (3D): everything between a minimum and a maximum, closed off where it meets
    //    the edge of the model. Built on a copy of the volume with one extra voxel all round that
    //    counts as "outside", so the surface is capped at the box instead of left open. ──
    var solid = null, padImg = null, pad = null, solidMC = null, px, py, pz;
    var sizePad = function () {          // one voxel bigger than the box on every side
      px = cx + 2; py = cy + 2; pz = cz + 2;
      padImg.setDimensions(px, py, pz);
      padImg.setOrigin((cr.i0 - 1) * sp[0], (cr.j0 - 1) * sp[1], -meta.extent_km[2] + (cr.k0 - 1) * sp[2]);
      pad = new Float32Array(px * py * pz).fill(-1e9);
      // give it values straight away: the window may draw before the first body is worked out
      padImg.getPointData().setScalars(vtk.Common.Core.vtkDataArray.newInstance({ name: 'g', numberOfComponents: 1, values: pad }));
      padImg.modified();
    };
    if (!is2d) {
      padImg = DM.vtkImageData.newInstance(); padImg.setSpacing(sp[0], sp[1], sp[2]);
      sizePad();
      solidMC = vtk.Filters.General.vtkImageMarchingCubes.newInstance({ contourValue: 0, computeNormals: true, mergePoints: true });
      solidMC.setInputData(padImg);
      var sm = Core.vtkMapper.newInstance(); sm.setInputConnection(solidMC.getOutputPort()); sm.setScalarVisibility(false);
      solid = Core.vtkActor.newInstance(); solid.setMapper(sm); ren.addActor(solid); scaled.push(solid);
    }
    var solidState = { ok: false, text: '' };
    var updateSolid = function () {
      if (is2d) return;
      var useMin = $('s-min-on').checked, useMax = $('s-max-on').checked, vmin = +$('s-min').value, vmax = +$('s-max').value;
      var bad = (useMin && ($('s-min').value === '' || !physOk(vmin))) || (useMax && ($('s-max').value === '' || !physOk(vmax))) || (useMin && useMax && !(vmin < vmax));
      $('s-err').textContent = bad ? (useMin && useMax ? 'Minimum must be below maximum.' : 'Enter a valid value.') : '';
      solidState.ok = !bad && (useMin || useMax);
      if (!solidState.ok) return;
      var a = useMin ? toRaw(toStored(vmin)) : -Infinity, b = useMax ? toRaw(toStored(vmax)) : Infinity;
      var raw = cache[stemOf()].raw, gap = cache[stemOf()].gap, OUT = -1e9, inside = 0;
      pad.fill(OUT);
      for (var z = 0; z < cz; z++) for (var y = 0; y < cy; y++) {
        var src = cr.i0 + nx * (y + cr.j0 + ny * (z + cr.k0)), dst = 1 + px * (y + 1 + py * (z + 1));
        for (var x = 0; x < cx; x++) {
          var v = raw[src + x];
          if (gap && gap[src + x]) continue;                    // no value here: never part of the body
          var g = Math.min(v - a, b - v);                       // positive inside the range
          pad[dst + x] = g; if (g > 0) inside++;
        }
      }
      padImg.getPointData().setScalars(vtk.Common.Core.vtkDataArray.newInstance({ name: 'g', numberOfComponents: 1, values: pad }));
      padImg.modified();
      colourAt(useMin && useMax ? (toStored(vmin) + toStored(vmax)) / 2 : toStored(useMin ? vmin : vmax), solid);
      solidState.text = (100 * inside / (cx * cy * cz)).toFixed(1) + (cx * cy * cz === nx * ny * nz ? ' % of the model' : ' % of the part shown');
    };

    // ── extra surfaces at typed values (3D) ──
    var surfs = [];
    var updateSurfs = function () {
      if (is2d) return;
      surfs.forEach(function (s) { ren.removeActor(s.actor); scaled.splice(scaled.indexOf(s.actor), 1); });
      surfs = [];
      var parts = $('surf').value.split(/[,;\s]+/).filter(Boolean), vals = parts.map(Number);
      var bad = vals.some(function (v) { return !physOk(v); }) || vals.length > 6;
      $('surf-err').textContent = bad ? (vals.length > 6 ? 'Six values at most.' : 'Use numbers separated by commas.') : '';
      if (bad) return;
      vals.forEach(function (v) {
        var mcx = vtk.Filters.General.vtkImageMarchingCubes.newInstance({ contourValue: toRaw(toStored(v)), computeNormals: true, mergePoints: true });
        mcx.setInputData(image);
        var m = Core.vtkMapper.newInstance(); m.setInputConnection(mcx.getOutputPort()); m.setScalarVisibility(false);
        var a = Core.vtkActor.newInstance(); a.setMapper(m); colourAt(toStored(v), a);
        ren.addActor(a); scaled.push(a); surfs.push({ actor: a, value: v, mc: mcx });
      });
    };

    // ── box, and axes with distances ──
    var outline = vtk.Filters.General.vtkOutlineFilter.newInstance(); outline.setInputData(image);
    var oMapper = Core.vtkMapper.newInstance(); oMapper.setInputConnection(outline.getOutputPort());
    var oActor = Core.vtkActor.newInstance(); oActor.setMapper(oMapper); oActor.getProperty().setColor(0.16, 0.15, 0.45);
    ren.addActor(oActor); scaled.push(oActor);
    var ve = 1;
    var nice = function (a, b) {                       // round tick values across a range
      var span = b - a, step = Math.pow(10, Math.floor(Math.log10(span / 3))), r = span / 3 / step;
      step *= r >= 5 ? 5 : r >= 2 ? 2 : 1;
      var out = []; for (var t = Math.ceil(a / step - 1e-9) * step; t <= b + 1e-9; t += step) out.push(+t.toPrecision(12));
      return out;
    };
    // The box is stretched upward by the exaggeration; the depth labels still read true kilometres.
    // Built with extend() rather than newInstance(): newInstance returns a locked object, and the
    // labelling step below has to be replaced.
    var axes = {};
    Core.vtkCubeAxesActor.extend(axes, {}, { generateTicks: function (b) {
      var t = [nice(b[0], b[1]), nice(b[2], b[3]), nice(b[4] / ve, b[5] / ve)];
      var str = t.map(function (a) { return a.map(function (v) { return String(+v.toPrecision(6)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }); });
      return { ticks: [t[0], t[1], t[2].map(function (v) { return v * ve; })], tickStrings: str };
    } });
    // Label one edge per axis, not every outer edge. The library marks each edge it would label
    // with 1; all but the first for each axis are changed to "draw the line, no text".
    var EDGE_AXIS = [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2], labelEdges = axes.updateTextData;
    axes.updateTextData = function (faces, edges, ticks, strings) {
      var seen = [false, false, false], e2 = Array.prototype.slice.call(edges);
      for (var i = 0; i < 12; i++) if (e2[i] === 1) { if (seen[EDGE_AXIS[i]]) e2[i] = 2; else seen[EDGE_AXIS[i]] = true; }
      return labelEdges(faces, e2, ticks, strings);
    };
    axes.setDataBounds(B);      // before anything is drawn
    axes.setCamera(cam); axes.setAxisLabels(is2d ? [axisNames[0], '', axisNames[2]] : axisNames);
    axes.setTickTextStyle({ fontColor: '#333333', fontSize: 13, fontFamily: 'Arial' });
    axes.setAxisTextStyle({ fontColor: '#282572', fontSize: 15, fontStyle: 'bold', fontFamily: 'Arial' });
    axes.getProperty().setColor(0.62, 0.64, 0.68);
    ren.addActor(axes);

    // ── observation sites, where the scene has them ──
    var sites = null, siteApi = null, S = null;
    if (sc.sites) {
      S = (await (await fetch('volumes/' + sc.sites)).json()).sites;
      // Sites are plain dark points, or tinted by how well the model fits each one (see fit.js).
      // A second, larger point sits just under the chosen site to mark it.
      var shown = [], fitRGB = null, picked = null;
      var poly = DM.vtkPolyData.newInstance(), ring = DM.vtkPolyData.newInstance();
      var sMapper = Core.vtkMapper.newInstance(); sMapper.setInputData(poly); sMapper.setScalarModeToUsePointData(); sMapper.setColorModeToDirectScalars();
      sites = Core.vtkActor.newInstance(); sites.setMapper(sMapper);
      var rMapper = Core.vtkMapper.newInstance(); rMapper.setInputData(ring);
      var ringActor = Core.vtkActor.newInstance(); ringActor.setMapper(rMapper); ringActor.getProperty().setPointSize(18); ringActor.getProperty().setColor(0.157, 0.145, 0.447);
      var placeSites = function () {
        shown = [];
        if (cr.k1 === nz - 1) S.forEach(function (s, i) { if (!(s.x < B[0] || s.x > B[1] || s.y < B[2] || s.y > B[3])) shown.push(i); });
        var n = shown.length, pts = new Float32Array(n * 3), verts = new Uint32Array(n * 2), rgb = new Uint8Array(n * 3);
        var tint = !!fitRGB && $('on-sitefit').checked;
        shown.forEach(function (si, q) {
          var p = S[si];
          pts.set([p.x, p.y, 0.05], 3 * q); verts[2 * q] = 1; verts[2 * q + 1] = q; rgb.set((tint && fitRGB[p.id]) || [13, 13, 13], 3 * q);
        });
        poly.getPoints().setData(pts, 3); poly.getVerts().setData(verts);
        poly.getPointData().setScalars(vtk.Common.Core.vtkDataArray.newInstance({ name: 'rgb', numberOfComponents: 3, values: rgb }));
        poly.modified();
        sites.getProperty().setPointSize(tint ? 11 : 6);
        var p = picked != null && shown.indexOf(picked) >= 0 ? S[picked] : null;
        ring.getPoints().setData(new Float32Array(p ? [p.x, p.y, 0.03] : []), 3); ring.getVerts().setData(new Uint32Array(p ? [1, 0] : [])); ring.modified();
        $('n-sites').textContent = '(' + n + (n < S.length ? ' of ' + S.length : '') + ')';
      };
      placeSites();
      ren.addActor(ringActor); scaled.push(ringActor);
      ren.addActor(sites); scaled.push(sites);

      siteApi = {
        onPick: null,
        colour: function (byId) { fitRGB = byId; placeSites(); win.render(); },
        select: function (id) { picked = null; S.forEach(function (p, i) { if (p.id === id) picked = i; }); placeSites(); win.render(); },
        shown: function () { return shown.map(function (i) { return S[i].id; }); },
        toScreen: function (id) {       // where a site is drawn, in page pixels; for checks
          var p = S.filter(function (q) { return q.id === id; })[0], api = grw.getApiSpecificRenderWindow(), cv = api.getCanvas(), r = cv.getBoundingClientRect(), k = cv.width / r.width;
          var d = api.worldToDisplay(p.x, p.y, 0.05 * ve, ren); return [r.left + d[0] / k, r.bottom - d[1] / k];
        }
      };
      $('on-sitefit').addEventListener('input', function () { placeSites(); win.render(); });
      // a click (not a drag) on a site chooses it
      var down = null;
      $('view').addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; }, true);
      $('view').addEventListener('pointerup', function (e) {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !sites.getVisibility()) return;
        var api = grw.getApiSpecificRenderWindow(), cv = api.getCanvas(), r = cv.getBoundingClientRect(), k = cv.width / r.width;
        var mx = (e.clientX - r.left) * k, my = (r.bottom - e.clientY) * k, best = null, bd = 14 * k;
        shown.forEach(function (si) {
          var d = api.worldToDisplay(S[si].x, S[si].y, 0.05 * ve, ren), dist = Math.hypot(d[0] - mx, d[1] - my);
          if (dist < bd) { bd = dist; best = si; }
        });
        if (best != null) { siteApi.select(S[best].id); if (siteApi.onPick) siteApi.onPick(S[best].id); }
      }, true);
    }

    // ── compass cube ──
    var L = sc.compass || ['E', 'W', 'N', 'S'];
    var cube = Core.vtkAnnotatedCubeActor.newInstance();
    cube.setDefaultStyle({ text: '', fontStyle: 'bold', fontFamily: 'Arial', fontColor: 'white', fontSizeScale: function (res) { return res / 2.4; }, faceColor: '#282572', faceRotation: 0, edgeThickness: 0.08, edgeColor: 'white', resolution: 300 });
    cube.setXPlusFaceProperty({ text: L[0] }); cube.setXMinusFaceProperty({ text: L[1] });
    cube.setYPlusFaceProperty({ text: L[2] }); cube.setYMinusFaceProperty({ text: L[3] });
    cube.setZPlusFaceProperty({ text: 'UP', faceColor: '#3F88C8' }); cube.setZMinusFaceProperty({ text: 'DN', faceColor: '#6C757D' });
    var OMW = vtk.Interaction.Widgets.vtkOrientationMarkerWidget;
    var compass = OMW.newInstance({ actor: cube, interactor: win.getInteractor() });
    compass.setEnabled(true); compass.setViewportCorner(OMW.Corners.BOTTOM_RIGHT);
    compass.setViewportSize(0.16); compass.setMinPixelSize(90); compass.setMaxPixelSize(130);
    // the same marker as three arrows, in the AusMT data colours
    var ARROW = [[234, 30, 49], [89, 143, 57], [63, 136, 200]];
    var arrows = Core.vtkAxesActor.newInstance();
    arrows.setXConfig({ color: ARROW[0] }); arrows.setYConfig({ color: ARROW[1] }); arrows.setZConfig({ color: ARROW[2] }); arrows.update();
    $('arrow-key').innerHTML = [L[0], L[2], 'up'].map(function (t, i) { return '<i style="background:rgb(' + ARROW[i].join(',') + ')"></i>' + t; }).join('');
    var setCompass = function () {
      var m = $('compass').value;
      compass.setEnabled(false);
      if (m !== 'off') { compass.setActor(m === 'arrows' ? arrows : cube); compass.setEnabled(true); compass.updateMarkerOrientation(); }
      $('arrow-key').hidden = m !== 'arrows';
    };

    // ── set views ──
    var VIEWS = { oblique: [[-1, -1.5, 0.9], [0, 0, 1]], above: [[0, 0, 1], [0, 1, 0]], south: [[0, -1, 0], [0, 0, 1]], north: [[0, 1, 0], [0, 0, 1]], east: [[1, 0, 0], [0, 0, 1]], west: [[-1, 0, 0], [0, 0, 1]] };
    var current = null;
    var view = function (n) {
      var v = VIEWS[n], cz = C[2] * ve; current = n;
      cam.setFocalPoint(C[0], C[1], cz); cam.setPosition(C[0] + v[0][0], C[1] + v[0][1], cz + v[0][2]); cam.setViewUp(v[1][0], v[1][1], v[1][2]);
      ren.resetCamera(); if (is2d) cam.zoom(1.2); ren.resetCameraClippingRange(); compass.updateMarkerOrientation(); win.render();
      [].forEach.call($('views').children, function (b) { b.setAttribute('aria-pressed', b.dataset.v === n); });
    };
    $('views').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) view(b.dataset.v); });
    $('view').addEventListener('pointerdown', function () { current = null; [].forEach.call($('views').children, function (b) { b.setAttribute('aria-pressed', 'false'); }); });
    if (sc.viewNames) [].forEach.call($('views').children, function (b) { if (sc.viewNames[b.dataset.v]) b.textContent = sc.viewNames[b.dataset.v]; });

    // ── vertical exaggeration: stretch everything upward, keep the labels true ──
    var setVE = function (v) {
      ve = v;
      scaled.forEach(function (a) { a.setScale(1, 1, ve); });
      axes.setDataBounds([B[0], B[1], B[2], B[3], B[4] * ve, B[5] * ve]);
      $('ve-note').textContent = ve === 1 ? 'True scale.' : 'Heights are drawn ' + ve + ' times taller than widths. Depth labels stay true.';
    };

    // ── controls ──
    var short = function (label) { return label.replace(/\s*\(.*\)/, '').toLowerCase(); };
    var pct = function (id) { var v = +$(id).value; return Math.min(1, Math.max(0.05, (isFinite(v) && $(id).value !== '' ? v : 100) / 100)); };
    var sync = function () {
      if (!is2d) {
        solid.setVisibility($('on-solid').checked && solidState.ok); solid.getProperty().setOpacity(pct('s-op'));
        $('s-o').textContent = $('on-solid').checked && solidState.ok ? solidState.text : '';
        surfs.forEach(function (s) { s.actor.getProperty().setOpacity(pct('surf-op')); });
        var inBox = function (v, a, n) { return Math.max(0, Math.min(n - 1, v - a)); };
        setSlice.k(inBox(+$('k').value, cr.k0, cz)); $('k-o').textContent = ((nz - 1 - $('k').value) * sp[2]).toFixed(sp[2] < 1 ? 1 : 0) + ' km deep';
        setSlice.i(inBox(+$('i').value, cr.i0, cx)); $('i-o').textContent = ($('i').value * sp[0]).toFixed(sp[0] < 1 ? 1 : 0) + ' km';
        setSlice.j(inBox(+$('j').value, cr.j0, cy)); $('j-o').textContent = ($('j').value * sp[1]).toFixed(sp[1] < 1 ? 1 : 0) + ' km';
        ['i', 'j', 'k'].forEach(function (ax) { slices[ax].actor.setVisibility($('on-' + ax).checked); slices[ax].actor.getProperty().setOpacity(pct('op-' + ax)); });
      } else {
        setSlice.j(0); slices.i.actor.setVisibility(false); slices.k.actor.setVisibility(false); slices.j.actor.setVisibility(true);
      }
      if (sites) { sites.setVisibility($('on-sites').checked); ringActor.setVisibility($('on-sites').checked); }
      axes.setVisibility($('on-axes').checked); oActor.setVisibility($('on-outline').checked);
      win.render();
    };
    var rescale = function () { if (applyScale()) { updateSolid(); updateSurfs(); setVE(ve); sync(); } };

    // take a field's own range and defaults
    var fieldOver = null;       // set by a saved view; cleared when the visitor picks a field
    var useField = function (keepLimits) {
      var f = Object.assign({}, sc.fields[fi], fieldOver || {}), m = cache[stemOf()].meta;
      lo = m.scale.lo; hi = m.scale.hi; isLog = m.log !== false; unit = f.unit;
      $('scale-title').textContent = f.label + (unit ? ' (' + unit + ')' : '');
      [].forEach.call(document.querySelectorAll('.unit'), function (e) { e.textContent = unit || ''; });
      if (!keepLimits) {
        $('vmin').value = fmt(f.vmin != null ? f.vmin : toPhys(lo)); $('vmax').value = fmt(f.vmax != null ? f.vmax : toPhys(hi));
        $('cmap').value = f.cmap || 'mt'; $('rev').checked = !!f.reverse;
        var s = f.solid || {};
        $('s-min-on').checked = s.min != null; $('s-max-on').checked = s.max != null;
        $('s-min').value = fmt(s.min != null ? s.min : toPhys(lo + 0.25 * (hi - lo))); $('s-max').value = fmt(s.max != null ? s.max : toPhys(lo + 0.75 * (hi - lo)));
        $('surf').value = (f.surfaces || []).join(', ');
      }
    };
    var swap = async function (keepLimits) {
      $('busy').hidden = false;
      var v = await load(stemOf()); setData(v.raw); useField(keepLimits); applyScale(); updateSolid(); updateSurfs(); setVE(ve); sync();
      $('busy').hidden = true;
    };

    // fields
    $('field').innerHTML = sc.fields.map(function (f, i) { return '<option value="' + i + '">' + f.label + '</option>'; }).join('');
    show('field-row', sc.fields.length > 1);
    $('field').addEventListener('change', function () { fi = +this.value; fieldOver = null; swap(false); });

    // time
    var timer = null;
    if (sc.times) {
      $('t').max = sc.times.length - 1; $('t').value = ti;
      var tLabel = function () { $('t-o').textContent = sc.times[ti].label; };
      tLabel();
      $('t').addEventListener('input', function () { ti = +this.value; tLabel(); swap(true); });
      $('play').onclick = function () {
        if (timer) { clearInterval(timer); timer = null; this.textContent = 'Play'; return; }
        this.textContent = 'Pause';
        timer = setInterval(function () { ti = (ti + 1) % sc.times.length; $('t').value = ti; tLabel(); swap(true); }, 900);
      };
    }
    show('time-row', !!sc.times);
    document.querySelector('.cp-data').hidden = sc.fields.length <= 1 && !sc.times && !(sc.views && sc.views.length);

    // what a 2D section does not need
    ['tab-slices', 'tab-volume'].forEach(function (id) { show(id, !is2d); });
    show('sites-tick', !!sc.sites); show('sitefit-tick', !!(sc.sites && sc.fit));
    if (is2d) [].forEach.call($('views').children, function (b) { b.hidden = b.dataset.v !== 'south'; });
    if (!is2d) {
      $('k').max = nz - 1; $('i').max = nx - 1; $('j').max = ny - 1;
      $('i-name').textContent = 'Section across ' + short(axisNames[0]); $('j-name').textContent = 'Section across ' + short(axisNames[1]);
    }

    ['k', 'i', 'j', 'on-k', 'on-i', 'on-j', 'op-k', 'op-i', 'op-j', 'on-solid', 's-op', 'surf-op', 'on-sites', 'on-axes', 'on-outline'].forEach(function (id) { $(id).addEventListener('input', sync); });
    ['cmap', 'rev', 'vmin', 'vmax'].forEach(function (id) { $(id).addEventListener('change', rescale); });
    ['s-min-on', 's-max-on', 's-min', 's-max'].forEach(function (id) { $(id).addEventListener('change', function () { updateSolid(); sync(); }); });
    $('surf').addEventListener('change', function () { updateSurfs(); setVE(ve); sync(); });
    $('ve').addEventListener('change', function () { setVE(+this.value); if (current) view(current); else { ren.resetCamera(); ren.resetCameraClippingRange(); win.render(); } });
    $('vreset').onclick = function () { fieldOver = null; useField(false); rescale(); };
    $('compass').addEventListener('change', function () { setCompass(); win.render(); });

    // ── extent: cut in from any side, in kilometres ──
    var CUTS = [['cut-w', 0, 'i0', 1], ['cut-e', 0, 'i1', -1], ['cut-s', 1, 'j0', 1], ['cut-n', 1, 'j1', -1], ['cut-b', 2, 'k0', 1], ['cut-t', 2, 'k1', -1]];
    var full = [nx, ny, nz];
    var extentNote = function () {
      var e = [cx - 1, cy - 1, cz - 1].map(function (n, a) { return n * sp[a]; });
      var parts = (is2d ? [e[0], e[2]] : e).map(function (v) { return v.toFixed(v < 100 ? 1 : 0); });
      $('cut-o').textContent = 'Showing ' + parts.join(' × ') + ' km';
    };
    var applyCut = function () {
      var next = { i0: 0, i1: nx - 1, j0: 0, j1: ny - 1, k0: 0, k1: nz - 1 }, bad = '';
      CUTS.forEach(function (c) {
        if (is2d && c[1] === 1) return;
        var v = $(c[0]).value === '' ? 0 : +$(c[0]).value;
        if (!isFinite(v) || v < 0) { bad = 'Use zero or a positive distance.'; return; }
        var n = Math.round(v / sp[c[1]]);
        next[c[2]] = c[3] > 0 ? n : full[c[1]] - 1 - n;
      });
      if (!bad && (next.i1 - next.i0 < 1 || (!is2d && next.j1 - next.j0 < 1) || next.k1 - next.k0 < 1)) bad = 'Those cuts leave nothing to show.';
      $('cut-err').textContent = bad;
      if (bad) return;
      cr = next;
      setData(curRaw); if (!is2d) sizePad();
      if (sites) placeSites();
      updateSolid(); updateSurfs(); setVE(ve); extentNote(); sync();
      if (current) view(current); else { ren.resetCamera(); ren.resetCameraClippingRange(); win.render(); }
    };
    CUTS.forEach(function (c) { $(c[0]).addEventListener('change', applyCut); });
    $('cut-reset').onclick = function () { CUTS.forEach(function (c) { $(c[0]).value = 0; }); applyCut(); };
    // name the sides the way this model names them
    [['cut-w-l', L[1]], ['cut-e-l', L[0]], ['cut-s-l', L[3]], ['cut-n-l', L[2]]].forEach(function (p) { $(p[0]).textContent = { W: 'West', E: 'East', S: 'South', N: 'North' }[p[1]] || p[1] + ' side'; });
    show('cut-s-row', !is2d); show('cut-n-row', !is2d);

    // tabs in the control panel
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      [].forEach.call($('tabs').children, function (t) { t.setAttribute('aria-selected', t === b); $('pane-' + t.dataset.p).hidden = t !== b; });
    });

    // full screen: the whole viewer, panel included
    var app = $('app');
    $('full').onclick = function () { if (document.fullscreenElement) document.exitFullscreen(); else app.requestFullscreen(); };
    document.addEventListener('fullscreenchange', function () {
      $('full').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
      setTimeout(function () { grw.resize(); win.render(); }, 60);
    });
    window.addEventListener('resize', function () { grw.resize(); win.render(); });

    // ── the model's own starting view. Everything a visitor can change has a default in the
    //    scene file ("defaults", plus each field's own scale, solid and surfaces), so a model opens
    //    looking the way its author chose, and "Model defaults" brings that back. ──
    //    A model can also carry several named views ("views" in the scene file), each a full set of
    //    the same settings, so its author can point at different things in the same model.
    var D = sc.defaults || {};
    var num = function (v, fallback) { return v != null ? v : fallback; };
    var VIEWSETS = [{ name: 'Opening view', defaults: sc.defaults || {}, field: null }].concat(sc.views || []);
    $('preset').innerHTML = VIEWSETS.map(function (p, i) { return '<option value="' + i + '">' + p.name + '</option>'; }).join('');
    show('preset-row', VIEWSETS.length > 1);
    $('preset').addEventListener('change', function () { applyDefaults(); });
    var applyDefaults = async function () {
      var chosen = VIEWSETS[+$('preset').value] || VIEWSETS[0];
      D = chosen.defaults || {}; fieldOver = chosen.field || null;
      var sl = D.slices || {}, sh = D.show || {}, cut = D.cut || {};
      fi = D.field || 0; $('field').value = fi;
      if (sc.times) { ti = num(D.time, sc.times.length - 1); $('t').value = ti; $('t-o').textContent = sc.times[ti].label; }
      $('ve').value = String(D.ve || 1);
      $('on-outline').checked = sh.outline !== false; $('on-axes').checked = sh.axes !== false; $('on-sites').checked = sh.sites !== false; $('on-sitefit').checked = !!sh.siteFit;
      $('compass').value = D.marker || 'cube';
      [['cut-w', 'w'], ['cut-e', 'e'], ['cut-s', 's'], ['cut-n', 'n'], ['cut-t', 't'], ['cut-b', 'b']].forEach(function (c) { $(c[0]).value = cut[c[1]] || 0; });
      if (!is2d) {
        $('k').value = sl.depth_km != null ? nz - 1 - Math.round(sl.depth_km / sp[2]) : Math.round(nz * 0.85);
        $('i').value = sl.x_km != null ? Math.round(sl.x_km / sp[0]) : Math.round(nx / 2);
        $('j').value = sl.y_km != null ? Math.round(sl.y_km / sp[1]) : Math.round(ny / 2);
        $('on-k').checked = sl.showDepth !== false; $('on-i').checked = !!sl.showX; $('on-j').checked = sl.showY !== false;
        $('op-k').value = num(sl.opacityDepth, 100); $('op-i').value = num(sl.opacityX, 100); $('op-j').value = num(sl.opacityY, 100);
        $('on-solid').checked = D.showSolid !== false; $('s-op').value = num(D.solidOpacity, 100); $('surf-op').value = num(D.surfaceOpacity, 50);
      }
      await swap(false);                    // the field's own scale, solid and surfaces
      setVE(+$('ve').value); setCompass(); applyCut();
      view(!is2d && VIEWS[D.view] ? D.view : (is2d ? 'south' : 'oblique'));
    };
    $('to-defaults').onclick = function () { $('preset').value = 0; applyDefaults(); };

    // For whoever sets a model up: the current settings, in the form the scene file takes.
    $('copy-settings').onclick = function () {
      var b = this, f = sc.fields[fi], on = function (id) { return $(id).checked; }, n = function (id) { return +$(id).value; };
      var out = { defaults: { field: fi, view: current || 'oblique', ve: ve, marker: $('compass').value,
        show: { outline: on('on-outline'), axes: on('on-axes'), sites: on('on-sites'), siteFit: on('on-sitefit') },
        cut: { w: n('cut-w'), e: n('cut-e'), s: n('cut-s'), n: n('cut-n'), t: n('cut-t'), b: n('cut-b') } } };
      if (sc.times) out.defaults.time = ti;
      if (!is2d) {
        out.defaults.slices = { depth_km: +((nz - 1 - n('k')) * sp[2]).toFixed(2), x_km: +(n('i') * sp[0]).toFixed(2), y_km: +(n('j') * sp[1]).toFixed(2),
          showDepth: on('on-k'), showX: on('on-i'), showY: on('on-j'), opacityDepth: n('op-k'), opacityX: n('op-i'), opacityY: n('op-j') };
        out.defaults.showSolid = on('on-solid'); out.defaults.solidOpacity = n('s-op'); out.defaults.surfaceOpacity = n('surf-op');
      }
      out.field = { label: f.label, vmin: n('vmin'), vmax: n('vmax'), cmap: $('cmap').value, reverse: on('rev') };
      if (!is2d) {
        out.field.solid = {}; if (on('s-min-on')) out.field.solid.min = n('s-min'); if (on('s-max-on')) out.field.solid.max = n('s-max');
        out.field.surfaces = $('surf').value.split(/[,;\s]+/).filter(Boolean).map(Number);
      }
      window.__lastSettings = out;
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy settings'; }, 1500); };
      navigator.clipboard.writeText(JSON.stringify(out, null, 1)).then(done, done);
    };

    extentNote();
    await applyDefaults();
    msg.remove();
    if (sc.fit && siteApi && window.MATEFit) window.MATEFit.init({ url: 'volumes/' + sc.fit, sites: S, api: siteApi });
    window.__viewer = { siteApi: siteApi,  win: win, ren: ren, cam: cam, image: image, ctf: ctf, sites: sites, axes: axes, compass: compass, solid: solid, solidMC: solidMC, slices: slices, scene: sc, applyDefaults: applyDefaults, crop: function () { return { box: cr, dims: [cx, cy, cz], bounds: B }; },
      surfs: function () { return surfs; }, ve: function () { return ve; },
      state: function () { return { field: fi, time: ti, stem: stemOf(), loaded: Object.keys(cache).length, solid: solidState }; } };
  } catch (e) {
    msg.textContent = 'The viewer could not start: ' + e.message;
    console.error(e);
  }
})();
