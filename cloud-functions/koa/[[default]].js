import Koa from 'koa';
import Router from '@koa/router';
import { Readable } from 'stream';
import { getStore } from '@edgeone/pages-blob';

// ---------- Configuration ----------

const STORE_NAME = 'cursor-cache';
// 6 MB per chunk — comfortably below the 25 MB single-blob limit, and small
// enough that one chunk downloads in ~3s even on a ~2 MB/s egress (EdgeOne ->
// cursor.com observed bandwidth). This keeps each /api/update-step call well
// under EdgeOne's ~30s function execution cap, with room for retries.
// 199 MB installer -> ~34 chunks.
const CHUNK_SIZE = 6 * 1024 * 1024;

// Cursor official "golden" download API.
// The path ends with `cursor/` (no version pin) — this always redirects to the
// newest stable build for the platform (e.g. 3.13.10). Pinning to a version
// like `cursor/3.5` would freeze us on the 3.5.x channel.
// We follow the redirect and read the production URL (commit hash + version)
// to detect updates reliably. macOS filenames don't include a version, so we
// fall back to the Windows URL to resolve a version label for the same commit.
const PLATFORMS = {
  'win32-x64-user': {
    label: 'Windows x64 (User Setup)',
    fileExt: '.exe',
    contentType: 'application/x-msdos-program',
    url: 'https://api2.cursor.sh/updates/download/golden/win32-x64-user/cursor/',
  },
  'darwin-arm64': {
    label: 'macOS Apple Silicon (ARM64)',
    fileExt: '.dmg',
    contentType: 'application/x-apple-diskimage',
    url: 'https://api2.cursor.sh/updates/download/golden/darwin-arm64/cursor/',
  },
  'darwin-x64': {
    label: 'macOS Intel (x64)',
    fileExt: '.dmg',
    contentType: 'application/x-apple-diskimage',
    url: 'https://api2.cursor.sh/updates/download/golden/darwin-x64/cursor/',
  },
  'linux-x64': {
    label: 'Linux x64 (AppImage)',
    fileExt: '.AppImage',
    contentType: 'binary/octet-stream',
    url: 'https://api2.cursor.sh/updates/download/golden/linux-x64/cursor/',
  },
};

// Used as a version-label fallback for platforms whose redirect URL has no
// semver (macOS .dmg filenames are just "Cursor-darwin-arm64.dmg"). All
// platforms on the same release share the same commit, so we can borrow the
// version string from the Windows redirect.
const VERSION_PROBE_PLATFORM = 'win32-x64-user';

// ---------- Helpers ----------

function isValidPlatform(p) {
  return !!p && Object.prototype.hasOwnProperty.call(PLATFORMS, p);
}

function getStoreInstance() {
  // strong consistency so reads right after a write return the new value
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

// Extract a human-readable message from a fetch error. Node's undici wraps
// the underlying cause (ECONNRESET, ENOTFOUND, TLS, ...) in err.cause.
function describeFetchError(err) {
  if (!err) return 'unknown';
  const parts = [err.message || String(err)];
  let c = err.cause;
  while (c) {
    const msg = c.message || c.code || c.name;
    if (msg && !parts.includes(msg)) parts.push(msg);
    c = c.cause;
  }
  return parts.join(' · ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wrap fetch with an AbortController timeout. Without this, a hung connection
// to cursor.com blocks the whole function until EdgeOne's 30s cap kills it,
// leaving no time for a retry. Aborting throws an AbortError which the caller's
// retry loop catches.
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Read the response body as an ArrayBuffer, but bail out if it takes longer
// than `ms`. The fetch AbortController only covers the header phase; once
// headers arrive, a slow body stream can still hang us. We poll the promise
// against a timer and reject if it doesn't resolve in time.
function readBodyWithTimeout(resp, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`body read timed out after ${ms}ms`)), ms);
    resp.arrayBuffer().then(
      (buf) => { clearTimeout(timer); resolve(buf); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Retry a fetch operation a few times with exponential backoff + a per-attempt
// timeout. The EdgeOne egress to cursor.com is flaky — a single request often
// hangs or fails with a generic "fetch failed", but a retry a second later
// succeeds.
async function fetchWithRetry(url, opts = {}, { tries = 4, baseMs = 800, timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetchWithTimeout(url, opts, timeoutMs);
      return resp;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// Parse the redirected production URL into a fingerprint we can compare.
// Example URL:
//   https://downloads.cursor.com/production/009bb5a3.../win32/x64/user-setup/CursorUserSetup-x64-3.13.10.exe
function parseVersionInfo(url) {
  let commit = null;
  let version = null;
  let fileName = '';

  const commitMatch = url.match(/production\/([a-f0-9]{20,})\//i);
  if (commitMatch) commit = commitMatch[1];

  const semverMatch = url.match(/(\d+\.\d+\.\d+)/);
  if (semverMatch) version = semverMatch[1];

  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) fileName = decodeURIComponent(parts[parts.length - 1]);
  } catch (_) {
    fileName = '';
  }

  return { commit, version, fileName, url };
}

const FETCH_HEADERS = {
  // Some CDNs reject requests with no / default User-Agent.
  'User-Agent': 'Mozilla/5.0 (compatible; CursorMirrorBot/1.0; +https://cursor.sxwzxc.cn)',
  Accept: '*/*',
};

// HEAD the official endpoint, follow the redirect, read the production URL.
// `retryOpts` is forwarded to fetchWithRetry; callers that need a tighter
// time budget (e.g. /api/check, which must stay under EdgeOne's ~30s
// function cap) can pass { tries, timeoutMs }.
async function getLatestVersionInfo(platform, retryOpts) {
  const cfg = PLATFORMS[platform];
  const resp = await fetchWithRetry(cfg.url, { method: 'HEAD', redirect: 'follow', headers: FETCH_HEADERS }, retryOpts);
  if (!resp.ok) {
    throw new Error(`cursor.com HEAD failed: HTTP ${resp.status}`);
  }
  const finalUrl = resp.url;
  if (!finalUrl) {
    throw new Error('No final URL after redirect from cursor.com');
  }
  const info = parseVersionInfo(finalUrl);
  const contentLength = resp.headers.get('content-length');
  const fileSize = contentLength ? parseInt(contentLength, 10) : 0;

  let version = info.version;
  // macOS .dmg filenames don't carry a version, so the URL has no semver.
  // Fall back to the Windows redirect for the same release (shared commit).
  if (!version && platform !== VERSION_PROBE_PLATFORM) {
    try {
      const probe = PLATFORMS[VERSION_PROBE_PLATFORM];
      const probeResp = await fetchWithRetry(probe.url, { method: 'HEAD', redirect: 'follow', headers: FETCH_HEADERS }, retryOpts);
      if (probeResp.ok) {
        const probeInfo = parseVersionInfo(probeResp.url || '');
        version = probeInfo.version || null;
      }
    } catch (_) {
      // Non-fatal — version label is cosmetic; commit comparison still works.
    }
  }

  return {
    platform,
    version,
    commit: info.commit,
    fileName: info.fileName || `cursor-${platform}${cfg.fileExt}`,
    fileSize,
    url: finalUrl,
    contentType: cfg.contentType,
    lastModified: resp.headers.get('last-modified') || null,
    fetchedAt: new Date().toISOString(),
  };
}

async function getCachedMeta(platform) {
  const store = getStoreInstance();
  const meta = await store.get(`meta/${platform}`, { type: 'json' });
  return meta;
}

async function saveCachedMeta(platform, meta) {
  const store = getStoreInstance();
  await store.setJSON(`meta/${platform}`, meta);
}

async function deleteCachedMeta(platform) {
  const store = getStoreInstance();
  await store.delete(`meta/${platform}`);
}

// Delete every chunk under chunks/{platform}/. Returns count deleted.
async function deleteOldChunks(platform) {
  const store = getStoreInstance();
  const result = await store.list({ prefix: `chunks/${platform}/` });
  const blobs = result.blobs || [];
  await Promise.all(blobs.map((b) => store.delete(b.key || b.pathname)));
  return blobs.length;
}

// Probe the download URL with a 0-byte Range request to:
//  1. confirm the CDN honours Range (we need this to chunk the download);
//  2. read the true total size from Content-Range (more reliable than the
//     Content-Length on the HEAD response, which can be absent on redirects).
// Returns { totalSize, chunkCount }. Throws if Range is unsupported.
async function probeRangeSupport(url) {
  const probeResp = await fetchWithRetry(url, {
    method: 'GET',
    headers: { ...FETCH_HEADERS, Range: 'bytes=0-0' },
    redirect: 'follow',
  });
  if (probeResp.status !== 206) {
    throw new Error(`Range requests not supported (probe returned HTTP ${probeResp.status}). Cannot safely chunk-download.`);
  }
  const contentRange = probeResp.headers.get('content-range') || '';
  const declaredTotal = contentRange.match(/\/(\d+)/);
  try { await probeResp.body.cancel(); } catch (_) {}
  const totalSize = declaredTotal ? parseInt(declaredTotal[1], 10) : 0;
  if (!totalSize) throw new Error('Could not determine total size from Content-Range.');
  return { totalSize, chunkCount: Math.ceil(totalSize / CHUNK_SIZE) };
}

// Download a single slice via HTTP Range and write it to blob storage.
// Single attempt per call — on failure, throws so the caller can retry.
// `chunkSize` is read from the cached meta (not the constant) so that an
// in-flight download keeps its original chunk boundaries even if CHUNK_SIZE
// is later changed.
async function downloadSingleChunk(platform, url, index, totalSize, chunkSize) {
  const store = getStoreInstance();
  const sz = chunkSize || CHUNK_SIZE;
  const start = index * sz;
  const end = Math.min(start + sz - 1, totalSize - 1);
  const expected = end - start + 1;

  let buf = null;
  // 8s per-attempt timeout. With 6 MB chunks at ~2 MB/s, a normal download
  // takes ~3s, so this only fires on genuine stalls.
  const FETCH_TIMEOUT_MS = 8000;
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { ...FETCH_HEADERS, Range: `bytes=${start}-${end}` },
      redirect: 'follow',
    }, FETCH_TIMEOUT_MS);
    if (resp.status !== 206 && resp.status !== 200) {
      throw new Error(`HTTP ${resp.status} for range ${start}-${end}`);
    }
    buf = await readBodyWithTimeout(resp, FETCH_TIMEOUT_MS);
    if (!buf || buf.byteLength === 0) {
      throw new Error('empty body for range');
    }
    // The final chunk may be shorter than CHUNK_SIZE; everything else must
    // be exactly the requested size, otherwise the reassembled file would
    // be corrupt.
    if (buf.byteLength !== expected && end !== totalSize - 1) {
      throw new Error(`short read: expected ${expected}, got ${buf.byteLength}`);
    }
  } catch (e) {
    throw new Error(`chunk ${index} (${start}-${end}) failed: ${describeFetchError(e)}`);
  }

  await store.set(`chunks/${platform}/${index}`, buf);
  return { index, start, end, size: buf.byteLength };
}

// Download up to `count` missing chunks CONCURRENTLY within one function
// invocation, so a single /api/update-step call advances the download several
// chunks instead of one. `skip` (a Set of chunk indexes) excludes chunks that
// already failed earlier in the same call — we don't retry them within one
// invocation, the caller's next call picks them up again.
//
// Every successful chunk is committed to meta.chunksDone in a single write at
// the end, keeping the meta consistent even under concurrent batch calls.
// Returns { done, failed, remaining } — `remaining` is how many chunks are
// still missing (excluding skipped ones), so callers know when to stop.
async function downloadChunksInParallel(platform, meta, count, skip) {
  const doneSet = new Set(meta.chunksDone || []);
  const missing = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    if (doneSet.has(i)) continue;
    if (skip && skip.has(i)) continue;
    missing.push(i);
  }
  const picked = missing.slice(0, Math.max(1, count || 1));
  if (picked.length === 0) return { done: [], failed: [], remaining: 0 };

  const results = await Promise.allSettled(
    picked.map((idx) => downloadSingleChunk(platform, meta.sourceUrl, idx, meta.fileSize, meta.chunkSize)),
  );
  const done = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      done.push(picked[i]);
    } else {
      failed.push({ index: picked[i], error: describeFetchError(r.reason) });
    }
  });
  for (const idx of done) {
    if (!meta.chunksDone.includes(idx)) meta.chunksDone.push(idx);
  }
  await saveCachedMeta(platform, meta);
  return { done, failed, remaining: missing.length - picked.length };
}

