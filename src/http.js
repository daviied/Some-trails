// fetch with timeout and retry on network errors / 429 / 5xx.
export const UA = process.env.USER_AGENT || "trail-fetcher/1.0 (self-hosted Wanderer companion)";

export async function fetchRetry(url, opts = {}, { tries = 4, timeout = 120000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(t);
    }
    await sleep(2000 * 2 ** i);
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
