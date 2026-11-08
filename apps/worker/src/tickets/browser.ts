// A short-lived real Chrome for ticket platforms. Cloudflare in front of BookMyShow refuses plain HTTP clients and
// headless Chrome, so this opens the same Chrome WhatsApp uses, headed but placed off-screen, loads a page on the
// dashboard's origin and runs each API call as a fetch from there, exactly as the dashboard does. It closes after the
// run. A Linux server without a desktop needs a virtual display: run the worker under `xvfb-run` (deploy docs).
import puppeteer, { type Browser, type Page } from "puppeteer";
import { BMS_API, BMS_HEADERS, BMS_ORIGIN, type ApiCall } from "./bms.ts";

let queue: Promise<unknown> = Promise.resolve();

/** One ticket browser at a time across the whole server, so many accounts never open many Chromes. */
export function withTicketBrowser<T>(fn: (call: ApiCall) => Promise<T>): Promise<T> {
  const run = queue.then(() => runOnce(fn));
  queue = run.catch(() => undefined);
  return run;
}

async function runOnce<T>(fn: (call: ApiCall) => Promise<T>): Promise<T> {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    throw new Error("Ticket sync needs a display for its browser. Start the worker under xvfb-run (see docs/tickets.md).");
  }
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--window-position=-2400,-2400", "--window-size=800,600", "--no-first-run", "--no-default-browser-check"],
      defaultViewport: null,
    });
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    // A small page on the dashboard's origin is enough for the API's CORS check; the full app isn't needed.
    await page.goto(`${BMS_ORIGIN}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return await fn(apiCall(page));
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function apiCall(page: Page): ApiCall {
  return async (method, path, token, body) => {
    const headers: Record<string, string> = { ...BMS_HEADERS };
    if (token) headers.authorization = /^bearer /i.test(token) ? token : `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const [status, data] = await page.evaluate(
      async (url: string, m: string, h: Record<string, string>, b: string | null) => {
        try {
          const r = await fetch(url, { method: m, headers: h, body: b ?? undefined });
          let d: unknown = null;
          try {
            d = await r.json();
          } catch {
            /* not JSON: Cloudflare page or empty */
          }
          return [r.status, d] as const;
        } catch {
          return [0, null] as const; // network error or a CORS-less Cloudflare block
        }
      },
      BMS_API + path, method, headers, body === undefined ? null : JSON.stringify(body),
    );
    return { status, data };
  };
}
