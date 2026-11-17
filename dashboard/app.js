// Launch Radar — renders window.RADAR, written beside this page by main.ts. No network, no framework.
// Every number derives from the sealed snapshot. The page recomputes each row's value from its factors
// (recompute), exposes the model's weights in a live sandbox (renderSandbox) and lets a reader audit
// and compare protocols side by side. Board, screenshots and source are the same model.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var BASE = D.model;
  var model = Object.assign({}, BASE);

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) { return n === null || n === undefined ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function age(d) { return d === null || d === undefined ? 'unknown' : d >= 365 ? (d / 365).toFixed(1) + 'y' : Math.round(d) + 'd'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // The valuation, recomputed from a row's own fields under a given set of weights. Mirrors
  // valueProtocol() in lib/model.ts exactly; the sandbox passes edited weights here.
  function recompute(row, m) {
    m = m || model;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d == null ? 0 : row.change_7d));
    var gm = Math.min(2.5, Math.max(.15, 1 + (growth / 100) * m.growth_weight));
    var a = row.age_days == null ? m.unknown_age_days : row.age_days;
    var mm = 1 + m.age_weight * (1 - 2 * Math.exp(-a / m.age_scale_days));
    var cm = 1 + m.chain_weight * Math.min(Math.max((row.chains || []).length - 1, 0), 4);
    var tilt = Math.min(4, Math.max(-2, Math.log2(m.discovery_ref_usd / Math.max(row.tvl_usd, 1))));
    var dm = 1 + m.discovery_weight * tilt;
    var pm = row.peer_mult == null ? 1 : row.peer_mult;
    var sm = row.synergy_mult == null ? 1 : row.synergy_mult;
    var cf = row.confidence == null ? 1 : row.confidence;
    // peer, synergy and confidence are snapshot factors, fixed even when the sandbox edits weights.
    return Math.max(1, Math.round(row.tvl_usd * row.comp_multiple * gm * mm * cm * dm * pm * sm * cf));
  }

  function rationale(r) {
    var out = [];
    if (r.change_7d !== null && Math.abs(r.change_7d) >= 5) out.push((r.change_7d > 0 ? 'strong ' : 'weak ') + '7-day momentum');
    if ((r.peer_mult || 1) >= 1.06) out.push('large for its peer group');
    if ((r.maturity_mult || 1) >= 1.12) out.push('a long tokenless track record');
    if ((r.discovery_mult || 1) >= 1.1) out.push('early-scale discovery');
    if ((r.comp_n || 0) > 0 && (r.comp_multiple || 0) > 0) out.push('category comps of ' + r.comp_multiple.toFixed(2) + '×');
    return out.length ? out.slice(0, 3).join(', ') : 'at or near the snapshot median on each factor';
  }

  var S = { tab: 'board', q: '', cat: 'all', chain: 'all', sort: 'rank', dir: 1, sel: null };
  var pinned = [];

  // Header, hero, coverage.
  $('asof').textContent = D.as_of;
  $('modelver').textContent = D.model_version;
  $('footSource').textContent = D.source;
  $('coverage').innerHTML =
    '<span class="cov-item">WATCHLIST <b>' + D.watchlist_size + '/' + D.watchlist_size + '</b><span class="cov-bar"><i style="transform:scaleX(1)"></i></span></span>' +
    '<span class="cov-item">SCANNED <b>' + D.protocols_count + '</b> protocols</span>' +
    '<span class="cov-item">RANKED <b>' + D.board_size + '</b> rows</span>' +
    '<span class="cov-item">EARLY <b>' + D.early_size + '</b> below floor</span>';
  $('stats').innerHTML = [
    stat(D.protocols_count, 'PROTOCOLS IN SNAPSHOT', 'the whole sealed universe', ''),
    stat(D.watchlist_size, 'ON THE WATCHLIST', 'pre-token, above the floor', 'teal'),
    stat(D.board_size, 'RANKED BY VALUE', D.early_size + ' early discoveries added', 'amber'),
    stat(D.comps.listed_count, 'LISTED COMPS', 'learned from this snapshot', 'blue'),
  ].join('');
  function stat(v, k, n, cls) {
    return '<div class="stat ' + cls + '"><div class="stat-k">' + k + '</div><div class="stat-v">' + v + '</div><div class="stat-n">' + n + '</div></div>';
  }

  // Tabs.
  var TABS = [['board', 'PRE-TOKEN BOARD'], ['market', 'MARKET COMPS'], ['sandbox', 'SANDBOX'], ['method', 'METHOD']];
  $('tabs').innerHTML = TABS.map(function (t) {
    return '<button class="tab' + (S.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
  }).join('');
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
    b.addEventListener('click', function () {
      S.tab = b.getAttribute('data-tab');
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.toggle('on', x === b); });
      closeDrawer(); render();
    });
  });

  // Controls.
  function options(values, all) {
    return '<option value="all">' + all + '</option>' + values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
  }
  var cats = Object.keys(D.comps.categories).sort();
  var chains = {};
  D.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chains[c] = 1; }); });
  $('controls').innerHTML =
    '<div class="field search"><label>Search protocols</label><input id="q" type="search" placeholder="name, category or chain…" value="' + esc(S.q) + '"></div>' +
    '<div class="field"><label>Category</label><select id="cat">' + options(cats, 'All categories') + '</select></div>' +
    '<div class="field"><label>Chain</label><select id="chain">' + options(Object.keys(chains).sort(), 'All chains') + '</select></div>' +
    '<div class="field"><label>Sort by</label><select id="sort">' +
      [['rank', 'Rank'], ['implied', 'Implied value'], ['tvl', 'TVL'], ['growth', '7-day change'], ['age', 'Tokenless age']]
        .map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('') + '</select></div>' +
    '<div class="hint" id="countline"></div>';
  $('q').addEventListener('input', function (e) { S.q = e.target.value.toLowerCase(); renderTable(); });
  $('cat').addEventListener('change', function (e) { S.cat = e.target.value; renderTable(); });
  $('chain').addEventListener('change', function (e) { S.chain = e.target.value; renderTable(); });
  $('sort').addEventListener('change', function (e) { S.sort = e.target.value; renderTable(); });

  var COLS = {
    board: [
      ['rank', '#'], ['name', 'PROTOCOL'], ['category', 'CATEGORY'], ['chains', 'CHAINS'],
      ['tvl', 'TVL', 1], ['growth', '7D', 1], ['age', 'AGE', 1], ['implied', 'IMPLIED VALUE', 1],
    ],
    market: [
      ['name', 'PROTOCOL'], ['category', 'CATEGORY'], ['tvl', 'TVL', 1],
      ['mcap', 'MARKET CAP', 1], ['ratio', 'MCAP / TVL', 1], ['growth', '7D', 1],
    ],
  };
  var maxV = D.rows.length ? D.rows[0].implied_value_usd : 1;

  function header(tab) {
    $('gridHead').innerHTML = '<tr>' + COLS[tab].map(function (c) {
      return '<th data-col="' + c[0] + '" class="' + (c[2] ? 'num' : '') + '">' + c[1] +
        (S.sort === c[0] ? ' <span class="sortmark">' + (S.dir === 1 ? '↑' : '↓') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    Array.prototype.forEach.call(document.querySelectorAll('#gridHead th'), function (th) {
      th.addEventListener('click', function () {
        var c = th.getAttribute('data-col');
        if (S.sort === c) S.dir = -S.dir; else { S.sort = c; S.dir = 1; }
        renderTable();
      });
    });
  }

  function filtered() {
    var rows = D.rows.filter(function (r) {
      if (S.cat !== 'all' && r.category !== S.cat) return false;
      if (S.chain !== 'all' && (r.chains || []).indexOf(S.chain) < 0) return false;
      if (S.q) {
        var hay = (r.name + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ') + ' ' + r.slug).toLowerCase();
        if (hay.indexOf(S.q) < 0) return false;
      }
      return true;
    });
    var key = S.sort;
    rows.sort(function (a, b) {
      var x = key === 'tvl' ? a.tvl_usd : key === 'growth' ? (a.change_7d === null ? -1e9 : a.change_7d)
        : key === 'age' ? (a.age_days === null ? -1 : a.age_days)
        : key === 'implied' ? a.implied_value_usd : a.rank;
      var y = key === 'tvl' ? b.tvl_usd : key === 'growth' ? (b.change_7d === null ? -1e9 : b.change_7d)
        : key === 'age' ? (b.age_days === null ? -1 : b.age_days)
        : key === 'implied' ? b.implied_value_usd : b.rank;
      return (x - y) * S.dir;
    });
    return rows;
  }

  function cell(r, c) {
    switch (c) {
      case 'rank': return '<td class="rank ' + (r.rank <= 10 ? 'top' : '') + '">' + String(r.rank).padStart(3, '0') + '</td>';
      case 'name': return '<td><div class="namecell"><button class="pin' + (pinned.indexOf(r.slug) >= 0 ? ' on' : '') + '" data-pin="' + esc(r.slug) + '" aria-label="Pin to compare">' + (pinned.indexOf(r.slug) >= 0 ? '★' : '☆') + '</button><div class="pname">' + esc(r.name) + (r.watchlist ? '<span class="wbadge">WATCH</span>' : '') + '</div></div></td>';
      case 'category': return '<td><span class="pill">' + esc(r.category || 'uncategorised') + '</span></td>';
      case 'chains': return '<td class="chains">' + esc((r.chains || []).slice(0, 2).join(' · ') || '—') + '</td>';
      case 'tvl': return '<td class="num">' + money(r.tvl_usd) + '</td>';
      case 'growth': return '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + pct(r.change_7d) + '</td>';
      case 'age': return '<td class="num">' + age(r.age_days) + '</td>';
      case 'mcap': return '<td class="num">' + money(r.mcap_usd) + '</td>';
      case 'ratio': return '<td class="num">' + (r.mcap_over_tvl == null ? 'n/a' : r.mcap_over_tvl.toFixed(2) + '×') + '</td>';
      case 'implied': return '<td class="num"><span class="value">' + money(r.implied_value_usd) + '</span><div class="vbar"><i style="width:' +
        Math.max(3, Math.round(100 * r.implied_value_usd / maxV)) + '%"></i></div></td>';
    }
    return '<td></td>';
  }

  function renderTable() {
    var tab = S.tab;
    if (tab === 'method' || tab === 'sandbox') return;
    header(tab);
    var rows = tab === 'board' ? filtered() : D.live.slice();
    if (tab === 'market' && S.q) rows = rows.filter(function (r) { return (r.name + ' ' + (r.category || '')).toLowerCase().indexOf(S.q) >= 0; });
    var cols = COLS[tab];
    $('gridBody').innerHTML = rows.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '">' + cols.map(function (c) { return cell(r, c[0]); }).join('') + '</tr>';
    }).join('');
    $('empty').hidden = rows.length > 0;
    $('countline').textContent = rows.length + (tab === 'board' ? ' of ' + D.board_size + ' ranked rows' : ' listed comparables');
    Array.prototype.forEach.call(document.querySelectorAll('#gridBody tr'), function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.classList.contains('pin')) return;
        open(tr.getAttribute('data-slug'));
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#gridBody .pin'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation(); togglePin(b.getAttribute('data-pin'));
      });
    });
  }

  // Detail drawer.
  function open(slug) {
    var r = D.rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    S.sel = slug;
    var check = recompute(r);
    var m = r.model || {};
    $('drawerBody').innerHTML =
      '<div class="d-eyebrow">PROTOCOL DOSSIER · RANK ' + String(r.rank).padStart(3, '0') + '</div>' +
      '<h2 class="d-title">' + esc(r.name) + '</h2>' +
      '<div class="d-sub">' + esc((r.chains || []).join(' · ') || 'chain not recorded') + ' · ' +
        esc(r.category || 'uncategorised') + (r.watchlist ? ' · on the watchlist' : ' · early discovery') + '</div>' +
      '<div class="d-val"><div class="d-val-k">IMPLIED VALUE IF ITS RECORD STAYS AS IT IS</div>' +
        '<div class="d-val-v">' + money(r.implied_value_usd) + '</div>' +
        '<div class="d-val-n">Page recomputation: ' + money(check) + ' from the same snapshot figures</div>' +
        '<div class="d-val-n" style="margin-top:8px;color:var(--amber2)">Signal: ' + esc(rationale(r)) + '</div></div>' +
      '<div class="d-grid">' +
        cell2('TVL', money(r.tvl_usd)) + cell2('7-DAY TVL', pct(r.change_7d)) +
        cell2('TIME WITHOUT TOKEN', age(r.age_days)) + cell2('COMP MULTIPLE', (r.comp_multiple || 0).toFixed(2) + '×') +
      '</div>' +
      '<div class="d-h">How the value was built</div>' +
      factor('TVL × comp multiple', money(r.tvl_usd) + ' × ' + (r.comp_multiple || 0).toFixed(2) + '× = ' + money(r.base_usd || Math.round(r.tvl_usd * r.comp_multiple))) +
      factor('Comp source', esc(r.comp_source || 'category')) +
      factor('7-day momentum', pct(r.change_7d) + ' → ' + (r.growth_mult || 1).toFixed(3) + '×') +
      factor('Tokenless maturity', age(r.age_days) + ' → ' + (r.maturity_mult || 1).toFixed(3) + '×') +
      factor('Chain breadth', (r.chains || []).length + ' chains → ' + (r.chain_mult || 1).toFixed(3) + '×') +
      factor('Discovery tilt', money(r.tvl_usd) + ' TVL → ' + (r.discovery_mult || 1).toFixed(3) + '×') +
      factor('Peer-relative size', money(r.tvl_usd) + ' vs peers → ' + (r.peer_mult || 1).toFixed(3) + '×') +
      factor('Growth × tokenless age', pct(r.change_7d) + ' × ' + age(r.age_days) + ' → ' + (r.synergy_mult || 1).toFixed(3) + '×') +
      factor('Data confidence', (r.confidence || 1) === 1 ? '7-day reported → 1.000×' : '7-day unreported → ' + (r.confidence || 1).toFixed(3) + '×') +
      '<div class="d-h">Farm plan — concrete steps, cost and time</div>' +
      '<div class="d-steps">' + (r.farm_steps || []).map(function (s, i) {
        var parts = /^(.*?) Cost: (.*?)\. Time: (.*?)\.$/.exec(s);
        var text = parts ? parts[1] : s, cost = parts ? parts[2] : '', time = parts ? parts[3] : '';
        return '<div class="step"><span class="step-n">' + String(i + 1).padStart(2, '0') + '</span><div>' +
          '<div class="step-t">' + esc(text) + '</div><div class="step-m"><b>' + esc(cost) + '</b> · ' + esc(time) + '</div></div></div>';
      }).join('') + '</div>';
    showDrawer();
  }
  function cell2(k, v) { return '<div class="d-cell"><div class="d-cell-k">' + k + '</div><div class="d-cell-v">' + v + '</div></div>'; }
  function factor(k, v) { return '<div class="factor"><span class="muted">' + k + '</span><span>' + v + '</span></div>'; }
  function showDrawer() { $('drawer').classList.add('on'); $('drawer').setAttribute('aria-hidden', 'false'); $('scrim').classList.add('on'); }
  function closeDrawer() { $('drawer').classList.remove('on'); $('drawer').setAttribute('aria-hidden', 'true'); $('scrim').classList.remove('on'); }
  $('drawerClose').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  // Compare: pin up to 3 protocols, then a side-by-side factor audit.
  function togglePin(slug) {
    var i = pinned.indexOf(slug);
    if (i >= 0) pinned.splice(i, 1);
    else { if (pinned.length >= 3) pinned.shift(); pinned.push(slug); }
    renderTray();
    if (S.tab === 'board' || S.tab === 'market') renderTable();
  }
  function renderTray() {
    $('tray').classList.toggle('on', pinned.length > 0);
    $('tray').setAttribute('aria-hidden', pinned.length ? 'false' : 'true');
    $('trayChips').innerHTML = pinned.map(function (s) {
      var r = D.rows.find(function (x) { return x.slug === s; });
      return '<span class="chip">' + esc(r ? r.name : s) + '<x data-unpin="' + esc(s) + '">×</x></span>';
    }).join('');
    $('trayGo').disabled = pinned.length < 2;
    Array.prototype.forEach.call(document.querySelectorAll('#trayChips x'), function (x) {
      x.addEventListener('click', function () { togglePin(x.getAttribute('data-unpin')); });
    });
  }
  $('trayClear').addEventListener('click', function () { pinned = []; renderTray(); if (S.tab === 'board') renderTable(); });
  $('trayGo').addEventListener('click', showCompare);
  function showCompare() {
    if (pinned.length < 2) return;
    var rs = pinned.map(function (s) { return D.rows.find(function (x) { return x.slug === s; }); }).filter(Boolean);
    var rows = [
      ['Implied value', rs.map(function (r) { return r.implied_value_usd; }), money],
      ['TVL', rs.map(function (r) { return r.tvl_usd; }), money],
      ['Comp multiple', rs.map(function (r) { return r.comp_multiple; }), function (v) { return v.toFixed(2) + '×'; }],
      ['7-day momentum', rs.map(function (r) { return r.change_7d; }), pct],
      ['Tokenless age', rs.map(function (r) { return r.age_days; }), age],
      ['Maturity factor', rs.map(function (r) { return r.maturity_mult; }), function (v) { return v.toFixed(3) + '×'; }],
      ['Discovery tilt', rs.map(function (r) { return r.discovery_mult; }), function (v) { return v.toFixed(3) + '×'; }],
      ['Peer-relative size', rs.map(function (r) { return r.peer_mult; }), function (v) { return v.toFixed(3) + '×'; }],
      ['Growth × age', rs.map(function (r) { return r.synergy_mult; }), function (v) { return v.toFixed(3) + '×'; }],
      ['Farm steps', rs.map(function (r) { return (r.farm_steps || []).length; }), function (v) { return v + ' steps'; }],
    ];
    var head = '<tr><th>FACTOR</th>' + rs.map(function (r) { return '<th>' + esc(r.name) + '</th>'; }).join('') + '</tr>';
    var body = rows.map(function (row) {
      var vals = row[1], fmt = row[2];
      var best = null;
      if (vals.every(function (v) { return v !== null && v !== undefined; })) best = Math.max.apply(null, vals);
      return '<tr><td>' + row[0] + '</td>' + vals.map(function (v) {
        return '<td class="' + (v === best && vals.length > 1 ? 'win' : '') + '">' + (v === null || v === undefined ? 'n/a' : fmt(v)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    $('drawerBody').innerHTML =
      '<div class="d-eyebrow">SIDE-BY-SIDE AUDIT</div><h2 class="d-title">Compare protocols</h2>' +
      '<div class="d-sub">The same snapshot factors, audited next to each other. Green marks the strongest value in each row.</div>' +
      '<div class="cmp-wrap"><table class="cmp"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="d-h">Dominant signal</div>' + rs.map(function (r) {
        return '<div class="factor"><span class="muted">' + esc(r.name) + '</span><span>' + esc(rationale(r)) + '</span></div>';
      }).join('');
    showDrawer();
  }

  // Sandbox: edit the model's weights and watch the ranking react, live.
  var SB = [
    ['growth_weight', 'Momentum weight', .55, 0, 1.5, .05, 'How strongly 7-day TVL change moves value.'],
    ['age_weight', 'Tokenless-age weight', .35, 0, 1, .05, 'Span of the saturating maturity factor.'],
    ['chain_weight', 'Chain-breadth weight', .05, 0, .2, .01, 'Bonus per extra chain, capped at four.'],
    ['discovery_weight', 'Discovery tilt', .11, 0, .4, .01, 'Tilt toward smaller protocols on the curve.'],
  ];
  function renderSandbox() {
    $('sandbox').innerHTML =
      '<h2>Model sandbox</h2>' +
      '<p>Every value on the board is arithmetic on snapshot figures. Move a weight and the table below re-ranks all ' + D.board_size +
        ' rows live, showing how far each protocol moves from its shipped rank. Editing here changes this preview only — <b>board.json ships the documented model</b>.</p>' +
      '<div class="sbx-grid">' + SB.map(function (s) {
        return '<div class="sbx-ctl"><div class="sbx-top"><span class="sbx-name">' + s[1] + '</span><span class="sbx-val" id="sv-' + s[0] + '">' + model[s[0]].toFixed(2) + '</span></div>' +
          '<input type="range" min="' + s[3] + '" max="' + s[4] + '" step="' + s[5] + '" value="' + model[s[0]] + '" data-w="' + s[0] + '">' +
          '<small>' + s[6] + '</small></div>';
      }).join('') + '</div>' +
      '<button class="sbx-reset" id="sbxReset">Reset to shipped model</button>' +
      '<div class="sbx-note" id="sbxNote"></div>' +
      '<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>NEW #</th><th>PROTOCOL</th><th>VALUE</th><th class="num">Δ RANK</th></tr></thead><tbody id="sbxBody"></tbody></table></div>';
    Array.prototype.forEach.call(document.querySelectorAll('#sandbox input[type=range]'), function (inp) {
      inp.addEventListener('input', function () {
        var w = inp.getAttribute('data-w');
        model[w] = parseFloat(inp.value);
        $('sv-' + w).textContent = model[w].toFixed(2);
        runSandbox();
      });
    });
    $('sbxReset').addEventListener('click', function () {
      SB.forEach(function (s) { model[s[0]] = BASE[s[0]]; });
      renderSandbox();
    });
    runSandbox();
  }
  function runSandbox() {
    var scored = D.rows.map(function (r) { return { r: r, v: recompute(r, model) }; });
    scored.sort(function (a, b) { return b.v - a.v || a.r.rank - b.r.rank; });
    var changed = 0;
    scored.forEach(function (s, i) { if (s.r.rank !== i + 1) changed++; });
    $('sbxNote').textContent = 'With these weights, ' + changed + ' of ' + D.board_size +
      ' protocols change rank. Category comparables, peer size, synergy and data confidence stay fixed because they are snapshot facts, not tunable choices.';
    $('sbxBody').innerHTML = scored.slice(0, 12).map(function (s, i) {
      var delta = s.r.rank - (i + 1);
      return '<tr><td class="rank ' + (i < 10 ? 'top' : '') + '">' + String(i + 1).padStart(3, '0') + '</td>' +
        '<td><div class="pname">' + esc(s.r.name) + '</div></td>' +
        '<td><span class="value">' + money(s.v) + '</span></td>' +
        '<td class="num ' + (delta > 0 ? 'pos' : delta < 0 ? 'neg' : '') + '">' + (delta > 0 ? '+' + delta : delta) + '</td></tr>';
    }).join('');
  }

  // Method view.
  function renderMethod() {
    var c = D.comps;
    var top = Object.keys(c.categories).sort(function (a, b) { return c.categories[b].n - c.categories[a].n; }).slice(0, 6);
    $('method').innerHTML =
      '<h2>How the board is priced</h2>' +
      '<p>The radar ranks only protocols that record no token. Every value is arithmetic on the sealed snapshot: no curated list, no name special-cased. Open any protocol to audit its factors; the sandbox lets you stress the weights.</p>' +
      '<h3>1 · Comparables, learned from this snapshot</h3>' +
      '<p>Among the ' + c.listed_count + ' protocols that already trade, the median market-cap/TVL ratio is ' + c.global_ratio.toFixed(2) +
        '×. By category: ' + top.map(function (k) { return '<span class="key">' + esc(k) + '</span> ' + c.categories[k].ratio.toFixed(2) + '× (n=' + c.categories[k].n + ')'; }).join(', ') +
        '. Thin categories fall back to the cross-category median and say so.</p>' +
      '<h3>2 · The valuation</h3>' +
      '<div class="formula">base = tvl_usd × category_comp_multiple<br>' +
        'growth = clamp(7d_change, ' + M.growth_floor + ', ' + M.growth_cap + ') → 1 + growth/100 × w_growth<br>' +
        'maturity = 1 + w_age × (1 − 2·exp(−days_without_token / ' + M.age_scale_days + '))<br>' +
        'chain = 1 + w_chain × (chains − 1) &nbsp; discovery = 1 + w_discovery × log2(' + money(M.discovery_ref_usd) + ' / tvl)<br>' +
        'peer, synergy, confidence = snapshot facts, stated per row<br>' +
        'implied = round(base × growth × maturity × chain × discovery × peer × synergy × confidence)</div>' +
      '<p>Longer tokenless records raise credibility with a saturating effect; small protocols get a bounded discovery tilt. Size relative to pre-token peers and the interaction of momentum with tokenless age are further snapshot-derived signals. An unreported 7-day change takes a small confidence haircut. Listed protocols are never ranked — they appear in Market comps with the market’s own price.</p>' +
      '<h3>3 · Coverage and farm plans</h3>' +
      '<p>The board carries all ' + D.watchlist_size + ' watchlist protocols plus ' + D.early_size + ' early pre-token names below the floor, ranked ' +
        D.board_size + ' deep. Every row’s plan is built from its category, chains, TVL and age: a fresh wallet, one tailored on-chain action, a weekly qualifying action, a holding window, a safety check on the official rewards page, a farm log and a full budget. Each step states its cash cost and time.</p>' +
      '<h3>4 · Caveat</h3>' +
      '<p>Implied value is this radar’s own claim, not make.fun’s. A record with no token in DefiLlama is not proof no token exists. Nothing here predicts whether or when a launch happens.</p>';
  }

  function render() {
    $('method').hidden = S.tab !== 'method';
    $('sandbox').hidden = S.tab !== 'sandbox';
    $('board').hidden = S.tab === 'method' || S.tab === 'sandbox';
    $('controls').hidden = S.tab === 'method' || S.tab === 'sandbox';
    if (S.tab === 'method') renderMethod();
    else if (S.tab === 'sandbox') renderSandbox();
    else renderTable();
    renderTray();
  }
  render();
})();
