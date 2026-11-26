/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Bounded Chunk Streaming Proxy (/api/chunk)

   Zero-buffering, CDN-cacheable 128 KB slice proxy for Google Drive documents.
   - Allowlists strictly against public/manifest.json (loaded once at module init)
   - Enforces query allowlist, canonical version tag ?v=, and 128 KB alignment
   - Passes Drive API key via X-Goog-Api-Key with safe manual redirect validation
   - Rejects HTML interstitials (502), size drift (409), truncated chunks (502),
     and upstream timeouts at 8s (504) with Cache-Control: no-store on all errors
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const manifest = require('../public/manifest.json');

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_ALIGN_BYTES = 131072; // 128 KB canonical CDN slice size
const MAX_CHUNK_BYTES = 262144; // 256 KB hard ceiling per range slice
const MAX_FULL_BYTES = 4 * 1024 * 1024; // 4 MB hard ceiling for mode=full
const UPSTREAM_TIMEOUT_MS = 8000; // Abort before Vercel Hobby 10s hard kill
const MAX_REDIRECT_HOPS = 3;
const SAFE_DRIVE_ID_RE = /^[a-zA-Z0-9_-]{10,64}$/;
const DIGIT_ONLY_RE = /^\d+$/;
const SAFE_DRIVE_URL_RE = /^https:\/\/(drive|docs)\.google\.com\//i;
const SAFE_REDIRECT_HOST_RE = /^([a-z0-9-]+\.)*(google\.com|googleusercontent\.com|googleapis\.com)$/i;
const ALLOWED_CHUNK_QUERY_KEYS = new Set(['id', 'mode', 'start', 'end', 'v']);
const ALLOWED_FULL_QUERY_KEYS = new Set(['id', 'mode', 'v', 'download']);
const TOKEN_TTL_FALLBACK_MS = 50 * 60 * 1000;

/** @type {Map<string, object>} */
const ALLOWED_FILES = new Map(
  Array.isArray(manifest)
    ? manifest
        .filter((item) => item && typeof item.fileId === 'string')
        .map((item) => [item.fileId, item])
    : []
);

let cachedSaToken = { token: null, expiresAt: 0 };

// ── Error & Header Helpers ────────────────────────────────────────────────────

function computeCanonicalVersion(entry) {
  const ts = Date.parse(entry?.uploadedAt || '');
  return Number.isFinite(ts) ? String(ts) : '1';
}

function sanitizeDownloadFileName(rawName, fileExt = 'PDF') {
  const extRaw = String(fileExt || 'PDF').trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const effectiveExt = !extRaw || extRaw === 'GDOC' || extRaw === 'GSLIDES' ? 'PDF' : extRaw;
  const extLower = effectiveExt.toLowerCase();

  let cleaned = String(rawName || '')
    .replace(/[\x00-\x1f\x7f"\\/:*?<>|';]+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');

  if (!cleaned) {
    cleaned = 'document';
  }

  const extSuffix = `.${extLower}`;
  if (extRaw === 'GDOC' || extRaw === 'GSLIDES') {
    cleaned = cleaned.replace(/\.(gdoc|gslides)$/i, '');
  }
  if (!cleaned.toLowerCase().endsWith(extSuffix)) {
    cleaned = `${cleaned.slice(0, Math.max(1, 140 - extSuffix.length)).replace(/[.\s]+$/g, '') || 'document'}${extSuffix}`;
  } else if (cleaned.length > 140) {
    const base = cleaned.slice(0, cleaned.length - extSuffix.length).slice(0, Math.max(1, 140 - extSuffix.length)).replace(/[.\s]+$/g, '') || 'document';
    cleaned = `${base}${extSuffix}`;
  }

  const asciiName = cleaned.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || `document${extSuffix}`;
  return { asciiName, utf8Name: cleaned };
}

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
}

function sendError(res, status, code, message, extra = {}) {
  res.statusCode = status;
  setNoStoreHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ error: code, message, ...extra }));
}

function parseSearchParams(req) {
  if (req && req.url) {
    try {
      return new URL(req.url, 'http://localhost').searchParams;
    } catch (_) {
      // Fall through to req.query
    }
  }
  const params = new URLSearchParams();
  if (req && req.query && typeof req.query === 'object') {
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, String(item));
        } else {
          params.set(k, String(v));
        }
      }
    }
  }
  return params;
}

