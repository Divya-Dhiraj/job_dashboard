// profile_ui.js — Account menu, Settings modal, and the post-signup setup
// wizard. Loads after the auth gate has already redirected unauthenticated
// users away. By the time this runs, /api/auth/me is expected to succeed.
//
// Responsibilities:
//   - Render the profile chip in the header (avatar, name, sign-out menu)
//   - Open the Settings modal (per-profile fields + shared API keys)
//   - If the logged-in profile is "incomplete" (no resume_text, no skills),
//     auto-open the setup wizard so the user can finish onboarding
//   - Provide window.ProfileUI for app.js + brain_ui.js to call

(function() {
  const $ = (id) => document.getElementById(id);

  // ───── State ─────
  let countries = [];
  let presets = [];
  let parsedProfile = null;     // staged from upload-resume, before save
  let parsedAllowed = ['de'];
  let parsedLanguages = [];     // [{lang, level}, ...]
  let parsedTemplates = [];     // [{id, name, description}, ...]
  let parsedTemplate = 'modern_single';
  let parsedVisibility = {};    // field key → bool
  let me = null;                // current logged-in profile

  const ProfileUI = {
    init,
    refresh: refreshMe,
    openWizard,
    openSettings,
    getActive: () => me,
  };
  window.ProfileUI = ProfileUI;

  async function init() {
    bindUI();
    await loadSettingsMeta();
    const ok = await refreshMe();
    if (!ok) return;  // auth gate will have redirected
    if (isProfileIncomplete(me)) {
      // First time on the dashboard after signup → run setup wizard.
      openWizard();
    }
  }

  function isProfileIncomplete(profile) {
    if (!profile) return true;
    return !profile.resume_text || Object.keys(profile.skill_groups || {}).length === 0;
  }

  async function loadSettingsMeta() {
    try {
      const data = await api('/api/settings');
      countries = data.countries || [];
      presets   = data.presets   || [];
      $('hintAnthropic').textContent = data.env_fallbacks?.anthropic_api_key ? '(env fallback available)' : '';
      $('hintApify').textContent     = data.env_fallbacks?.apify_token       ? '(env fallback available)' : '';
      $('hintResend').textContent    = data.env_fallbacks?.resend_api_key    ? '(env fallback available)' : '';
    } catch (e) { console.warn('[ProfileUI] settings meta load failed:', e); }
    try {
      const t = await api('/api/templates');
      parsedTemplates = t.templates || [];
    } catch (e) { console.warn('[ProfileUI] templates load failed:', e); }
  }

  // Default visibility for the "include in CV" toggles. AGG-sensitive
  // fields default OFF; standard contact / professional fields default ON.
  function defaultVisibility() {
    return {
      name: true, email: true, phone: true, address: true, linkedin: true,
      dob: false, place_of_birth: false, nationality: false, marital_status: false,
      photo: true, languages: true,
    };
  }

  async function refreshMe() {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!r.ok) {
        window.location.replace('/login.html');
        return false;
      }
      const { profile } = await r.json();
      me = profile;
      renderBadge();
      refreshLinkedInChip();
      return true;
    } catch (e) {
      console.warn('[ProfileUI] /me failed:', e);
      return false;
    }
  }

  // Header chip showing whether scraping uses cookie-based auth or anonymous.
  // Lives in #liChip — added to index.html. Refreshed on /me and after Settings
  // save (because the cookie field lives in the Settings modal).
  async function refreshLinkedInChip() {
    const chip = $('liChip');
    if (!chip) return;
    try {
      const s = await api('/api/profile/linkedin-status');
      if (!s.cookie_set) {
        chip.className = 'li-chip';
        chip.textContent = '🔗 LinkedIn: anonymous';
        chip.title = 'No cookie set — using public scraper. Add your li_at cookie in Settings to scrape as you.';
      } else if (!s.format_valid) {
        chip.className = 'li-chip invalid';
        chip.textContent = '🔗 LinkedIn: cookie format invalid';
        chip.title = `Cookie length ${s.cookie_length} chars, starts "${s.cookie_starts_with}". Re-copy from Chrome DevTools.`;
      } else {
        chip.className = 'li-chip authenticated';
        chip.textContent = '🔗 LinkedIn: authenticated';
        chip.title = `Using ${s.actor_id} with your li_at cookie. Click Settings → Test connection to verify live.`;
      }
    } catch (e) {
      chip.className = 'li-chip';
      chip.textContent = '🔗 LinkedIn: ?';
    }
  }

  function renderBadge() {
    const initial = (me?.name || me?.username || '?')[0].toUpperCase();
    $('profileName').textContent = me?.name || me?.username || '—';
    $('profileSub').textContent  = me?.username ? '@' + me.username : '';
    $('profileAvatar').textContent = initial;
  }

  // ─────────────────────────────
  // UI bindings
  // ─────────────────────────────
  function bindUI() {
    $('profileBtn').onclick = (e) => {
      e.stopPropagation();
      $('profileMenu').classList.toggle('open');
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#profileSwitcher')) closeMenu();
    });
    $('profileMenuSettings').onclick = () => { closeMenu(); openSettings(); };
    $('profileMenuLogout').onclick   = () => { closeMenu(); handleLogout(); };

    // Wizard modal
    if ($('wizardClose')) $('wizardClose').onclick = () => hide($('wizardOverlay'));
    bindDropzone();
    if ($('wizardUploadBtn')) $('wizardUploadBtn').onclick = handleUpload;
    document.querySelectorAll('[data-wizard-next]').forEach(btn => {
      btn.onclick = () => stepTo(parseInt(btn.dataset.wizardNext));
    });
    document.querySelectorAll('[data-wizard-back]').forEach(btn => {
      btn.onclick = () => stepTo(parseInt(btn.dataset.wizardBack));
    });
    if ($('wizardSaveBtn')) $('wizardSaveBtn').onclick = handleSaveProfile;

    // Settings modal
    if ($('settingsClose'))  $('settingsClose').onclick  = () => hide($('settingsOverlay'));
    if ($('settingsCancel')) $('settingsCancel').onclick = () => hide($('settingsOverlay'));
    if ($('settingsSave'))   $('settingsSave').onclick   = handleSaveSettings;
    if ($('peDelete'))       $('peDelete').onclick       = handleDeleteProfile;
  }

  function closeMenu() { $('profileMenu').classList.remove('open'); }
  // The base CSS for .modal-overlay starts at opacity:0, pointer-events:none
  // and only becomes interactive when the .open class is present. The
  // initial inline `style="display:none"` is to keep the modal off the layout
  // before any JS runs; we strip that on first show so the .open class can
  // do its job.
  function show(el) {
    if (!el) return;
    el.style.display = '';        // clear inline display:none from HTML
    requestAnimationFrame(() => el.classList.add('open'));  // RAF lets the transition animate
  }
  function hide(el) {
    if (!el) return;
    el.classList.remove('open');
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.replace('/login.html');
    }
  }

  // ─────────────────────────────
  // Setup wizard (post-signup)
  // ─────────────────────────────
  function openWizard() {
    // Seed state from the logged-in profile if it already has anything saved
    parsedProfile    = null;
    parsedAllowed    = me?.allowed_country_codes?.length ? me.allowed_country_codes : ['de'];
    parsedLanguages  = (me?.languages_cefr?.length ? me.languages_cefr : [{ lang: 'English', level: 'C1' }]).slice();
    parsedTemplate   = me?.cv_template || 'modern_single';
    parsedVisibility = Object.keys(me?.cv_field_visibility || {}).length
      ? { ...defaultVisibility(), ...me.cv_field_visibility }
      : defaultVisibility();

    if ($('cvFileInput')) $('cvFileInput').value = '';
    if ($('wizardUploadBtn')) $('wizardUploadBtn').disabled = true;
    if ($('wizardUploadNote')) $('wizardUploadNote').textContent = '';
    // Pre-populate fields from the existing profile so a returning user
    // doesn't lose what they already entered.
    if (me) prefillFromProfile(me);

    stepTo(1);
    show($('wizardOverlay'));
  }

  function stepTo(n) {
    document.querySelectorAll('.wizard-step-body').forEach(b => {
      b.style.display = (parseInt(b.dataset.step) === n) ? 'block' : 'none';
    });
    document.querySelectorAll('.wizard-step').forEach(s => {
      const sn = parseInt(s.dataset.step);
      s.classList.toggle('active', sn === n);
      s.classList.toggle('done', sn < n);
    });
    // Per-step renderers
    if (n === 3) renderLanguagesEditor();
    if (n === 4) renderPhotoStep();
    if (n === 5) renderTemplatePicker();
    if (n === 6) renderCountryPickers('countryGrid', 'presetRow', parsedAllowed, (codes) => { parsedAllowed = codes; });
    if (n === 8) renderSummary();
  }

  function prefillFromProfile(p) {
    if ($('wzName'))     $('wzName').value     = p.name     || '';
    if ($('wzEmail'))    $('wzEmail').value    = p.email    || '';
    if ($('wzPhone'))    $('wzPhone').value    = p.phone    || '';
    if ($('wzAddress'))  $('wzAddress').value  = p.address  || '';
    if ($('wzLinkedin')) $('wzLinkedin').value = p.linkedin || '';
    if ($('wzDob'))            $('wzDob').value            = p.dob || '';
    if ($('wzPlaceOfBirth'))   $('wzPlaceOfBirth').value   = p.place_of_birth || '';
    if ($('wzNationality'))    $('wzNationality').value    = p.nationality || '';
    if ($('wzMaritalStatus'))  $('wzMaritalStatus').value  = p.marital_status || '';
    if ($('wzNotifyEmail'))    $('wzNotifyEmail').value    = p.notify_email || '';
    if ($('wzSearchTitles'))   $('wzSearchTitles').value   = (p.search_titles || []).join(', ');
    if ($('wzSkillGroups'))    $('wzSkillGroups').value    = JSON.stringify(p.skill_groups || {}, null, 2);
    // Visibility checkboxes
    document.querySelectorAll('.incl-toggle input[data-vis]').forEach(cb => {
      const k = cb.dataset.vis;
      cb.checked = parsedVisibility[k] !== false;
      cb.onchange = () => { parsedVisibility[k] = cb.checked; };
    });
  }

  function renderLanguagesEditor() {
    const list = $('wzLangList');
    if (!list) return;
    list.innerHTML = '';
    parsedLanguages.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'lang-row';
      row.innerHTML = `
        <input class="input" placeholder="Language (e.g. German)" value="${escapeHtml(entry.lang || '')}"/>
        <select class="input lang-level-sel">
          ${['Native','C2','C1','B2','B1','A2','A1'].map(l => `<option ${entry.level === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button type="button" class="lang-remove" title="Remove">×</button>`;
      const [langIn, levelSel] = row.querySelectorAll('input, select');
      langIn.oninput  = () => { parsedLanguages[i].lang  = langIn.value; };
      levelSel.onchange = () => { parsedLanguages[i].level = levelSel.value; };
      row.querySelector('.lang-remove').onclick = () => {
        parsedLanguages.splice(i, 1);
        renderLanguagesEditor();
      };
      list.appendChild(row);
    });
    if (!$('wzLangAdd').dataset.bound) {
      $('wzLangAdd').onclick = () => {
        parsedLanguages.push({ lang: '', level: 'B2' });
        renderLanguagesEditor();
      };
      $('wzLangAdd').dataset.bound = '1';
    }
  }

  let pickedPhotoFile = null;
  function renderPhotoStep() {
    const preview = $('wzPhotoPreview');
    const clearBtn = $('wzPhotoClearBtn');
    const input = $('wzPhotoInput');
    const pickBtn = $('wzPhotoPickBtn');
    if (!preview) return;

    function showPlaceholder() {
      preview.innerHTML = '<span class="photo-placeholder">No photo</span>';
      clearBtn.style.display = 'none';
    }
    function showImg(src) {
      preview.innerHTML = '';
      const img = document.createElement('img'); img.src = src;
      preview.appendChild(img);
      clearBtn.style.display = '';
    }

    // If profile already has a photo on the server, show it
    if (me?.photo_path && !pickedPhotoFile) {
      showImg('/api/profile/photo?ts=' + Date.now());
    } else if (pickedPhotoFile) {
      const r = new FileReader();
      r.onload = () => showImg(r.result);
      r.readAsDataURL(pickedPhotoFile);
    } else {
      showPlaceholder();
    }

    pickBtn.onclick = () => input.click();
    input.onchange = (e) => {
      pickedPhotoFile = e.target.files?.[0] || null;
      renderPhotoStep();
    };
    clearBtn.onclick = async () => {
      pickedPhotoFile = null;
      try {
        await api('/api/profile/photo', { method: 'DELETE' });
        await refreshMe();
      } catch {}
      renderPhotoStep();
    };
  }

  function renderTemplatePicker() {
    const list = $('wzTemplateList');
    if (!list) return;
    list.innerHTML = '';
    for (const t of parsedTemplates) {
      const card = document.createElement('div');
      card.className = 'template-card' + (t.id === parsedTemplate ? ' selected' : '');
      card.innerHTML = `
        <span class="tc-radio"></span>
        <div class="tc-body">
          <div class="tc-name">${escapeHtml(t.name)}</div>
          <div class="tc-desc">${escapeHtml(t.description || '')}</div>
        </div>`;
      card.onclick = () => {
        parsedTemplate = t.id;
        renderTemplatePicker();
      };
      list.appendChild(card);
    }
  }

  function bindDropzone() {
    const dz = $('cvDropzone');
    if (!dz) return;
    const input = $('cvFileInput');
    dz.onclick = () => input.click();
    input.onchange = (e) => onFilePicked(e.target.files[0]);
    ;['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('dragover');
    }));
    ;['dragleave','drop'].forEach(ev => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('dragover');
    }));
    dz.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files?.[0];
      if (f) onFilePicked(f);
    });
  }

  let pickedFile = null;
  function onFilePicked(file) {
    if (!file) return;
    pickedFile = file;
    $('wizardUploadNote').textContent = `Picked: ${file.name} (${Math.round(file.size/1024)} KB)`;
    $('wizardUploadBtn').disabled = false;
  }

  async function handleUpload() {
    if (!pickedFile) return;
    $('wizardUploadBtn').disabled = true;
    $('wizardUploadNote').textContent = 'Parsing — Claude is reading your CV…';
    try {
      const fd = new FormData();
      fd.append('resume', pickedFile);
      fd.append('allowed_country_codes', JSON.stringify(parsedAllowed));
      const res = await fetch('/api/profiles/upload-resume', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const { profile } = await res.json();
      parsedProfile = profile;
      fillReviewForm(profile);
      stepTo(2);
    } catch (e) {
      $('wizardUploadNote').textContent = 'Failed: ' + e.message + ' — make sure your Anthropic key is set in Settings, then retry.';
      $('wizardUploadBtn').disabled = false;
    }
  }

  function fillReviewForm(p) {
    $('wzName').value     = p.name     || me?.name || '';
    $('wzEmail').value    = p.email    || '';
    $('wzPhone').value    = p.phone    || '';
    $('wzAddress').value  = p.address  || '';
    $('wzLinkedin').value = p.linkedin || '';
    $('wzSearchTitles').value = (p.search_titles || []).join(', ');
    $('wzSkillGroups').value  = JSON.stringify(p.skill_groups || {}, null, 2);
  }

  // readReviewForm pulls every editable wizard field into a single object,
  // ready to PUT to /api/profiles/:id. Includes the German-specific fields
  // (DOB, place of birth, nationality, marital status). Visibility toggles,
  // languages, and template are stitched in by handleSaveProfile.
  function readReviewForm2() {
    let skill_groups = {};
    try { skill_groups = JSON.parse($('wzSkillGroups').value || '{}'); }
    catch (e) { alert('Skill groups JSON is invalid: ' + e.message); throw e; }
    return {
      ...(parsedProfile || {}),
      name:           $('wzName').value.trim(),
      email:          $('wzEmail').value.trim(),
      phone:          $('wzPhone').value.trim(),
      address:        $('wzAddress').value.trim(),
      linkedin:       $('wzLinkedin').value.trim(),
      dob:            $('wzDob').value.trim(),
      place_of_birth: $('wzPlaceOfBirth').value.trim(),
      nationality:    $('wzNationality').value.trim(),
      marital_status: $('wzMaritalStatus').value.trim(),
      search_titles:  $('wzSearchTitles').value.split(',').map(s => s.trim()).filter(Boolean),
      skill_groups,
    };
  }

  function renderSummary() {
    let p;
    try { p = readReviewForm2(); } catch { return; }
    parsedProfile = p;
    const cc = parsedAllowed.map(c => (countries.find(x => x.code === c)?.name || c)).join(', ');
    const tplName = parsedTemplates.find(t => t.id === parsedTemplate)?.name || parsedTemplate;
    const langs = parsedLanguages.filter(l => l.lang).map(l => `${l.lang} (${l.level})`).join(', ') || 'none';
    const visOff = Object.entries(parsedVisibility).filter(([, v]) => v === false).map(([k]) => k);
    $('wizardSummary').innerHTML = `
      <strong>${escapeHtml(p.name || '?')}</strong> &middot; ${escapeHtml(p.email || '')}<br/>
      <span>Search titles:</span> ${escapeHtml((p.search_titles || []).join(', ') || 'none')}<br/>
      <span>Languages:</span> ${escapeHtml(langs)}<br/>
      <span>Template:</span> ${escapeHtml(tplName)}<br/>
      <span>Allowed countries:</span> ${escapeHtml(cc)}<br/>
      <span>Skill groups:</span> ${Object.keys(p.skill_groups || {}).length} categories<br/>
      <span>Photo:</span> ${pickedPhotoFile ? 'will be uploaded' : (me?.photo_path ? 'already on file' : 'none')}<br/>
      <span>Hidden CV fields:</span> ${visOff.length ? escapeHtml(visOff.join(', ')) : 'none'}
    `;
  }

  // Save flow: PUT the logged-in profile (auth signup already created it).
  async function handleSaveProfile() {
    let p;
    try { p = readReviewForm2(); } catch { return; }
    p.allowed_country_codes = parsedAllowed.length ? parsedAllowed : ['de'];
    p.notify_email          = $('wzNotifyEmail').value.trim();
    p.languages_cefr        = parsedLanguages.filter(l => l.lang);
    p.cv_template           = parsedTemplate;
    p.cv_field_visibility   = parsedVisibility;
    // Per-profile API key overrides
    const ak = $('wzAnthropicKey').value.trim(); if (ak) p.anthropic_key_override = ak;
    const pk = $('wzApifyKey').value.trim();     if (pk) p.apify_token_override   = pk;
    const ok = $('wzOpenAIKey').value.trim();    if (ok) p.openai_key_override    = ok;
    const rk = $('wzResendKey').value.trim();    if (rk) p.resend_key_override    = rk;

    try {
      // 1. Upload photo first (so the next-step PUT sees the path saved)
      if (pickedPhotoFile) {
        const fd = new FormData();
        fd.append('photo', pickedPhotoFile);
        await fetch('/api/profile/photo', { method: 'POST', body: fd, credentials: 'same-origin' });
      }
      // 2. Save the profile fields
      await api(`/api/profiles/${me.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      hide($('wizardOverlay'));
      pickedPhotoFile = null;
      await refreshMe();
      if (typeof window.refreshAll === 'function') window.refreshAll();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }

  // ─────────────────────────────
  // Country picker (shared between wizard step 3 + settings)
  // ─────────────────────────────
  function renderCountryPickers(gridId, presetId, currentCodes, onChange) {
    const codes = new Set(currentCodes);
    const grid = $(gridId);
    if (!grid) return;
    grid.innerHTML = '';
    for (const c of countries) {
      const id = `${gridId}-${c.code}`;
      const wrap = document.createElement('label');
      wrap.className = 'country-checkbox';
      wrap.innerHTML = `<input type="checkbox" id="${id}" value="${c.code}" ${codes.has(c.code) ? 'checked' : ''}/> <span>${escapeHtml(c.name)} <span style="color:#64748b">(${c.code})</span></span>`;
      const input = wrap.querySelector('input');
      input.onchange = () => {
        if (input.checked) codes.add(c.code); else codes.delete(c.code);
        onChange([...codes]);
      };
      grid.appendChild(wrap);
    }
    if (presetId) {
      const row = $(presetId);
      if (!row) return;
      row.innerHTML = '';
      for (const p of presets) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'preset-chip';
        chip.textContent = p.label;
        chip.onclick = () => {
          codes.clear(); p.codes.forEach(c => codes.add(c));
          onChange([...codes]);
          grid.querySelectorAll('input').forEach(i => i.checked = codes.has(i.value));
        };
        row.appendChild(chip);
      }
    }
  }

  // ─────────────────────────────
  // Settings modal (logged-in user's own profile + shared API keys)
  // ─────────────────────────────
  async function openSettings() {
    show($('settingsOverlay'));
    try {
      const data = await api('/api/settings');
      $('setAnthropic').value = '';
      $('setApify').value     = '';
      $('setResend').value    = '';
      $('setFrom').value      = '';
      if ($('setOpenAI')) $('setOpenAI').value = '';
      $('setMinScore').value  = data.settings.min_match_score      || 30;
      $('setInterval').value  = data.settings.scrape_interval_hours || 1;
      // cron_enabled: stored as string 'true'/'false'; default true if unset.
      if ($('setCronEnabled')) {
        $('setCronEnabled').checked = (data.settings.cron_enabled ?? 'true') !== 'false';
      }
      // Actor IDs — show what's currently set so the user can see the
      // active value (or empty if using defaults).
      if ($('setLinkedInActorPublic')) $('setLinkedInActorPublic').value = data.settings.linkedin_actor_public_id || '';
      if ($('setLinkedInActorAuth'))   $('setLinkedInActorAuth').value   = data.settings.linkedin_actor_auth_id   || '';
      if ($('setIndeedActor'))         $('setIndeedActor').value         = data.settings.indeed_actor_id         || '';
    } catch (e) { console.warn(e); }

    if (!me) return;
    const r = await api(`/api/profiles/${me.id}`);
    const prof = r.profile;
    $('profileEditName').textContent = `(${prof.name})`;

    // Standard contact
    $('peName').value     = prof.name     || '';
    $('peEmail').value    = prof.email    || '';
    $('pePhone').value    = prof.phone    || '';
    $('peAddress').value  = prof.address  || '';
    $('peLinkedin').value = prof.linkedin || '';
    $('peNotify').value   = prof.notify_email || '';

    // German personal data
    $('peDob').value            = prof.dob || '';
    $('pePlaceOfBirth').value   = prof.place_of_birth || '';
    $('peNationality').value    = prof.nationality || '';
    $('peMaritalStatus').value  = prof.marital_status || '';

    // Per-profile API key overrides — shown blank but server keeps existing
    // values unless we send a new one (we never send blanks back).
    $('peAnthropicKey').value = '';
    $('peApifyKey').value     = '';
    $('peOpenAIKey').value    = '';
    $('peResendKey').value    = '';
    // LinkedIn cookie: pre-fill so user sees what's saved (it's effectively
    // sensitive but already in the DB; reading it back makes "is it saved?"
    // verifiable). User can edit or clear it to revert to anonymous mode.
    if ($('peLinkedInCookie')) $('peLinkedInCookie').value = prof.linkedin_cookie_override || '';
    // Wire the live-test button. We bind once via dataset.bound to avoid
    // stacking handlers each time Settings opens.
    if ($('peLinkedInTestBtn') && !$('peLinkedInTestBtn').dataset.bound) {
      $('peLinkedInTestBtn').onclick = handleLinkedInTest;
      $('peLinkedInTestBtn').dataset.bound = '1';
    }
    if ($('peLinkedInTestResult')) $('peLinkedInTestResult').textContent = '';

    $('peSearchTitles').value = (prof.search_titles || []).join(', ');

    // Languages with CEFR
    settingsLanguages = (prof.languages_cefr || []).slice();
    renderSettingsLanguages();
    if (!$('peLangAdd').dataset.bound) {
      $('peLangAdd').onclick = () => {
        settingsLanguages.push({ lang: '', level: 'B2' });
        renderSettingsLanguages();
      };
      $('peLangAdd').dataset.bound = '1';
    }

    // Photo preview
    settingsPickedPhoto = null;
    renderSettingsPhoto(prof);

    // Template chooser
    settingsTemplate = prof.cv_template || 'modern_single';
    renderSettingsTemplate();

    // Visibility toggles
    settingsVisibility = Object.keys(prof.cv_field_visibility || {}).length
      ? { ...defaultVisibility(), ...prof.cv_field_visibility }
      : defaultVisibility();
    renderSettingsVisibility();

    // Countries
    let peCodes = [...(prof.allowed_country_codes || ['de'])];
    renderCountryPickers('peCountryGrid', null, peCodes, (codes) => { peCodes = codes; });

    // "Edit full profile in setup wizard" button
    if ($('peOpenWizard') && !$('peOpenWizard').dataset.bound) {
      $('peOpenWizard').onclick = () => {
        hide($('settingsOverlay'));
        openWizard();
      };
      $('peOpenWizard').dataset.bound = '1';
    }

    // Resume controls — show length + bind upload + populate textarea
    initResumeControls(prof);

    $('peDelete').style.display = '';
  }

  // ─────────────────────────────
  // Settings sub-renderers (languages, photo, template, visibility)
  // ─────────────────────────────
  let settingsLanguages = [];
  let settingsPickedPhoto = null;
  let settingsTemplate = 'modern_single';
  let settingsVisibility = {};

  function renderSettingsLanguages() {
    const list = $('peLangList');
    if (!list) return;
    list.innerHTML = '';
    settingsLanguages.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'lang-row';
      row.innerHTML = `
        <input class="input" placeholder="Language (e.g. German)" value="${escapeHtml(entry.lang || '')}"/>
        <select class="input lang-level-sel">
          ${['Native','C2','C1','B2','B1','A2','A1'].map(l => `<option ${entry.level === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button type="button" class="lang-remove" title="Remove">×</button>`;
      const [langIn, levelSel] = row.querySelectorAll('input, select');
      langIn.oninput  = () => { settingsLanguages[i].lang  = langIn.value; };
      levelSel.onchange = () => { settingsLanguages[i].level = levelSel.value; };
      row.querySelector('.lang-remove').onclick = () => {
        settingsLanguages.splice(i, 1);
        renderSettingsLanguages();
      };
      list.appendChild(row);
    });
  }

  function renderSettingsPhoto(prof) {
    const preview  = $('pePhotoPreview');
    const clearBtn = $('pePhotoClearBtn');
    const pickBtn  = $('pePhotoPickBtn');
    const input    = $('pePhotoInput');
    if (!preview) return;

    function showPlaceholder() {
      preview.innerHTML = '<span class="photo-placeholder">No photo</span>';
      clearBtn.style.display = 'none';
    }
    function showImg(src) {
      preview.innerHTML = '';
      const img = document.createElement('img'); img.src = src;
      preview.appendChild(img);
      clearBtn.style.display = '';
    }

    if (prof?.photo_path && !settingsPickedPhoto) {
      showImg('/api/profile/photo?ts=' + Date.now());
    } else if (settingsPickedPhoto) {
      const r = new FileReader();
      r.onload = () => showImg(r.result);
      r.readAsDataURL(settingsPickedPhoto);
    } else {
      showPlaceholder();
    }

    if (!pickBtn.dataset.bound) {
      pickBtn.onclick = () => input.click();
      input.onchange = (e) => {
        settingsPickedPhoto = e.target.files?.[0] || null;
        renderSettingsPhoto(prof);
      };
      clearBtn.onclick = async () => {
        settingsPickedPhoto = null;
        try { await api('/api/profile/photo', { method: 'DELETE' }); } catch {}
        await refreshMe();
        renderSettingsPhoto(me);
      };
      pickBtn.dataset.bound = '1';
    }
  }

  function renderSettingsTemplate() {
    const list = $('peTemplateList');
    if (!list) return;
    list.innerHTML = '';
    for (const t of parsedTemplates) {
      const card = document.createElement('div');
      card.className = 'template-card' + (t.id === settingsTemplate ? ' selected' : '');
      card.innerHTML = `
        <span class="tc-radio"></span>
        <div class="tc-body">
          <div class="tc-name">${escapeHtml(t.name)}</div>
          <div class="tc-desc">${escapeHtml(t.description || '')}</div>
        </div>`;
      card.onclick = () => {
        settingsTemplate = t.id;
        renderSettingsTemplate();
      };
      list.appendChild(card);
    }
  }

  // Resume controls in Settings — direct replace via file upload, plus
  // an inline textarea for small text-level tweaks. Uploading a file
  // hits /api/profiles/upload-resume which parses with Claude and
  // returns a fresh profile shape; we then PUT that to the profile so
  // skills + search_titles + contact info stay in sync.
  function initResumeControls(prof) {
    const fileBtn   = $('peResumeUploadBtn');
    const fileInput = $('peResumeFile');
    const status    = $('peResumeStatus');
    const meta      = $('peResumeMeta');
    const textarea  = $('peResumeText');
    if (!fileBtn) return;

    // Show what's currently saved
    const len = (prof.resume_text || '').length;
    if (meta) meta.textContent = len ? `(${len.toLocaleString()} characters saved)` : '(no resume saved yet)';
    if (textarea) textarea.value = prof.resume_text || '';
    if (status) { status.textContent = ''; status.className = 'resume-status'; }

    if (!fileBtn.dataset.bound) {
      fileBtn.onclick = () => fileInput.click();
      fileInput.onchange = async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        status.className = 'resume-status busy';
        status.textContent = `Parsing ${f.name} (${Math.round(f.size/1024)} KB) with Claude…`;
        try {
          const fd = new FormData();
          fd.append('resume', f);
          // Reuse the existing upload-resume endpoint — returns the same
          // shape we use during signup. Since this is post-signup, we
          // PUT the parsed fields onto the existing profile rather than
          // creating a new one.
          const r = await fetch('/api/profiles/upload-resume', { method: 'POST', body: fd, credentials: 'same-origin' });
          if (!r.ok) throw new Error((await r.json()).error || r.statusText);
          const { profile: parsed } = await r.json();
          // Persist to the logged-in profile. We send the whole parsed
          // payload so skills + search_titles + contact info refresh
          // alongside the resume text.
          await api(`/api/profiles/${me.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              resume_text: parsed.resume_text,
              skill_groups: parsed.skill_groups,
              search_titles: parsed.search_titles,
              target_titles: parsed.target_titles,
              // Only fill contact fields if the existing profile lacks them
              // — don't clobber a manually-entered phone/address.
              ...(prof.email    ? {} : { email:    parsed.email    }),
              ...(prof.phone    ? {} : { phone:    parsed.phone    }),
              ...(prof.address  ? {} : { address:  parsed.address  }),
              ...(prof.linkedin ? {} : { linkedin: parsed.linkedin }),
            }),
          });
          status.className = 'resume-status ok';
          status.textContent = `✓ Replaced. ${parsed.resume_text.length.toLocaleString()} characters parsed; ${Object.keys(parsed.skill_groups || {}).length} skill groups inferred.`;
          // Refresh the form values from the new profile so the textarea
          // reflects the just-uploaded resume.
          await refreshMe();
          if (textarea) textarea.value = parsed.resume_text || '';
          if (meta) meta.textContent = `(${(parsed.resume_text || '').length.toLocaleString()} characters saved)`;
          if (typeof window.refreshAll === 'function') window.refreshAll();
        } catch (err) {
          status.className = 'resume-status err';
          status.textContent = '✗ ' + err.message + ' — make sure your Anthropic key is set.';
        } finally {
          fileInput.value = '';   // allow re-selecting the same file
        }
      };
      fileBtn.dataset.bound = '1';
    }
  }

  function renderSettingsVisibility() {
    const grid = $('peVisibility');
    if (!grid) return;
    grid.innerHTML = '';
    const keys = ['name', 'email', 'phone', 'address', 'linkedin', 'dob', 'place_of_birth', 'nationality', 'marital_status', 'photo', 'languages'];
    const labels = {
      name: 'Name', email: 'Email', phone: 'Phone', address: 'Location', linkedin: 'LinkedIn',
      dob: 'Date of birth', place_of_birth: 'Place of birth', nationality: 'Nationality',
      marital_status: 'Marital status', photo: 'Photo', languages: 'Languages section',
    };
    for (const k of keys) {
      const wrap = document.createElement('label');
      const isOn = settingsVisibility[k] !== false;
      wrap.innerHTML = `<input type="checkbox" ${isOn ? 'checked' : ''} data-vis-key="${k}"/> ${labels[k]}`;
      const cb = wrap.querySelector('input');
      cb.onchange = () => { settingsVisibility[k] = cb.checked; };
      grid.appendChild(wrap);
    }
  }

  async function handleSaveSettings() {
    const settings = {};
    if ($('setAnthropic').value.trim()) settings.anthropic_api_key   = $('setAnthropic').value.trim();
    if ($('setApify').value.trim())     settings.apify_token         = $('setApify').value.trim();
    if ($('setResend').value.trim())    settings.resend_api_key      = $('setResend').value.trim();
    if ($('setFrom').value.trim())      settings.from_email          = $('setFrom').value.trim();
    if ($('setOpenAI') && $('setOpenAI').value.trim()) settings.openai_api_key = $('setOpenAI').value.trim();
    if ($('setMinScore').value)         settings.min_match_score     = $('setMinScore').value;
    if ($('setInterval').value)         settings.scrape_interval_hours = $('setInterval').value;
    if ($('setCronEnabled')) settings.cron_enabled = $('setCronEnabled').checked ? 'true' : 'false';
    // Actor ID overrides — empty input = revert to defaults (clear the column).
    if ($('setLinkedInActorPublic')) settings.linkedin_actor_public_id = $('setLinkedInActorPublic').value.trim();
    if ($('setLinkedInActorAuth'))   settings.linkedin_actor_auth_id   = $('setLinkedInActorAuth').value.trim();
    if ($('setIndeedActor'))         settings.indeed_actor_id          = $('setIndeedActor').value.trim();

    try {
      if (Object.keys(settings).length) {
        await api('/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });
      }

      if (me) {
        // Photo first so the profile row picks up its new photo_path.
        if (settingsPickedPhoto) {
          const fd = new FormData();
          fd.append('photo', settingsPickedPhoto);
          await fetch('/api/profile/photo', { method: 'POST', body: fd, credentials: 'same-origin' });
          settingsPickedPhoto = null;
        }

        const peCodes = [...$('peCountryGrid').querySelectorAll('input:checked')].map(i => i.value);
        const updates = {
          name:     $('peName').value.trim(),
          email:    $('peEmail').value.trim(),
          phone:    $('pePhone').value.trim(),
          address:  $('peAddress').value.trim(),
          linkedin: $('peLinkedin').value.trim(),
          notify_email:   $('peNotify').value.trim(),
          // Inline resume edit — saved with the rest of the profile.
          // Empty string means "keep existing" because the textarea
          // pre-populates from the saved value; we only override if
          // the user actually typed something different.
          ...(($('peResumeText') && $('peResumeText').value !== (me?.resume_text || ''))
              ? { resume_text: $('peResumeText').value }
              : {}),
          // German personal data
          dob:            $('peDob').value.trim(),
          place_of_birth: $('pePlaceOfBirth').value.trim(),
          nationality:    $('peNationality').value.trim(),
          marital_status: $('peMaritalStatus').value.trim(),
          // Languages, template, visibility
          languages_cefr:       settingsLanguages.filter(l => l.lang),
          cv_template:          settingsTemplate,
          cv_field_visibility:  settingsVisibility,
          // Search + countries
          search_titles:        $('peSearchTitles').value.split(',').map(s => s.trim()).filter(Boolean),
          allowed_country_codes: peCodes.length ? peCodes : ['de'],
        };
        // Per-profile API key overrides — only send when the user typed
        // something. Empty inputs leave existing values untouched server-side.
        const ak = $('peAnthropicKey').value.trim(); if (ak) updates.anthropic_key_override = ak;
        const pk = $('peApifyKey').value.trim();     if (pk) updates.apify_token_override   = pk;
        const ok = $('peOpenAIKey').value.trim();    if (ok) updates.openai_key_override    = ok;
        const rk = $('peResendKey').value.trim();    if (rk) updates.resend_key_override    = rk;
        // LinkedIn cookie — ALWAYS send (so the user can clear it explicitly
        // to revert to anonymous scraping). Empty string clears the column.
        if ($('peLinkedInCookie')) {
          updates.linkedin_cookie_override = $('peLinkedInCookie').value.trim();
        }

        await api(`/api/profiles/${me.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
      }

      hide($('settingsOverlay'));
      await refreshMe();
      if (typeof window.refreshAll === 'function') window.refreshAll();
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
  }

  // Live LinkedIn test: saves the cookie first (so the server has the
  // latest value), then asks the server to spin up a 1-job Apify run with
  // the cookie. Shows result inline next to the button. Costs a tiny
  // bit of Apify credit per run — the user is the trigger, so opt-in.
  async function handleLinkedInTest() {
    const btn = $('peLinkedInTestBtn');
    const out = $('peLinkedInTestResult');
    const cookieVal = $('peLinkedInCookie').value.trim();
    if (!cookieVal) {
      out.className = 'li-test-result warn';
      out.textContent = 'Paste a cookie above first.';
      return;
    }
    btn.disabled = true;
    out.className = 'li-test-result';
    out.textContent = 'Saving cookie + running 1-job test scrape (this takes 30-60s)…';

    try {
      // Save the just-typed cookie before testing so the server uses it.
      await api(`/api/profiles/${me.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedin_cookie_override: cookieVal }),
      });
      const r = await api('/api/profile/linkedin-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        out.className = 'li-test-result ok';
        const sample = r.sample ? ` Sample: "${r.sample.title}" @ ${r.sample.company || '?'}.` : '';
        out.textContent = `✓ Authenticated. Found ${r.jobs_found} job(s) for "${r.query}" in ${r.location}.${sample} Took ${(r.duration_ms/1000).toFixed(1)}s.`;
        await refreshMe();  // refresh header chip
      } else {
        out.className = 'li-test-result err';
        out.textContent = '✗ ' + (r.error || r.message || 'Unknown failure') + (r.hint ? ' — ' + r.hint : '');
      }
    } catch (e) {
      out.className = 'li-test-result err';
      out.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function handleDeleteProfile() {
    if (!me) return;
    if (!confirm(`Delete your account "${me.name}" and all its jobs/applications/brain data? This cannot be undone.`)) return;
    try {
      await api(`/api/profiles/${me.id}`, { method: 'DELETE' });
      window.location.replace('/login.html');
    } catch (e) { alert('Delete failed: ' + e.message); }
  }

  // ─────────────────────────────
  // Helpers
  // ─────────────────────────────
  async function api(url, opts = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...opts });
    if (res.status === 401) {
      window.location.replace('/login.html');
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
