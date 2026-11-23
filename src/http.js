// fetch with timeout and retry on network errors / 429 / 5xx.
// The timeout also covers reading the body, so a slow server cannot block a job.
export const UA = process.env.USER_AGENT || "trail-fetcher/1.0 (self-hosted Wanderer companion)";

export async function fetchRetry(url, opts = {}, { tries = 4, timeout = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new Error(`Timeout after ${timeout / 1000}s from ${new URL(url).host}`)), timeout);
    try {
      const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      } else {
        return { ok: res.ok, status: res.status, text, json: async () => JSON.parse(text) };
      }
    } catch (e) {
      lastErr = ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : e;
    } finally {
      clearTimeout(t);
    }
    if (i < tries - 1) await sleep(2000 * 2 ** i);
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reject if a promise takes longer than ms.
export function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(msg)), ms)))]).finally(() => clearTimeout(t));
}
