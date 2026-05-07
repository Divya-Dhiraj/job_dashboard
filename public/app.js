// app.js — Dashboard frontend logic
let allJobs = [];
let currentView = 'table';
let timelineChart = null;
let refreshInterval = null;

const $ = id => document.getElementById(id);

// ─────────────────────────────
// Init
// ─────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  refreshAll();
  bindEvents();
  startAutoRefresh();
});

// Exposed for profile_ui.js to call when the active profile changes.
// Reloads the dashboard data without a full page refresh.
window.refreshAll = function refreshAll() {
  loadResume();
  loadStats();
  loadJobs();
  loadTimeline();
};
function refreshAll() { window.refreshAll(); }

// ─────────────────────────────
// Clock
// ─────────────────────────────
function startClock() {
  const tick = () => {
    const now = new Date();
    $('liveClock').textContent = now.toLocaleTimeString('en-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────
// Data Fetching
// ─────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 409) {
    // No active profile yet — the wizard is/will be open. Return an "empty"
    // shape so existing render code doesn't blow up.
    return { jobs: [], total: 0, _empty: true };
  }
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    $('totalJobs').textContent = s.total ?? '—';
    $('todayJobs').textContent = s.today ?? '—';
    $('avgScore').textContent = s.avgScore != null ? `${s.avgScore}%` : '—';
    if (s.topJob) {
      $('topMatch').textContent = `${Math.round(s.topJob.match_score)}%`;
      $('topMatchLabel').textContent = s.topJob.title.slice(0, 22) + (s.topJob.title.length > 22 ? '…' : '');
    }
    // Status dot
    const dot = $('statusDot'), txt = $('statusText');
    if (s.isScraping) {
      dot.className = 'status-dot scraping';
      txt.textContent = 'Scraping now...';
    } else if (s.lastScrapeTime) {
      dot.className = 'status-dot';
      const mins = Math.round((Date.now() - new Date(s.lastScrapeTime)) / 60000);
      txt.textContent = `Updated ${mins < 1 ? 'just now' : mins + 'm ago'}`;
    } else {
      dot.className = 'status-dot idle';
      txt.textContent = 'No scrape yet';
    }
    if (s.lastScrapeTime) {
      $('lastUpdated').textContent = 'Last updated: ' + new Date(s.lastScrapeTime).toLocaleString('en-DE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
  } catch (e) { console.error('Stats error:', e); }
}

async function loadJobs() {
  $('loader').style.display = 'flex';
  $('tableView').style.display = 'none';
  $('cardsView').style.display = 'none';
  $('emptyState').style.display = 'none';
  try {
    const minScore = $('minScore').value;
    const source   = $('sourceFilter').value;
    const search   = $('searchInput').value;
    const sortBy   = $('sortBy').value;
    const params   = new URLSearchParams({ limit: 300, minScore, ...(source && {source}), ...(search && {search}), sortBy, sortDir: sortBy === 'title' ? 'ASC' : 'DESC' });
    const data = await api(`/api/jobs?${params}`);
    allJobs = data.jobs || [];
    renderJobs(allJobs);
  } catch (e) { console.error('Jobs error:', e); }
  finally { $('loader').style.display = 'none'; }
}

async function loadTimeline() {
  try {
    const data = await api('/api/timeline');
    renderTimelineChart(data.reverse());
  } catch (e) { console.error('Timeline error:', e); }
}

async function loadResume() {
  try {
    const data = await api('/api/resume');
    const container = $('resumeSkills');
    container.innerHTML = '';
    (data.keywords || []).slice(0, 30).forEach(kw => {
      const span = document.createElement('span');
      span.className = 'skill-tag';
      span.textContent = kw;
      container.appendChild(span);
    });
    if (!data.keywords?.length) container.innerHTML = '<span class="skill-tag" style="color:var(--amber)">No skills yet — set up a profile</span>';
  } catch (e) {}
}

// ─────────────────────────────
// Render Jobs
// ─────────────────────────────
function matchClass(score) {
  if (score >= 70) return 'high';
  if (score >= 45) return 'mid';
  return 'low';
}
function badgeClass(score) {
  if (score >= 70) return 'match-high';
  if (score >= 45) return 'match-mid';
  return 'match-low';
}
function scoreColor(score) {
  if (score >= 70) return '#22c55e';
  if (score >= 45) return '#f59e0b';
  return '#ef4444';
}
function fmtDate(str) {
  if (!str) return '—';
  try { return new Date(str).toLocaleDateString('en-DE', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { return str; }
}
function fmtRelDate(str) {
  if (!str) return '—';
  try {
    const diff = Date.now() - new Date(str).getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 0) return 'Today';
    if (days === 0) return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 7) return `${days} days ago`;
    if (days < 30) return `${Math.floor(days/7)}w ago`;
    return fmtDate(str);
  } catch { return str; }
}
function fmtApplicants(n) {
  if (!n || n === 0) return '—';
  if (n >= 1000) return `${(n/1000).toFixed(1)}k`;
  return String(n);
}

function renderJobs(jobs) {
  $('jobCount').textContent = jobs.length;
  if (!jobs.length) {
    $('emptyState').style.display = 'flex';
    return;
  }
  if (currentView === 'table') renderTable(jobs);
  else renderCards(jobs);
}

function renderTable(jobs) {
  const tbody = $('jobsTableBody');
  tbody.innerHTML = '';
  jobs.forEach(job => {
    const score = Math.round(job.match_score || 0);
    const tr = document.createElement('tr');
    const applyHref = safeUrl(job.apply_url, job);
    const hasUrl = job.apply_url && (job.apply_url.startsWith('http://') || job.apply_url.startsWith('https://'));
    const applicants = job.applicants || 0;
    tr.innerHTML = `
      <td>
        <div class="match-badge ${badgeClass(score)}" title="Click for breakdown" onclick="event.stopPropagation(); openMatchExplain('${esc(job.id)}', ${score})">${score}%</div>
      </td>
      <td class="job-title-cell">${esc(job.title)}</td>
      <td class="job-company-cell">${esc(job.company || '—')}</td>
      <td class="job-loc-cell">${esc(job.location || '—')}</td>
      <td class="job-posted-cell" title="${esc(fmtDate(job.posted_at))}">${fmtRelDate(job.posted_at)}</td>
      <td class="job-applicants-cell">${applicants > 0 ? `<span class="applicants-badge${applicants > 100 ? ' hot' : ''}">${fmtApplicants(applicants)}</span>` : '<span style="color:var(--text-faint)">—</span>'}</td>
      <td><span class="source-badge source-${(job.source||'').toLowerCase().replace(/\s+/g,'-')}">${esc(job.source)}</span></td>
      <td>
        <button class="apply-now-btn${hasUrl ? '' : ' fallback'}" data-jobid="${esc(job.id)}" onclick="event.stopPropagation(); openApplyDialog('${esc(job.id)}')">${hasUrl ? 'Apply Now' : 'Search'}</button>
      </td>
    `;
    tr.addEventListener('click', () => openModal(job));
    tbody.appendChild(tr);
  });
  $('tableView').style.display = 'block';
}

function renderCards(jobs) {
  const grid = $('cardsView');
  grid.innerHTML = '';
  jobs.forEach(job => {
    const score = Math.round(job.match_score || 0);
    const skills = (job.matched_skills || []).slice(0, 6);
    const hasUrl = job.apply_url && (job.apply_url.startsWith('http://') || job.apply_url.startsWith('https://'));
    const card = document.createElement('div');
    card.className = `job-card ${matchClass(score)}`;
    card.innerHTML = `
      <div class="job-card-header">
        <span class="job-card-title">${esc(job.title)}</span>
        <div class="match-badge ${badgeClass(score)}" style="width:42px;height:42px;font-size:11px;">${score}%</div>
      </div>
      <div class="job-card-meta">
        <span>🏢 ${esc(job.company || '—')}</span>
        <span>📍 ${esc(job.location || '—')}</span>
        <span>🗓️ ${fmtRelDate(job.posted_at)}${job.applicants > 0 ? ` · 👥 ${fmtApplicants(job.applicants)} applicants` : ''}</span>
      </div>
      <p class="job-card-desc">${esc(job.description || 'No description available.')}</p>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px;">
        ${skills.map(s => `<span class="skill-tag">${esc(s)}</span>`).join('')}
      </div>
      <div class="job-card-footer">
        <span style="font-size:11px;color:var(--text-faint)">${esc(job.source)} · ${fmtDate(job.scraped_at)}</span>
        <button class="apply-now-btn${hasUrl ? '' : ' fallback'}" data-jobid="${esc(job.id)}" onclick="event.stopPropagation(); openApplyDialog('${esc(job.id)}')">${hasUrl ? 'Apply Now' : 'Search'}</button>
      </div>
    `;
    card.addEventListener('click', () => openModal(job));
    grid.appendChild(card);
  });
  $('cardsView').style.display = 'grid';
}

// ─────────────────────────────
// Modal
// ─────────────────────────────
function openModal(job) {
  const score = Math.round(job.match_score || 0);
  $('modalTitle').textContent = job.title;
  const applicantsTxt = job.applicants > 0 ? `&nbsp;|&nbsp; 👥 ${fmtApplicants(job.applicants)} applicants` : '';
  $('modalMeta').innerHTML = `
    🏢 <strong>${esc(job.company || '—')}</strong> &nbsp;|&nbsp;
    📍 ${esc(job.location || '—')}
    ${job.salary ? `&nbsp;|&nbsp; 💰 ${esc(job.salary)}` : ''}
    <br>🗓️ Posted: ${fmtDate(job.posted_at)} (${fmtRelDate(job.posted_at)})${applicantsTxt} &nbsp;|&nbsp; Source: ${esc(job.source)}
    ${job.apply_url ? `<br>🔗 <a href="${esc(job.apply_url)}" target="_blank" rel="noopener">${esc(job.apply_url).slice(0, 60)}…</a>` : ''}
  `;
  $('modalScore').style.background = `radial-gradient(circle, ${scoreColor(score)}, ${scoreColor(score)}aa)`;
  $('modalScore').innerHTML = `<span>${score}%</span><span style="font-size:10px;font-weight:500;margin-top:2px;">Match</span>`;
  const skills = Array.isArray(job.matched_skills) ? job.matched_skills : [];
  $('modalSkills').innerHTML = skills.length
    ? skills.map(s => `<span class="modal-skill">${esc(s)}</span>`).join('')
    : '<span style="color:var(--text-faint);font-size:13px;">No matching skills detected</span>';
  $('modalDesc').textContent = job.description || 'No description available.';
  const hasApplyUrl = job.apply_url && (job.apply_url.startsWith('http://') || job.apply_url.startsWith('https://'));
  const applyBtn = $('modalApply');
  applyBtn.href = '#';
  applyBtn.textContent = hasApplyUrl ? 'Apply Now →' : 'Search on Google →';
  applyBtn.className = hasApplyUrl ? 'btn btn-apply btn-lg' : 'btn btn-primary btn-lg';
  applyBtn.onclick = (e) => { e.preventDefault(); closeModal(); openApplyDialog(job.id); };
  $('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  $('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ─────────────────────────────
// Chart
// ─────────────────────────────
function renderTimelineChart(data) {
  const ctx = document.getElementById('timelineChart').getContext('2d');
  if (timelineChart) timelineChart.destroy();
  timelineChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.day),
      datasets: [{
        label: 'Jobs Found',
        data: data.map(d => d.count),
        backgroundColor: 'rgba(99,102,241,0.6)',
        borderColor: '#6366f1',
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#475569', font: { size: 10 } }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#475569', font: { size: 10 } }, grid: { color: '#1e293b' } },
      }
    }
  });
}

// ─────────────────────────────
// Auto Refresh
// ─────────────────────────────
function startAutoRefresh() {
  refreshInterval = setInterval(async () => {
    await loadStats();
    await loadJobs();
  }, 60000); // every 60 seconds
}

// ─────────────────────────────
// Events
// ─────────────────────────────
function bindEvents() {
  // Scrape button
  $('scrapeBtn').addEventListener('click', async () => {
    $('scrapeBtn').disabled = true;
    $('scrapeBtn').textContent = '⏳ Scraping...';
    try {
      await api('/api/scrape', { method: 'POST' });
      showToast('🚀 Scrape started! Results will appear in a few minutes.');
      setTimeout(() => { loadStats(); loadJobs(); }, 5000);
    } catch (e) { showToast('❌ ' + e.message, true); }
    finally {
      setTimeout(() => { $('scrapeBtn').disabled = false; $('scrapeBtn').textContent = '⚡ Scrape Now'; }, 10000);
    }
  });
  $('scrapeNowEmpty')?.addEventListener('click', () => $('scrapeBtn').click());

  // Test email
  $('testEmailBtn').addEventListener('click', async () => {
    try {
      const res = await api('/api/test-email', { method: 'POST' });
      showToast('📧 ' + res.message);
    } catch (e) { showToast('❌ ' + e.message, true); }
  });

  // Filters
  ['searchInput', 'sourceFilter', 'sortBy'].forEach(id => {
    $(id).addEventListener('input', debounce(loadJobs, 400));
  });
  $('minScore').addEventListener('input', e => {
    $('minScoreVal').textContent = `${e.target.value}%`;
    debounce(loadJobs, 300)();
  });
  $('resetFilters').addEventListener('click', () => {
    $('searchInput').value = '';
    $('sourceFilter').value = '';
    $('minScore').value = 0;
    $('minScoreVal').textContent = '0%';
    $('sortBy').value = 'posted_at';
    loadJobs();
  });

  // View toggle
  $('viewTable').addEventListener('click', () => {
    currentView = 'table';
    $('viewTable').classList.add('active'); $('viewCards').classList.remove('active');
    $('tableView').style.display = 'block'; $('cardsView').style.display = 'none';
  });
  $('viewCards').addEventListener('click', () => {
    currentView = 'cards';
    $('viewCards').classList.add('active'); $('viewTable').classList.remove('active');
    $('tableView').style.display = 'none';
    renderCards(allJobs);
  });

  // Modal
  $('modalClose').addEventListener('click', closeModal);
  $('modalOverlay').addEventListener('click', e => { if (e.target === $('modalOverlay')) closeModal(); });
  // Apply Dialog
  $('applyDialogClose').addEventListener('click', closeApplyDialog);
  $('applyDialogOverlay').addEventListener('click', e => { if (e.target === $('applyDialogOverlay')) closeApplyDialog(); });
  $('applyDialogYes').addEventListener('click', handleGenerate);
  $('applyDialogNo').addEventListener('click', handleJustApply);

  // Preview Modal
  $('previewClose').addEventListener('click', closePreviewModal);
  $('previewOverlay').addEventListener('click', e => { if (e.target === $('previewOverlay')) closePreviewModal(); });
  $('editCvBtn').addEventListener('click', () => handleEdit('cv'));
  $('editClBtn').addEventListener('click', () => handleEdit('coverLetter'));
  $('previewAppliedCheck').addEventListener('change', e => handleMarkApplied(e.target.checked));
  $('previewOpenLocal').addEventListener('click', handleOpenFolder);
  $('editCvInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleEdit('cv'); });
  $('editClInput').addEventListener('keydown', e => { if (e.key === 'Enter') handleEdit('coverLetter'); });

  // Tracker
  $('myAppsBtn').addEventListener('click', openTracker);
  $('trackerCloseBtn').addEventListener('click', closeTracker);
  $('exportExcelBtn').addEventListener('click', exportExcel);

  // Escape key closes all modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      closeApplyDialog();
      closePreviewModal();
      closeTracker();
    }
  });
}

