// brain_db.js — Per-profile knowledge store. Tables are profile_id-scoped so
// each profile (Divya, future Avinash, etc.) has an independent brain.
//
// Schema is deliberately verbose: every column documents what role it plays
// in the learning loop. The brain feeds two reads (analyzeJobAndCompany,
// retrieveContext) and several writes (record*, addInsight/Fact, reflection).
//
// Embeddings live here too (brain_embeddings) but the actual cosine math is
// done in embeddings.js so this file stays storage-only.
const db = require('./database');

function getRawDb() {
  // database.js manages the singleton — borrow it.
  // Caller must have already called db.getDb() during boot.
  // We only access it via small helpers below.
  return db;
}

function ensureSchema() {
  // Schema is idempotent (CREATE IF NOT EXISTS), safe to call on every boot.
  const ddl = `
    CREATE TABLE IF NOT EXISTS brain_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      industry TEXT,
      size_estimate TEXT,
      what_they_do TEXT,
      mission TEXT,
      tech_stack TEXT DEFAULT '[]',
      notes TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      application_count INTEGER DEFAULT 0,
      UNIQUE(profile_id, name)
    );
    CREATE TABLE IF NOT EXISTS brain_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      what_they_do TEXT,
      what_they_want TEXT,
      notes TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(profile_id, company_id, name)
    );
    CREATE TABLE IF NOT EXISTS brain_role_archetypes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      common_skills TEXT DEFAULT '[]',
      application_count INTEGER DEFAULT 0,
      applied_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(profile_id, name)
    );
    CREATE TABLE IF NOT EXISTS brain_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      skill TEXT NOT NULL,
      category TEXT,
      candidate_strength INTEGER DEFAULT 1,
      demand_count INTEGER DEFAULT 0,
      emphasis_count INTEGER DEFAULT 0,
      proof_points TEXT DEFAULT '[]',
      last_seen_at TEXT,
      UNIQUE(profile_id, skill)
    );
    CREATE TABLE IF NOT EXISTS brain_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source_bullet TEXT,
      variation TEXT NOT NULL,
      context TEXT,
      was_kept INTEGER DEFAULT 0,
      was_applied INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brain_application_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      application_id INTEGER,
      company_id INTEGER,
      department_id INTEGER,
      role_archetype_id INTEGER,
      job_id TEXT,
      job_title TEXT,
      job_description TEXT,
      cv_json TEXT,
      cover_letter TEXT,
      user_edits TEXT DEFAULT '[]',
      applied INTEGER DEFAULT 0,
      applied_at TEXT,
      outcome TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brain_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      insight TEXT NOT NULL,
      category TEXT,
      source TEXT DEFAULT 'reflection',
      confidence REAL DEFAULT 0.5,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brain_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      fact TEXT NOT NULL,
      tag TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brain_match_explanations (
      profile_id INTEGER NOT NULL,
      job_id     TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, job_id)
    );
    CREATE TABLE IF NOT EXISTS brain_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      ref_type TEXT NOT NULL,
      ref_id INTEGER,
      ref_key TEXT,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      provider TEXT,
      dim INTEGER,
      created_at TEXT NOT NULL
    );
  `;
  for (const stmt of ddl.split(';').map(s => s.trim()).filter(Boolean)) {
    db.brainExec(stmt);
  }
  // Idempotent column-add migrations for installs that pre-date angle support.
  ensureBrainColumn('brain_insights', 'archetype_id', 'INTEGER');
  ensureBrainColumn('brain_facts',    'archetype_id', 'INTEGER');
}

