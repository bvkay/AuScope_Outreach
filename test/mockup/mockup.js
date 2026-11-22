/**
 * @fileoverview Shared by every mockup page: review bar, header, footer and model helpers.
 *
 * The mockup number comes from <body data-variant>, or from ?v= on the pages that all mockups
 * share (News, About, Team, model pages). It is written back to <body data-layout> so the
 * stylesheet can lay those shared pages out to match the mockup they were opened from.
 *
 * Exposes window.MATE.
 */
(() => {
  const SUBMIT_URL = 'https://github.com/ModelAtlasofTheEarth/model-submission/issues/new?template=model_submission.yml';
  const NAMES = {
    1: 'Featured + grid',
    2: 'Scrolling strip + list',
    3: 'Filter sidebar',
    4: 'Filter sidebar + grid',
    5: '3D model viewer',
    6: 'Featured + grid, topic menu',
  };
  /** Models that open in the 3D viewer, by slug. */
  const SCENES = {
    'Kay-2024-Vulcan': 'vulcan',
    'gollapalli-2025-sundamegathrust': 'sunda',
    'sandiford-2021-detachment': 'detachment',
  };

  const variant = document.body.dataset.variant || (location.search.match(/[?&]v=([1-6])/) || [])[1] || '1';
  // Shared pages have four layouts. Mockup 5 (the viewer) and mockup 6 (mockup 1 with a topic
  // menu) borrow layout 1.
  const layout = variant > '4' ? '1' : variant;
  document.body.dataset.layout = layout;

  const models = (window.MODELS || []).slice().sort((a, b) => (b.year || 0) - (a.year || 0));
  const topics = {};
  const people = new Set();
  models.forEach((m) => {
    m.creators.forEach((c) => people.add(c));
    m.tags.forEach((t) => { topics[t.toLowerCase()] = (topics[t.toLowerCase()] || 0) + 1; });
  });

  /**
   * Escapes text for use in HTML.
   * @param {*} text Value to escape.
   * @return {string} The escaped text.
   */
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

  /**
   * @param {string|number} n Mockup number.
   * @return {string} That mockup's home page.
   */
  const pageOf = (n) => (String(n) === '5' ? 'model-3d.html?scene=vulcan&v=5' : `mockup-${n}.html`);
  const home = pageOf(variant);

  /**
   * @param {!Object} m A model.
   * @return {string} Link to the model's page, in the current mockup.
   */
  const href = (m) => {
    const page = SCENES[m.slug] ? `model-3d.html?scene=${SCENES[m.slug]}&v=` : 'model.html?v=';
    return `${page}${variant}&m=${encodeURIComponent(m.slug)}`;
  };

  /**
   * @param {!Object} m A model.
   * @return {string} Short author credit, such as "Kay et al.".
   */
  const who = (m) => (m.creators.length > 2 ? `${m.creators[0]} et al.` : m.creators.join(' & '));

  /**
   * @param {!Object} m A model.
   * @return {string} Author and year line, as HTML.
   */
  const byline = (m) => `<p class="byline"><b>${esc(who(m))}</b>${m.year ? ` · ${m.year}` : ''}</p>`;

  /**
   * @param {!Object} m A model.
   * @param {number} limit Most tags to show.
   * @return {string} Tag list as HTML, or an empty string for a model with no tags.
   */
  const tags = (m, limit) => (m.tags.length ?
    `<ul class="tags">${m.tags.slice(0, limit).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');

  /**
   * Builds a model's picture. A picture that fails to load leaves a plain "no preview" panel.
   * @param {!Object} m A model.
   * @param {boolean=} lazy Load only when scrolled near.
   * @param {boolean=} full Use the whole landing image from mate.science. The default is the
   *     thumbnail cut to the card shape by tools/make_thumbs.py.
   * @return {string} An <img> element as HTML.
   */
  const img = (m, lazy, full) => {
    const remote = /^https?:/.test(m.img) ? m.img : `https://mate.science/${m.img}`;
    const src = full ? remote : `thumbs/${m.slug}.jpg`;
    return `<img ${lazy ? 'loading="lazy" ' : ''}${full ? '' : 'width="800" height="500" '}src="${encodeURI(src)}" alt="" ` +
      `onerror="this.parentNode.classList.add('noimg');this.remove()">`;
  };

  /**
   * Builds one model as a link with a picture above or beside its details.
   * @param {string} cls Component class: 'card' (grid), 'rowcard' (full-width row) or 'slide' (strip).
   * @param {!Object} m A model.
   * @return {string} The component as HTML.
   */
  const tile = (cls, m) => {
    const extra = cls === 'slide' ? '' : `${tags(m, cls === 'rowcard' ? 5 : 3)}<p class="doi">doi:${esc(m.doi)}</p>`;
    return `<a class="${cls}" href="${href(m)}"><div class="thumb">${img(m, cls !== 'slide')}</div>` +
      `<div class="body">${byline(m)}<h3>${esc(m.title)}</h3>${extra}</div></a>`;
  };

  /**
   * Filters and sorts the models.
   * @param {string} needle Text to look for in title, authors and tags.
   * @param {!Array<string>} topicSet Lower-case topics; a model must have at least one. Empty for any.
   * @param {!Array<string>} yearSet Years as strings. Empty for any.
   * @param {string} sort 'new', 'old' or 'az'.
   * @return {!Array<!Object>} The matching models, in order.
   */
  const find = (needle, topicSet, yearSet, sort) => {
    const text = (needle || '').trim().toLowerCase();
    const rows = models.filter((m) => {
      const hay = `${m.title} ${m.creators.join(' ')} ${m.tags.join(' ')}`.toLowerCase();
      const topicOk = !topicSet.length || m.tags.some((t) => topicSet.includes(t.toLowerCase()));
      const yearOk = !yearSet.length || yearSet.includes(String(m.year));
      return topicOk && yearOk && (!text || hay.includes(text));
    });
    if (sort === 'az') return rows.sort((a, b) => a.title.localeCompare(b.title));
    return rows.sort((a, b) => (sort === 'old' ? 1 : -1) * ((a.year || 0) - (b.year || 0)));
  };

  /**
   * Runs the filter-sidebar catalogue of mockups 3 and 4: search box, year and topic ticks, sort
   * menu and result count. Expects elements with the ids q, years, topics, clear, sort, count, rows.
   * @param {string} cls Component class for each result, as for tile().
   */
  const filterCatalogue = (cls) => {
    const $ = (id) => document.getElementById(id);
    const side = document.querySelector('.filters');
    const check = (group, value, n) => `<label><input type="checkbox" data-g="${group}" value="${esc(value)}"> ` +
      `<span>${esc(value)}</span><span class="n mono">${n}</span></label>`;
    const years = {};
    models.forEach((m) => { years[m.year] = (years[m.year] || 0) + 1; });
    $('years').innerHTML = Object.keys(years).sort().reverse().map((y) => check('y', y, years[y])).join('');
    // Most-used topics first, then alphabetical.
    $('topics').innerHTML = Object.keys(topics)
        .sort((a, b) => topics[b] - topics[a] || a.localeCompare(b))
        .map((t) => check('t', t, topics[t])).join('');

    const picked = (group) => [...side.querySelectorAll(`input[data-g=${group}]:checked`)].map((i) => i.value);
    const draw = () => {
      const rows = find($('q').value, picked('t'), picked('y'), $('sort').value);
      $('count').textContent = `${rows.length} of ${models.length} shown`;
      $('rows').innerHTML = rows.length ? rows.map((m) => tile(cls, m)).join('') :
        '<p class="empty">No models match those filters.</p>';
    };
    side.addEventListener('change', draw);
    $('q').addEventListener('input', draw);
    $('sort').addEventListener('change', draw);
    $('clear').addEventListener('click', () => {
      $('q').value = '';
      side.querySelectorAll('input:checked').forEach((i) => { i.checked = false; });
      draw();
    });
    draw();
  };

  const switcher = '<div class="switcher"><span>Mockup</span>' +
    Object.keys(NAMES).map((n) => `<a href="${pageOf(n)}"${n === variant ? ' aria-current="true"' : ''}>${n} · ${NAMES[n]}</a>`).join('') +
    '<span class="note">review aid, not part of the design</span>' +
    '<span class="warn">Design mockup for discussion. This is not the M@TE website; the real one is at ' +
    '<a href="https://mate.science/">mate.science</a>.</span></div>';

  const here = document.body.dataset.page || '';
  const nav = [['Models', home, ''], ['News', 'news.html', 'news'], ['About', 'about.html', 'about'], ['Team', 'team.html', 'team']]
      .map(([label, url, page]) => `<a href="${page ? `${url}?v=${variant}` : url}"${here === page ? ' aria-current="page"' : ''}>${label}</a>`)
      .join('');
  const header = '<header class="site-header">' +
    `<a class="brand" href="${home}"><img src="logos/auscope-icon-colour.png" alt="AuScope" width="35" height="36">` +
    `<span class="wordmark wm-${variant}" role="img" aria-label="M@TE">M<span class="at"></span>TE</span></a>` +
    `<nav class="nav" aria-label="Main">${nav}<a class="plain" href="${SUBMIT_URL}">Submit a model</a></nav>` +
    '<div class="tagline">Model Atlas of the Earth</div></header>';

  // One footer: a line pinned to the bottom of the window, with the supporter logos floating above it.
  const footer = '<footer class="site-footer">' +
    '<div class="fzone fleft"><a class="mono" href="https://github.com/ModelAtlasofTheEarth">GitHub ↗</a></div>' +
    '<div class="fzone fcenter">M@TE is enabled by <a href="https://www.auscope.org.au/">AuScope</a> · ' +
    'Model data hosted at <a href="https://nci.org.au/">NCI</a></div>' +
    `<div class="fzone fright"><span class="mono"><b>${models.length}</b> models</span></div></footer>` +
    '<div class="float-logos">' +
    '<a href="https://www.auscope.org.au/"><img src="logos/auscope-ncris-colour.png" alt="AuScope and NCRIS"></a>' +
    '<a href="https://nci.org.au/"><img class="nci" src="logos/nci.png" alt="NCI Australia"></a></div>';

  document.body.insertAdjacentHTML('afterbegin', switcher + header);
  document.body.insertAdjacentHTML('beforeend', footer);

  window.MATE = {
    models, topics, layout, home, nPeople: people.size,
    esc, href, who, byline, tags, img, tile, find, filterCatalogue,
  };
})();