// ─────────────────────────────
// Apply Dialog
// ─────────────────────────────
let applyDialogJob = null;

function openApplyDialog(jobId) {
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;
  applyDialogJob = job;

  $('applyDialogJob').innerHTML = `
    <div class="adl">Role</div><div class="adv">${esc(job.title)}</div>
    <div class="adl">Company</div><div class="adv">${esc(job.company || '—')}</div>
    <div class="adl">Location</div><div class="adv">${esc(job.location || '—')}</div>
    <div class="adl">Match Score</div><div class="adv">${Math.round(job.match_score || 0)}%</div>
  `;
  $('applyDialogOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  // If the user has multiple resumes on file, surface the picker dropdown.
  // Default selection is "" → backend auto-picks the best match. Single-
  // resume profiles never see this row (it stays hidden).
  populateResumePicker();
}

async function populateResumePicker() {
  const row = $('applyDialogResumeRow');
  const sel = $('applyDialogResume');
  if (!row || !sel) return;
  try {
    const r = await fetch('/api/resumes', { credentials: 'same-origin' });
    if (!r.ok) { row.style.display = 'none'; return; }
    const { resumes = [] } = await r.json();
    if (resumes.length <= 1) { row.style.display = 'none'; return; }
    sel.innerHTML = '<option value="">Auto-pick (recommended)</option>' +
      resumes.map(rs => `<option value="${rs.id}">${esc(rs.label)}${rs.is_default ? ' (default)' : ''}</option>`).join('');
    row.style.display = '';
  } catch {
    row.style.display = 'none';
  }
}

function closeApplyDialog() {
  $('applyDialogOverlay').classList.remove('open');
  document.body.style.overflow = '';
  applyDialogJob = null;
}

async function handleGenerate() {
  if (!applyDialogJob) return;
  const job = applyDialogJob;
  closeApplyDialog();

  // Show generating spinner
  $('generatingOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    // Read the language radio (en | de | both). Defaults to 'en' so users
    // who don't touch the radio get the original behaviour.
    const langRadio = document.querySelector('input[name="applyDialogLang"]:checked');
    const language  = langRadio ? langRadio.value : 'en';
    // resumeId="" → backend auto-picks best match. Otherwise the user
    // chose a specific resume from the picker dropdown.
    const resumeSel = $('applyDialogResume');
    const resumeId  = resumeSel && resumeSel.value ? +resumeSel.value : null;
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, language, resumeId }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Generation failed');
    }
    const data = await res.json();
    $('generatingOverlay').classList.remove('open');
    openPreviewModal(data.id, job);
    const resumeNote = data.resume_used
      ? ` Used ${data.resume_used.auto ? 'auto-picked' : 'selected'} resume "${data.resume_used.label}".`
      : '';
    showToast(`CV and Cover Letter generated.${resumeNote}`);
  } catch (err) {
    $('generatingOverlay').classList.remove('open');
    document.body.style.overflow = '';
    showToast('Generation failed: ' + err.message, true);
  }
}