function ensureBrainColumn(table, column, type) {
  try {
    const cols = db.brainAll(`PRAGMA table_info(${table})`).map(r => r.name);
    if (!cols.includes(column)) db.brainExec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    console.warn(`[brain_db] ensureBrainColumn(${table}.${column}) failed:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — every method here calls into the database.js raw exec
// ─────────────────────────────────────────────────────────────────────────────

function nowISO() { return new Date().toISOString(); }

function selectAll(sql, params = []) { return db.brainAll(sql, params); }
function selectOne(sql, params = []) { return db.brainOne(sql, params); }
function exec(sql, params = []) { return db.brainExec(sql, params); }
// For INSERTs where we need the new rowid back (sql.js rowid is unreliable
// once save() has run, so insertId() captures it before save).
function insertId(sql, params = []) { return db.brainExecReturningId(sql, params); }

// Companies
function upsertCompany(profileId, { name, industry, size_estimate, what_they_do, mission, tech_stack, notes }) {
  if (!name) return null;
  const existing = selectOne('SELECT id, application_count, notes FROM brain_companies WHERE profile_id = ? AND name = ?', [profileId, name]);
  const ts = JSON.stringify(tech_stack || []);
  if (existing) {
    exec(`UPDATE brain_companies SET
            industry = COALESCE(NULLIF(?, ''), industry),
            size_estimate = COALESCE(NULLIF(?, ''), size_estimate),
            what_they_do = COALESCE(NULLIF(?, ''), what_they_do),
            mission = COALESCE(NULLIF(?, ''), mission),
            tech_stack = CASE WHEN ? = '[]' THEN tech_stack ELSE ? END,
            notes = CASE WHEN ? = '' THEN notes ELSE COALESCE(notes, '') || char(10) || ? END,
            last_seen_at = ?
          WHERE id = ?`,
      [industry || '', size_estimate || '', what_they_do || '', mission || '', ts, ts, notes || '', notes || '', nowISO(), existing.id]);
    return existing.id;
  }
  return insertId(`INSERT INTO brain_companies (profile_id, name, industry, size_estimate, what_they_do, mission, tech_stack, notes, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, name, industry || '', size_estimate || '', what_they_do || '', mission || '', ts, notes || '', nowISO(), nowISO()]);
}

function bumpCompanyApplicationCount(companyId) {
  exec('UPDATE brain_companies SET application_count = application_count + 1, last_seen_at = ? WHERE id = ?', [nowISO(), companyId]);
}

function listCompanies(profileId) {
  return selectAll('SELECT * FROM brain_companies WHERE profile_id = ? ORDER BY last_seen_at DESC', [profileId]);
}

function getCompanyByName(profileId, name) {
  return selectOne('SELECT * FROM brain_companies WHERE profile_id = ? AND name = ?', [profileId, name]);
}

// Departments
function upsertDepartment(profileId, companyId, { name, what_they_do, what_they_want, notes }) {
  if (!name || !companyId) return null;
  const existing = selectOne('SELECT id FROM brain_departments WHERE profile_id = ? AND company_id = ? AND name = ?', [profileId, companyId, name]);
  if (existing) {
    exec(`UPDATE brain_departments SET
            what_they_do   = COALESCE(NULLIF(?, ''), what_they_do),
            what_they_want = COALESCE(NULLIF(?, ''), what_they_want),
            notes          = CASE WHEN ? = '' THEN notes ELSE COALESCE(notes, '') || char(10) || ? END,
            last_seen_at   = ?
          WHERE id = ?`,
      [what_they_do || '', what_they_want || '', notes || '', notes || '', nowISO(), existing.id]);
    return existing.id;
  }
  return insertId(`INSERT INTO brain_departments (profile_id, company_id, name, what_they_do, what_they_want, notes, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, companyId, name, what_they_do || '', what_they_want || '', notes || '', nowISO(), nowISO()]);
}

// Role archetypes
function upsertRoleArchetype(profileId, { name, description, common_skills }) {
  if (!name) return null;
  const existing = selectOne('SELECT id, common_skills FROM brain_role_archetypes WHERE profile_id = ? AND name = ?', [profileId, name]);
  if (existing) {
    // Merge skill lists
    let merged = [];
    try {
      const a = JSON.parse(existing.common_skills || '[]');
      const b = Array.isArray(common_skills) ? common_skills : [];
      merged = [...new Set([...a, ...b])];
    } catch { merged = Array.isArray(common_skills) ? common_skills : []; }
    exec(`UPDATE brain_role_archetypes SET
            description = COALESCE(NULLIF(?, ''), description),
            common_skills = ?,
            application_count = application_count + 1
          WHERE id = ?`,
      [description || '', JSON.stringify(merged), existing.id]);
    return existing.id;
  }
  return insertId(`INSERT INTO brain_role_archetypes (profile_id, name, description, common_skills, application_count, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`,
    [profileId, name, description || '', JSON.stringify(common_skills || []), nowISO()]);
}

// Skills inventory — counters per skill
function bumpSkillDemand(profileId, skill, category) {
  if (!skill) return;
  const s = String(skill).toLowerCase().trim();
  const existing = selectOne('SELECT id FROM brain_skills WHERE profile_id = ? AND skill = ?', [profileId, s]);
  if (existing) {
    exec('UPDATE brain_skills SET demand_count = demand_count + 1, last_seen_at = ? WHERE id = ?', [nowISO(), existing.id]);
  } else {
    exec(`INSERT INTO brain_skills (profile_id, skill, category, demand_count, last_seen_at) VALUES (?, ?, ?, 1, ?)`,
      [profileId, s, category || '', nowISO()]);
  }
}

function bumpSkillEmphasis(profileId, skill) {
  if (!skill) return;
  const s = String(skill).toLowerCase().trim();
  const existing = selectOne('SELECT id FROM brain_skills WHERE profile_id = ? AND skill = ?', [profileId, s]);
  if (existing) {
    exec('UPDATE brain_skills SET emphasis_count = emphasis_count + 1, last_seen_at = ? WHERE id = ?', [nowISO(), existing.id]);
  } else {
    exec(`INSERT INTO brain_skills (profile_id, skill, emphasis_count, last_seen_at) VALUES (?, ?, 1, ?)`,
      [profileId, s, nowISO()]);
  }
}

function listSkills(profileId, { limit = 50 } = {}) {
  return selectAll(`SELECT * FROM brain_skills WHERE profile_id = ? ORDER BY (demand_count + emphasis_count) DESC LIMIT ?`, [profileId, limit]);
}

// Achievements
function addAchievement(profileId, { source_bullet, variation, context, was_kept = 0, was_applied = 0 }) {
  if (!variation) return null;
  exec(`INSERT INTO brain_achievements (profile_id, source_bullet, variation, context, was_kept, was_applied, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [profileId, source_bullet || '', variation, context || '', was_kept ? 1 : 0, was_applied ? 1 : 0, nowISO()]);
}

// Application log
function logApplication(profileId, payload) {
  return insertId(`INSERT INTO brain_application_log
          (profile_id, application_id, company_id, department_id, role_archetype_id,
           job_id, job_title, job_description, cv_json, cover_letter, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, payload.application_id || null, payload.company_id || null, payload.department_id || null,
     payload.role_archetype_id || null, payload.job_id || '', payload.job_title || '',
     payload.job_description || '', JSON.stringify(payload.cv || {}), payload.cover_letter || '', nowISO()]);
}

function appendUserEdit(applicationId, edit) {
  const row = selectOne('SELECT id, user_edits FROM brain_application_log WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicationId]);
  if (!row) return;
  let edits = [];
  try { edits = JSON.parse(row.user_edits || '[]'); } catch {}
  edits.push({ ...edit, at: nowISO() });
  exec('UPDATE brain_application_log SET user_edits = ? WHERE id = ?', [JSON.stringify(edits), row.id]);
}

function markApplicationApplied(applicationId) {
  exec('UPDATE brain_application_log SET applied = 1, applied_at = ? WHERE application_id = ?', [nowISO(), applicationId]);
}

function recentApplicationLogs(profileId, limit = 5) {
  return selectAll(`SELECT * FROM brain_application_log WHERE profile_id = ? ORDER BY id DESC LIMIT ?`, [profileId, limit]);
}

function applicationLogStats(profileId) {
  const total = (selectOne('SELECT COUNT(*) c FROM brain_application_log WHERE profile_id = ?', [profileId]) || {}).c || 0;
  const applied = (selectOne('SELECT COUNT(*) c FROM brain_application_log WHERE profile_id = ? AND applied = 1', [profileId]) || {}).c || 0;
  return { total, applied };
}

// Insights
function addInsight(profileId, { insight, category, source = 'reflection', confidence = 0.5, archetype_id = null }) {
  if (!insight) return null;
  return insertId(`INSERT INTO brain_insights (profile_id, insight, category, source, confidence, archetype_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, insight, category || '', source, confidence, archetype_id, nowISO(), nowISO()]);
}

// listInsights returns rows for the profile, optionally filtered by archetype.
//   - activeOnly: only is_active = 1
//   - archetypeId: exact archetype_id to match
//   - includeGlobal: if archetypeId is given, also include rows with NULL archetype_id
//                   (cross-angle insights). Defaults to true so callers see global wisdom.
function listInsights(profileId, { activeOnly = false, archetypeId = undefined, includeGlobal = true } = {}) {
  const where = ['profile_id = ?'];
  const params = [profileId];
  if (activeOnly) where.push('is_active = 1');
  if (archetypeId !== undefined && archetypeId !== null) {
    if (includeGlobal) where.push('(archetype_id = ? OR archetype_id IS NULL)');
    else where.push('archetype_id = ?');
    params.push(archetypeId);
  } else if (archetypeId === null) {
    where.push('archetype_id IS NULL');
  }
  return selectAll(`SELECT * FROM brain_insights WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params);
}

function updateInsight(id, fields) {
  const allowed = ['insight', 'category', 'is_active', 'confidence', 'archetype_id'];
  const sets = []; const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v === '' ? null : v); }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?'); params.push(nowISO());
  params.push(id);
  exec(`UPDATE brain_insights SET ${sets.join(', ')} WHERE id = ?`, params);
}

function deleteInsight(id) {
  exec('DELETE FROM brain_insights WHERE id = ?', [id]);
}

// Facts (manual notes)
function addFact(profileId, { fact, tag, archetype_id = null }) {
  if (!fact) return null;
  return insertId(`INSERT INTO brain_facts (profile_id, fact, tag, archetype_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [profileId, fact, tag || '', archetype_id, nowISO()]);
}

// Same filter semantics as listInsights: archetypeId=N → that angle + (optionally) global rows.
function listFacts(profileId, { archetypeId = undefined, includeGlobal = true } = {}) {
  const where = ['profile_id = ?'];
  const params = [profileId];
  if (archetypeId !== undefined && archetypeId !== null) {
    if (includeGlobal) where.push('(archetype_id = ? OR archetype_id IS NULL)');
    else where.push('archetype_id = ?');
    params.push(archetypeId);
  } else if (archetypeId === null) {
    where.push('archetype_id IS NULL');
  }
  return selectAll(`SELECT * FROM brain_facts WHERE ${where.join(' AND ')} ORDER BY id DESC`, params);
}

function updateFact(id, fields) {
  const allowed = ['fact', 'tag', 'archetype_id'];
  const sets = []; const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v === '' ? null : v); }
  }
  if (!sets.length) return;
  params.push(id);
  exec(`UPDATE brain_facts SET ${sets.join(', ')} WHERE id = ?`, params);
}

function deleteFact(id) {
  exec('DELETE FROM brain_facts WHERE id = ?', [id]);
}

// Archetype lookup helpers used by server endpoints
function listArchetypes(profileId) {
  return selectAll('SELECT id, name, description, application_count, applied_count, created_at FROM brain_role_archetypes WHERE profile_id = ? ORDER BY application_count DESC, name ASC', [profileId]);
}
function getArchetype(profileId, id) {
  return selectOne('SELECT * FROM brain_role_archetypes WHERE profile_id = ? AND id = ?', [profileId, id]);
}
function bumpArchetypeApplied(id) {
  exec('UPDATE brain_role_archetypes SET applied_count = applied_count + 1 WHERE id = ?', [id]);
}

// Embeddings — store + search
function saveEmbedding(profileId, { ref_type, ref_id, ref_key, text, embedding, provider, dim }) {
  // embedding: Float32Array
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  exec(`INSERT INTO brain_embeddings (profile_id, ref_type, ref_id, ref_key, text, embedding, provider, dim, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, ref_type, ref_id || null, ref_key || '', text, buf, provider || '', dim || embedding.length, nowISO()]);
}

function listEmbeddings(profileId, refType) {
  const rows = refType
    ? selectAll('SELECT * FROM brain_embeddings WHERE profile_id = ? AND ref_type = ?', [profileId, refType])
    : selectAll('SELECT * FROM brain_embeddings WHERE profile_id = ?', [profileId]);
  return rows.map(r => ({
    ...r,
    embedding: r.embedding ? new Float32Array(r.embedding.buffer || r.embedding, r.embedding.byteOffset || 0, (r.embedding.byteLength || r.embedding.length) / 4) : null,
  }));
}

function deleteEmbeddingsForRef(profileId, refType, refId) {
  exec('DELETE FROM brain_embeddings WHERE profile_id = ? AND ref_type = ? AND ref_id = ?', [profileId, refType, refId]);
}

// Match-explanation cache. Computed via Claude per (profile, job); skip
// the Claude call on a repeat request if we already have one less than a
// few weeks old. Re-running explainability is cheap-but-not-free.
function getCachedMatchExplanation(profileId, jobId) {
  const row = selectOne(
    'SELECT payload, created_at FROM brain_match_explanations WHERE profile_id = ? AND job_id = ?',
    [profileId, jobId]
  );
  if (!row) return null;
  try { return { ...JSON.parse(row.payload), _cached_at: row.created_at }; }
  catch { return null; }
}
function saveMatchExplanation(profileId, jobId, payload) {
  exec(
    `INSERT OR REPLACE INTO brain_match_explanations (profile_id, job_id, payload, created_at) VALUES (?, ?, ?, ?)`,
    [profileId, jobId, JSON.stringify(payload), nowISO()]
  );
}

module.exports = {
  ensureSchema,
  upsertCompany, bumpCompanyApplicationCount, listCompanies, getCompanyByName,
  upsertDepartment,
  upsertRoleArchetype,
  bumpSkillDemand, bumpSkillEmphasis, listSkills,
  addAchievement,
  logApplication, appendUserEdit, markApplicationApplied, recentApplicationLogs, applicationLogStats,
  addInsight, listInsights, updateInsight, deleteInsight,
  addFact, listFacts, updateFact, deleteFact,
  listArchetypes, getArchetype, bumpArchetypeApplied,
  saveEmbedding, listEmbeddings, deleteEmbeddingsForRef,
  getCachedMatchExplanation, saveMatchExplanation,
};
