import Koa from 'koa';
import Router from '@koa/router';
import { Readable } from 'stream';
import { getStore } from '@edgeone/pages-blob';

// ---------- Configuration ----------

const STORE_NAME = 'cursor-cache';
// 24 MB per chunk — safely below the 25 MB single-blob limit
const CHUNK_SIZE = 24 * 1024 * 1024;

// Cursor official "golden" download API — /cursor/3.5 always redirects to the
// newest 3.5.x build for the given platform. We follow the redirect and read
// the production URL (which contains the commit hash + version) to detect
// updates reliably across all platforms (macOS filenames don't include version).
const PLATFORMS = {
  'win32-x64-user': {
    label: 'Windows x64 (User Setup)',
    fileExt: '.exe',
    contentType: 'application/x-msdos-program',
    url: 'https://api2.cursor.sh/updates/download/golden/win32-x64-user/cursor/3.5',
  },
  'darwin-arm64': {
    label: 'macOS Apple Silicon (ARM64)',
    fileExt: '.dmg',
    contentType: 'application/x-apple-diskimage',
    url: 'https://api2.cursor.sh/updates/download/golden/darwin-arm64/cursor/3.5',
  },
  'darwin-x64': {
    label: 'macOS Intel (x64)',
    fileExt: '.dmg',
    contentType: 'application/x-apple-diskimage',
    url: 'https://api2.cursor.sh/updates/download/golden/darwin-x64/cursor/3.5',
  },
  'linux-x64': {
    label: 'Linux x64 (AppImage)',
    fileExt: '.AppImage',
    contentType: 'binary/octet-stream',
    url: 'https://api2.cursor.sh/updates/download/golden/linux-x64/cursor/3.5',
  },
};

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

// Retry a fetch operation a few times with exponential backoff. The EdgeOne
// egress to cursor.com is flaky — a single request often fails with a generic
// "fetch failed", but a retry a second later succeeds.
async function fetchWithRetry(url, opts = {}, { tries = 4, baseMs = 800 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url, opts);
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
//   https://downloads.cursor.com/production/009bb5a3.../win32/x64/user-setup/CursorUserSetup-x64-3.5.38.exe
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
  return {
    platform,
    version: info.version,
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

// Download using HTTP Range requests, one CHUNK_SIZE slice at a time.
// Each slice is fetched independently with its own retry, so a flaky egress
// can't kill the whole 177 MB download — only the failing slice is retried.
// Returns { chunkCount, totalSize, ranges: [...] }.
async function downloadAndChunk(platform, latestInfo) {
  const store = getStoreInstance();
  const totalSize = latestInfo.fileSize && latestInfo.fileSize > 0
    ? latestInfo.fileSize
    : 0;

  if (!totalSize) {
    throw new Error('Cannot range-download: latest.fileSize is unknown (cursor.com did not return Content-Length).');
  }

  // downloads.cursor.com is fronted by CloudFront and supports Range requests.
  // We double-check by probing with a 0-0 range; if the server ignores Range
  // we abort early and let the caller show a clear error.
  const probeResp = await fetchWithRetry(latestInfo.url, {
    method: 'GET',
    headers: { ...FETCH_HEADERS, Range: 'bytes=0-0' },
    redirect: 'follow',
  });
  if (probeResp.status !== 206) {
    throw new Error(`Range requests not supported (probe returned HTTP ${probeResp.status}). Cannot safely chunk-download.`);
  }
  const acceptRanges = probeResp.headers.get('accept-ranges');
  const contentRange = probeResp.headers.get('content-range') || '';
  const declaredTotal = contentRange.match(/\/(\d+)/);
  if (declaredTotal && parseInt(declaredTotal[1], 10) !== totalSize) {
    // Trust the content-range; update the size we use for chunking.
    latestInfo.fileSize = parseInt(declaredTotal[1], 10);
  }
  // Close probe body to free the connection.
  try { await probeResp.body.cancel(); } catch (_) {}

  const finalTotal = latestInfo.fileSize;
  const chunkCount = Math.ceil(finalTotal / CHUNK_SIZE);
  const ranges = [];

  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    // Range end is inclusive.
    const end = Math.min(start + CHUNK_SIZE - 1, finalTotal - 1);

    let buf = null;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const resp = await fetch(latestInfo.url, {
          method: 'GET',
          headers: { ...FETCH_HEADERS, Range: `bytes=${start}-${end}` },
          redirect: 'follow',
        });
        if (!resp.ok && resp.status !== 206 && resp.status !== 200) {
          throw new Error(`HTTP ${resp.status} for range ${start}-${end}`);
        }
        buf = await resp.arrayBuffer();
        if (!buf || buf.byteLength === 0) {
          throw new Error('empty body for range');
        }
        // CloudFront may return fewer bytes than requested on the last chunk;
        // that's fine. For non-final chunks, verify size.
        if (i < chunkCount - 1 && buf.byteLength !== (end - start + 1)) {
          throw new Error(`short read: expected ${end - start + 1}, got ${buf.byteLength}`);
        }
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleep(800 * Math.pow(2, attempt));
      }
    }
    if (!buf) {
      throw new Error(`chunk ${i} (${start}-${end}) failed after retries: ${describeFetchError(lastErr)}`);
    }

    await store.set(`chunks/${platform}/${i}`, buf);
    ranges.push({ index: i, start, end, size: buf.byteLength });
  }

  return { chunkCount, totalSize: finalTotal, ranges };
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
      'POST /api/update?platform=<id>&force=<true|false>': 'If newer (or force), delete old chunks, download, re-chunk, save meta. Otherwise skip.',
      'GET /api/download?platform=<id>': 'Stream the cached installer (reassembled from chunks)',
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
  try {
    const latest = await getLatestVersionInfo(platform);
    const cached = await getCachedMeta(platform);
    const sameCommit = cached && latest.commit && cached.commit === latest.commit;
    const needsUpdate = !sameCommit;
    let reason;
    if (!cached) reason = 'no_cached_version';
    else if (!latest.commit) reason = 'no_commit_on_latest';
    else if (sameCommit) reason = 'up_to_date';
    else reason = 'new_version_available';
    ctx.body = {
      latest,
      cached,
      needsUpdate,
      reason,
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    ctx.status = 502;
    ctx.body = { error: 'check_failed', detail: describeFetchError(e) };
  }
});