function handleJustApply() {
  if (!applyDialogJob) return;
  const url = safeUrl(applyDialogJob.apply_url, applyDialogJob);
  window.open(url, '_blank');
  closeApplyDialog();
}

// ─────────────────────────────
// Preview Modal
// ─────────────────────────────
let currentAppId = null;
let currentAppJob = null;
let currentAppLang = 'en';
let currentAppLanguagesAvailable = ['en'];

async function openPreviewModal(appId, job) {
  currentAppId = appId;
  currentAppJob = job;
  // Expose to other modules (bullet_editor_ui) so they don't need to
  // duplicate the modal-state lookup.
  window.currentAppId = appId;

  // Wire "🔍 Match Details" → opens the explainer scoped to this app.
  // Bind once via dataset flag to avoid stacking handlers if openPreviewModal
  // runs multiple times in a session.
  const matchBtn = $('previewMatchBtn');
  if (matchBtn && !matchBtn.dataset.bound) {
    matchBtn.onclick = () => {
      if (typeof window.openAppMatchExplain === 'function') {
        window.openAppMatchExplain(currentAppId, currentAppLang);
      }
    };
    matchBtn.dataset.bound = '1';
  }

  $('previewTitle').textContent = 'Application Preview';
  $('previewMeta').textContent = `${job?.title || ''} at ${job?.company || ''}`;
  $('previewApplyLink').href = safeUrl(job?.apply_url, job);
  $('previewAppliedCheck').checked = false;

  // Pull the application detail (without re-fetching the PDFs) to learn
  // which languages exist on disk. This drives the language tab UI.
  try {
    const detail = await fetch(`/api/applications/${appId}`, { credentials: 'same-origin' }).then(r => r.json());
    currentAppLanguagesAvailable = detail.languages_available || ['en'];
    currentAppLang = detail.primary_language || currentAppLanguagesAvailable[0] || 'en';
  } catch {
    currentAppLanguagesAvailable = ['en'];
    currentAppLang = 'en';
  }
  renderLangTabs();

  // Load PDFs in iframes — language-aware via ?lang=…
  loadPreviewPdfs();

  // Render the structured Draft view (default tab in the preview modal).
  // The draft view fetches generated.json and renders it as HTML with
  // clickable bullets; toggling to "📄 PDF" shows the iframe pair.
  if (typeof window.renderDraftView === 'function') {
    window.renderDraftView(currentAppId, currentAppLang);
  }

  $('editCvInput').value = '';
  $('editClInput').value = '';

  $('previewOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

// Re-render the language tabs above the preview panes. Shows the available
// languages as buttons and a "Translate to other →" button when only one
// language exists. Tab clicks switch the iframe `src` without re-fetching
// the application detail.
function renderLangTabs() {
  const host = $('previewLangTabs');
  if (!host) return;
  host.innerHTML = '';
  const labelFor = code => ({ en: '🇬🇧 English', de: '🇩🇪 German' })[code] || code;

  for (const code of currentAppLanguagesAvailable) {
    const btn = document.createElement('button');
    btn.className = 'lang-tab' + (code === currentAppLang ? ' active' : '');
    btn.textContent = labelFor(code);
    btn.onclick = () => {
      currentAppLang = code;
      renderLangTabs();
      loadPreviewPdfs();
      if (typeof window.draftViewSetLanguage === 'function') window.draftViewSetLanguage(code);
    };
    host.appendChild(btn);
  }

  // If only one language exists, offer to translate to the other.
  if (currentAppLanguagesAvailable.length === 1) {
    const have = currentAppLanguagesAvailable[0];
    const other = have === 'en' ? 'de' : 'en';
    const btn = document.createElement('button');
    btn.className = 'lang-tab';
    btn.textContent = `+ ${labelFor(other)}`;
    btn.title = `Generate the ${labelFor(other)} version (translates the existing one — no new Claude generation)`;
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = `Translating to ${labelFor(other)}…`;
      try {
        const r = await fetch(`/api/applications/${currentAppId}/translate`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_language: other }),
        });
        if (!r.ok) throw new Error((await r.json()).error || 'Translation failed');
        currentAppLanguagesAvailable.push(other);
        currentAppLang = other;
        renderLangTabs();
        loadPreviewPdfs();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = `+ ${labelFor(other)}`;
        showToast('Translation failed: ' + e.message, true);
      }
    };
    host.appendChild(btn);
  }
}