// Sum the actual bytes covered by chunksDone (the last chunk is shorter).
function sumBytesDone(meta) {
  if (!meta || !meta.chunksDone || !meta.chunkCount) return 0;
  let total = 0;
  for (const idx of meta.chunksDone) {
    total += idx === meta.chunkCount - 1
      ? (meta.fileSize - idx * meta.chunkSize)
      : meta.chunkSize;
  }
  return Math.max(0, Math.min(total, meta.fileSize));
}

// Build a minimal LatestInfo object from cached meta, for responses on the
// fast path where we skipped the cursor.com HEAD.
function metaToLatest(meta) {
  return {
    platform: meta.platform,
    version: meta.version,
    commit: meta.commit,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    url: meta.sourceUrl,
    contentType: meta.contentType,
    lastModified: meta.sourceLastModified,
    fetchedAt: meta.cachedAt,
  };
}

// ---------- Changelog translation (LLM) ----------
//
// The changelog is mirrored from cursor.com in English. To let Chinese users
// read it without leaving the site, we automatically translate it with an
// OpenAI-compatible chat-completion LLM whenever the source text changes, and
// cache the translation next to the original in blob storage.
//
// This project runs on EdgeOne Makers, whose Models 网关 is
// OpenAI-compatible (https://ai-gateway.edgeone.link/v1) and ships several
// free-tier built-in models prefixed with `@makers/`. See:
//   https://cloud.tencent.com/document/product/1552/132760
//
// The project has the Makers API key configured in the console under the env
// var literally named `apikey`. We read that first, then fall back through
// the official `MAKERS_MODELS_KEY` and the older `AI_GATEWAY_API_KEY` names
// so the code keeps working regardless of how the key was named. The base
// URL and model have sensible Makers defaults, so only the key is required.
//
//   apikey             — project-configured Makers key (this project)
//   MAKERS_MODELS_KEY  — official Makers key name (docs)
//   AI_GATEWAY_API_KEY — older Makers-injected name (still seen in field guides)
//   LLM_API_KEY        — generic local-dev fallback
//   LLM_API_BASE_URL   — optional override (default Makers gateway)
//   AI_GATEWAY_MODEL / LLM_MODEL — optional model override
//                                  (default @makers/deepseek-v4-flash)
//   LLM_TIMEOUT_MS     — per-request timeout (default 25000)
const MAKERS_DEFAULT_BASE_URL = 'https://ai-gateway.edgeone.link/v1';
const MAKERS_DEFAULT_MODEL = '@makers/deepseek-v4-flash';

function getLLMConfig() {
  const baseUrl = (
    process.env.AI_GATEWAY_BASE_URL
    || process.env.LLM_API_BASE_URL
    || MAKERS_DEFAULT_BASE_URL
  ).trim().replace(/\/+$/, '');
  // Key lookup order: project-configured name → official Makers name →
  // older Makers-injected name → generic local-dev fallback.
  const apiKey = (
    process.env.apikey
    || process.env.MAKERS_MODELS_KEY
    || process.env.AI_GATEWAY_API_KEY
    || process.env.LLM_API_KEY
    || ''
  ).trim();
  const model = (
    process.env.AI_GATEWAY_MODEL
    || process.env.LLM_MODEL
    || MAKERS_DEFAULT_MODEL
  ).trim();
  const timeout = parseInt(process.env.LLM_TIMEOUT_MS || '', 10);
  return {
    baseUrl,
    apiKey,
    model,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 25000,
  };
}

// "Configured" means we have an API key. baseUrl + model both have sensible
// Makers defaults, so only the key needs to be present.
function llmConfigured() {
  return !!getLLMConfig().apiKey;
}

