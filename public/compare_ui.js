// compare_ui.js — Resume vs generated CV side-by-side modal.
//
// Triggered by "🔀 Compare with resume" in the preview modal. Calls
// /api/applications/:id/compare which returns:
//   - resume_roles[] : the resume parsed into roles + verbatim bullets,
//                      with a per-bullet match map back to the CV
//   - cv.experience[]: the structured generated CV
//   - summary        : kept / dropped / added counts
//
// Left column: resume bullets, color-coded "kept" (green) or "dropped"
// (amber). Right column: CV bullets, color-coded "kept" (green) or
// "added" (purple — present in CV, no clear resume source).
//
// Each DROPPED resume bullet shows a "+ Add to CV" button. Click it →
// POST /api/applications/:id/add-bullet → re-render preview iframes.
//
// State is module-local; the modal can be closed and re-opened cleanly.

(function() {
  const $ = id => document.getElementById(id);
  let appId = null;
  let lang  = 'en';
  let data  = null;

  function show(el) { if (!el) return; el.style.display = ''; requestAnimationFrame(() => el.classList.add('open')); }
  function hide(el) { if (!el) return; el.classList.remove('open'); }

  function init() {
    const openBtn = $('previewCompareBtn');
    if (openBtn && !openBtn.dataset.bound) {
      openBtn.onclick = openCompare;
      openBtn.dataset.bound = '1';
    }
    if ($('compareClose')) $('compareClose').onclick = () => hide($('compareOverlay'));
  }
  window.openCompareModal = openCompare;

  async function openCompare() {
    appId = window.currentAppId;
    lang  = window.currentAppLang || 'en';
    if (!appId) { alert('Open an application first.'); return; }
    show($('compareOverlay'));
    $('compareGrid').innerHTML = '<div class="compare-loading">Parsing your resume + matching to the generated CV…</div>';
    $('compareMeta').innerHTML = '';
    try {
      const r = await fetch(`/api/applications/${appId}/compare?lang=${encodeURIComponent(lang)}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `compare ${r.status}`);
      data = await r.json();
      render();
    } catch (e) {
      $('compareGrid').innerHTML = `<div class="brain-empty">Compare failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function render() {
    if (!data) return;
    const grid = $('compareGrid');
    const meta = $('compareMeta');
    const s = data.summary || { kept_count: 0, dropped_count: 0, added_count: 0 };
    meta.innerHTML = `
      <span class="cm-pill"><span class="cm-dot kept"></span> ${s.kept_count} bullets kept</span>
      <span class="cm-pill"><span class="cm-dot dropped"></span> ${s.dropped_count} dropped from resume</span>
      <span class="cm-pill"><span class="cm-dot added"></span> ${s.added_count} added in CV</span>`;

    // Index which (cv_role, cv_bullet) positions are matched by ANY resume bullet.
    // Used to mark CV bullets as "kept" vs "added (no resume source)".
    const matchedCvKeys = new Set();
    for (const role of (data.resume_roles || [])) {
      for (const b of (role.bullets || [])) {
        if (Number.isFinite(b.matched_cv_role) && Number.isFinite(b.matched_cv_bullet)) {
          matchedCvKeys.add(`${b.matched_cv_role}:${b.matched_cv_bullet}`);
        }
      }
    }

    const leftHtml  = renderResumeColumn(data.resume_roles || []);
    const rightHtml = renderCvColumn(data.cv?.experience || [], matchedCvKeys);

    grid.innerHTML = `
      <div class="compare-col">
        <div class="compare-col-head">📄 Source resume</div>
        ${leftHtml}
      </div>
      <div class="compare-col">
        <div class="compare-col-head">✨ Generated CV — ${escapeHtml(lang.toUpperCase())}</div>
        ${rightHtml}
      </div>`;

    // Wire the + buttons (delegation).
    grid.querySelectorAll('.cb-add').forEach(btn => {
      btn.addEventListener('click', () => onPromote(btn));
    });
  }

  function renderResumeColumn(roles) {
    if (!roles.length) return '<div class="brain-empty">No structured roles parsed from resume.</div>';
    return roles.map(r => {
      const bulletsHtml = (r.bullets || []).map(b => {
        const isKept = Number.isFinite(b.matched_cv_role) && Number.isFinite(b.matched_cv_bullet);
        const cls    = isKept ? 'kept' : 'dropped';
        const tag    = `<span class="cb-tag ${cls}">${isKept ? 'kept' : 'dropped'}</span>`;
        // For dropped bullets, surface a + button. We need to know which CV
        // role to add it to — fallback to role 0 if no mapping. We pass the
        // resume role's company so the server-side helper can pick the right
        // CV role by company match (handled below in onPromote).
        const addBtn = isKept ? '' :
          `<button class="cb-add" data-bullet="${escapeAttr(b.text)}" data-resume-co="${escapeAttr(r.company || '')}" data-resume-title="${escapeAttr(r.title || '')}" title="Add this bullet back to the CV">+ Add</button>`;
        return `<div class="compare-bullet ${cls}">
          <span class="cb-text">${escapeHtml(b.text)}</span>
          ${addBtn}
          ${tag}
        </div>`;
      }).join('');
      return `<div class="compare-role">
        <div class="compare-role-head">
          <span class="cr-title">${escapeHtml(r.title || '(role)')}</span>
          ${r.company ? ` · <span class="cr-co">${escapeHtml(r.company)}</span>` : ''}
          ${r.dates ? ` · <span class="cr-dates">${escapeHtml(r.dates)}</span>` : ''}
        </div>
        <div class="compare-bullets">${bulletsHtml || '<div class="cv-empty" style="font-size:12px;color:#94a3b8;">no bullets</div>'}</div>
      </div>`;
    }).join('');
  }

  function renderCvColumn(experience, matchedKeys) {
    if (!experience.length) return '<div class="brain-empty">CV has no experience entries.</div>';
    return experience.map((e, idx) => {
      const bulletsHtml = (e.bullets || []).map((text, bi) => {
        const isKept = matchedKeys.has(`${idx}:${bi}`);
        const cls    = isKept ? 'kept' : 'added';
        const tag    = `<span class="cb-tag ${cls}">${isKept ? 'kept' : 'added'}</span>`;
        return `<div class="compare-bullet ${cls}">
          <span class="cb-text">${escapeHtml(text)}</span>
          ${tag}
        </div>`;
      }).join('');
      return `<div class="compare-role">
        <div class="compare-role-head">
          <span class="cr-title">${escapeHtml(e.title || '(role)')}</span>
          ${e.company ? ` · <span class="cr-co">${escapeHtml(e.company)}</span>` : ''}
          ${e.dates ? ` · <span class="cr-dates">${escapeHtml(e.dates)}</span>` : ''}
        </div>
        <div class="compare-bullets">${bulletsHtml || '<div class="cv-empty" style="font-size:12px;color:#94a3b8;">no bullets</div>'}</div>
      </div>`;
    }).join('');
  }

  // Find the best CV role index to add a resume bullet into. Match on
  // company name first (case-insensitive contains), then on title, else
  // fall back to the first role.
  function pickTargetCvRoleIndex(resumeCo, resumeTitle) {
    const exp = data?.cv?.experience || [];
    const co  = (resumeCo || '').toLowerCase().trim();
    const ti  = (resumeTitle || '').toLowerCase().trim();
    if (co) {
      const i = exp.findIndex(e => (e.company || '').toLowerCase().includes(co) || co.includes((e.company || '').toLowerCase()));
      if (i >= 0) return i;
    }
    if (ti) {
      const i = exp.findIndex(e => (e.title || '').toLowerCase().includes(ti) || ti.includes((e.title || '').toLowerCase()));
      if (i >= 0) return i;
    }
    return 0;
  }

  async function onPromote(btn) {
    const bulletText = btn.dataset.bullet || '';
    const resumeCo   = btn.dataset.resumeCo || '';
    const resumeTitle= btn.dataset.resumeTitle || '';
    const targetIdx  = pickTargetCvRoleIndex(resumeCo, resumeTitle);
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`/api/applications/${appId}/add-bullet`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: lang,
          experience_index: targetIdx,
          bullet_text: bulletText,
          position: -1,           // append to the role's bullets
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'add failed');
      // Mark visually as kept; reload preview iframes so the user sees the CV update.
      const row = btn.closest('.compare-bullet');
      if (row) { row.classList.remove('dropped'); row.classList.add('kept'); }
      const tag = row?.querySelector('.cb-tag');
      if (tag) { tag.classList.remove('dropped'); tag.classList.add('kept'); tag.textContent = 'kept'; }
      btn.remove();
      if (typeof window.loadPreviewPdfs === 'function') window.loadPreviewPdfs();
      if (typeof window.showToast === 'function') window.showToast('Bullet added to CV.');
    } catch (e) {
      btn.disabled = false; btn.textContent = '+ Add';
      alert('Add failed: ' + e.message);
    }
  }

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
