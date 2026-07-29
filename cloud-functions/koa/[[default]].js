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
async function getLatestVersionInfo(platform) {
  const cfg = PLATFORMS[platform];
  const resp = await fetchWithRetry(cfg.url, { method: 'HEAD', redirect: 'follow', headers: FETCH_HEADERS });
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
      const probeResp = await fetchWithRetry(probe.url, { method: 'HEAD', redirect: 'follow', headers: FETCH_HEADERS });
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
// This project runs on EdgeOne Makers, which auto-injects an OpenAI-compatible
// AI Gateway on deploy with a free monthly token quota. We read those env vars
// first so translation works out of the box with zero extra configuration:
//
//   AI_GATEWAY_BASE_URL  — default https://ai-gateway.edgeone.link/v1
//   AI_GATEWAY_API_KEY   — Bearer token (auto-injected by Makers)
//   AI_GATEWAY_MODEL     — e.g. @makers/deepseek-v4-flash, @makers/hy3-prev
//
// For local dev or a non-Makers deploy, the generic LLM_* names are still
// honoured as a fallback. If neither set is present the feature is silently
// disabled and the rest of the site keeps working.
//   LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TIMEOUT_MS
const MAKERS_DEFAULT_BASE_URL = 'https://ai-gateway.edgeone.link/v1';
const MAKERS_DEFAULT_MODEL = '@makers/deepseek-v4-flash';

function getLLMConfig() {
  const baseUrl = (
    process.env.AI_GATEWAY_BASE_URL
    || process.env.LLM_API_BASE_URL
    || MAKERS_DEFAULT_BASE_URL
  ).trim().replace(/\/+$/, '');
  const apiKey = (
    process.env.AI_GATEWAY_API_KEY
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
// Makers defaults, so on a Makers deploy only the key needs to be injected
// (which Makers does automatically).
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

// Call an OpenAI-compatible /chat/completions endpoint to translate the
// changelog text into Simplified Chinese. Returns { ok, translation } on
// success or { ok: false, reason } on failure.
async function translateChangelogToZh(text) {
  const cfg = getLLMConfig();
  if (!llmConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }
  // Guard against absurdly long inputs that would blow the context window.
  // If the changelog ever grows past this, we still translate the head.
  const MAX_CHARS = 24000;
  const payload = text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + '\n\n[... truncated for translation ...]'
    : text;

  const systemPrompt = [
    'You are a professional software-release-note translator.',
    'Translate the user message from English into Simplified Chinese (简体中文).',
    'Rules:',
    '- Preserve all version numbers, dates, commit hashes, file names, and URLs verbatim.',
    '- Preserve Markdown/whitespace structure, bullet points, headings, and code blocks.',
    '- Keep the same line breaks; do not merge or split lines.',
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

// Read the cached Chinese translation, but only trust it if its hash matches
// the current source hash (otherwise the source changed and the translation
// is stale). Returns null if no usable translation exists.
async function getCachedTranslation(sourceHash) {
  const store = getStoreInstance();
  let zh = null;
  try {
    zh = await store.get('changelog/cached_zh', { type: 'json' });
  } catch (_) {}
  if (!zh || !zh.text || !zh.hash) return null;
  if (sourceHash && zh.hash !== sourceHash) return null;
  return zh;
}

// Translate the given source text and persist the result. Returns the stored
// translation object on success, or null on failure.
async function buildAndStoreTranslation(source) {
  if (!llmConfigured()) return null;
  const result = await translateChangelogToZh(source.text);
  if (!result.ok) return null;
  const zhData = {
    text: result.translation,
    sourceUrl: source.sourceUrl,
    fetchedAt: source.fetchedAt,
    translatedAt: new Date().toISOString(),
    hash: source.hash,
    translationStatus: 'done',
  };
  const store = getStoreInstance();
  await store.setJSON('changelog/cached_zh', zhData);
  return zhData;
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
      'POST /api/update-step?platform=<id>&force=<bool>': 'Download ONE chunk per call (resumable, for frontend loop)',
      'POST /api/auto-update?platform=<id>': 'Auto check + download within 25s budget (for cron). Loop until action=completed|skipped.',
      'GET /api/download-manifest?platform=<id>': 'Chunk manifest (use this + /api/download-chunk to fetch the installer)',
      'GET /api/download-chunk?platform=<id>&index=<n>': 'Fetch a single chunk (avoids the function response size cap)',
      'GET /api/download?platform=<id>': 'Legacy single-shot stream — will 413 for large files; prefer the manifest flow',
      'GET /api/changelog?force=<bool>': 'Fetch and cache the cursor.com changelog page as text',
      'GET /api/changelog?lang=zh': 'Get the Simplified-Chinese LLM translation of the cached changelog (auto-generated when source changes)',
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

router.get('/api/check', async (ctx) => {
  const platform = ctx.query.platform;
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }
  const startedAt = Date.now();
  let latest;
  try {
    latest = await getLatestVersionInfo(platform);
  } catch (e) {
    ctx.status = 502;
    ctx.body = { error: 'fetch_latest_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
    return;
  }
  const cached = await getCachedMeta(platform);
  const ready = cached && cached.status === 'ready';
  const sameCommit = ready && latest.commit && cached.commit === latest.commit;
  const needsUpdate = !sameCommit;
  let reason;
  if (needsUpdate) {
    reason = !cached ? 'no_cache' : !ready ? 'download_incomplete' : 'new_version';
  } else {
    reason = 'up_to_date';
  }
  ctx.body = { latest, cached, needsUpdate, reason, durationMs: Date.now() - startedAt };
});

// Per-step update — downloads ONE chunk per invocation. This is the endpoint
// the frontend calls in a loop: it dodges the EdgeOne function execution-time
// cap (~30s) and gives natural progress reporting.
//
// State machine (persisted in meta/{platform}):
//   - No meta, or meta.commit != latest.commit, or force:
//       -> delete old chunks, write a fresh meta with status='downloading'
//       -> return action='started' (no chunk fetched yet this call)
//   - meta.status === 'downloading' and !force:
//       -> FAST PATH: skip the cursor.com HEAD re-check and go straight to
//          the next missing chunk.
//       -> find the smallest chunk index not in chunksDone
//       -> download + store that one chunk
//       -> if all chunks done, flip status to 'ready' and set completedAt
//       -> return action='chunk_done' | 'completed'
//   - meta.status === 'ready' and meta.commit === latest.commit and !force:
//       -> return action='skipped'
router.post('/api/update-step', async (ctx) => {
  const platform = ctx.query.platform;
  const force = ctx.query.force === 'true' || ctx.query.force === '1';
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
    const resumeResult = await resumeDownload(platform, cached, startedAt);
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

// Resume helper: downloads the next missing chunk for an in-progress download.
// Returns either { body } (success) or { error } (failure).
async function resumeDownload(platform, cached, startedAt, latest) {
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

  let range;
  try {
    range = await downloadSingleChunk(platform, cached.sourceUrl, nextIndex, cached.fileSize, cached.chunkSize);
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

  cached.chunksDone.push(nextIndex);
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
        chunkSize: range.size,
        chunkStart: range.start,
        chunkEnd: range.end,
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
  const chunksDoneSet = new Set(cached.chunksDone || []);
  let chunksDownloadedThisCall = 0;
  let consecutiveFailures = 0;
  let lastError = null;

  for (let i = 0; i < cached.chunkCount; i++) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    if (chunksDoneSet.has(i)) continue;

    try {
      await downloadSingleChunk(platform, cached.sourceUrl, i, cached.fileSize, cached.chunkSize);
      cached.chunksDone.push(i);
      chunksDoneSet.add(i);
      chunksDownloadedThisCall++;
      consecutiveFailures = 0;
      await saveCachedMeta(platform, cached);
    } catch (e) {
      lastError = e;
      consecutiveFailures++;
      if (consecutiveFailures >= 5) break;
      await sleep(1000);
    }
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
  //   - Otherwise → synchronously call the LLM once; if it succeeds, mark
  //     'done'; if it fails, mark 'failed' so the client can show the
  //     "translation unavailable" state instead of looping forever.
  if (!llmConfigured()) {
    changelogData.translationStatus = 'none';
    changelogData.translatedAt = null;
    await store.setJSON('changelog/cached', changelogData);
    return changelogData;
  }

  const existingZh = await getCachedTranslation(newHash);
  if (existingZh) {
    changelogData.translationStatus = 'done';
    changelogData.translatedAt = existingZh.translatedAt;
    await store.setJSON('changelog/cached', changelogData);
    return changelogData;
  }

  // Mark pending, persist the source first so a crash mid-translation still
  // leaves the original changelog readable, then attempt the LLM call.
  changelogData.translationStatus = 'pending';
  changelogData.translatedAt = null;
  await store.setJSON('changelog/cached', changelogData);

  const zh = await buildAndStoreTranslation(changelogData);
  if (zh) {
    changelogData.translationStatus = 'done';
    changelogData.translatedAt = zh.translatedAt;
  } else {
    changelogData.translationStatus = 'failed';
  }
  await store.setJSON('changelog/cached', changelogData);
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

    if (source && source.hash) {
      // 1. Reuse a matching cached translation.
      let zh = await getCachedTranslation(source.hash);
      // 2. If the LLM is configured but the translation is missing/failed,
      //    try to produce it on demand so the user's first click still works.
      if (!zh && llmConfigured() && source.translationStatus !== 'pending') {
        zh = await buildAndStoreTranslation(source);
        if (zh) {
          source.translationStatus = 'done';
          source.translatedAt = zh.translatedAt;
          try { await store.setJSON('changelog/cached', source); } catch (_) {}
        }
      }
      if (zh) {
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { changelog: zh, durationMs: Date.now() - startedAt };
        return;
      }
      // No translation available right now.
      ctx.status = 404;
      ctx.body = {
        error: 'translation_unavailable',
        translationStatus: source.translationStatus || (llmConfigured() ? 'pending' : 'none'),
        detail: llmConfigured()
          ? 'Translation is not ready yet. Try the original text and switch back in a few seconds.'
          : 'EdgeOne Makers AI Gateway key is not configured (AI_GATEWAY_API_KEY).',
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

  ctx.set('Cache-Control', 'no-store');
  ctx.body = { changelog, durationMs: Date.now() - startedAt };
});

app.use(router.routes());
app.use(router.allowedMethods());

export default app;
