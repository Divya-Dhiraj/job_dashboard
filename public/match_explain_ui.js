// match_explain_ui.js — "Why N%?" modal.
//
// Triggered by clicking any match badge in the job table. Pulls structured
// match data from /api/jobs/:jobId/match-explain (Claude-analysed, cached
// per job) and renders four sections:
//
//   1. Summary — one-sentence overall fit
//   2. Requirements — for each JD requirement, which CV bullets/skills support it
//   3. Skill matches — explicit overlap between candidate's skills and JD
//   4. Gaps — must-have requirements the resume doesn't cover
//
// "🔄 Refresh" button forces a re-analysis (ignores the cache).

(function() {
  const $ = id => document.getElementById(id);
  // Two modes:
  //   - mode='job'  → /api/jobs/:jobId/match-explain (resume vs JD), opened from the job-table badge
  //   - mode='app'  → /api/applications/:appId/match-explain (resume OR generated CV vs JD), opened from the preview modal
  // The state below covers both.
  let activeJobId = null;
  let activeAppId = null;
  let activeMode  = 'job';
  let activeScore = null;
  let activeSource = 'resume';   // 'resume' | 'cv' — only meaningful in app mode
  let activeLang  = 'en';

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
    if ($('matchExplainClose')) $('matchExplainClose').onclick = () => hide($('matchExplainOverlay'));
    if ($('matchExplainRefresh')) $('matchExplainRefresh').onclick = () => load(true);
  }

  // Job-table badge entrypoint — compares the candidate's resume to the JD.
  window.openMatchExplain = function(jobId, score) {
    activeMode    = 'job';
    activeJobId   = jobId;
    activeAppId   = null;
    activeScore   = score;
    activeSource  = 'resume';
    $('matchExplainTitle').textContent = `Why ${score || '?'}%?`;
    $('matchExplainMeta').textContent = '';
    $('matchExplainBody').innerHTML = '<div class="bullet-popover-loading">Analysing the JD against your resume…</div>';
    show($('matchExplainOverlay'));
    load(false);
  };

  // Preview-modal entrypoint — defaults to the generated CV side, with a
  // toggle to flip back to the raw resume comparison. Lets the user see
  // BEFORE (resume) vs AFTER (tailored CV) coverage of JD requirements.
  window.openAppMatchExplain = function(appId, lang) {
    activeMode    = 'app';
    activeAppId   = appId;
    activeJobId   = null;
    activeScore   = null;
    activeSource  = 'cv';
    activeLang    = lang || 'en';
    $('matchExplainTitle').textContent = 'Match details';
    $('matchExplainMeta').textContent = '';
    $('matchExplainBody').innerHTML = '<div class="bullet-popover-loading">Analysing the tailored CV against the JD…</div>';
    show($('matchExplainOverlay'));
    load(false);
  };

  async function load(force) {
    let url;
    if (activeMode === 'app') {
      if (!activeAppId) return;
      const params = new URLSearchParams({ source: activeSource, lang: activeLang });
      if (force) params.set('refresh', '1');
      url = `/api/applications/${activeAppId}/match-explain?${params}`;
    } else {
      if (!activeJobId) return;
      url = `/api/jobs/${encodeURIComponent(activeJobId)}/match-explain` + (force ? '?refresh=1' : '');
    }
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json()).error || r.statusText);
      const data = await r.json();
      render(data);
    } catch (e) {
      $('matchExplainBody').innerHTML = `<div class="brain-empty">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function render(data) {
    const job = data.job || {};
    $('matchExplainTitle').textContent = activeMode === 'app'
      ? `Match details — ${job.title || ''}${job.company ? ' @ ' + job.company : ''}`
      : `Why ${Math.round(job.match_score || activeScore || 0)}% — ${job.title || ''}${job.company ? ' @ ' + job.company : ''}`;
    const cacheNote = data._cached_at ? `Cached analysis · use 🔄 to re-run` : 'Fresh analysis';
    const sourceNote = activeMode === 'app'
      ? (activeSource === 'cv' ? '· comparing your <strong>tailored CV</strong> to the JD' : '· comparing your <strong>raw resume</strong> to the JD')
      : '';
    $('matchExplainMeta').innerHTML = `${cacheNote} ${sourceNote}`;

    const body = $('matchExplainBody');
    body.innerHTML = '';

    // ⚠️ Important: build the rest of the content as ONE HTML string and
    // insert it via insertAdjacentHTML AFTER appending the tab buttons as
    // a real DOM node. Using `body.innerHTML += '...'` here would re-parse
    // the entire body and destroy the click handlers on the tab buttons,
    // which is exactly the bug that made the tabs feel "not working".
    const sections = [];

    // 1. Summary
    if (data.summary) {
      sections.push(`<div class="me-section"><div class="me-summary">${escapeHtml(data.summary)}</div></div>`);
    }

    // 2. Requirements with supporting evidence
    if (data.requirements?.length) {
      const reqsHtml = data.requirements.map(req => {
        const conf = typeof req.confidence === 'number' ? req.confidence : 0;
        const confClass = conf >= 0.7 ? 'high' : conf >= 0.4 ? 'mid' : 'low';
        const cat = (req.category || '').toLowerCase();
        const catClass = cat.includes('must') ? 'must' : cat.includes('nice') ? 'nice' : cat.includes('soft') ? 'soft' : '';
        const supports = req.supported_by || [];
        const supportHtml = supports.length
          ? `<ul>${supports.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
          : `<div class="me-empty">No clear support in the ${activeSource === 'cv' ? 'tailored CV' : 'resume'} — possible gap.</div>`;
        return `
          <div class="me-req">
            <div class="me-req-head">
              <span class="me-req-text"><span class="me-req-cat ${catClass}">${escapeHtml(req.category || 'requirement')}</span>${escapeHtml(req.text)}</span>
              <span class="me-req-conf ${confClass}">${Math.round(conf * 100)}%</span>
            </div>
            ${supportHtml}
          </div>`;
      }).join('');
      sections.push(`<div class="me-section"><h3>Requirements ↔ Your ${activeSource === 'cv' ? 'CV' : 'Resume'}</h3>${reqsHtml}</div>`);
    }

    // 3. Skill matches
    if (data.skill_matches?.length) {
      const chips = data.skill_matches.map(m => `
        <span class="me-skill ${escapeHtml(m.weight || 'exact')}" title="${escapeHtml(m.weight || '')} match">
          <strong>${escapeHtml(m.cv_skill)}</strong>
          <span class="me-skill-arrow">→</span>
          ${escapeHtml(m.jd_phrase)}
        </span>`).join('');
      sections.push(`<div class="me-section"><h3>Skill matches (your ${activeSource === 'cv' ? 'tailored CV' : 'resume'} ↔ JD phrasing)</h3><div class="me-skill-grid">${chips}</div></div>`);
    }

    // 4. Gaps
    if (data.gaps?.length) {
      const chips = data.gaps.map(g => `<span class="me-gap">${escapeHtml(g)}</span>`).join('');
      sections.push(`<div class="me-section"><h3>Gaps (worth addressing in cover letter)</h3>${chips}</div>`);
    }

    if (!data.requirements?.length && !data.skill_matches?.length) {
      sections.push('<div class="brain-empty">Claude returned no structured data.</div>');
    }

    // Source toggle (app mode only): "Resume" vs "Tailored CV"
    // Append the tab DOM node FIRST so the rest of the body renders below it.
    if (activeMode === 'app') {
      const tabs = document.createElement('div');
      tabs.className = 'me-source-tabs';
      tabs.innerHTML = `
        <button type="button" class="me-source-tab ${activeSource === 'resume' ? 'active' : ''}" data-src="resume">📄 Your resume vs JD</button>
        <button type="button" class="me-source-tab ${activeSource === 'cv' ? 'active' : ''}" data-src="cv">✨ Tailored CV vs JD</button>`;
      tabs.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
          if (btn.dataset.src === activeSource) return;     // already on this tab
          activeSource = btn.dataset.src;
          $('matchExplainBody').innerHTML = '<div class="bullet-popover-loading">Analysing…</div>';
          load(false);
        });
      });
      body.appendChild(tabs);
    }

    // Now insert the analysis HTML AFTER the tabs without going through
    // body.innerHTML+= — insertAdjacentHTML does NOT touch existing children
    // so the tab buttons keep their event listeners.
    if (sections.length) {
      body.insertAdjacentHTML('beforeend', sections.join(''));
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
