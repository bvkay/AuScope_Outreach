/* Shared by every mockup page: header, footer, the review-only variant switcher, and model helpers.
   The variant comes from <body data-variant="1..5">, or ?v= on the model page. */
(function () {
  var v = document.body.dataset.variant || (location.search.match(/[?&]v=([1-5])/) || [])[1] || '1';
  var M = (window.MODELS || []).slice();
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  var FOOTERS = { band: 'Logo band + strip', row: 'Single row', fixed: 'Fixed strip', float: 'Floating logos', floatbare: 'Floating logos, no box', fixedfloat: 'Fixed line + floating logos', fixedfloatbare: 'Fixed line + floating logos, no box' };
  var DEFAULT_F = { 1: 'band', 2: 'row', 3: 'fixed', 4: 'float', 5: 'band' };
  var dark = document.body.classList.contains('dark');   // mockup 5 only: white logos on a dark page
  var fq = (location.search.match(/[?&]f=(band|row|fixedfloatbare|fixedfloat|fixed|floatbare|float)/) || [])[1];
  var f = fq || DEFAULT_F[v];
  var keep = fq ? '?f=' + fq : '';                       // carry an overridden footer between pages
  var page = location.pathname.split('/').pop() || 'mockup-1.html';
  // mockup 5 is the 3D model viewer itself; the others are home-page layouts
  var pageOf = function (n) { return String(n) === '5' ? 'model-3d.html?scene=vulcan&v=5' + keep.replace('?', '&') : 'mockup-' + n + '.html' + keep; };
  var home = pageOf(v);

  var NAMES = { 1: 'Featured + grid', 2: 'Scrolling strip + list', 3: 'Filter sidebar', 4: 'Filter sidebar + grid', 5: '3D model viewer' };
  var switcher = '<div class="switcher"><span>Mockup</span>' + [1, 2, 3, 4, 5].map(function (n) {
    return '<a href="' + pageOf(n) + '"' + (String(n) === v ? ' aria-current="true"' : '') + '>' + n + ' · ' + NAMES[n] + '</a>';
  }).join('') + '<span class="sep">Footer</span>' + Object.keys(FOOTERS).map(function (k) {
    var q = location.search.replace(/[?&]f=\w+/, '').replace(/^&/, '?');
    return '<a href="' + page + q + (q ? '&' : '?') + 'f=' + k + '"' + (k === f ? ' aria-current="true"' : '') + '>' + FOOTERS[k] + '</a>';
  }).join('') + '<span class="note">review aid, not part of the design</span>' +
    '<span class="warn">Design mockup for discussion. This is not the M@TE website; the real one is at <a href="https://mate.science/">mate.science</a>.</span></div>';

  var header = '<header class="site-header">' +
    '<a class="brand" href="' + home + '">' +
      '<img src="logos/auscope-icon-' + 'colour' + '.png" alt="AuScope" width="35" height="36">' +
      '<span class="wordmark wm-' + v + '" role="img" aria-label="M@TE">M<span class="at"></span>TE</span>' +
    '</a>' +
    '<nav class="nav" aria-label="Main">' +
      '<a href="' + home + '" aria-current="page">Models</a><a href="#">News</a><a href="#">About</a><a href="#">Team</a>' +
      '<a class="plain" href="https://github.com/ModelAtlasofTheEarth/model-submission/issues/new?template=model_submission.yml">Submit a model</a>' +
    '</nav>' +
    '<div class="tagline">Model Atlas of the Earth</div></header>';

  var logos = function () {
    return '<a href="https://www.auscope.org.au/"><img src="logos/auscope-ncris-' + 'colour' + '.png" alt="AuScope and NCRIS"></a>' +
           '<a href="https://nci.org.au/"><img class="nci" src="logos/nci.png" alt="NCI Australia"></a>';
  };
  var gh = '<a class="mono" href="https://github.com/ModelAtlasofTheEarth">GitHub ↗</a>';
  var credit = 'M@TE is enabled by <a href="https://www.auscope.org.au/">AuScope</a> · Model data hosted at <a href="https://nci.org.au/">NCI</a>';
  var count = '<span class="mono"><b>' + M.length + '</b> models</span>';
  var strip = function (cls, left, right) {
    return '<footer class="site-footer ' + cls + '"><div class="fzone fleft">' + left + '</div>' +
      '<div class="fzone fcenter">' + credit + '</div><div class="fzone fright">' + right + '</div></footer>';
  };
  var footer = {
    // logos in their own band, then the slim AusMT strip, both at the end of the page
    band: function () { return '<div class="supporters">' + logos() + '</div>' + strip('', gh, count); },
    // one row at the end of the page: logos left, credit centre, links right
    row: function () { return strip('f-row', '<span class="flogos">' + logos() + '</span>', gh + ' · ' + count); },
    // strip pinned to the bottom of the window, as in the AusMT app, with small logos at the right
    fixed: function () { return strip('f-fixed', gh + ' · ' + count, '<span class="flogos">' + logos() + '</span>'); },
    // strip at the end of the page, logos floating bottom-right of the window (AusMT's map corner)
    float: function () { return strip('', gh + ' · ' + count, '') + '<div class="float-logos">' + logos() + '</div>'; },
    // as above, but the logos sit straight on the page with no card behind them
    floatbare: function () { return strip('', gh + ' · ' + count, '') + '<div class="float-logos bare">' + logos() + '</div>'; },
    // one line pinned to the bottom of the window, logos floating just above it at the right
    fixedfloat: function () { return strip('f-fixed', gh, count) + '<div class="float-logos">' + logos() + '</div>'; },
    // the same, with no card behind the logos
    fixedfloatbare: function () { return strip('f-fixed', gh, count) + '<div class="float-logos bare">' + logos() + '</div>'; }
  }[f]();
  document.body.classList.add('foot-' + f);

  document.body.insertAdjacentHTML('afterbegin', switcher + header);
  document.body.insertAdjacentHTML('beforeend', footer);

  var people = {}, topics = {};
  M.forEach(function (m) {
    m.creators.forEach(function (c) { people[c] = 1; });
    m.tags.forEach(function (t) { var k = t.toLowerCase(); topics[k] = (topics[k] || 0) + 1; });
  });
  M.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });   // newest first by default

  window.MATE = {
    models: M, esc: esc, topics: topics, nPeople: Object.keys(people).length,
    href: function (m) { var scene = { 'Kay-2024-Vulcan': 'vulcan', 'gollapalli-2025-sundamegathrust': 'sunda', 'sandiford-2021-detachment': 'detachment' }[m.slug];
      return (scene ? 'model-3d.html?scene=' + scene + '&v=' : 'model.html?v=') + v + (fq ? '&f=' + fq : '') + '&m=' + encodeURIComponent(m.slug); },
    who: function (m) { var c = m.creators; return c.length > 2 ? c[0] + ' et al.' : c.join(' & '); },
    byline: function (m) { return '<p class="byline"><b>' + esc(this.who(m)) + '</b>' + (m.year ? ' · ' + m.year : '') + '</p>'; },
    tags: function (m, n) {
      return m.tags.length ? '<ul class="tags">' + m.tags.slice(0, n).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '';
    },
    // generated graphics are site-relative on the live site; a missing image leaves a plain panel
    img: function (m, lazy) {
      var u = /^https?:/.test(m.img) ? m.img : 'https://mate.science/' + m.img;
      return '<img ' + (lazy ? 'loading="lazy" ' : '') + 'src="' + encodeURI(u) + '" alt="" onerror="this.parentNode.classList.add(\'noimg\');this.remove()">';
    },
    // text search plus optional topic set and year set; sort is new | old | az
    find: function (needle, tagSet, yearSet, sort) {
      needle = (needle || '').trim().toLowerCase();
      var rows = M.filter(function (m) {
        var hay = (m.title + ' ' + m.creators.join(' ') + ' ' + m.tags.join(' ')).toLowerCase();
        var okT = !tagSet || !tagSet.length || m.tags.some(function (t) { return tagSet.indexOf(t.toLowerCase()) > -1; });
        var okY = !yearSet || !yearSet.length || yearSet.indexOf(String(m.year)) > -1;
        return okT && okY && (!needle || hay.indexOf(needle) > -1);
      });
      return rows.sort(sort === 'az'
        ? function (a, b) { return a.title.localeCompare(b.title); }
        : function (a, b) { return (sort === 'old' ? 1 : -1) * ((a.year || 0) - (b.year || 0)); });
    }
  };
})();
