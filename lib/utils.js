import path from "node:path";

/**
 * Escapes HTML special characters so user-supplied text (filenames, IDs, etc.)
 * can never break Telegram's HTML parse mode or inject markup.
 */
export function escapeHtml(input) {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sanitizes a user-supplied filename so it can never escape the intended
 * directory (path traversal) and can't contain characters that break the
 * filesystem or Telegram captions.
 *
 * - Strips directory separators and ".." segments
 * - Strips control characters
 * - Collapses whitespace
 * - Enforces a max length (keeping the extension)
 * - Falls back to a safe default if nothing usable remains
 */
export function sanitizeFileName(rawName, fallback = "file") {
  if (!rawName || typeof rawName !== "string") return fallback;

  // Keep only the last path segment, dropping any directory components.
  let name = rawName.replace(/\\/g, "/").split("/").pop() || "";

  // Remove control characters and NULLs.
  name = name.replace(/[\x00-\x1f\x7f]/g, "");

  // Remove characters that are unsafe on common filesystems / Telegram.
  name = name.replace(/[<>:"|?*\u0000]/g, "");

  // Collapse ".." sequences that could still be used for traversal tricks.
  name = name.replace(/\.\.+/g, ".");

  // Trim leading dots/spaces/dashes that could hide the file or look like a flag.
  name = name.replace(/^[.\s-]+/, "").trim();

  if (!name) return fallback;

  // Enforce a reasonable max length while preserving the extension.
  const MAX_LEN = 180;
  if (name.length > MAX_LEN) {
    const ext = path.extname(name);
    const base = name.slice(0, MAX_LEN - ext.length);
    name = base + ext;
  }

  return name || fallback;
}

/** Sanitizes a free-text category/folder name (no extension logic needed). */
export function sanitizeCategoryName(rawName, fallback = "General") {
  if (!rawName || typeof rawName !== "string") return fallback;
  let name = rawName.replace(/[\x00-\x1f\x7f]/g, "").trim();
  name = name.replace(/[<>"]/g, "");
  if (!name) return fallback;
  if (name.length > 60) name = name.slice(0, 60);
  return name;
}

export function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return bytes + " B";
}

export function fmtSpeed(bytesPerSec) {
  if (bytesPerSec >= 1e9) return (bytesPerSec / 1e9).toFixed(1) + " GB/s";
  if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + " MB/s";
  if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(1) + " KB/s";
  return Math.round(bytesPerSec) + " B/s";
}

export function getExtension(filename) {
  const parts = String(filename).split(".");
  return parts.length > 1 ? parts.pop() : "";
}

export function bar(pct) {
  const filled = Math.min(10, Math.round(pct / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function normalizeId(id) {
  if (id == null) return "";
  return String(id).replace(/n$/, "");
}

/** Simple sliding-window rate limiter, e.g. "max 6 files per 60s per user". */
export class RateLimiter {
  constructor(maxEvents, windowMs) {
    this.maxEvents = maxEvents;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> array of timestamps
  }
  /** Returns true if the event is allowed (and records it). */
  allow(key) {
    const now = Date.now();
    let arr = this.hits.get(key);
    if (!arr) {
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length && now - arr[0] > this.windowMs) arr.shift();
    if (arr.length >= this.maxEvents) return false;
    arr.push(now);
    return true;
  }
  /** ms until the next slot frees up, for messaging the user. */
  retryAfterMs(key) {
    const arr = this.hits.get(key);
    if (!arr || !arr.length) return 0;
    return Math.max(0, this.windowMs - (Date.now() - arr[0]));
  }
}

/** Retries an async function with exponential backoff. */
export async function withRetry(fn, { retries = 2, baseDelayMs = 1500, shouldRetry = () => true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
