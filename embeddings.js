// embeddings.js — Pluggable text embedding + cosine similarity.
//
// Provider priority (chosen at runtime so user can flip it without restart):
//   1. OpenAI text-embedding-3-small  — if app_settings.openai_api_key is set
//   2. Local @xenova/transformers     — using BAAI/bge-base-en-v1.5 (top-tier
//                                       MTEB scores, 768-dim, ~440 MB on disk
//                                       after first-run download, no API key
//                                       needed, no data leaves your machine).
//   3. Keyword fallback               — 256-dim DJB2-hashed token bag
//
// The local provider is loaded lazily on first embed() call. The first call
// after a fresh install can take 10-30s while the ONNX weights download into
// ~/.cache/huggingface/. Subsequent calls are ~50-200ms on Apple Silicon.
//
// To force the keyword fallback (e.g. low-RAM machine, no internet on first
// run), set EMBEDDINGS_DISABLE_LOCAL=1 in .env.
const axios = require('axios');
const db = require('./database');

const OPENAI_MODEL = 'text-embedding-3-small';   // 1536 dims
const LOCAL_MODEL  = 'Xenova/bge-base-en-v1.5';  // 768 dims, beats OpenAI on MTEB
const FALLBACK_DIM = 256;

function getOpenAIKey() {
  return db.getSetting?.('openai_api_key') || process.env.OPENAI_API_KEY || '';
}

function localDisabled() {
  return process.env.EMBEDDINGS_DISABLE_LOCAL === '1';
}

function provider() {
  if (getOpenAIKey()) return 'openai';
  if (!localDisabled() && _localState !== 'failed') return 'local';
  return 'keyword';
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI embeddings
// ─────────────────────────────────────────────────────────────────────────────
async function embedOpenAI(texts) {
  const key = getOpenAIKey();
  if (!key) throw new Error('OpenAI key missing');
  const res = await axios.post(
    'https://api.openai.com/v1/embeddings',
    { model: OPENAI_MODEL, input: texts },
    { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return res.data.data.map(d => Float32Array.from(d.embedding));
}

// ─────────────────────────────────────────────────────────────────────────────
// Local @xenova/transformers — lazy-init the pipeline once, cache forever.
//
// We use a feature-extraction pipeline. BGE models expect a specific prompt
// prefix for queries vs. documents — "Represent this sentence for searching
// relevant passages: " on the query side. For symmetric similarity (CV ↔ JD)
// we treat both sides as documents and skip the prefix.
//
// Mean pooling + L2 normalization at the end so cosine == dot product, which
// keeps callers simple and matches what OpenAI returns.
// ─────────────────────────────────────────────────────────────────────────────
let _localPipelinePromise = null;
let _localState = 'unloaded';   // 'unloaded' | 'loading' | 'ready' | 'failed'

async function getLocalPipeline() {
  if (_localPipelinePromise) return _localPipelinePromise;
  _localState = 'loading';
  // The library's API mutates global state on first import (env config), so
  // import lazily — keeps boot fast for users who only use OpenAI/keyword.
  _localPipelinePromise = (async () => {
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      // Cache models in the workspace, not the home dir, so it's tied to
      // this install. Comment out to use the default ~/.cache/huggingface/.
      // env.cacheDir = './.embeddings-cache';
      env.allowLocalModels = false;  // always fetch from HF the first time
      const pipe = await pipeline('feature-extraction', LOCAL_MODEL, { quantized: true });
      _localState = 'ready';
      console.log(`[embeddings] Local model "${LOCAL_MODEL}" loaded (quantized).`);
      return pipe;
    } catch (e) {
      _localState = 'failed';
      console.warn(`[embeddings] Local model load failed: ${e.message}. Falling back to keyword.`);
      throw e;
    }
  })();
  return _localPipelinePromise;
}

async function embedLocal(texts) {
  const pipe = await getLocalPipeline();
  const out = [];
  for (const t of texts) {
    // Truncate aggressively so we never feed the model more than its context.
    // bge-base-en-v1.5 has a 512-token max; ~1800 chars is a safe upper bound.
    const safe = String(t || '').slice(0, 1800);
    const result = await pipe(safe, { pooling: 'mean', normalize: true });
    // Result is a Tensor; .data is Float32Array of length 768.
    out.push(Float32Array.from(result.data));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword fallback — DJB2-hashed token bag → fixed-dim float vector
// ─────────────────────────────────────────────────────────────────────────────
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && t.length < 30);
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function embedKeyword(text) {
  const v = new Float32Array(FALLBACK_DIM);
  const tokens = tokenize(text);
  if (!tokens.length) return v;
  for (const t of tokens) {
    const h = djb2(t) % FALLBACK_DIM;
    v[h] += 1;
  }
  let norm = 0;
  for (let i = 0; i < FALLBACK_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < FALLBACK_DIM; i++) v[i] /= norm;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
async function embed(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const p = provider();
  if (p === 'openai') {
    try { return await embedOpenAI(arr); }
    catch (e) {
      console.warn(`[embeddings] OpenAI failed (${e.response?.status || ''} ${e.message}) — trying local.`);
    }
  }
  if (p === 'openai' || p === 'local') {
    if (_localState !== 'failed' && !localDisabled()) {
      try { return await embedLocal(arr); }
      catch (e) { /* falls through to keyword */ }
    }
  }
  return arr.map(embedKeyword);
}

async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function topK(queryVec, candidates, k = 5) {
  if (!queryVec || !candidates?.length) return [];
  return candidates
    .map(c => ({ ...c, _sim: cosine(queryVec, c.embedding) }))
    .sort((a, b) => b._sim - a._sim)
    .slice(0, k);
}

module.exports = {
  embed, embedOne, cosine, topK, provider,
  LOCAL_MODEL,
  // exposed for tests
  _embedKeyword: embedKeyword, FALLBACK_DIM,
};
