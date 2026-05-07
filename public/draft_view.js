// draft_view.js — Structured "draft" rendering of the generated CV +
// cover letter inside the preview modal, with inline expandable bullet
// alternatives.
//
// The PDF iframe view is still available via the 📄 PDF toggle. The
// draft view is the new default after generation: faster to scan, lets
// you click any bullet to see Claude's 4 rewrites + your past phrasings
// + a manual textbox without leaving the page.
//
// Each bullet edit POSTs /api/applications/:id/update-bullet which
// persists the change to generated.json AND re-renders the language's
// docx + pdf in the background — so when the user toggles to PDF view
// it's already up to date.

(function() {
  const $ = id => document.getElementById(id);

  // Cached generated.json contents per active app+language. Survives
  // language switches in the same modal session; cleared when the modal
  // closes (handled by the parent app.js when it closes the overlay).
  let appData = null;
  let appId = null;
  let language = 'en';

  // bulletKey = "<expIdx>:<bulletIdx>"  → array of suggestions cached
  // so re-clicking a bullet doesn't re-fetch (the user often clicks back
  // and forth comparing alternatives).
  const altCache = new Map();

  function init() {
    // View toggle (Draft / PDF)
    document.querySelectorAll('.view-toggle-btn').forEach(btn => {
      btn.onclick = () => switchView(btn.dataset.view);
    });
  }

  function switchView(view) {
    document.querySelectorAll('.view-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (view === 'pdf') {
      $('previewDraft').style.display = 'none';
      $('previewPanes').style.display = '';
      // Make sure the iframes are pointing at fresh PDFs (each bullet
      // edit already triggers re-render server-side; just bump the cache
      // buster).
      if (typeof window.loadPreviewPdfs === 'function') window.loadPreviewPdfs();
    } else {
      $('previewPanes').style.display = 'none';
      $('previewDraft').style.display = '';
    }
  }

  // Public — called by app.js after openPreviewModal sets currentAppId.
  // Renders the draft view for the given language, hiding the PDF panes.
  window.renderDraftView = async function(thisAppId, thisLang) {
    appId    = thisAppId;
    language = thisLang || 'en';
    altCache.clear();

    // Default to Draft tab whenever the modal (re)opens
    switchView('draft');
    const host = $('previewDraft');
    host.innerHTML = '<div class="bullet-popover-loading">Loading draft…</div>';

    try {
      const r = await fetch(`/api/applications/${appId}`, { credentials: 'same-origin' });
      const data = await r.json();
      appData = data.generatedData || {};
      render();
    } catch (e) {
      host.innerHTML = `<div class="brain-empty">Failed to load draft: ${escapeHtml(e.message)}</div>`;
    }
  };

  // Public — called by the language tab handler in app.js when the user
  // switches between en/de in the preview header.
  window.draftViewSetLanguage = function(lang) {
    if (!appData) return;
    language = lang;
    altCache.clear();
    render();
  };

  function getActivePayload() {
    if (!appData) return null;
    const langs = appData.languages || {};
    if (langs[language]) return langs[language];
    if (language === (appData.primary_language || 'en')) {
      return { cv: appData.cv, coverLetter: appData.coverLetter };
    }
    // Fallback to whatever is available
    const first = Object.keys(langs)[0];
    return langs[first] || { cv: appData.cv, coverLetter: appData.coverLetter };
  }

  function render() {
    const host = $('previewDraft');
    const payload = getActivePayload();
    if (!payload?.cv) {
      host.innerHTML = '<div class="brain-empty">No CV content for this language.</div>';
      return;
    }
    const cv = payload.cv;
    const cl = payload.coverLetter || '';

    let html = '';
    // Header — every field below is click-to-edit. The `data-edit-path`
    // attribute drives the inline editor; the `data-edit-as` attribute
    // tells it whether to render an <input> (short single-line) or
    // <textarea> (multiline) when activated.
    html += `<h2 class="pd-name pd-editable" data-edit-path="cv.name" data-edit-as="input">${escapeHtml(cv.name || '—')}</h2>`;
    html += `<p class="pd-headline pd-editable" data-edit-path="cv.targetTitle" data-edit-as="input" data-empty-placeholder="(click to add a headline role)">${escapeHtml(cv.targetTitle || '')}</p>`;

    // Contact line: each field individually editable so the user can
    // tweak just the email or just the LinkedIn without retyping the
    // others. Renders as a · separated list.
    const contactFields = [
      { path: 'cv.email',    text: cv.email,    placeholder: 'email' },
      { path: 'cv.phone',    text: cv.phone,    placeholder: 'phone' },
      { path: 'cv.address',  text: cv.address,  placeholder: 'location' },
      { path: 'cv.linkedin', text: cv.linkedin, placeholder: 'linkedin' },
    ];
    html += `<p class="pd-contact">${contactFields.map(f => `<span class="pd-editable pd-inline" data-edit-path="${f.path}" data-edit-as="input" data-empty-placeholder="${f.placeholder}">${escapeHtml(f.text || '')}</span>`).join('<span class="pd-sep">·</span>')}</p>`;

    // Summary — single editable block
    html += `<h3 class="pd-section">Profile Summary</h3>`;
    html += `<p class="pd-summary pd-editable" data-edit-path="cv.profileSummary" data-edit-as="textarea" data-empty-placeholder="(click to add a 2-3 sentence summary)">${escapeHtml(cv.profileSummary || '')}</p>`;

    // Experience — bullets keep their alternatives popover; everything
    // else (title, company, dates, location) is click-to-edit text.
    if (cv.experience?.length) {
      html += `<h3 class="pd-section">Professional Experience</h3>`;
      cv.experience.forEach((exp, ei) => {
        html += `<div class="pd-role">
          <div class="pd-role-head">
            <span>
              <span class="pd-role-title pd-editable" data-edit-path="cv.experience.${ei}.title" data-edit-as="input">${escapeHtml(exp.title || '')}</span>${
                exp.company !== undefined
                  ? ', <span class="pd-role-company pd-editable" data-edit-path="cv.experience.' + ei + '.company" data-edit-as="input" data-empty-placeholder="company">' + escapeHtml(exp.company || '') + '</span>'
                  : ''
              }
            </span>
            <span class="pd-role-dates pd-editable" data-edit-path="cv.experience.${ei}.dates" data-edit-as="input" data-empty-placeholder="dates">${escapeHtml(exp.dates || '')}</span>
          </div>`;
        html += `<div class="pd-role-loc pd-editable" data-edit-path="cv.experience.${ei}.location" data-edit-as="input" data-empty-placeholder="location">${escapeHtml(exp.location || '')}</div>`;
        (exp.bullets || []).forEach((b, bi) => {
          const key = `${ei}:${bi}`;
          // Bullets are NOT plain editable — they keep their alternatives
          // popover. We use a distinct CSS class + dataset to drive the
          // bullet-click handler instead of the generic field editor.
          html += `<div class="pd-bullet" data-key="${key}" data-ei="${ei}" data-bi="${bi}">
            <span class="pd-bullet-marker">·</span>
            <span class="pd-bullet-text">${escapeHtml(b)}</span>
            <span class="pd-bullet-toggle">▼ alternatives</span>
          </div>`;
        });
        html += `</div>`;
      });
    }

    // Skills — each line is editable (the comma-joined skills list per
    // category). Editing replaces the whole array for that category.
    if (cv.skills && typeof cv.skills === 'object' && Object.keys(cv.skills).length) {
      html += `<h3 class="pd-section">Technical Skills</h3>`;
      html += `<div class="pd-skills">`;
      for (const [cat, list] of Object.entries(cv.skills)) {
        const items = Array.isArray(list) ? list.join(', ') : String(list);
        // Editing the category name → renames the key (handled specially
        // in the editor — splits comma-list into array on save).
        html += `<p><strong class="pd-editable pd-skill-cat" data-edit-path="cv.skills" data-skill-cat="${escapeHtml(cat)}" data-edit-as="rename">${escapeHtml(cat)}</strong>: <span class="pd-editable pd-skill-list" data-edit-path="cv.skills.${escapeHtml(cat)}" data-edit-as="csv-input">${escapeHtml(items)}</span></p>`;
      }
      html += `</div>`;
    }

    // Education
    if (cv.education?.length) {
      html += `<h3 class="pd-section">Education</h3>`;
      cv.education.forEach((ed, edi) => {
        html += `<div class="pd-edu">
          <div class="pd-edu-head">
            <span>
              <span class="pd-edu-degree pd-editable" data-edit-path="cv.education.${edi}.degree" data-edit-as="input">${escapeHtml(ed.degree || '')}</span>${
                ed.school !== undefined
                  ? ', <span class="pd-edu-school pd-editable" data-edit-path="cv.education.' + edi + '.school" data-edit-as="input" data-empty-placeholder="school">' + escapeHtml(ed.school || '') + '</span>'
                  : ''
              }
            </span>
            <span class="pd-role-dates pd-editable" data-edit-path="cv.education.${edi}.dates" data-edit-as="input" data-empty-placeholder="dates">${escapeHtml(ed.dates || '')}</span>
          </div>
          <div class="pd-edu-details pd-editable" data-edit-path="cv.education.${edi}.details" data-edit-as="textarea" data-empty-placeholder="(optional details — thesis, GPA, focus area)">${escapeHtml(ed.details || '')}</div>
        </div>`;
      });
    }

    // Languages — comma-joined editable line
    if (cv.languages?.length) {
      const inline = cv.languages.map(l => typeof l === 'string' ? l : `${l.lang || ''}${l.level ? ' (' + l.level + ')' : ''}`).join(', ');
      html += `<h3 class="pd-section">Languages</h3><p class="pd-langs-line pd-editable" data-edit-path="cv.languages" data-edit-as="lang-csv-input">${escapeHtml(inline)}</p>`;
    }

    // Certifications
    if (cv.certifications?.length) {
      html += `<h3 class="pd-section">Certifications</h3><ul>`;
      cv.certifications.forEach((c, ci) => html += `<li class="pd-editable" data-edit-path="cv.certifications.${ci}" data-edit-as="input" style="color:#cbd5e1; font-size:10.5pt; margin-bottom:2px;">${escapeHtml(c)}</li>`);
      html += `</ul>`;
    }

    // Cover letter — each paragraph editable separately so you can
    // rewrite one without losing the others.
    if (cl) {
      html += `<div class="pd-cl-block"><h3 class="pd-section">Cover Letter</h3>`;
      const paragraphs = cl.split(/\n\n+/).filter(p => p.trim());
      // Each paragraph carries its index so the editor can rebuild
      // coverLetter as paragraphs.join('\n\n') on save.
      paragraphs.forEach((p, pi) => {
        html += `<p class="pd-cl-paragraph pd-editable" data-edit-path="coverLetter" data-cl-paragraph-index="${pi}" data-edit-as="textarea">${escapeHtml(p.trim())}</p>`;
      });
      html += `</div>`;
    }

    host.innerHTML = html;

    // Wire handlers — bullets get their existing alternatives popover,
    // every other .pd-editable element gets the inline-edit flow.
    host.querySelectorAll('.pd-bullet').forEach(el => {
      el.onclick = () => toggleBullet(el);
    });
    host.querySelectorAll('.pd-editable').forEach(el => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        beginInlineEdit(el);
      };
    });
  }

  // Inline-edit flow for any non-bullet field.
  //   data-edit-path        → server path to update on save
  //   data-edit-as          → 'input' | 'textarea' | 'csv-input' | 'lang-csv-input' | 'rename'
  //   data-empty-placeholder→ greyed text to show when the field is empty
  //   data-cl-paragraph-index → for cover-letter paragraphs, which one this is
  //   data-skill-cat        → for skill-category renames, the original key
  function beginInlineEdit(el) {
    if (el.classList.contains('pd-editing')) return;  // already editing
    el.classList.add('pd-editing');

    const path        = el.dataset.editPath;
    const editAs      = el.dataset.editAs || 'input';
    const placeholder = el.dataset.emptyPlaceholder || '';

    // Source value: if the element is showing an empty-placeholder,
    // start the input empty rather than with the placeholder text.
    let currentText = el.textContent === placeholder ? '' : el.textContent;
    // If the user clicked an empty-placeholder field, the textContent
    // matches placeholder visually but might also be the literal empty
    // string from the markup. Trust the data-empty marker.
    if (el.classList.contains('pd-empty')) currentText = '';

    let inputEl;
    if (editAs === 'textarea') {
      inputEl = document.createElement('textarea');
      inputEl.rows = Math.max(2, Math.min(8, currentText.split('\n').length + 1));
    } else {
      inputEl = document.createElement('input');
      inputEl.type = 'text';
    }
    inputEl.className = 'input pd-inline-input';
    inputEl.value = currentText;

    // Replace the element's content with the input
    const originalHtml = el.innerHTML;
    el.innerHTML = '';
    el.appendChild(inputEl);
    inputEl.focus();
    inputEl.select?.();

    let committed = false;
    const cleanup = () => {
      el.classList.remove('pd-editing');
      committed = true;
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      el.classList.remove('pd-editing');
      el.innerHTML = originalHtml;
    };

    const commit = async () => {
      if (committed) return;
      const newText = inputEl.value;
      // No-op if nothing changed
      if (newText === currentText) { cancel(); return; }

      cleanup();
      el.innerHTML = '<span class="pd-saving">saving…</span>';

      try {
        const value = computeValueForPath(editAs, newText, el);
        const r = await fetch(`/api/applications/${appId}/update-field`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, path, value }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'update failed');

        // Patch local appData so the next render shows the new value
        // without re-fetching the application.
        applyLocalChange(editAs, path, value, el);
        render();
      } catch (e) {
        el.innerHTML = originalHtml;
        alert('Save failed: ' + e.message);
      }
    };

    // Enter to save (single-line) or Cmd-Enter (textarea); Esc to cancel.
    inputEl.onkeydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); return; }
      if (ev.key === 'Enter') {
        if (editAs === 'textarea' && !(ev.metaKey || ev.ctrlKey)) return;  // newline
        ev.preventDefault();
        commit();
      }
    };
    inputEl.onblur = () => commit();
  }

  // Convert the user-typed string into the right shape for the
  // /update-field request body, depending on the field type.
  function computeValueForPath(editAs, newText, el) {
    // Cover letter paragraph edit — the server takes the WHOLE cover
    // letter as a single string, so we splice the new paragraph back
    // into the existing text and send the full recomposition.
    if (el.dataset.clParagraphIndex !== undefined) {
      const idx = parseInt(el.dataset.clParagraphIndex);
      const payload = getActivePayload();
      const paragraphs = (payload?.coverLetter || '').split(/\n\n+/).filter(p => p.trim());
      paragraphs[idx] = String(newText).trim();
      return paragraphs.join('\n\n');
    }

    if (editAs === 'csv-input') {
      // Skill list — comma-separated → array of trimmed strings.
      return newText.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (editAs === 'lang-csv-input') {
      // Languages: "English (C2), German (B2), Telugu (Native)" → array of {lang, level}.
      return newText.split(',').map(s => s.trim()).filter(Boolean).map(part => {
        const m = part.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
        return m ? { lang: m[1].trim(), level: m[2].trim() } : { lang: part, level: '' };
      });
    }
    if (editAs === 'rename') {
      // Skill-category rename: replace the entire skills object with
      // the renamed key. We need the original key from data-skill-cat.
      const oldKey = el.dataset.skillCat;
      const cv = getActivePayload()?.cv;
      const skills = cv?.skills || {};
      const renamed = {};
      for (const [k, v] of Object.entries(skills)) {
        renamed[k === oldKey ? newText.trim() : k] = v;
      }
      return renamed;
    }
    // Input / textarea / default — plain string
    return newText;
  }

  // Update appData in memory so the next render reflects the change.
  function applyLocalChange(editAs, path, value, el) {
    const payload = getActivePayload();
    if (!payload) return;

    // Cover letter paragraphs — special case: we update one paragraph
    // by index but the saved field is the whole coverLetter string.
    if (path === 'coverLetter' && el.dataset.clParagraphIndex !== undefined) {
      const idx = parseInt(el.dataset.clParagraphIndex);
      const paragraphs = (payload.coverLetter || '').split(/\n\n+/).filter(p => p.trim());
      paragraphs[idx] = String(value).trim();
      payload.coverLetter = paragraphs.join('\n\n');
      return;
    }

    // Generic walk for everything else
    const segments = path.split('.');
    let target = payload;
    for (let i = 0; i < segments.length - 1; i++) {
      if (target == null) return;
      target = target[segments[i]];
    }
    if (target == null) return;
    target[segments[segments.length - 1]] = value;
  }

  async function toggleBullet(el) {
    const key = el.dataset.key;
    const expanded = el.classList.contains('expanded');

    // Close any other expanded bullet first — only one open at a time
    document.querySelectorAll('.pd-bullet.expanded').forEach(other => {
      if (other !== el) {
        other.classList.remove('expanded');
        const after = other.nextElementSibling;
        if (after?.classList.contains('pd-bullet-alts')) after.remove();
      }
    });

    if (expanded) {
      // collapse this one
      el.classList.remove('expanded');
      const after = el.nextElementSibling;
      if (after?.classList.contains('pd-bullet-alts')) after.remove();
      return;
    }

    el.classList.add('expanded');
    const ei = parseInt(el.dataset.ei);
    const bi = parseInt(el.dataset.bi);
    const popover = document.createElement('div');
    popover.className = 'pd-bullet-alts';
    popover.innerHTML = '<div class="bullet-popover-loading">Loading alternatives…</div>';
    el.after(popover);

    try {
      let data = altCache.get(key);
      if (!data) {
        const r = await fetch(`/api/applications/${appId}/bullet-suggestions`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, experience_index: ei, bullet_index: bi }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Failed');
        data = await r.json();
        altCache.set(key, data);
      }
      renderAltsPopover(popover, ei, bi, data);
    } catch (e) {
      popover.innerHTML = `<div class="brain-empty">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderAltsPopover(host, ei, bi, data) {
    const apply = txt => applyBullet(ei, bi, txt);
    host.innerHTML = '';

    if (data.alternatives?.length) {
      const sec = document.createElement('div');
      sec.className = 'bullet-popover-section';
      sec.innerHTML = `<h4>Suggested rewrites</h4>`;
      data.alternatives.forEach(text => {
        const row = document.createElement('div');
        row.className = 'bullet-suggestion';
        row.innerHTML = `<div class="bs-text">${escapeHtml(text)}</div>`;
        row.onclick = () => apply(text);
        sec.appendChild(row);
      });
      host.appendChild(sec);
    }

    const past = (data.past_uses || []).slice(0, 6);
    if (past.length) {
      const sec = document.createElement('div');
      sec.className = 'bullet-popover-section';
      sec.innerHTML = `<h4>From your past CVs</h4>`;
      past.forEach(p => {
        const row = document.createElement('div');
        row.className = 'bullet-suggestion';
        row.innerHTML = `<div class="bs-text">${escapeHtml(p.text)}<div class="bs-meta">${p.applied ? '<span class="bs-applied">applied</span> · ' : ''}${escapeHtml(p.context || '')}</div></div>`;
        row.onclick = () => apply(p.text);
        sec.appendChild(row);
      });
      host.appendChild(sec);
    }

    const sec = document.createElement('div');
    sec.className = 'bullet-popover-section';
    sec.innerHTML = `<h4>Type your own</h4>
      <div class="bullet-manual-row">
        <textarea class="input" placeholder="Write the new bullet…">${escapeHtml(data.current_bullet || '')}</textarea>
        <button class="btn btn-primary">Apply</button>
      </div>`;
    const ta = sec.querySelector('textarea');
    const btn = sec.querySelector('button');
    btn.onclick = () => { const v = ta.value.trim(); if (v) apply(v); };
    host.appendChild(sec);
  }

  async function applyBullet(ei, bi, newText) {
    try {
      const r = await fetch(`/api/applications/${appId}/update-bullet`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language,
          experience_index: ei,
          bullet_index: bi,
          new_text: newText,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Update failed');
      // Optimistic local update — patch appData so the next render shows
      // the new bullet without re-fetching the application.
      const payload = getActivePayload();
      if (payload?.cv?.experience?.[ei]?.bullets) {
        payload.cv.experience[ei].bullets[bi] = newText;
      }
      altCache.delete(`${ei}:${bi}`);  // next click re-fetches alts against the new bullet
      render();
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
