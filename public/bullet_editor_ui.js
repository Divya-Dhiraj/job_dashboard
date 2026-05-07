// bullet_editor_ui.js — Click-to-edit individual experience bullets.
//
// Opened from the "✏️ Edit Bullets" button in the preview modal. Renders
// the current language's CV experience as cards. Each bullet is clickable;
// click expands a popover under it with:
//
//   • 4 Claude-generated alternative phrasings (loaded on demand from
//     /api/applications/:id/bullet-suggestions)
//   • Up to 8 past bullets from the brain_achievements table (the user's
//     actual phrasings from previous CVs — many are lifted verbatim from
//     the source resume)
//   • A free-text input for manual rewording
//
// Click any suggestion or hit "Apply" on the manual input → POST
// /api/applications/:id/update-bullet → CV docx + pdf re-render → preview
// iframe in the parent modal reloads.
//
// State is kept module-local so the popover stays open across re-renders.
// We never accept a click on a different bullet without closing the open
// popover first — keeps the UX uncluttered.

(function() {
  const $ = id => document.getElementById(id);

  let appId = null;
  let appData = null;        // generated.json contents
  let currentLang = 'en';
  let availableLangs = ['en'];
  let openBulletKey = null;  // e.g. "0:2" for experience[0].bullets[2]

  function show(el) {
    if (!el) return;
    el.style.display = '';
    requestAnimationFrame(() => el.classList.add('open'));
  }
  function hide(el) {
    if (!el) return;
    el.classList.remove('open');
  }

  function init() {
    const openBtn = $('previewEditBulletsBtn');
    if (openBtn) openBtn.onclick = openEditor;
    if ($('bulletEditorClose')) $('bulletEditorClose').onclick = () => hide($('bulletEditorOverlay'));
  }

  // Public — called from app.js if present
  window.openBulletEditor = openEditor;

  async function openEditor() {
    // The preview modal in app.js exposes currentAppId / currentAppLang
    appId = window.currentAppId;
    if (!appId) { alert('Open an application first.'); return; }
    currentLang = window.currentAppLang || 'en';

    show($('bulletEditorOverlay'));
    $('bulletEditorBody').innerHTML = '<div class="bullet-popover-loading">Loading CV…</div>';

    try {
      const r = await fetch(`/api/applications/${appId}`, { credentials: 'same-origin' });
      const data = await r.json();
      appData = data.generatedData || {};
      availableLangs = data.languages_available || ['en'];
      renderLangTabs();
      renderRoles();
    } catch (e) {
      $('bulletEditorBody').innerHTML = '<div class="brain-empty">Failed to load CV: ' + e.message + '</div>';
    }
  }

  function renderLangTabs() {
    const host = $('bulletEditorLangTabs');
    if (!host) return;
    host.innerHTML = '';
    if (availableLangs.length <= 1) return;
    const labelFor = c => ({ en: '🇬🇧 English', de: '🇩🇪 German' })[c] || c;
    for (const code of availableLangs) {
      const btn = document.createElement('button');
      btn.className = 'lang-tab' + (code === currentLang ? ' active' : '');
      btn.textContent = labelFor(code);
      btn.onclick = () => { currentLang = code; openBulletKey = null; renderLangTabs(); renderRoles(); };
      host.appendChild(btn);
    }
  }

  function getActiveCv() {
    // Multi-language schema (current) vs. legacy top-level cv (pre-bilingual)
    const langs = appData.languages || {};
    const fromLang = langs[currentLang]?.cv;
    if (fromLang) return fromLang;
    if (currentLang === (appData.primary_language || 'en')) return appData.cv;
    return null;
  }

  function renderRoles() {
    const cv = getActiveCv();
    const host = $('bulletEditorBody');
    host.innerHTML = '';
    if (!cv?.experience?.length) {
      host.innerHTML = '<div class="brain-empty">No experience entries in this CV.</div>';
      return;
    }
    cv.experience.forEach((exp, ei) => {
      const card = document.createElement('div');
      card.className = 'role-card';
      card.innerHTML = `
        <div class="role-card-head">
          <span class="role-card-title">${escapeHtml(exp.title || '')}${exp.company ? ', ' + escapeHtml(exp.company) : ''}</span>
          <span class="role-card-dates">${escapeHtml(exp.dates || '')}</span>
        </div>`;
      const bulletsDiv = document.createElement('div');
      (exp.bullets || []).forEach((b, bi) => {
        const key = `${ei}:${bi}`;
        const row = document.createElement('div');
        row.className = 'bullet-row' + (openBulletKey === key ? ' editing' : '');
        row.innerHTML = `
          <span class="bullet-marker">·</span>
          <span class="bullet-text">${escapeHtml(b)}</span>
          <span class="bullet-edit-icon">✏️</span>`;
        row.onclick = () => toggleBullet(ei, bi);
        bulletsDiv.appendChild(row);

        if (openBulletKey === key) {
          const pop = document.createElement('div');
          pop.className = 'bullet-popover';
          pop.id = 'bulletPopover-' + key.replace(':', '-');
          pop.innerHTML = `<div class="bullet-popover-loading">Generating alternatives…</div>`;
          bulletsDiv.appendChild(pop);
          loadSuggestions(ei, bi, pop);
        }
      });
      card.appendChild(bulletsDiv);
      host.appendChild(card);
    });
  }

  function toggleBullet(ei, bi) {
    const key = `${ei}:${bi}`;
    openBulletKey = (openBulletKey === key) ? null : key;
    renderRoles();
  }

  async function loadSuggestions(ei, bi, container) {
    try {
      const r = await fetch(`/api/applications/${appId}/bullet-suggestions`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: currentLang,
          experience_index: ei,
          bullet_index: bi,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      const data = await r.json();
      renderPopover(container, ei, bi, data);
    } catch (e) {
      container.innerHTML = `<div class="brain-empty">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderPopover(container, ei, bi, data) {
    const apply = (text) => applyBullet(ei, bi, text);
    container.innerHTML = '';

    // Section 1: Claude alternatives
    if (data.alternatives?.length) {
      const sec = document.createElement('div');
      sec.className = 'bullet-popover-section';
      sec.innerHTML = `<h4>Suggested rewrites (Claude)</h4>`;
      data.alternatives.forEach(text => {
        const row = document.createElement('div');
        row.className = 'bullet-suggestion';
        row.innerHTML = `<div class="bs-text">${escapeHtml(text)}</div>`;
        row.onclick = () => apply(text);
        sec.appendChild(row);
      });
      container.appendChild(sec);
    }

    // Section 2: Past uses from brain_achievements
    const past = (data.past_uses || []).slice(0, 8);
    if (past.length) {
      const sec = document.createElement('div');
      sec.className = 'bullet-popover-section';
      sec.innerHTML = `<h4>From your past CVs</h4>`;
      past.forEach(p => {
        const row = document.createElement('div');
        row.className = 'bullet-suggestion';
        row.innerHTML = `
          <div class="bs-text">${escapeHtml(p.text)}<div class="bs-meta">${p.applied ? '<span class="bs-applied">applied</span> · ' : ''}${escapeHtml(p.context || '')}</div></div>`;
        row.onclick = () => apply(p.text);
        sec.appendChild(row);
      });
      container.appendChild(sec);
    }

    // Section 3: Original passage from the resume — collapsed by default,
    // fetched on demand. Useful when the generator trimmed too aggressively
    // and the user wants to recover the unabridged version.
    {
      const sec = document.createElement('div');
      sec.className = 'bullet-popover-section';
      sec.innerHTML = `
        <h4>From your resume <span class="bs-meta" style="font-weight:400;">(unshortened original)</span></h4>
        <button type="button" class="btn btn-ghost bs-show-source" style="font-size:12px; padding:4px 10px;">Show original passage</button>
        <div class="bs-source-results" style="margin-top:6px;"></div>`;
      const showBtn = sec.querySelector('.bs-show-source');
      const results = sec.querySelector('.bs-source-results');
      showBtn.onclick = async () => {
        showBtn.disabled = true;
        showBtn.textContent = 'Searching your resume…';
        try {
          const r = await fetch(`/api/applications/${appId}/bullet-source`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bullet: data.current_bullet || '' }),
          });
          if (!r.ok) throw new Error((await r.json()).error || 'lookup failed');
          const out = await r.json();
          showBtn.style.display = 'none';
          results.innerHTML = '';
          if (!out.excerpts?.length) {
            results.innerHTML = `<div class="brain-empty" style="font-size:12px;">${escapeHtml(out.reasoning || 'No clear match in the resume for this bullet.')}</div>`;
            return;
          }
          out.excerpts.forEach(ex => {
            const row = document.createElement('div');
            row.className = 'bullet-suggestion';
            row.innerHTML = `<div class="bs-text">${escapeHtml(ex)}<div class="bs-meta">click to use as bullet</div></div>`;
            row.onclick = () => apply(ex);
            results.appendChild(row);
          });
          if (out.reasoning) {
            const note = document.createElement('div');
            note.className = 'bs-meta';
            note.style.cssText = 'margin-top:4px; font-size:11px;';
            note.textContent = out.reasoning;
            results.appendChild(note);
          }
        } catch (e) {
          showBtn.disabled = false;
          showBtn.textContent = 'Show original passage';
          results.innerHTML = `<div class="brain-empty" style="font-size:12px;">Lookup failed: ${escapeHtml(e.message)}</div>`;
        }
      };
      container.appendChild(sec);
    }

    // Section 4: Manual input
    const sec = document.createElement('div');
    sec.className = 'bullet-popover-section';
    sec.innerHTML = `<h4>Type your own</h4>
      <div class="bullet-manual-row">
        <textarea class="input" placeholder="Write the new bullet…">${escapeHtml(data.current_bullet || '')}</textarea>
        <button class="btn btn-primary">Apply</button>
      </div>`;
    const ta  = sec.querySelector('textarea');
    const btn = sec.querySelector('button');
    btn.onclick = () => {
      const txt = ta.value.trim();
      if (!txt) return;
      apply(txt);
    };
    container.appendChild(sec);
  }

  async function applyBullet(ei, bi, newText) {
    try {
      const r = await fetch(`/api/applications/${appId}/update-bullet`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: currentLang,
          experience_index: ei,
          bullet_index: bi,
          new_text: newText,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'update failed');
      // Update local appData so the next render shows the new bullet without
      // re-fetching from the server.
      const cv = getActiveCv();
      if (cv?.experience?.[ei]?.bullets) {
        cv.experience[ei].bullets[bi] = newText;
      }
      openBulletKey = null;
      renderRoles();
      // Reload the preview iframes in the parent modal so the user sees the
      // change reflected in the PDF immediately. loadPreviewPdfs is exposed
      // by app.js when the preview modal is open.
      if (typeof window.loadPreviewPdfs === 'function') window.loadPreviewPdfs();
    } catch (e) {
      alert('Update failed: ' + e.message);
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