function loadPreviewPdfs() {
  const ts = Date.now();
  const lang = encodeURIComponent(currentAppLang);
  $('previewCvFrame').src = `/api/applications/${currentAppId}/preview/cv?t=${ts}&lang=${lang}`;
  $('previewClFrame').src = `/api/applications/${currentAppId}/preview/cover-letter?t=${ts}&lang=${lang}`;
  window.currentAppLang = currentAppLang;  // bullet editor reads this
}
// Exposed for bullet_editor_ui.js to reload the iframes after a bullet edit.
window.loadPreviewPdfs = loadPreviewPdfs;

function closePreviewModal() {
  $('previewOverlay').classList.remove('open');
  document.body.style.overflow = '';
  currentAppId = null;
  currentAppJob = null;
}

async function handleEdit(target) {
  const inputId = target === 'cv' ? 'editCvInput' : 'editClInput';
  const instruction = $(inputId).value.trim();
  if (!instruction) { showToast('Please enter an edit instruction.', true); return; }
  if (!currentAppId) return;

  const btn = target === 'cv' ? $('editCvBtn') : $('editClBtn');
  const origText = btn.textContent;
  btn.textContent = 'Regenerating...';
  btn.disabled = true;

  try {
    const res = await fetch(`/api/applications/${currentAppId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, instruction }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Edit failed');
    }
    const result = await res.json().catch(() => ({}));

    // Reload the active-language PDF so the user sees the edit applied.
    loadPreviewPdfs();
    $(inputId).value = '';
    // Surface what actually changed — Claude is asked to declare its scope
    // so the user can verify the edit wasn't broader than intended.
    const changes = Array.isArray(result.changes) ? result.changes : [];
    if (changes.length > 0) {
      const summary = changes.length === 1
        ? changes[0]
        : `${changes.length} changes: ${changes.slice(0, 3).join(' · ')}${changes.length > 3 ? ' …' : ''}`;
      showToast(`${target === 'cv' ? 'CV' : 'Cover Letter'} updated — ${summary}`);
    } else {
      showToast(`${target === 'cv' ? 'CV' : 'Cover Letter'} updated.`);
    }
  } catch (err) {
    showToast('Edit failed: ' + err.message, true);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

async function handleMarkApplied(checked) {
  if (!currentAppId) return;
  if (checked) {
    try {
      await fetch(`/api/applications/${currentAppId}/apply`, { method: 'POST' });
      showToast('Marked as applied!');
    } catch (err) { showToast('Error: ' + err.message, true); }
  }
}

async function handleOpenFolder() {
  if (!currentAppId) return;
  try {
    const res = await api(`/api/applications/${currentAppId}/open`);
    showToast('Folder: ' + res.folderPath);
  } catch (err) { showToast('Error: ' + err.message, true); }
}

// ─────────────────────────────
// Applications Tracker
// ─────────────────────────────
async function openTracker() {
  $('trackerOverlay').style.display = 'block';
  document.body.style.overflow = 'hidden';
  await loadApplications();
}

function closeTracker() {
  $('trackerOverlay').style.display = 'none';
  document.body.style.overflow = '';
}

async function loadApplications() {
  try {
    const apps = await api('/api/applications');
    renderTracker(apps);
  } catch (err) { console.error('Applications error:', err); }
}

function renderTracker(apps) {
  $('trackerCount').textContent = `${apps.length} application${apps.length !== 1 ? 's' : ''} tracked`;
  const tbody = $('trackerBody');
  tbody.innerHTML = '';

  if (!apps.length) {
    $('trackerEmpty').style.display = 'block';
    return;
  }
  $('trackerEmpty').style.display = 'none';

  apps.forEach(app => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;">${esc(app.company || '—')}</td>
      <td>${esc(app.role || '—')}</td>
      <td style="color:var(--text-faint);font-size:12px;">${esc(app.location || '—')}</td>
      <td><div class="match-badge ${badgeClass(Math.round(app.match_score||0))}" style="width:36px;height:36px;font-size:10px;">${Math.round(app.match_score||0)}%</div></td>
      <td><span class="status-pill status-${(app.status||'generated').toLowerCase()}">${esc(app.status || 'generated')}</span></td>
      <td><input type="checkbox" class="tracker-check" ${app.applied ? 'checked' : ''} onchange="handleTrackerApply(${app.id}, this.checked)" /></td>
      <td style="font-size:12px;color:var(--text-muted);">${fmtDate(app.created_at)}</td>
      <td><button class="btn btn-ghost" style="padding:4px 10px;font-size:12px;" onclick="event.stopPropagation(); viewApplication(${app.id})">View</button></td>
    `;
    tr.addEventListener('click', () => viewApplication(app.id));
    tbody.appendChild(tr);
  });
}

