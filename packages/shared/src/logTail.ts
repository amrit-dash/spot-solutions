// A live log tail that only grows. Servers send their newest N lines on each refresh, so the oldest ones drop off the top
// every time; shown as-is, the text under a reader who scrolled up shifts or is replaced. Merging each refresh onto what
// is already shown keeps every line in place and adds new ones at the bottom. (The worker console page has a copy of this
// in plain JS: apps/worker/console/index.html, mergeLogTail.)

/** `prev` plus the lines of `next` that come after it. `next` starting over (a restarted server) is appended whole. */
export function mergeLogTail(prev: readonly string[], next: readonly string[], max = 2000): string[] {
  if (!prev.length) return next.slice(-max);
  // The longest end of prev that next starts with.
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) {
        same = false;
        break;
      }
    }
    if (same) return k === next.length ? (prev as string[]) : [...prev, ...next.slice(k)].slice(-max);
  }
  return [...prev, ...next].slice(-max);
}
