// brain_ui.js — Frontend logic for the 🧠 Brain overlay.
// Loads after profile_ui.js and app.js. Pulls /api/brain on open and
// re-renders. Lets the user edit insights, add manual facts, and trigger
// a reflection pass.

(function() {
  const $ = id => document.getElementById(id);
  let chart = null;
  // Currently-selected angle filter ('' = all angles / cross-angle only).
  // Persisted across re-renders inside the modal but reset on each open.
  let angleFilter = '';
  let archetypes = [];

  function init() {
    const btn = $('brainBtn');
    if (btn) btn.onclick = openBrain;
    const close = $('brainCloseBtn');
    if (close) close.onclick = closeBrain;
    const reflect = $('brainReflectBtn');
    if (reflect) reflect.onclick = handleReflect;
    const add = $('addFactBtn');
    if (add) add.onclick = handleAddFact;
    const af = $('brainAngleFilter');
    if (af) af.onchange = () => { angleFilter = af.value; refresh(); };
  }

  async function openBrain() {
    angleFilter = '';
    if ($('brainAngleFilter')) $('brainAngleFilter').value = '';
    $('brainOverlay').style.display = 'flex';
    await refresh();
  }
  function closeBrain() { $('brainOverlay').style.display = 'none'; }

  async function refresh() {
    try {
      const data = await fetchJson('/api/brain');
      if (data._empty) {
        $('brainProfileName').textContent = '(no active profile)';
        return;
      }
      $('brainProfileName').textContent = data.profile?.name || '—';
      $('bsGen').textContent    = data.stats.generations;
      $('bsApp').textContent    = data.stats.applied;
      $('bsCo').textContent     = data.stats.companies_seen;
      $('bsAngles').textContent = data.stats.angles ?? (data.archetypes?.length || 0);
      $('bsIns').textContent    = data.stats.insights_active;
      $('bsFacts').textContent  = data.stats.facts;

      archetypes = data.archetypes || [];
      renderAngles(archetypes);
      populateAngleSelectors(archetypes);

      renderSkillChart(data.top_demand, data.top_emphasis);

      // Re-fetch insights and facts with the active angle filter so we get
      // the right slice (angle-specific + global, vs. global-only).
      const insightsParams = angleFilter ? `?archetypeId=${angleFilter}` : '?archetypeId=null';
      const factsParams    = angleFilter ? `?archetypeId=${angleFilter}` : '?archetypeId=null';
      const [insights, facts] = await Promise.all([
        fetchJson('/api/brain/insights' + insightsParams),
        fetchJson('/api/brain/facts'    + factsParams),
      ]);
      renderInsights(insights);
      renderFacts(facts);

      renderCompanies(data.recent_companies);
    } catch (e) {
      console.warn('[BrainUI] refresh failed:', e);
    }
  }

  function renderAngles(list) {
    const container = $('brainAnglesList');
    container.innerHTML = '';
    if (!list || list.length === 0) {
      container.innerHTML = '<div class="brain-empty">No angles yet — generate an application and Claude will infer the role archetype (e.g. "BI Engineer at fintech", "SAP Consultant at enterprise"). One profile typically targets several distinct angles.</div>';
      return;
    }
    for (const a of list) {
      const row = document.createElement('div');
      row.className = 'angle-row';
      row.innerHTML = `
        <div class="ar-name">${escapeHtml(a.name)}</div>
        <div class="ar-meta">${a.application_count} generation${a.application_count === 1 ? '' : 's'} · ${a.applied_count} applied</div>`;
      // Click an angle row to jump-filter
      row.style.cursor = 'pointer';
      row.title = 'Filter insights & facts to this angle';
      row.onclick = () => {
        angleFilter = String(a.id);
        $('brainAngleFilter').value = angleFilter;
        refresh();
      };
      container.appendChild(row);
    }
  }

  function populateAngleSelectors(list) {
    const filterEl = $('brainAngleFilter');
    const composerEl = $('newFactAngle');
    const fillSelect = (el, leadingLabel) => {
      if (!el) return;
      const current = el.value;
      el.innerHTML = `<option value="">${leadingLabel}</option>`;
      for (const a of list) {
        const opt = document.createElement('option');
        opt.value = String(a.id);
        opt.textContent = `${a.name} (${a.application_count})`;
        el.appendChild(opt);
      }
      el.value = current;
    };
    fillSelect(filterEl,   'All angles (cross-angle wisdom only)');
    fillSelect(composerEl, 'Applies to all angles');
  }

  // ─── Skill chart (demand vs supply) ───
  function renderSkillChart(demand, emphasis) {
    if (!window.Chart) return;
    // Merge top skills from both lists
    const map = new Map();
    for (const s of demand)    map.set(s.skill, { skill: s.skill, demand: s.demand_count, emphasis: 0 });
    for (const s of emphasis) {
      const ex = map.get(s.skill) || { skill: s.skill, demand: 0, emphasis: 0 };
      ex.emphasis = s.emphasis_count;
      map.set(s.skill, ex);
    }
    const all = [...map.values()].sort((a, b) => (b.demand + b.emphasis) - (a.demand + a.emphasis)).slice(0, 12);

    const ctx = $('brainSkillChart').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: all.map(s => s.skill),
        datasets: [
          { label: 'Demand (jobs ask)',  data: all.map(s => s.demand),   backgroundColor: 'rgba(99, 102, 241, 0.7)' },
          { label: 'Supply (CVs emphasize)', data: all.map(s => s.emphasis), backgroundColor: 'rgba(34, 197, 94, 0.7)' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbd5e1' } } },
        scales: {
          x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
        },
      },
    });
  }

  // ─── Insights ───
  function renderInsights(insights) {
    const list = $('brainInsightsList');
    list.innerHTML = '';
    if (!insights || insights.length === 0) {
      list.innerHTML = '<div class="brain-empty">No insights yet. After you mark applications "applied", Claude reflects and adds lessons here.</div>';
      return;
    }
    for (const i of insights) {
      const row = document.createElement('div');
      row.className = 'brain-row' + (i.is_active ? '' : ' inactive');
      const cat = i.category ? `<span class="br-cat">${escapeHtml(i.category)}</span>` : '';
      const angleChip = renderAngleChip(i.archetype_id);
      const conf = (i.confidence != null) ? `confidence ${Math.round(i.confidence * 100)}%` : '';
      row.innerHTML = `
        <div class="br-text">
          <div>${angleChip}${cat}${escapeHtml(i.insight)}</div>
          <div class="br-meta">${escapeHtml(i.source || '')} · ${conf} · updated ${fmt(i.updated_at)}</div>
        </div>
        <div class="br-actions">
          <button title="Edit">✏️</button>
          <button title="${i.is_active ? 'Deactivate' : 'Activate'}">${i.is_active ? '🔇' : '🔊'}</button>
          <button title="Delete">🗑</button>
        </div>`;
      const [editBtn, toggleBtn, delBtn] = row.querySelectorAll('.br-actions button');
      editBtn.onclick = () => beginInsightEdit(row, i);
      toggleBtn.onclick = async () => {
        await fetchJson(`/api/brain/insights/${i.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: i.is_active ? 0 : 1 }) });
        await refresh();
      };
      delBtn.onclick = async () => {
        if (!confirm('Delete this insight?')) return;
        await fetchJson(`/api/brain/insights/${i.id}`, { method: 'DELETE' });
        await refresh();
      };
      list.appendChild(row);
    }
  }

  function beginInsightEdit(row, i) {
    const textDiv = row.querySelector('.br-text');
    const angleOpts = ['<option value="">Applies to all angles</option>']
      .concat(archetypes.map(a => `<option value="${a.id}" ${a.id === i.archetype_id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`))
      .join('');
    textDiv.innerHTML = `
      <input class="input br-edit-input" value="${escapeAttr(i.insight)}"/>
      <div class="br-meta" style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
        <input class="input" placeholder="category" value="${escapeAttr(i.category || '')}" style="max-width:140px"/>
        <select class="input" style="max-width:220px">${angleOpts}</select>
        <button class="btn btn-primary" style="padding:4px 12px">Save</button>
        <button class="btn btn-ghost" style="padding:4px 12px">Cancel</button>
      </div>`;
    const [textIn, catIn] = textDiv.querySelectorAll('input');
    const angleSel = textDiv.querySelector('select');
    const [saveBtn, cancelBtn] = textDiv.querySelectorAll('button');
    saveBtn.onclick = async () => {
      await fetchJson(`/api/brain/insights/${i.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          insight: textIn.value.trim(),
          category: catIn.value.trim(),
          archetype_id: angleSel.value ? parseInt(angleSel.value) : null,
        }),
      });
      await refresh();
    };
    cancelBtn.onclick = refresh;
  }

  // Render an angle chip showing whether a row is angle-specific or applies
  // across all angles. The chip styling differs (gold for angle-specific,
  // neutral grey for "all angles") so the user can scan a list and know which
  // brain entries will fire on which generations.
  function renderAngleChip(archetypeId) {
    if (!archetypeId) {
      return `<span class="angle-chip global">all angles</span>`;
    }
    const a = archetypes.find(x => x.id === archetypeId);
    return `<span class="angle-chip">${escapeHtml(a?.name || `angle #${archetypeId}`)}</span>`;
  }

  // ─── Facts ───
  function renderFacts(facts) {
    const list = $('brainFactsList');
    list.innerHTML = '';
    if (!facts || facts.length === 0) {
      list.innerHTML = '<div class="brain-empty">No facts yet — add anything you want the brain to remember above.</div>';
      return;
    }
    for (const f of facts) {
      const row = document.createElement('div');
      row.className = 'brain-row';
      const tag = f.tag ? `<span class="br-tag">${escapeHtml(f.tag)}</span>` : '';
      const angleChip = renderAngleChip(f.archetype_id);
      row.innerHTML = `
        <div class="br-text">
          <div>${angleChip}${tag}${escapeHtml(f.fact)}</div>
          <div class="br-meta">added ${fmt(f.created_at)}</div>
        </div>
        <div class="br-actions">
          <button title="Re-assign angle">🎯</button>
          <button title="Delete">🗑</button>
        </div>`;
      const [angleBtn, delBtn] = row.querySelectorAll('button');
      angleBtn.onclick = () => beginFactAngleEdit(row, f);
      delBtn.onclick = async () => {
        await fetchJson(`/api/brain/facts/${f.id}`, { method: 'DELETE' });
        await refresh();
      };
      list.appendChild(row);
    }
  }

  function beginFactAngleEdit(row, f) {
    const textDiv = row.querySelector('.br-text');
    const angleOpts = ['<option value="">Applies to all angles</option>']
      .concat(archetypes.map(a => `<option value="${a.id}" ${a.id === f.archetype_id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`))
      .join('');
    const original = textDiv.innerHTML;
    textDiv.innerHTML = original + `
      <div class="br-meta" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
        <select class="input" style="max-width:220px">${angleOpts}</select>
        <button class="btn btn-primary" style="padding:4px 12px">Save angle</button>
        <button class="btn btn-ghost" style="padding:4px 12px">Cancel</button>
      </div>`;
    const sel = textDiv.querySelector('select');
    const [saveBtn, cancelBtn] = textDiv.querySelectorAll('button');
    saveBtn.onclick = async () => {
      await fetchJson(`/api/brain/facts/${f.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archetype_id: sel.value ? parseInt(sel.value) : null }),
      });
      await refresh();
    };
    cancelBtn.onclick = refresh;
  }

  async function handleAddFact() {
    const fact = $('newFactInput').value.trim();
    const tag  = $('newFactTag').value.trim();
    const angleVal = $('newFactAngle')?.value || '';
    if (!fact) return;
    try {
      await fetchJson('/api/brain/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact, tag,
          archetype_id: angleVal ? parseInt(angleVal) : null,
        }),
      });
      $('newFactInput').value = ''; $('newFactTag').value = '';
      if ($('newFactAngle')) $('newFactAngle').value = '';
      await refresh();
    } catch (e) { alert('Add failed: ' + e.message); }
  }

  // ─── Companies ───
  function renderCompanies(companies) {
    const list = $('brainCompaniesList');
    list.innerHTML = '';
    if (!companies || companies.length === 0) {
      list.innerHTML = '<div class="brain-empty">No companies yet — generate an application to populate this.</div>';
      return;
    }
    for (const c of companies) {
      const row = document.createElement('div');
      row.className = 'brain-row';
      const ts = (() => { try { return JSON.parse(c.tech_stack || '[]'); } catch { return []; } })();
      row.innerHTML = `
        <div class="br-text">
          <div><strong>${escapeHtml(c.name)}</strong> ${c.industry ? '<span class="br-cat">'+escapeHtml(c.industry)+'</span>' : ''}</div>
          ${c.what_they_do ? `<div class="br-meta">${escapeHtml(c.what_they_do)}</div>` : ''}
          ${ts.length ? `<div class="br-meta">Stack: ${ts.map(escapeHtml).join(', ')}</div>` : ''}
          <div class="br-meta">applications: ${c.application_count} · last seen ${fmt(c.last_seen_at)}</div>
        </div>`;
      list.appendChild(row);
    }
  }

  // ─── Reflect ───
  async function handleReflect() {
    const btn = $('brainReflectBtn');
    btn.disabled = true; btn.textContent = '🔁 Reflecting…';
    // If the user has filtered to a specific angle, reflect within that angle
    // (insights tagged for it). Otherwise run a global cross-angle reflection.
    const body = angleFilter ? { archetypeId: parseInt(angleFilter) } : {};
    try {
      const r = await fetchJson('/api/brain/reflect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.skipped) alert('Reflection skipped: ' + r.reason);
      else if (r.created?.length) alert(`Added ${r.created.length} new insight(s)${r.archetype ? ' for "' + r.archetype + '"' : ' (cross-angle)'}.`);
      else alert('Reflection complete — no new insights this round.');
      await refresh();
    } catch (e) { alert('Reflect failed: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '🔁 Reflect'; }
  }

  // ─── Helpers ───
  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, opts);
    if (res.status === 409) return { _empty: true };
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }
  function fmt(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
