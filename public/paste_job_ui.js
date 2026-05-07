// paste_job_ui.js — Paste-a-Job flow.
// Lightweight: opens the modal, sends pasted JD to the server, the server
// scores it + analyses the company via brain.analyzeJobAndCompany, stores
// it under the active profile so it shows up in the dashboard table next
// to scraped jobs. The user can then click "Generate" exactly like a
// scraped job.
//
// We don't try to do live web search here — Claude analyses the pasted
// JD text only. If the user wants real-time company info, they should
// paste it into the JD area or extend this with an Apify web-fetch later.

(function() {
  const $ = id => document.getElementById(id);

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
    const btn = $('pasteJobBtn');
    if (btn) btn.onclick = openModal;
    if ($('pasteJobClose'))  $('pasteJobClose').onclick  = () => hide($('pasteJobOverlay'));
    if ($('pasteJobCancel')) $('pasteJobCancel').onclick = () => hide($('pasteJobOverlay'));
    if ($('pasteJobSubmit')) $('pasteJobSubmit').onclick = handleSubmit;
    // Bilingual JD viewer: tab switches between original textarea and the
    // translated one; "🌐 Translate" calls /api/translate.
    document.querySelectorAll('.pj-jd-tab').forEach(tab => {
      tab.onclick = () => activateJdTab(tab.dataset.jdTab);
    });
    if ($('pjJdTranslateBtn')) $('pjJdTranslateBtn').onclick = handleTranslateJd;
  }

  function activateJdTab(name) {
    document.querySelectorAll('.pj-jd-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.jdTab === name);
    });
    // The "Original" tab shows the raw paste textarea; the "Translation" tab
    // shows the auto-translated readonly textarea.
    $('pjRawText').style.display                = (name === 'original')   ? '' : 'none';
    $('pjDescriptionTranslated').style.display  = (name === 'translated') ? '' : 'none';
  }

  async function handleTranslateJd() {
    // Prefer the raw paste; fall back to the override description if the user
    // already clicked into Advanced and filled in the cleaned JD.
    const text = ($('pjRawText').value || $('pjDescription').value || '').trim();
    if (!text) {
      alert('Paste a JD first.');
      return;
    }
    const btn = $('pjJdTranslateBtn');
    btn.disabled = true; btn.textContent = '🌐 Translating…';
    try {
      // Heuristic: if the input looks German (common German words), translate
      // to English; otherwise to German. Handles both directions of paste.
      const looksGerman = /\b(der|die|das|und|für|sind|werden|wir|Sie|Ihre|nicht|haben|mit)\b/i.test(text);
      const target = looksGerman ? 'en' : 'de';
      const r = await fetch('/api/translate', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target_language: target }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Translation failed');
      const data = await r.json();
      $('pjDescriptionTranslated').value = data.translated || '';
      $('pjJdTabTranslated').style.display = '';
      $('pjJdTabTranslated').textContent = target === 'en' ? '🇬🇧 English' : '🇩🇪 German';
      activateJdTab('translated');
    } catch (e) {
      alert('Translation failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🌐 Translate';
    }
  }

  function openModal() {
    // Reset previous state. We don't auto-clear the textarea so the user
    // doesn't lose a paste when they close + reopen the modal.
    $('pjResult').className = 'paste-job-result';
    $('pjResult').textContent = '';
    show($('pasteJobOverlay'));
    // Focus the raw-text textarea so the user can immediately Cmd-V.
    setTimeout(() => $('pjRawText').focus(), 100);
  }

  async function handleSubmit() {
    // Primary input: the big textarea where the user pasted the whole page.
    // Optional overrides: the advanced-fields section (hidden by default).
    const raw_text    = $('pjRawText').value.trim();
    const title       = $('pjTitle').value.trim();
    const company     = $('pjCompany').value.trim();
    const location    = $('pjLocation').value.trim();
    const apply_url   = $('pjApplyUrl').value.trim();
    const description = $('pjDescription').value.trim();
    const out = $('pjResult');

    // Either raw text OR a complete manual fill-in is required.
    if (!raw_text && !(title && description)) {
      out.className = 'paste-job-result err';
      out.textContent = 'Paste the job description (or expand "advanced fields" to fill in title + description manually).';
      return;
    }

    const btn = $('pasteJobSubmit');
    btn.disabled = true;
    out.className = 'paste-job-result busy';
    out.textContent = raw_text
      ? 'Parsing the paste with Claude (extracting title, company, location, URL, and clean JD)…'
      : 'Analysing the JD with Claude (extracting company / skills)…';

    try {
      // Send everything; the server will use Claude's parse for any field
      // not explicitly overridden by the advanced-fields section.
      const body = { raw_text, title, company, location, description, apply_url };
      const r = await fetch('/api/jobs/manual', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 401) { window.location.replace('/login.html'); return; }
      const data = await r.json();
      if (!r.ok) {
        out.className = 'paste-job-result err';
        out.textContent = data.error || 'Failed to store job.';
        return;
      }
      out.className = 'paste-job-result ok';
      // Show what Claude extracted so the user can verify (or tweak the
      // advanced fields and re-submit if something looks wrong).
      const j = data.job || {};
      const score = j.match_score || 0;
      const parsedSummary = data.parsed
        ? `Parsed: <strong>${escapeHtml(j.title)}</strong> at <strong>${escapeHtml(j.company || '?')}</strong>${j.location ? ' · ' + escapeHtml(j.location) : ''}${j.apply_url ? ' · <a href="' + j.apply_url + '" target="_blank" rel="noopener">apply link</a>' : ''}.`
        : '';
      out.innerHTML = `✓ Stored. ${parsedSummary} Match score <strong>${score}%</strong>. ${data.message || ''} Click ⚡ Apply on the job in the table to generate.`;

      // Refresh the dashboard table so the new row appears
      if (typeof window.refreshAll === 'function') window.refreshAll();
    } catch (e) {
      out.className = 'paste-job-result err';
      out.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