async function viewApplication(appId) {
  try {
    const app = await api(`/api/applications/${appId}`);
    const job = {
      id: app.job_id, title: app.role, company: app.company,
      location: app.location, apply_url: app.job_url, description: app.job_description,
    };
    openPreviewModal(appId, job);
  } catch (err) { showToast('Error: ' + err.message, true); }
}

async function handleTrackerApply(appId, checked) {
  if (checked) {
    try { await fetch(`/api/applications/${appId}/apply`, { method: 'POST' }); showToast('Marked as applied!'); }
    catch (err) { showToast('Error: ' + err.message, true); }
  }
  await loadApplications();
}

async function exportExcel() {
  window.open('/api/applications/export', '_blank');
}

// ─────────────────────────────
// Utils
// ─────────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Ensures a URL is safe to use as an href — falls back to Google search
function safeUrl(raw, job) {
  const url = String(raw || '').trim();
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) return url;
  if (url && url.startsWith('//')) return `https:${url}`;
  // Fallback: Google search for the job
  const q = encodeURIComponent(`${job?.title || ''} ${job?.company || ''} jobs apply`);
  return `https://www.google.com/search?q=${q}`;
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimeout;
function showToast(msg, isError = false) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '24px', right: '24px', zIndex: '9999',
      background: isError ? '#450a0a' : '#0f172a',
      border: `1px solid ${isError ? '#ef4444' : '#6366f1'}`,
      color: isError ? '#fca5a5' : '#f1f5f9',
      padding: '12px 20px', borderRadius: '10px', fontSize: '14px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)', transition: 'opacity 0.3s',
      maxWidth: '360px',
    });
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.style.opacity = '0'; }, 4000);
}