function validateQueryAllowlist(query, allowedKeys) {
  const seen = new Set();
  for (const key of query.keys()) {
    if (!allowedKeys.has(key) || seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

// ── Upstream Auth & Safe Redirect Transport ───────────────────────────────────

class UnsafeRedirectError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeRedirectError';
  }
}

class UnsafeUpstreamUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeUpstreamUrlError';
  }
}

async function getServiceAccountToken() {
  const now = Date.now();
  if (cachedSaToken.token && cachedSaToken.expiresAt > now + 60_000) {
    return cachedSaToken.token;
  }

  const rawKey = process.env.GOOGLE_SA_KEY;
  if (!rawKey) return null;

  const { google } = require('googleapis');
  const credentials = JSON.parse(rawKey);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) {
    throw new Error('Failed to obtain Google OAuth2 access token.');
  }

  const expiryDate = client.credentials?.expiry_date;
  cachedSaToken = {
    token,
    expiresAt: typeof expiryDate === 'number' ? expiryDate : now + TOKEN_TTL_FALLBACK_MS,
  };
  return token;
}

async function buildUpstreamRequest(entry, rangeHeader) {
  const fileId = entry.fileId;
  const mimeType = String(entry.mimeType || '');
  const isWorkspaceDoc = mimeType.startsWith('application/vnd.google-apps.');
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  const headers = {};

  if (rangeHeader && !isWorkspaceDoc) {
    headers.Range = rangeHeader;
  }

  let url;
  if (apiKey) {
    headers['X-Goog-Api-Key'] = apiKey;
    url = isWorkspaceDoc
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    return { url, headers, isWorkspaceDoc };
  }

  if (process.env.GOOGLE_SA_KEY) {
    const token = await getServiceAccountToken();
    headers.Authorization = `Bearer ${token}`;
    url = isWorkspaceDoc
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=application/pdf`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    return { url, headers, isWorkspaceDoc };
  }

  if (isWorkspaceDoc) {
    if (!SAFE_DRIVE_URL_RE.test(entry.downloadUrl || '')) {
      throw new UnsafeUpstreamUrlError('Invalid Workspace export URL in manifest.');
    }
    url = entry.downloadUrl;
  } else {
    url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  }
  return { url, headers, isWorkspaceDoc };
}

function stripCredentialHeaders(headersObj) {
  const next = {};
  for (const [k, v] of Object.entries(headersObj || {})) {
    const lower = k.toLowerCase();
    if (lower === 'x-goog-api-key' || lower === 'authorization') continue;
    next[k] = v;
  }
  return next;
}

async function fetchWithSafeRedirects(initialUrl, initialHeaders, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  let currentUrl = initialUrl;
  let currentHeaders = { ...(initialHeaders || {}) };

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const res = await fetch(currentUrl, {
      method: 'GET',
      headers: currentHeaders,
      redirect: 'manual',
      signal,
    });

    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel?.().catch(() => {});
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new UnsafeRedirectError('Exceeded maximum upstream redirect hops.');
      }

      const location = res.headers?.get?.('location');
      if (!location) {
        throw new UnsafeRedirectError('Upstream redirect missing Location header.');
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch (_) {
        throw new UnsafeRedirectError('Malformed upstream redirect URL.');
      }

      if (nextUrl.protocol !== 'https:' || !SAFE_REDIRECT_HOST_RE.test(nextUrl.hostname)) {
        throw new UnsafeRedirectError('Blocked redirect to untrusted upstream origin.');
      }

      currentUrl = nextUrl.toString();
      currentHeaders = stripCredentialHeaders(currentHeaders);
      continue;
    }

    return res;
  }

  throw new UnsafeRedirectError('Exceeded maximum upstream redirect hops.');
}

// ── Bounded Stream Reader ─────────────────────────────────────────────────────

class PayloadLimitError extends Error {
  constructor(limitBytes) {
    super(`Upstream payload exceeded limit of ${limitBytes} bytes.`);
    this.name = 'PayloadLimitError';
    this.limitBytes = limitBytes;
  }
}

async function readBoundedBuffer(upstreamRes, maxBytes) {
  if (!upstreamRes.body) {
    if (typeof upstreamRes.arrayBuffer === 'function') {
      const ab = await upstreamRes.arrayBuffer();
      if (ab.byteLength > maxBytes) {
        throw new PayloadLimitError(maxBytes);
      }
      return Buffer.from(ab);
    }
    return Buffer.alloc(0);
  }

  const reader = upstreamRes.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PayloadLimitError(maxBytes);
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_) { }
  }

  return Buffer.concat(chunks, totalBytes);
}

// ── Core Request Execution ────────────────────────────────────────────────────

async function handleRequest(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported.');
  }

  const query = parseSearchParams(req);
  const mode = query.get('mode') || 'chunk';

  if (mode !== 'chunk' && mode !== 'full') {
    return sendError(res, 400, 'INVALID_MODE', 'Mode must be "chunk" or "full".');
  }

  const allowedKeys = mode === 'full' ? ALLOWED_FULL_QUERY_KEYS : ALLOWED_CHUNK_QUERY_KEYS;
  if (!validateQueryAllowlist(query, allowedKeys)) {
    return sendError(res, 400, 'UNEXPECTED_QUERY_PARAM', 'Unexpected or duplicate query parameters.');
  }

  const isDownloadAttachment = query.has('download');
  if (isDownloadAttachment && query.get('download') !== '1') {
    return sendError(res, 400, 'INVALID_DOWNLOAD_PARAM', 'Query param download must be "1" when present.');
  }

  const fileId = query.get('id') || '';
  if (!SAFE_DRIVE_ID_RE.test(fileId)) {
    return sendError(res, 400, 'INVALID_FILE_ID', 'Invalid or missing Drive file ID.');
  }

  const entry = ALLOWED_FILES.get(fileId);
  if (!entry) {
    return sendError(res, 403, 'FILE_NOT_ALLOWLISTED', 'Requested file ID is not in the verified manifest.');
  }

  const versionParam = query.get('v');
  const expectedVersion = computeCanonicalVersion(entry);
  if (versionParam !== expectedVersion) {
    return sendError(res, 400, 'INVALID_VERSION_TAG', 'Invalid or stale manifest version tag.');
  }

  const isWorkspaceDoc = String(entry.mimeType || '').startsWith('application/vnd.google-apps.');

  let start = 0;
  let effectiveEnd = null;
  let maxAllowedBytes = MAX_CHUNK_BYTES;
  let rangeHeader = null;

  if (mode === 'full') {
    if (!isWorkspaceDoc && Number.isSafeInteger(entry.fileSize) && entry.fileSize > MAX_FULL_BYTES) {
      return sendError(
        res,
        413,
        'FULL_MODE_SIZE_EXCEEDED',
        'File exceeds the 4 MB limit for mode=full. Use chunked range requests.'
      );
    }
    maxAllowedBytes = MAX_FULL_BYTES;
  } else {
    if (isWorkspaceDoc) {
      return sendError(res, 400, 'RANGE_UNSUPPORTED_FOR_WORKSPACE', 'Google Workspace exports require mode=full.');
    }

    const startStr = query.get('start');
    const endStr = query.get('end');
    if (!DIGIT_ONLY_RE.test(startStr || '') || !DIGIT_ONLY_RE.test(endStr || '')) {
      return sendError(res, 400, 'INVALID_RANGE_PARAMS', 'Query params start and end must be non-negative integers.');
    }

    start = Number(startStr);
    const requestedEnd = Number(endStr);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start) {
      return sendError(res, 400, 'INVALID_RANGE_BOUNDS', 'Range bounds must be safe non-negative integers with end >= start.');
    }

    if (Number.isSafeInteger(entry.fileSize) && entry.fileSize > 0 && start >= entry.fileSize) {
      res.setHeader('Content-Range', `bytes */${entry.fileSize}`);
      return sendError(res, 416, 'RANGE_START_OUT_OF_BOUNDS', 'Requested start offset exceeds file size.');
    }

    if (requestedEnd - start + 1 > MAX_CHUNK_BYTES) {
      return sendError(
        res,
        416,
        'CHUNK_SIZE_EXCEEDED',
        `Requested chunk exceeds ${MAX_CHUNK_BYTES}-byte limit.`
      );
    }

    if (start % CHUNK_ALIGN_BYTES !== 0) {
      return sendError(
        res,
        400,
        'UNALIGNED_CHUNK_START',
        `Chunk start offset must be aligned to ${CHUNK_ALIGN_BYTES}-byte boundaries.`
      );
    }

    const fullAlignedEnd = start + CHUNK_ALIGN_BYTES - 1;
    if (Number.isSafeInteger(entry.fileSize) && entry.fileSize > 0) {
      const expectedEnd = Math.min(fullAlignedEnd, entry.fileSize - 1);
      if (requestedEnd !== expectedEnd && requestedEnd !== fullAlignedEnd) {
        return sendError(
          res,
          400,
          'UNALIGNED_CHUNK_END',
          'Chunk end offset does not match aligned 128 KB slice boundary.'
        );
      }
      effectiveEnd = expectedEnd;
    } else {
      if (requestedEnd !== fullAlignedEnd) {
        return sendError(
          res,
          400,
          'UNALIGNED_CHUNK_END',
          'Chunk end offset does not match aligned 128 KB slice boundary.'
        );
      }
      effectiveEnd = requestedEnd;
    }

    maxAllowedBytes = MAX_CHUNK_BYTES;
    rangeHeader = `bytes=${start}-${effectiveEnd}`;
  }

  let upstreamRequest;
  try {
    upstreamRequest = await buildUpstreamRequest(entry, rangeHeader);
  } catch (authErr) {
    if (authErr instanceof UnsafeUpstreamUrlError) {
      return sendError(res, 400, 'INVALID_UPSTREAM_URL', 'Manifest upstream URL failed security validation.');
    }
    return sendError(res, 500, 'UPSTREAM_AUTH_FAILED', 'Upstream Drive authentication failed.');
  }

  let upstreamRes;
  try {
    upstreamRes = await fetchWithSafeRedirects(upstreamRequest.url, upstreamRequest.headers, UPSTREAM_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof UnsafeRedirectError) {
      return sendError(res, 502, 'UPSTREAM_UNSAFE_REDIRECT', 'Upstream attempted an unsafe redirect.', {
        retryable: false,
      });
    }
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Upstream Google Drive request timed out.', {
        retryable: true,
      });
    }
    return sendError(res, 502, 'UPSTREAM_NETWORK_ERROR', 'Failed to reach Google Drive.', {
      retryable: true,
    });
  }

  const upstreamContentType = upstreamRes.headers.get('content-type') || '';
  if (/text\/html/i.test(upstreamContentType)) {
    await upstreamRes.body?.cancel?.().catch(() => {});
    return sendError(
      res,
      502,
      'UPSTREAM_HTML_INTERSTITIAL',
      'Upstream returned HTML instead of document bytes.',
      { retryable: true }
    );
  }

  if (mode === 'chunk' && upstreamRes.status === 416) {
    await upstreamRes.body?.cancel?.().catch(() => {});
    return sendError(
      res,
      409,
      'FILE_SIZE_DRIFT',
      'Document size changed in Google Drive since last index sync.',
      { retryable: false }
    );
  }

  if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
    await upstreamRes.body?.cancel?.().catch(() => {});
    return sendError(
      res,
      502,
      'UPSTREAM_HTTP_ERROR',
      `Upstream Drive returned HTTP ${upstreamRes.status}.`,
      {
        upstreamStatus: upstreamRes.status,
        retryable: upstreamRes.status === 429 || upstreamRes.status >= 500,
      }
    );
  }

  if (mode === 'chunk') {
    const contentRange = upstreamRes.headers.get('content-range') || '';
    const crMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (crMatch && crMatch[3] !== '*') {
      const actualTotal = Number(crMatch[3]);
      if (Number.isSafeInteger(entry.fileSize) && entry.fileSize > 0 && actualTotal !== entry.fileSize) {
        await upstreamRes.body?.cancel?.().catch(() => {});
        return sendError(
          res,
          409,
          'FILE_SIZE_DRIFT',
          'Document size changed in Google Drive since last index sync.',
          { retryable: false }
        );
      }
    }
  }

  const declaredLenHeader = upstreamRes.headers.get('content-length');
  if (declaredLenHeader && DIGIT_ONLY_RE.test(declaredLenHeader.trim())) {
    const declaredLen = Number(declaredLenHeader.trim());
    if (declaredLen > maxAllowedBytes) {
      await upstreamRes.body?.cancel?.().catch(() => {});
      return mode === 'full'
        ? sendError(res, 413, 'FULL_MODE_SIZE_EXCEEDED', 'Upstream response exceeds 4 MB mode=full limit.')
        : sendError(res, 502, 'UPSTREAM_RANGE_IGNORED', 'Upstream exceeded requested chunk byte limit.', {
            retryable: true,
          });
    }
  }

  let buffer;
  try {
    buffer = await readBoundedBuffer(upstreamRes, maxAllowedBytes);
  } catch (readErr) {
    if (readErr instanceof PayloadLimitError) {
      return mode === 'full'
        ? sendError(res, 413, 'FULL_MODE_SIZE_EXCEEDED', 'Upstream payload exceeded 4 MB mode=full limit.')
        : sendError(res, 502, 'UPSTREAM_RANGE_IGNORED', 'Upstream exceeded requested chunk byte limit.', {
            retryable: true,
          });
    }
    if (readErr && (readErr.name === 'TimeoutError' || readErr.name === 'AbortError')) {
      return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Upstream stream timed out.', { retryable: true });
    }
    return sendError(res, 502, 'UPSTREAM_STREAM_ERROR', 'Failed reading upstream stream.', {
      retryable: true,
    });
  }

  if (mode === 'chunk' && Number.isSafeInteger(entry.fileSize) && entry.fileSize > 0) {
    const expectedLen = effectiveEnd - start + 1;
    if (buffer.length !== expectedLen) {
      return sendError(
        res,
        502,
        'UPSTREAM_TRUNCATED_CHUNK',
        'Upstream returned an incomplete chunk payload.',
        { retryable: true }
      );
    }
  }

  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    mode === 'full'
      ? (isWorkspaceDoc ? 'application/pdf' : (entry.mimeType || 'application/octet-stream'))
      : 'application/octet-stream'
  );
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=2592000, immutable');
  res.setHeader('CDN-Cache-Control', 'public, s-maxage=2592000, immutable');
  res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=2592000, immutable');

  if (mode === 'full' && isDownloadAttachment) {
    const { asciiName, utf8Name } = sanitizeDownloadFileName(
      entry.fileName || entry.courseTitle || entry.fileId,
      isWorkspaceDoc ? 'PDF' : (entry.fileExt || 'PDF')
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`
    );
  }

  if (mode === 'chunk') {
    const totalLabel = Number.isSafeInteger(entry.fileSize) && entry.fileSize > 0 ? String(entry.fileSize) : '*';
    const actualEnd = buffer.length > 0 ? start + buffer.length - 1 : start;
    res.setHeader('X-Content-Range', `bytes ${start}-${actualEnd}/${totalLabel}`);
  }

  res.end(req.method === 'HEAD' ? undefined : buffer);
}

async function handler(req, res) {
  try {
    await handleRequest(req, res);
  } catch (_) {
    if (!res.headersSent) {
      sendError(res, 500, 'INTERNAL_PROXY_ERROR', 'Unexpected proxy error.');
    } else {
      try {
        res.end();
      } catch (__) { }
    }
  }
}

handler._internal = {
  ALLOWED_FILES,
  CHUNK_ALIGN_BYTES,
  MAX_CHUNK_BYTES,
  MAX_FULL_BYTES,
  UPSTREAM_TIMEOUT_MS,
  MAX_REDIRECT_HOPS,
  computeCanonicalVersion,
  sanitizeDownloadFileName,
  validateQueryAllowlist,
  parseSearchParams,
  readBoundedBuffer,
  buildUpstreamRequest,
  fetchWithSafeRedirects,
  stripCredentialHeaders,
  UnsafeRedirectError,
  UnsafeUpstreamUrlError,
};

module.exports = handler;