// Smart update — only re-download if needed, unless force=true.
// This is the endpoint the "检查更新" button calls.
router.post('/api/update', async (ctx) => {
  const platform = ctx.query.platform;
  const force = ctx.query.force === 'true' || ctx.query.force === '1';
  if (!isValidPlatform(platform)) {
    ctx.status = 400;
    ctx.body = { error: 'invalid_platform' };
    return;
  }

  const startedAt = Date.now();
  let latest, cached;
  try {
    latest = await getLatestVersionInfo(platform);
  } catch (e) {
    ctx.status = 502;
    ctx.body = { error: 'fetch_latest_failed', detail: describeFetchError(e), durationMs: Date.now() - startedAt };
    return;
  }

  cached = await getCachedMeta(platform);
  const sameCommit = cached && latest.commit && cached.commit === latest.commit;

  if (!force && sameCommit) {
    ctx.body = {
      action: 'skipped',
      reason: 'already_latest',
      latest,
      cached,
      durationMs: Date.now() - startedAt,
    };
    return;
  }

  // Need to (re)download.
  // 1. Drop cached meta first — if we crash mid-download, callers will see
  //    "no cached version" and retry, instead of seeing a stale meta pointing
  //    at chunks that no longer exist.
  await deleteCachedMeta(platform);

  // 2. Delete any old chunks (from previous version, or partial leftovers
  //    from a failed earlier attempt).
  let deletedChunks = 0;
  try {
    deletedChunks = await deleteOldChunks(platform);
  } catch (e) {
    // listing may fail on an empty store; non-fatal
  }

  // 3. Download + chunk
  let chunkCount = 0;
  let totalSize = 0;
  try {
    ({ chunkCount, totalSize } = await downloadAndChunk(platform, latest));
  } catch (e) {
    ctx.status = 502;
    ctx.body = {
      error: 'download_failed',
      detail: describeFetchError(e),
      deletedChunks,
      durationMs: Date.now() - startedAt,
    };
    return;
  }

  // 4. Save new metadata (atomic from the reader's perspective: once this
  //    lands, the cache is consistent).
  const newMeta = {
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
    cachedAt: new Date().toISOString(),
  };
  await saveCachedMeta(platform, newMeta);

  ctx.body = {
    action: 'updated',
    reason: force ? 'forced' : (!cached ? 'no_previous_cache' : 'new_version_available'),
    previousVersion: cached ? cached.version : null,
    previousCommit: cached ? cached.commit : null,
    deletedChunks,
    latest: newMeta,
    durationMs: Date.now() - startedAt,
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
  if (!meta) {
    ctx.status = 404;
    ctx.body = {
      error: 'no_cached_version',
      detail: 'POST /api/update?platform=<id> to download the installer first.',
    };
    return;
  }

  const store = getStoreInstance();
  const chunkCount = meta.chunkCount;

  ctx.set('Content-Type', meta.contentType || 'application/octet-stream');
  ctx.set('Content-Disposition', `attachment; filename="${meta.fileName}"`);
  ctx.set('Content-Length', String(meta.fileSize));
  ctx.set('X-Cursor-Version', meta.version || 'unknown');
  ctx.set('X-Cursor-Commit', meta.commit || 'unknown');
  ctx.set('X-Cursor-Cached-At', meta.cachedAt || '');
  ctx.set('X-Cursor-Chunks', String(chunkCount));
  ctx.set('X-Cursor-Source-Url', meta.sourceUrl || '');

  // Reassemble chunks back into a single streamed response.
  async function* reassemble() {
    for (let i = 0; i < chunkCount; i++) {
      const buf = await store.get(`chunks/${platform}/${i}`, { type: 'arrayBuffer' });
      if (!buf) {
        throw new Error(`chunk_missing: index=${i} total=${chunkCount}; run POST /api/update?platform=${platform}&force=true to repair`);
      }
      yield Buffer.from(buf);
    }
  }

  ctx.body = Readable.from(reassemble());
});

app.use(router.routes());
app.use(router.allowedMethods());

export default app;