// FNV-1a 32-bit hash. Fast, dependency-free, good enough for change detection
// of multi-KB changelog text. Returned as an 8-char hex string.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// Call an OpenAI-compatible /chat/completions endpoint to translate text
// into Simplified Chinese. Returns { ok, translation } on success or
// { ok: false, reason } on failure. `kind` ("changelog" | "models") only
// tunes the first line of the system prompt; the structural rules are shared
// because both sources are technical docs with tables/URLs/numbers.
async function translateToZh(text, kind = 'changelog') {
  const cfg = getLLMConfig();
  if (!llmConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }
  // Guard against absurdly long inputs that would blow the context window.
  // If the text ever grows past this, we still translate the head.
  const MAX_CHARS = 24000;
  const payload = text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + '\n\n[... truncated for translation ...]'
    : text;

  const roleLine = kind === 'models'
    ? 'You are a professional translator for software model & pricing documentation.'
    : 'You are a professional software-release-note translator.';
  const systemPrompt = [
    roleLine,
    'Translate the user message from English into Simplified Chinese (简体中文).',
    'Rules:',
    '- Preserve all version numbers, dates, commit hashes, file names, model names (e.g. Claude, GPT, Gemini, Grok), prices, and URLs verbatim.',
    '- Preserve Markdown/whitespace structure, bullet points, headings, code blocks, and table rows.',
    '- Keep the same line breaks; do not merge or split lines or table cells.',
    '- Translate prose naturally; do not add explanations, notes, or "Translation:" prefixes.',
    '- Output ONLY the translated text.',
  ].join('\n');

  const url = `${cfg.baseUrl}/chat/completions`;
  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: payload },
        ],
        temperature: 0.2,
        // Cap the output so long inputs can't produce a response that the
        // gateway rejects or that times out mid-generation. Long changelogs
        // are split into sections (see translateText), so each call only
        // needs a modest output budget.
        max_tokens: 4096,
        stream: false,
      }),
    }, cfg.timeoutMs);
  } catch (e) {
    return { ok: false, reason: 'fetch_failed', detail: describeFetchError(e) };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return { ok: false, reason: 'http_error', detail: `LLM HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, reason: 'bad_json', detail: describeFetchError(e) };
  }
  const translation = data && data.choices && data.choices[0] && data.choices[0].message
    && typeof data.choices[0].message.content === 'string'
    ? data.choices[0].message.content.trim()
    : '';
  if (!translation) {
    return { ok: false, reason: 'empty_content' };
  }
  return { ok: true, translation };
}

// ---------- Sectioned translation ----------
//
// A single LLM call with the whole changelog (~8 KB) is unreliable on the
// Makers gateway: long inputs / outputs can trip generation limits or time
// out mid-response (observed as repeated translation failures), and each
// section call takes ~8-10s. EdgeOne kills the function process at ~30s
// (504 CLOUD_FUNCTION_INVOCATION_TIMEOUT), so NO request can afford to wait
// on the LLM inline. The strategy:
//   1. Long texts are split into small sections (date headers, else ~1.5 KB
//      paragraph chunks).
//   2. Every lang=zh request kicks off a BACKGROUND pass (fire-and-forget)
//      that translates the still-missing sections concurrently, persisting
//      each completed section immediately.
//   3. Persisted sections carry their own source hash, so the next pass
//      resumes where the previous one stopped — progress accumulates across
//      requests even if the process is recycled right after a response.
//   4. The client polls; the assembled translation grows from 'partial' to
//      'done' as passes advance.
const SECTION_CHAR_LIMIT = 1500;   // max chars per section for a long text
const SECTION_CONCURRENCY = 2;     // parallel LLM calls at once
const SECTION_MAX_RETRIES = 2;     // per-section attempts (incl. the first)
const SECTION_BUDGET_MS = 16000;   // per-pass cap. EdgeOne kills the function
                                   // at ~30s and in-flight LLM calls can run
                                   // ~10s past the budget, so 16s leaves a
                                   // safe margin for the response.
const PASS_THROTTLE_MS = 8000;     // min gap between translation passes
                                   // (avoids piling up concurrent LLM calls
                                   // from multiple clients/polls)

// Split at changelog date headers like "Jul 29, 2026 · Changelog" (or
// "3.11 Jul 10, 2026 · Changelog"). The header line stays with its section.
function splitChangelogSections(text) {
  const dateRe = /^(\d+(?:\.\d+)*\s*)?[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/i;
  const lines = text.split('\n');
  const sections = [];
  let current = { header: '', lines: [] };
  for (const line of lines) {
    if (dateRe.test(line.trim())) {
      current = { header: line, lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  if (sections.length === 0 && current.lines.length) sections.push(current);
  return sections
    .map((s) => {
      const body = s.lines.join('\n').trim();
      if (!s.header && !body) return null;
      return [s.header, body].filter(Boolean).join('\n');
    })
    .filter(Boolean);
}

// Split long text that has no date headers into ~SECTION_CHAR_LIMIT pieces,
// preferring paragraph boundaries so lines/tables aren't cut mid-row.
function splitLongText(text) {
  const paragraphs = text.split(/\n{2,}/);
  const parts = [];
  let current = '';
  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    if (current && candidate.length > SECTION_CHAR_LIMIT) {
      parts.push(current);
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [text];
}

// Translate `text` with the sectioned strategy described above. Short texts
// (<= 2500 chars) go through a single call with a few retries. Returns
// { ok, translation, partial, failedSections, durationMs, reason, detail }.
async function translateText(text, kind = 'changelog') {
  const startedAt = Date.now();
  const budget = SECTION_BUDGET_MS;

  if (text.length <= 2500) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() - startedAt > budget) break;
      const result = await translateToZh(text, kind);
      if (result.ok) {
        return { ok: true, translation: result.translation, partial: false, failedSections: [], durationMs: Date.now() - startedAt };
      }
      last = result;
      await sleep(500 * (attempt + 1));
    }
    return {
      ok: false,
      reason: last ? last.reason : 'timeout',
      detail: last ? last.detail : null,
      partial: false,
      failedSections: [],
      durationMs: Date.now() - startedAt,
    };
  }

  let sections = splitChangelogSections(text);
  if (sections.length <= 1) sections = splitLongText(text);

  const results = new Array(sections.length).fill(null);
  const failedSections = [];
  let next = 0;

  const worker = async () => {
    while (true) {
      if (Date.now() - startedAt > budget) break;
      const idx = next++;
      if (idx >= sections.length) break;
      let ok = false;
      let last = null;
      for (let attempt = 0; attempt < SECTION_MAX_RETRIES; attempt++) {
        if (Date.now() - startedAt > budget) break;
        const result = await translateToZh(sections[idx], kind);
        if (result.ok) {
          results[idx] = result.translation;
          ok = true;
          break;
        }
        last = result;
        await sleep(500 * (attempt + 1));
      }
      if (!ok) {
        failedSections.push(idx);
        // Keep the original text so the content stays readable.
        results[idx] = sections[idx];
      }
    }
  };

  await Promise.all(Array.from({ length: SECTION_CONCURRENCY }, () => worker()));

  const translation = results.join('\n\n');
  return {
    ok: failedSections.length === 0,
    translation,
    partial: failedSections.length > 0,
    failedSections: failedSections.map((i) => i + 1),
    durationMs: Date.now() - startedAt,
  };
}

// Read the cached Chinese translation, but only trust it if its hash matches
// the current source hash (otherwise the source changed and the translation
// is stale). Returns null if no usable translation exists. `zhBlobKey`
// selects which cache to read (e.g. 'changelog/cached_zh' or 'models/cached_zh').
async function getCachedTranslation(sourceHash, zhBlobKey) {
  const store = getStoreInstance();
  let zh = null;
  try {
    zh = await store.get(zhBlobKey, { type: 'json' });
  } catch (_) {}
  if (!zh || !zh.text || !zh.hash) return null;
  if (sourceHash && zh.hash !== sourceHash) return null;
  return zh;
}

// One translation pass over `source.text`. Translates the sections that are
// still missing (resuming from the per-section hashes already persisted in
// `zhBlobKey`), and rewrites the assembled blob after every section
// completes so partial progress survives even if the request is killed by
// EdgeOne's ~30s function cap. Each pass runs within SECTION_BUDGET_MS of
// LLM time; callers invoke it INLINE (awaited) — EdgeOne recycles the
// process right after the response, so fire-and-forget work is unreliable.
// Never throws. `kind` tunes the LLM system prompt.
async function runTranslationPass(source, kind, zhBlobKey) {
  try {
    if (!llmConfigured()) {
      console.log('[translate] pass skipped: llm not configured', { zhBlobKey });
      return;
    }
    const startedAt = Date.now();
    let sections = splitChangelogSections(source.text);
    if (sections.length <= 1) sections = splitLongText(source.text);
    const srcHash = sections.map((s) => hashText(s));
    const store = getStoreInstance();

    // Load sections already completed for the same source.
    let existing = null;
    try { existing = await store.get(zhBlobKey, { type: 'json' }); } catch (_) {}
    const doneMap = new Map(); // section number -> zh text
    if (existing && Array.isArray(existing.sections)) {
      for (const sec of existing.sections) {
        const idx = (sec.num || 0) - 1;
        if (idx >= 0 && idx < srcHash.length && sec.sourceHash === srcHash[idx] && typeof sec.text === 'string') {
          doneMap.set(sec.num, sec.text);
        }
      }
    }

    // Reassemble + persist the current progress.
    const persist = async () => {
      const doneList = [];
      const partialSections = [];
      sections.forEach((_, i) => {
        const num = i + 1;
        if (doneMap.has(num)) doneList.push({ num, sourceHash: srcHash[i], text: doneMap.get(num) });
        else partialSections.push(num);
      });
      doneList.sort((a, b) => a.num - b.num);
      const zhData = {
        text: doneList.map((s) => s.text).join('\n\n'),
        sourceUrl: source.sourceUrl,
        fetchedAt: source.fetchedAt,
        translatedAt: new Date().toISOString(),
        hash: source.hash,
        translationStatus: partialSections.length === 0 ? 'done' : (doneList.length ? 'partial' : 'pending'),
        partialSections,
        sections: doneList,
      };
      await store.setJSON(zhBlobKey, zhData);
      return zhData;
    };

    let next = 0;
    const worker = async () => {
      while (true) {
        if (Date.now() - startedAt > SECTION_BUDGET_MS) break;
        const idx = next++;
        if (idx >= sections.length) break;
        const num = idx + 1;
        if (doneMap.has(num)) continue;
        let ok = false;
        for (let attempt = 0; attempt < SECTION_MAX_RETRIES; attempt++) {
          if (Date.now() - startedAt > SECTION_BUDGET_MS) break;
          const result = await translateToZh(sections[idx], kind);
          if (result.ok) {
            doneMap.set(num, result.translation);
            await persist(); // checkpoint — survives process recycling
            ok = true;
            break;
          }
          await sleep(500 * (attempt + 1));
        }
        if (!ok && doneMap.has(num) === false) {
          // Section kept in English; the next pass will try it again.
          await persist();
        }
      }
    };
    await Promise.all(Array.from({ length: SECTION_CONCURRENCY }, () => worker()));

    const finalZh = await persist();
    console.log('[translate] pass done', {
      zhBlobKey,
      status: finalZh.translationStatus,
      sectionsDone: finalZh.sections.length,
      sectionsTotal: sections.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.log('[translate] pass failed', { zhBlobKey, error: describeFetchError(e) });
  }
}

// ---------- Koa setup ----------

const app = new Koa();
const router = new Router();

// CORS + JSON error handling
app.use(async (ctx, next) => {
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
    return;
  }
  try {
    await next();
  } catch (err) {
    ctx.status = ctx.status && ctx.status >= 400 ? ctx.status : 500;
    ctx.set('Content-Type', 'application/json');
    ctx.body = { error: 'internal_error', detail: err && err.message ? err.message : String(err) };
  }
});

// ---------- Routes ----------

// API root: lists endpoints so the site is easy to test after deployment.
router.get('/', (ctx) => {
  ctx.body = {
    name: 'Cursor Installer Mirror API',
    version: '1.0.0',
    description: 'Mirrors the latest Cursor installer from cursor.com into EdgeOne Pages Blob storage, chunked to respect the 25 MB single-blob limit.',
    store: STORE_NAME,
    chunkSize: CHUNK_SIZE,
    endpoints: {
      'GET /api/platforms': 'List supported platforms',
      'GET /api/latest?platform=<id>': 'Fetch latest version info from cursor.com',
      'GET /api/status?platform=<id>': 'Return cached metadata (or null)',
      'GET /api/check?platform=<id>': 'Compare latest vs cached; returns needsUpdate flag',
      'POST /api/update-step?platform=<id>&force=<bool>&count=<n>': 'Download up to 4 chunks in parallel per call (resumable, for frontend loop)',
      'POST /api/auto-update?platform=<id>': 'Auto check + download within 25s budget (for cron). Loop until action=completed|skipped.',
      'GET /api/download-manifest?platform=<id>': 'Chunk manifest (use this + /api/download-chunk to fetch the installer)',
      'GET /api/download-chunk?platform=<id>&index=<n>': 'Fetch a single chunk (avoids the function response size cap)',
      'GET /api/download?platform=<id>': 'Legacy single-shot stream — will 413 for large files; prefer the manifest flow',
      'GET /api/changelog?force=<bool>': 'Fetch and cache the cursor.com changelog page as text',
      'GET /api/changelog?lang=zh': 'Get the Simplified-Chinese LLM translation of the cached changelog (auto-generated when source changes)',
      'GET /api/models?force=<bool>': 'Mirror cursor.com/docs/models-and-pricing per-model token pricing table; shown in English as-is',
    },
  };
});

router.get('/api/platforms', (ctx) => {
  const platforms = Object.entries(PLATFORMS).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    fileExt: cfg.fileExt,
    contentType: cfg.contentType,
  }));
  ctx.body = { platforms };
});

router.get('/api/latest', async (ctx) => {
  const platform = ctx.query.platform;
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform', detail: 'Use GET /api/platforms for the list of valid ids.' };
    return;
  }
  try {
    const latest = await getLatestVersionInfo(platform);
    ctx.body = { latest };
  } catch (e) {
    ctx.status = 502;
    ctx.body = { error: 'fetch_latest_failed', detail: describeFetchError(e) };
  }
});

// Debug endpoint — shows which env var names are populated and which LLM
// config the code will actually use. Key values are masked so this is safe
// to call on a public site. Used to diagnose "translation unavailable".
router.get('/api/debug-llm', async (ctx) => {
  const checked = ['apikey', 'MAKERS_MODELS_KEY', 'AI_GATEWAY_API_KEY', 'LLM_API_KEY'];
  const sources = {};
  for (const name of checked) {
    const val = process.env[name];
    sources[name] = val
      ? { present: true, length: val.length, masked: `${val.slice(0, 4)}…${val.slice(-4)}` }
      : { present: false };
  }
  const cfg = getLLMConfig();
  // Surface any other env var whose name looks LLM-related, so if the key
  // was named differently we can spot it.
  const envKeys = Object.keys(process.env).filter((k) =>
    /key|token|maker|gateway|llm|api/i.test(k),
  );
  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    configured: llmConfigured(),
    resolved: {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey: cfg.apiKey
        ? { length: cfg.apiKey.length, masked: `${cfg.apiKey.slice(0, 4)}…${cfg.apiKey.slice(-4)}` }
        : null,
      timeoutMs: cfg.timeoutMs,
    },
    envSources: sources,
    relatedEnvKeys: envKeys,
    processEnvKeysCount: Object.keys(process.env).length,
    processEnvSample: Object.keys(process.env).slice(0, 30),
  };
});

// Debug endpoint — runs a real LLM translation and returns the raw outcome
// (ok/fail, reason, detail). This lets us verify end-to-end that the Makers
// gateway accepts our key, model and request shape without depending on the
// cached changelog.
//
// Query params:
//   text=<url-encoded>   custom input (default: a tiny test sentence). Use a
//                        long text to reproduce/sectioned-test translation.
router.get('/api/debug-translate', async (ctx) => {
  const cfg = getLLMConfig();
  const input = typeof ctx.query.text === 'string' && ctx.query.text.trim()
    ? ctx.query.text.slice(0, 24000)
    : 'Bug fixes and performance improvements.';
  console.log('[debug-translate] start', {
    configured: llmConfigured(),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    keyLen: cfg.apiKey.length,
    inputLen: input.length,
  });
  const result = await translateText(input, 'changelog');
  console.log('[debug-translate] result', { ok: result.ok, partial: result.partial, reason: result.reason, detail: result.detail, durationMs: result.durationMs });
  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    inputLen: input.length,
    inputHead: input.slice(0, 120),
    ok: result.ok,
    partial: result.partial,
    reason: result.reason || undefined,
    detail: result.detail || undefined,
    failedSections: result.failedSections,
    durationMs: result.durationMs,
    translation: result.translation ? result.translation.slice(0, 300) : undefined,
  };
});

router.get('/api/status', async (ctx) => {
  const platform = ctx.query.platform;
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }
  const cached = await getCachedMeta(platform);
  ctx.body = { cached };
});

// Debug endpoint — diagnose why EdgeOne functions cannot reach cursor.com.
// Runs multiple probes (HEAD + GET, with and without redirect) against the
// official download endpoint and returns a structured log. This is callable
// via the public API so the site owner can inspect the failure without
// needing EdgeOne console access.
//
// Query params:
//   url=<https://...>   override the probe URL (default: the Windows golden
//                       redirect endpoint, the same one /api/check uses)
//   timeout=<ms>        per-attempt timeout (default 8000)
router.get('/api/debug-conn', async (ctx) => {
  const targetUrl = ctx.query.url || PLATFORMS['win32-x64-user'].url;
  const timeoutMs = Math.min(parseInt(ctx.query.timeout, 10) || 8000, 15000);
  const startedAt = Date.now();
  const log = [];

  const push = (phase, extra) => {
    const entry = { t: Date.now() - startedAt, phase, ...(extra || {}) };
    log.push(entry);
    // Also emit to the function log stream so it shows up in EdgeOne console.
    console.log(`[debug-conn] ${entry.t}ms ${phase}`, extra || {});
  };

  push('start', { url: targetUrl, timeoutMs, ua: FETCH_HEADERS['User-Agent'] });

  const probe = async (label, method, redirect, headers) => {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      push(`${label}:fetch_start`, { method, redirect });
      const r = await fetch(targetUrl, {
        method,
        redirect,
        headers: { ...FETCH_HEADERS, ...(headers || {}) },
        signal: controller.signal,
      });
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      push(`${label}:response`, {
        elapsed,
        status: r.status,
        statusText: r.statusText,
        finalUrl: r.url,
        redirected: r.redirected,
        headers: {
          'content-length': r.headers.get('content-length'),
          'content-type': r.headers.get('content-type'),
          location: r.headers.get('location'),
          server: r.headers.get('server'),
          via: r.headers.get('via'),
          'cf-ray': r.headers.get('cf-ray'),
          'x-edgeone': r.headers.get('x-edgeone') || r.headers.get('x-eo'),
        },
      });
      return { ok: true, status: r.status, elapsed };
    } catch (e) {
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      const errInfo = describeFetchError(e);
      push(`${label}:error`, { elapsed, error: errInfo, name: e.name, code: e.code });
      return { ok: false, error: errInfo, elapsed };
    }
  };

  const results = {};
  results.head_follow = await probe('head_follow', 'HEAD', 'follow');
  results.head_noredirect = await probe('head_noredirect', 'HEAD', 'manual');
  results.get_follow = await probe('get_follow', 'GET', 'follow');

  push('done', { totalMs: Date.now() - startedAt });

  ctx.set('Cache-Control', 'no-store');
  ctx.body = {
    targetUrl,
    timeoutMs,
    totalMs: Date.now() - startedAt,
    results,
    log,
  };
});

router.get('/api/check', async (ctx) => {
  const platform = ctx.query.platform;
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }
  const startedAt = Date.now();
  let latest;
  let warning = null;
  try {
    // Tighter budget than the default (4 tries × 8s ≈ 37s, which can blow
    // past EdgeOne's ~30s function cap). 3 tries × 6s + backoff ≈ 20s max,
    // leaving room for the cache read and response serialisation.
    latest = await getLatestVersionInfo(platform, { tries: 3, timeoutMs: 6000, baseMs: 600 });
  } catch (e) {
    // cursor.com unreachable. Rather than surfacing a hard 502 ("出错了"),
    // degrade gracefully: fall back to the cached meta so the user at least
    // sees the version they already have, and flag it with a warning.
    const cached = await getCachedMeta(platform);
    if (cached && cached.status === 'ready') {
      latest = metaToLatest(cached);
      warning = `暂时无法连接 Cursor 官网（${describeFetchError(e)}），以下为本地缓存数据`;
    } else {
      ctx.status = 502;
      ctx.body = { error: 'fetch_latest_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
      return;
    }
  }
  const cached = await getCachedMeta(platform);
  const ready = cached && cached.status === 'ready';
  const sameCommit = ready && latest.commit && cached.commit === latest.commit;
  const needsUpdate = !sameCommit;
  let reason;
  if (needsUpdate) {
    reason = !cached ? 'no_cache' : !ready ? 'download_incomplete' : 'new_version';
  } else {
    reason = warning ? 'up_to_date_cached' : 'up_to_date';
  }
  ctx.body = { latest, cached, needsUpdate, reason, warning, durationMs: Date.now() - startedAt };
});

// Per-step update — downloads a BATCH of chunks (default 4, parallel) per
// invocation. This is the endpoint the frontend calls in a loop: it dodges
// the EdgeOne function execution-time cap (~30s) and gives natural progress
// reporting. Each batch of 4 × 6 MB downloads in ~3-15s, well under the cap.
//
// Query params:
//   count=<n>  chunks to download concurrently per call (default 4, max 8)
//
// State machine (persisted in meta/{platform}):
//   - No meta, or meta.commit != latest.commit, or force:
//       -> delete old chunks, write a fresh meta with status='downloading'
//       -> return action='started' (no chunk fetched yet this call)
//   - meta.status === 'downloading' and !force:
//       -> FAST PATH: skip the cursor.com HEAD re-check and go straight to
//          the next missing chunks.
//       -> download up to `count` missing chunks concurrently
//       -> if all chunks done, flip status to 'ready' and set completedAt
//       -> return action='chunk_done' | 'completed'
//   - meta.status === 'ready' and meta.commit === latest.commit and !force:
//       -> return action='skipped'
router.post('/api/update-step', async (ctx) => {
  const platform = ctx.query.platform;
  const force = ctx.query.force === 'true' || ctx.query.force === '1';
  const count = Math.min(Math.max(parseInt(ctx.query.count, 10) || 4, 1), 8);
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }

  const startedAt = Date.now();

  // ---------- FAST PATH: resume an in-progress download ----------
  let cached = await getCachedMeta(platform);
  if (!force && cached && cached.status === 'downloading' && cached.commit && cached.sourceUrl
      && cached.chunkSize === CHUNK_SIZE) {
    const resumeResult = await resumeDownload(platform, cached, startedAt, null, count);
    if (resumeResult.body) {
      ctx.body = resumeResult.body;
      return;
    }
    ctx.status = 502;
    ctx.body = resumeResult.error || { error: 'resume_failed' };
    return;
  }

  // ---------- SLOW PATH: re-check cursor.com (first call, force, or ready) ----------
  let latest;
  try {
    latest = await getLatestVersionInfo(platform);
  } catch (e) {
    ctx.status = 502;
    ctx.body = { error: 'fetch_latest_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
    return;
  }

  cached = await getCachedMeta(platform);
  const ready = cached && cached.status === 'ready';
  const sameCommit = ready && latest.commit && cached.commit === latest.commit;

  // Already up to date — nothing to do.
  if (!force && sameCommit) {
    ctx.body = {
      action: 'skipped',
      reason: 'already_latest',
      latest,
      cached,
      progress: {
        chunksDone: cached.chunksDone ? cached.chunksDone.length : cached.chunkCount,
        chunksTotal: cached.chunkCount,
        bytesDownloaded: cached.fileSize,
        bytesTotal: cached.fileSize,
        chunkIndex: -1,
      },
      durationMs: Date.now() - startedAt,
    };
    return;
  }

  // Start (or restart) a download for this commit.
  const hadPreviousCache = !!cached;
  const startFresh = !cached || cached.commit !== latest.commit || force
    || cached.chunkSize !== CHUNK_SIZE;
  if (startFresh) {
    let totalSize, chunkCount;
    try {
      ({ totalSize, chunkCount } = await probeRangeSupport(latest.url));
    } catch (e) {
      ctx.status = 502;
      ctx.body = { error: 'probe_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
      return;
    }

    let deletedChunks = 0;
    try { deletedChunks = await deleteOldChunks(platform); } catch (_) {}

    cached = {
      status: 'downloading',
      platform,
      version: latest.version,
      commit: latest.commit,
      fileName: latest.fileName,
      fileSize: totalSize,
      chunkCount,
      chunkSize: CHUNK_SIZE,
      contentType: latest.contentType,
      sourceUrl: latest.url,
      sourceLastModified: latest.lastModified,
      chunksDone: [],
      cachedAt: new Date().toISOString(),
      completedAt: null,
    };
    await saveCachedMeta(platform, cached);

    ctx.body = {
      action: 'started',
      reason: force ? 'forced' : (!hadPreviousCache ? 'no_previous_cache' : 'new_version_available'),
      deletedChunks,
      latest,
      cached,
      progress: {
        chunksDone: 0,
        chunksTotal: chunkCount,
        bytesDownloaded: 0,
        bytesTotal: totalSize,
        chunkIndex: -1,
      },
      durationMs: Date.now() - startedAt,
    };
    return;
  }

  ctx.status = 500;
  ctx.body = {
    error: 'update_step_unreachable',
    detail: 'No state transition matched. This indicates a bug in the state machine.',
    durationMs: Date.now() - startedAt,
  };
});

// Resume helper: downloads the next missing chunks (up to `count` in
// parallel) for an in-progress download. Returns either { body } (success)
// or { error } (failure).
async function resumeDownload(platform, cached, startedAt, latest, count) {
  const chunksDoneSet = new Set(cached.chunksDone || []);
  let nextIndex = -1;
  for (let i = 0; i < cached.chunkCount; i++) {
    if (!chunksDoneSet.has(i)) { nextIndex = i; break; }
  }

  if (nextIndex === -1) {
    cached.status = 'ready';
    cached.completedAt = new Date().toISOString();
    await saveCachedMeta(platform, cached);
    return {
      body: {
        action: 'completed',
        reason: 'already_downloaded',
        latest: latest || metaToLatest(cached),
        cached,
        progress: {
          chunksDone: cached.chunksDone.length,
          chunksTotal: cached.chunkCount,
          bytesDownloaded: cached.fileSize,
          bytesTotal: cached.fileSize,
          chunkIndex: -1,
        },
        durationMs: Date.now() - startedAt,
      },
    };
  }

  let batch;
  try {
    batch = await downloadChunksInParallel(platform, cached, count || 4);
  } catch (e) {
    // Return action='retry' (HTTP 200) so the frontend loops again.
    return {
      body: {
        action: 'retry',
        reason: 'chunk_download_failed',
        detail: describeFetchError(e),
        latest: latest || metaToLatest(cached),
        cached,
        progress: {
          chunksDone: cached.chunksDone.length,
          chunksTotal: cached.chunkCount,
          bytesDownloaded: sumBytesDone(cached),
          bytesTotal: cached.fileSize,
          chunkIndex: nextIndex,
        },
        durationMs: Date.now() - startedAt,
      },
    };
  }

  if (batch.done.length === 0) {
    const first = batch.failed[0];
    return {
      body: {
        action: 'retry',
        reason: 'chunk_download_failed',
        detail: first ? first.error : 'chunk download failed',
        latest: latest || metaToLatest(cached),
        cached,
        progress: {
          chunksDone: cached.chunksDone.length,
          chunksTotal: cached.chunkCount,
          bytesDownloaded: sumBytesDone(cached),
          bytesTotal: cached.fileSize,
          chunkIndex: nextIndex,
        },
        durationMs: Date.now() - startedAt,
      },
    };
  }

  const bytesDownloaded = sumBytesDone(cached);

  let action = 'chunk_done';
  if (cached.chunksDone.length >= cached.chunkCount) {
    cached.status = 'ready';
    cached.completedAt = new Date().toISOString();
    action = 'completed';
  }
  await saveCachedMeta(platform, cached);

  return {
    body: {
      action,
      reason: action === 'completed' ? 'all_chunks_done' : 'chunk_downloaded',
      latest: latest || metaToLatest(cached),
      cached,
      progress: {
        chunksDone: cached.chunksDone.length,
        chunksTotal: cached.chunkCount,
        bytesDownloaded,
        bytesTotal: cached.fileSize,
        chunkIndex: nextIndex,
        chunksDownloadedThisCall: batch.done.length,
      },
      durationMs: Date.now() - startedAt,
    },
  };
}

// ---------- Auto-update (for GitHub Actions cron) ----------

// POST /api/auto-update?platform=<id>
// Designed to be called repeatedly by an external scheduler (GitHub Actions).
// Each invocation:
//   1. If no download in progress, checks cursor.com for the latest version.
//   2. If an update is needed, starts/resumes the chunked download.
//   3. Downloads as many chunks as possible within a 25s time budget.
//   4. Returns the current state so the caller knows whether to call again.
router.post('/api/auto-update', async (ctx) => {
  const platform = ctx.query.platform || 'win32-x64-user';
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }

  const startedAt = Date.now();
  const TIME_BUDGET_MS = 25000;

  // ---- Phase 1: Check if we need to update ----
  let cached = await getCachedMeta(platform);
  const isInProgress = cached && cached.status === 'downloading'
    && cached.commit && cached.sourceUrl
    && cached.chunkSize === CHUNK_SIZE;

  let latest = null;
  let checkSkipped = false;

  if (isInProgress) {
    checkSkipped = true;
  } else {
    try {
      latest = await getLatestVersionInfo(platform);
    } catch (e) {
      ctx.status = 502;
      ctx.body = {
        action: 'error',
        error: 'fetch_latest_failed',
        detail: describeFetchError(e),
        durationMs: Date.now() - startedAt,
      };
      return;
    }
    cached = await getCachedMeta(platform);
    const ready = cached && cached.status === 'ready';
    const sameCommit = ready && latest.commit && cached.commit === latest.commit;
    if (sameCommit) {
      ctx.body = {
        action: 'skipped',
        reason: 'already_latest',
        latest,
        cached,
        progress: {
          chunksDone: cached.chunksDone ? cached.chunksDone.length : cached.chunkCount,
          chunksTotal: cached.chunkCount,
          bytesDownloaded: cached.fileSize,
          bytesTotal: cached.fileSize,
          chunkIndex: -1,
        },
        durationMs: Date.now() - startedAt,
      };
      return;
    }
    let totalSize, chunkCount;
    try {
      ({ totalSize, chunkCount } = await probeRangeSupport(latest.url));
    } catch (e) {
      ctx.status = 502;
      ctx.body = {
        action: 'error',
        error: 'probe_failed',
        detail: describeFetchError(e),
        durationMs: Date.now() - startedAt,
      };
      return;
    }
    try { await deleteOldChunks(platform); } catch (_) {}
    cached = {
      status: 'downloading',
      platform,
      version: latest.version,
      commit: latest.commit,
      fileName: latest.fileName,
      fileSize: totalSize,
      chunkCount,
      chunkSize: CHUNK_SIZE,
      contentType: latest.contentType,
      sourceUrl: latest.url,
      sourceLastModified: latest.lastModified,
      chunksDone: [],
      cachedAt: new Date().toISOString(),
      completedAt: null,
    };
    await saveCachedMeta(platform, cached);
  }

  // ---- Phase 2: Download chunks within the time budget ----
  // Chunks are downloaded in parallel batches (4 at a time) so each 25s call
  // advances the download ~4× faster than one chunk at a time. Chunks that
  // fail in this invocation are skipped (not retried) so the next batch can
  // make progress on other chunks; they are picked up by the following call.
  const BATCH_CONCURRENCY = 4;
  let chunksDownloadedThisCall = 0;
  let consecutiveFailures = 0;
  let lastError = null;
  const failedThisCall = new Set();

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const doneSet = new Set(cached.chunksDone || []);
    const missing = [];
    for (let i = 0; i < cached.chunkCount; i++) {
      if (!doneSet.has(i) && !failedThisCall.has(i)) missing.push(i);
    }
    if (missing.length === 0) break;

    let batch;
    try {
      batch = await downloadChunksInParallel(platform, cached, BATCH_CONCURRENCY, failedThisCall);
    } catch (e) {
      lastError = e;
      consecutiveFailures++;
      if (consecutiveFailures >= 5) break;
      await sleep(1000);
      continue;
    }
    chunksDownloadedThisCall += batch.done.length;
    if (batch.done.length > 0) consecutiveFailures = 0;
    if (batch.failed.length > 0) {
      lastError = new Error(batch.failed[0].error);
      consecutiveFailures += batch.failed.length;
      for (const f of batch.failed) failedThisCall.add(f.index);
    }
    if (consecutiveFailures >= 5) break;
    if (batch.failed.length > 0) await sleep(1000);
  }

  // ---- Phase 3: Check if we're done ----
  const allDone = cached.chunksDone.length >= cached.chunkCount;
  if (allDone) {
    cached.status = 'ready';
    cached.completedAt = new Date().toISOString();
    await saveCachedMeta(platform, cached);
  }

  if (!latest) latest = metaToLatest(cached);
  const bytesDownloaded = sumBytesDone(cached);
  const durationMs = Date.now() - startedAt;

  ctx.body = {
    action: allDone ? 'completed' : 'in_progress',
    reason: allDone ? 'all_chunks_downloaded' : checkSkipped ? 'resumed_download' : 'started_download',
    latest,
    cached,
    progress: {
      chunksDone: cached.chunksDone.length,
      chunksTotal: cached.chunkCount,
      bytesDownloaded,
      bytesTotal: cached.fileSize,
      chunkIndex: -1,
    },
    chunksDownloadedThisCall,
    consecutiveFailures,
    lastError: lastError ? describeFetchError(lastError) : null,
    durationMs,
    callAgain: !allDone,
  };
});

// ---------- Download endpoints ----------

router.get('/api/download-chunk', async (ctx) => {
  const platform = ctx.query.platform;
  const index = parseInt(ctx.query.index, 10);
  if (!isValidPlatform(platform) || Number.isNaN(index)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_params', detail: 'Need platform and index.' };
    return;
  }
  const meta = await getCachedMeta(platform);
  if (!meta || meta.status !== 'ready') {
    ctx.status = 404;
    ctx.body = { error: 'not_ready', detail: 'No cached installer. Run /api/update first.' };
    return;
  }
  if (index < 0 || index >= meta.chunkCount) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_index', detail: `index must be 0..${meta.chunkCount - 1}` };
    return;
  }
  const store = getStoreInstance();
  const buf = await store.get(`chunks/${platform}/${index}`, { type: 'arrayBuffer' });
  if (!buf) {
    ctx.status = 404;
    ctx.body = { error: 'chunk_missing', detail: `Chunk ${index} not found in blob storage.` };
    return;
  }
  ctx.set('Content-Type', 'application/octet-stream');
  ctx.set('Content-Length', String(buf.byteLength));
  ctx.body = Buffer.from(buf);
});

router.get('/api/download-manifest', async (ctx) => {
  const platform = ctx.query.platform;
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }
  const meta = await getCachedMeta(platform);
  if (!meta || meta.status !== 'ready') {
    ctx.status = 404;
    ctx.body = { error: 'not_ready', detail: 'No cached installer.' };
    return;
  }
  const chunks = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const start = i * meta.chunkSize;
    const end = Math.min(start + meta.chunkSize - 1, meta.fileSize - 1);
    chunks.push({
      index: i,
      url: `/koa/api/download-chunk?platform=${platform}&index=${i}`,
      size: end - start + 1,
    });
  }
  ctx.body = {
    platform,
    version: meta.version,
    commit: meta.commit,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    chunkCount: meta.chunkCount,
    chunkSize: meta.chunkSize,
    chunks,
  };
});

router.get('/api/download', async (ctx) => {
  const platform = ctx.query.platform;
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }
  const meta = await getCachedMeta(platform);
  if (!meta || meta.status !== 'ready') {
    ctx.status = 404;
    ctx.body = { error: 'not_ready' };
    return;
  }
  ctx.set('Content-Type', meta.contentType || 'application/octet-stream');
  ctx.set('Content-Disposition', `attachment; filename="${meta.fileName}"`);
  ctx.set('Content-Length', String(meta.fileSize));

  async function* reassemble() {
    const store = getStoreInstance();
    for (let i = 0; i < meta.chunkCount; i++) {
      const buf = await store.get(`chunks/${platform}/${i}`, { type: 'arrayBuffer' });
      if (!buf) {
        throw new Error(`chunk_missing: index=${i} total=${meta.chunkCount}; run POST /api/update?platform=${platform}&force=true to repair`);
      }
      yield Buffer.from(buf);
    }
  }

  ctx.body = Readable.from(reassemble());
});

// ---------- Changelog ----------

// Fetch the changelog page from cursor.com, extract readable text, and cache
// it in blob storage. Restricted environments can't reach cursor.com, so we
// mirror the content just like the installer.
async function fetchAndCacheChangelog() {
  const resp = await fetchWithRetry('https://www.cursor.com/changelog', {
    method: 'GET',
    headers: { ...FETCH_HEADERS, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  }, { tries: 3, timeoutMs: 10000 });
  if (!resp.ok) {
    throw new Error(`cursor.com changelog fetch failed: HTTP ${resp.status}`);
  }
  const html = await resp.text();

  // Extract only the main content area to avoid caching navigation, headers,
  // footers, and other boilerplate.
  let content = html;
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  content = content.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  content = content.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  content = content.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
  content = content.replace(/<link[^>]*>/gi, '');
  content = content.replace(/<meta[^>]*>/gi, '');
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  // Try to isolate <main> or <article>.
  let mainContent = '';
  const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    mainContent = mainMatch[1];
  } else {
    const articleMatch = content.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) mainContent = articleMatch[1];
  }
  let text = mainContent || content;

  // Convert to readable text.
  text = text.replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|tr|table|tbody|thead|br)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  if (text.length < 200) {
    text = content
      .replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|tr|table|tbody|thead|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
      .replace(/&hellip;/g, '…')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  const newHash = hashText(text);
  const store = getStoreInstance();

  // Read the previously cached source so we can detect whether the upstream
  // changelog actually changed. If the hash matches, we keep the existing
  // translation status (no need to re-translate an identical text).
  let previous = null;
  try {
    previous = await store.get('changelog/cached', { type: 'json' });
  } catch (_) {}
  const sameContent = previous && previous.hash && previous.hash === newHash;

  const changelogData = {
    text,
    sourceUrl: 'https://www.cursor.com/changelog',
    fetchedAt: new Date().toISOString(),
    hash: newHash,
  };

  if (sameContent && previous) {
    // Content unchanged — preserve the previous fetch time + translation
    // status so we don't churn the cache or trigger needless LLM calls.
    changelogData.fetchedAt = previous.fetchedAt;
    changelogData.translationStatus = previous.translationStatus || (llmConfigured() ? 'pending' : 'none');
    changelogData.translatedAt = previous.translatedAt || null;
    await store.setJSON('changelog/cached', changelogData);
    return changelogData;
  }

  // Content is new (or first cache). Decide what to do about translation:
  //   - LLM not configured → translationStatus='none', move on.
  //   - A matching cached translation already exists → reuse it.
  //   - Otherwise → mark 'pending' and kick the LLM off in the background.
  //     The response NEVER waits for the LLM: a slow/failed translation must
  //     not stall the changelog fetch (a synchronous call can take 15-25s and
  //     blow past EdgeOne's ~30s function execution cap, which is exactly the
  //     "一直加载中/失败" symptom this fixes). The translation is finalised by
  //     GET /api/changelog?lang=zh on demand or by the daily cron job.
  if (!llmConfigured()) {
    changelogData.translationStatus = 'none';
    changelogData.translatedAt = null;
    await store.setJSON('changelog/cached', changelogData);
    return changelogData;
  }

  const existingZh = await getCachedTranslation(newHash, 'changelog/cached_zh');
  if (existingZh) {
    changelogData.translationStatus = 'done';
    changelogData.translatedAt = existingZh.translatedAt;
    await store.setJSON('changelog/cached', changelogData);
    return changelogData;
  }

  // Mark pending, persist the source first so a crash mid-translation still
  // leaves the original changelog readable, then kick off a background pass
  // (best-effort — the process may be recycled right after the response, so
  // the resumable on-demand passes from /api/changelog?lang=zh are the
  // reliable mechanism).
  changelogData.translationStatus = 'pending';
  changelogData.translatedAt = null;
  changelogData.passStartedAt = new Date().toISOString();
  await store.setJSON('changelog/cached', changelogData);

  runTranslationPass(changelogData, 'changelog', 'changelog/cached_zh');
  return changelogData;
}

router.get('/api/changelog', async (ctx) => {
  const force = ctx.query.force === 'true' || ctx.query.force === '1';
  const lang = ctx.query.lang === 'zh' ? 'zh' : 'orig';
  const store = getStoreInstance();
  const startedAt = Date.now();

  // ---------- Chinese translation branch (?lang=zh) ----------
  // The translation is keyed by the source hash, so we always need the
  // current source object first to know which hash to look up / translate.
  if (lang === 'zh') {
    // Make sure we have a source changelog. Don't auto-refresh from
    // cursor.com here — that's the original-language branch's job. If there
    // is no cache at all, fall through to a 404 with a helpful message.
    let source = null;
    try {
      source = await store.get('changelog/cached', { type: 'json' });
    } catch (_) {}

    // Migration: blobs written by older code have no `hash` field. Derive it
    // from the text on the fly so the translation lookup/trigger still works,
    // and persist the backfilled hash so subsequent reads are cheap.
    if (source && source.text && !source.hash) {
      source.hash = hashText(source.text);
      try { await store.setJSON('changelog/cached', source); } catch (_) {}
    }

    if (source && source.hash) {
      // 1. Reuse a matching cached translation (may be 'partial' — some
      //    sections still in English while the background pass keeps going).
      const zh = await getCachedTranslation(source.hash, 'changelog/cached_zh');
      if (zh) {
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { changelog: zh, durationMs: Date.now() - startedAt };
        return;
      }
      // 2. No usable translation. Run ONE resumable pass INLINE, bounded by
      //    SECTION_BUDGET_MS so the request stays well under EdgeOne's ~30s
      //    function cap. Each pass translates a few sections and persists
      //    them; the client polls and the next request resumes from there.
      //    Never wait on the full changelog in a single call — the gateway
      //    takes ~8-10s per section, far too slow to finish inline.
      if (llmConfigured()) {
        const lastPass = source.passStartedAt ? Date.parse(source.passStartedAt) : 0;
        if (!Number.isFinite(lastPass) || Date.now() - lastPass > PASS_THROTTLE_MS) {
          source.passStartedAt = new Date().toISOString();
          try { await store.setJSON('changelog/cached', source); } catch (_) {}
          await runTranslationPass(source, 'changelog', 'changelog/cached_zh');
        }
        // Re-read after the pass — it may have finished (or partially
        // finished) the translation within this request.
        const zhAfter = await getCachedTranslation(source.hash, 'changelog/cached_zh');
        if (zhAfter) {
          ctx.set('Cache-Control', 'no-store');
          ctx.body = { changelog: zhAfter, durationMs: Date.now() - startedAt };
          return;
        }
      }
      ctx.status = 404;
      ctx.body = {
        error: 'translation_unavailable',
        translationStatus: llmConfigured() ? 'pending' : 'none',
        detail: llmConfigured()
          ? 'Translation is being generated in the background. Try again in a few seconds.'
          : 'EdgeOne Makers AI Gateway key is not configured (apikey).',
        durationMs: Date.now() - startedAt,
      };
      return;
    }

    // No source changelog at all — ask the client to load the original first.
    ctx.status = 404;
    ctx.body = {
      error: 'no_changelog',
      detail: 'Changelog has not been fetched yet. Open the changelog once to populate the cache, then switch to 简体中文.',
      durationMs: Date.now() - startedAt,
    };
    return;
  }

  // ---------- Original-language branch ----------
  let changelog = null;
  if (!force) {
    try {
      changelog = await store.get('changelog/cached', { type: 'json' });
    } catch (_) {}
  }

  if (!changelog) {
    try {
      changelog = await fetchAndCacheChangelog();
    } catch (e) {
      if (!force) {
        try {
          changelog = await store.get('changelog/cached', { type: 'json' });
        } catch (_) {}
      }
      if (changelog) {
        ctx.body = {
          changelog,
          warning: `Failed to refresh from cursor.com: ${describeFetchError(e)}. Showing cached version from ${changelog.fetchedAt}.`,
          durationMs: Date.now() - startedAt,
        };
        return;
      }
      ctx.status = 502;
      ctx.body = { error: 'fetch_changelog_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
      return;
    }
  }

  // Sync the translation badge/status: the source blob's translationStatus is
  // set to 'pending' when the content changes, but the authoritative state
  // lives in the zh blob (per-section progress). Reflect it here so the
  // frontend badge + prefetch stay accurate.
  if (changelog && changelog.hash) {
    try {
      const zh = await getCachedTranslation(changelog.hash, 'changelog/cached_zh');
      if (zh) {
        changelog.translationStatus = zh.translationStatus;
        changelog.translatedAt = zh.translatedAt;
      }
    } catch (_) {}
  }

  ctx.set('Cache-Control', 'no-store');
  ctx.body = { changelog, durationMs: Date.now() - startedAt };
});

// ---------- Models & Pricing ----------

// Shared HTML→text extractor used by both changelog and models mirroring.
// Strips script/style/nav/header/footer, isolates <main>/<article>, converts
// block tags to newlines, decodes entities, and collapses whitespace.
function htmlToReadableText(html) {
  let content = html;
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  content = content.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  content = content.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  content = content.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
  content = content.replace(/<link[^>]*>/gi, '');
  content = content.replace(/<meta[^>]*>/gi, '');
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  let mainContent = '';
  const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    mainContent = mainMatch[1];
  } else {
    const articleMatch = content.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) mainContent = articleMatch[1];
  }
  let text = mainContent || content;

  const decode = (s) => s
    .replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|tr|table|tbody|thead|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  text = decode(text);
  // Fallback: if <main> extraction was too aggressive (very short), decode
  // the whole stripped content instead.
  if (text.length < 200) text = decode(content);
  return text;
}

const MODELS_SOURCE_URL = 'https://cursor.com/docs/models-and-pricing';
const MODELS_SOURCE_BLOB = 'models/cached';

// Parse a cursor.com docs JS chunk and extract the model pricing table.
// The chunk embeds an array of model objects as a JS object literal, e.g.:
//   {name:"Claude 4.6 Sonnet",provider:"Anthropic",tokenInput:3,
//    cacheWrite:3.75,cacheRead:.3,tokenOutput:15,contextWindow:"200k",
//    maxContextWindow:"1M",isAgent:!0,thinking:!0,hidden:!0,...}
// We anchor on `name:"..."` (robust to nested object boundaries) and pull
// each field from the segment between consecutive names. Variant records
// named "Thinking"/"Fast Mode"/"Long Context (>200k)" inherit the preceding
// main model name so rows are self-describing.
function parseModelsFromChunk(js) {
  const nameRe = /name:"((?:[^"\\]|\\.)*)"/g;
  const names = [];
  let m;
  while ((m = nameRe.exec(js)) !== null) names.push(m);
  if (names.length === 0) return [];

  const fld = (seg, key) => {
    const r = new RegExp(key + ':(!0|!1|true|false|"[^"]*"|\\d*\\.?\\d+|\\[[^\\]]*\\])');
    const mm = seg.match(r);
    if (!mm) return null;
    const v = mm[1];
    if (v === '!0' || v === 'true') return true;
    if (v === '!1' || v === 'false') return false;
    if (v.startsWith('"')) return v.slice(1, -1);
    if (v.startsWith('[')) return v;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : v;
  };

  const VARIANT_NAMES = new Set(['Thinking', 'Fast Mode', 'Long Context (>200k)']);
  const rows = [];
  let lastName = '';
  for (let i = 0; i < names.length; i++) {
    const rawName = names[i][1].replace(/\\"/g, '"');
    const segStart = names[i].index + names[i][0].length;
    const segEnd = i + 1 < names.length ? names[i + 1].index : js.length;
    let seg = js.slice(segStart, segEnd);
    if (seg.indexOf('tokenInput') === -1 && i > 0) {
      // fields may precede the name; look back to previous name
      seg = js.slice(names[i - 1].index + names[i - 1][0].length, segEnd);
    }
    if (seg.indexOf('tokenInput') === -1) continue;
    const ti = fld(seg, 'tokenInput');
    if (ti == null) continue;

    let displayName = rawName;
    if (VARIANT_NAMES.has(rawName)) {
      displayName = lastName ? `${lastName} — ${rawName}` : rawName;
    } else {
      lastName = rawName;
    }
    rows.push({
      name: displayName,
      provider: fld(seg, 'provider'),
      tokenInput: ti,
      cacheWrite: fld(seg, 'cacheWrite'),
      cacheRead: fld(seg, 'cacheRead'),
      tokenOutput: fld(seg, 'tokenOutput'),
      contextWindow: fld(seg, 'contextWindow'),
      maxContextWindow: fld(seg, 'maxContextWindow'),
      isAgent: fld(seg, 'isAgent'),
      thinking: fld(seg, 'thinking'),
      hidden: fld(seg, 'hidden'),
    });
  }
  return rows;
}

// Render the parsed model array as a Markdown table (per-million-token USD).
function renderModelsMarkdown(rows) {
  const fmt = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (v === true) return '✓';
    if (v === false) return '';
    if (typeof v === 'number') return '$' + v;
    return String(v);
  };
  const header = '| Model | Provider | Input | Cache Write | Cache Read | Output | Context | Max |';
  const sep = '|---|---|---|---|---|---|---|---|';
  const lines = rows.map((r) =>
    `| ${r.name} | ${r.provider || ''} | ${fmt(r.tokenInput)} | ${fmt(r.cacheWrite)} | ${fmt(r.cacheRead)} | ${fmt(r.tokenOutput)} | ${r.contextWindow || '—'} | ${r.maxContextWindow || '—'} |`
  );
  return [header, sep, ...lines].join('\n');
}

// Fetch the cursor.com/docs/models-and-pricing HTML, discover the JS chunk
// that embeds the per-model token-pricing table, parse it, and cache both
// the structured rows and a Markdown rendering. The chunk filename is a
// hash that changes on every cursor.com deploy, so we discover it at runtime
// by fetching all referenced chunks in parallel and picking the one whose
// body contains `tokenInput:`. This runs once per cron refresh (daily) and
// on first user visit; subsequent reads are cache hits.
async function fetchAndCacheModels() {
  const resp = await fetchWithRetry(MODELS_SOURCE_URL, {
    method: 'GET',
    headers: { ...FETCH_HEADERS, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  }, { tries: 3, timeoutMs: 12000 });
  if (!resp.ok) {
    throw new Error(`cursor.com docs fetch failed: HTTP ${resp.status}`);
  }
  const html = await resp.text();

  // Extract every <script src="..."> chunk URL.
  const srcs = [];
  const srcRe = /<script[^>]*\ssrc=["']([^"']+)["']/gi;
  let mm;
  while ((mm = srcRe.exec(html)) !== null) srcs.push(mm[1]);
  // Resolve chunk URLs. The docs page references chunks as root-relative
  // paths like "/docs-static/_next/static/chunks/xxx.js". These must be
  // joined to the ORIGIN of the FINAL url after redirect — cursor.com
  // redirects to www.cursor.com, so resp.url gives the correct origin.
  // (Using the hardcoded MODELS_SOURCE_URL origin would produce
  // https://cursor.com/docs-static/... while the page was actually
  // served from https://www.cursor.com — and using the docs PATH
  // https://cursor.com/docs would yield a 404 /docs/docs-static/... )
  const finalOrigin = resp.url ? new URL(resp.url).origin : new URL(MODELS_SOURCE_URL).origin;
  const absUrls = srcs
    .map((s) => {
      if (s.startsWith('http')) return s;
      if (s.startsWith('//')) return 'https:' + s;
      if (s.startsWith('/')) return finalOrigin + s;
      return finalOrigin + '/' + s;
    })
    // only the docs-static chunk pool
    .filter((s) => /\/_next\/static\/chunks\//.test(s));
  if (absUrls.length === 0) {
    throw new Error('no JS chunks referenced by cursor.com docs page');
  }

  // Fetch chunks in parallel (bounded) and pick the one with the pricing data.
  const CONCURRENCY = 12;
  let dataChunk = null;
  for (let i = 0; i < absUrls.length && !dataChunk; i += CONCURRENCY) {
    const batch = absUrls.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (u) => {
      const r = await fetchWithRetry(u, {
        method: 'GET',
        headers: { ...FETCH_HEADERS, Accept: '*/*' },
        redirect: 'follow',
      }, { tries: 1, timeoutMs: 9000 });
      if (!r.ok) return null;
      const body = await r.text();
      // Match `tokenInput:<digit>` — the DATA chunk has `tokenInput:3` (a
      // literal price), while the COMPONENT chunk only has `tokenInput:a.x`
      // (a property accessor). This discriminator avoids picking the wrong
      // chunk when the component logic appears before the data in the
      // script list.
      return /tokenInput:\d/.test(body) ? body : null;
    }));
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) { dataChunk = res.value; break; }
    }
  }
  if (!dataChunk) {
    throw new Error('pricing data chunk not found among ' + absUrls.length + ' chunks');
  }

  const rows = parseModelsFromChunk(dataChunk);
  if (rows.length === 0) {
    throw new Error('parsed 0 models from pricing chunk');
  }
  const text = renderModelsMarkdown(rows);
  const newHash = hashText(text);

  const store = getStoreInstance();
  let previous = null;
  try {
    previous = await store.get(MODELS_SOURCE_BLOB, { type: 'json' });
  } catch (_) {}
  const sameContent = previous && previous.hash && previous.hash === newHash;

  const modelsData = {
    text,
    models: rows,
    sourceUrl: MODELS_SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    hash: newHash,
  };
  if (sameContent && previous) {
    modelsData.fetchedAt = previous.fetchedAt;
  }
  await store.setJSON(MODELS_SOURCE_BLOB, modelsData);
  return modelsData;
}

// GET /api/models?force=<bool>
// Mirrors the cursor.com/docs/models-and-pricing per-model token pricing
// table (Input / Cache Write / Cache Read / Output per million tokens).
// Shown in English as-is (no translation — prices are universal). The cron
// job calls ?force=true daily so the cache stays fresh.
router.get('/api/models', async (ctx) => {
  const force = ctx.query.force === 'true' || ctx.query.force === '1';
  const store = getStoreInstance();
  const startedAt = Date.now();

  let models = null;
  if (!force) {
    try {
      models = await store.get(MODELS_SOURCE_BLOB, { type: 'json' });
    } catch (_) {}
  }

  if (!models) {
    try {
      models = await fetchAndCacheModels();
    } catch (e) {
      if (!force) {
        try {
          models = await store.get(MODELS_SOURCE_BLOB, { type: 'json' });
        } catch (_) {}
      }
      if (models) {
        ctx.body = {
          models,
          warning: `Failed to refresh from cursor.com: ${describeFetchError(e)}. Showing cached version from ${models.fetchedAt}.`,
          durationMs: Date.now() - startedAt,
        };
        return;
      }
      ctx.status = 502;
      ctx.body = { error: 'fetch_models_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
      return;
    }
  }

  ctx.set('Cache-Control', 'no-store');
  ctx.body = { models, durationMs: Date.now() - startedAt };
});

app.use(router.routes());
app.use(router.allowedMethods());

export default app;
