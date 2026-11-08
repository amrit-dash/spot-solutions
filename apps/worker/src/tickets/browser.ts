// The browser ticket syncs run in. Cloudflare in front of BookMyShow refuses plain HTTP clients and headless Chrome
// (both headless modes tested), so this is the same Chrome WhatsApp uses, headed, minimised as soon as it opens (macOS
// pulls off-screen windows back into view, so moving it away isn't enough). It stays open between syncs and is reused,
// so the window appears once, not every 15 minutes; it closes after IDLE_MS without a sync. Each API call runs as a
// fetch from a page on the dashboard's own origin, exactly as the dashboard does.
// A Linux server without a desktop needs a virtual display: run the worker under `xvfb-run` (docs/tickets.md).
import { createRequire } from "node:module";
import type { Browser, Page, PuppeteerNode } from "puppeteer";
import { BMS_API, BMS_HEADERS, BMS_ORIGIN, type ApiCall } from "./bms.ts";

const IDLE_MS = 40 * 60_000;

/**
 * puppeteer, loaded only when a sync needs it, so the worker always starts. A server whose update didn't install the
 * worker's own copy (pnpm skipped it) borrows whatsapp-web.js's, which every install has.
 */
async function loadPuppeteer(): Promise<PuppeteerNode> {
  try {
    return (await import("puppeteer")).default as unknown as PuppeteerNode;
  } catch {
    const req = createRequire(import.meta.url);
    return createRequire(req.resolve("whatsapp-web.js"))("puppeteer") as PuppeteerNode;
  }
}

let queue: Promise<unknown> = Promise.resolve();
let shared: { browser: Browser; page: Page } | null = null;
let idle: NodeJS.Timeout | null = null;

/** One ticket browser per server, one run at a time, so many accounts never open many Chromes. */
export function withTicketBrowser<T>(fn: (call: ApiCall) => Promise<T>): Promise<T> {
  const run = queue.then(() => runOnce(fn));
  queue = run.catch(() => undefined);
  return run;
}

async function minimise(page: Page) {
  try {
    const cdp = await page.createCDPSession();
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    await cdp.detach();
  } catch (e) {
    console.warn("[tickets] couldn't minimise the ticket browser:", (e as Error).message);
  }
}

async function open(): Promise<{ browser: Browser; page: Page }> {
  if (shared?.browser.connected && !shared.page.isClosed()) return shared;
  await close();
  if (process.platform === "linux" && !process.env.DISPLAY) {
    throw new Error("Ticket sync needs a display for its browser. Start the worker under xvfb-run (see docs/tickets.md).");
  }
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--window-position=-2400,-2400", "--window-size=800,600", "--no-first-run", "--no-default-browser-check"],
    defaultViewport: null,
    // The worker's shutdown closes it (closeTicketBrowser); puppeteer's own handlers would exit the process mid-drain.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await minimise(page);
  // A small page on the dashboard's origin is enough for the API's CORS check; the full app isn't needed.
  await page.goto(`${BMS_ORIGIN}/robots.txt`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  browser.on("disconnected", () => {
    if (shared?.browser === browser) shared = null;
  });
  shared = { browser, page };
  return shared;
}

async function close() {
  const s = shared;
  shared = null;
  await s?.browser.close().catch(() => undefined);
}

/** Close the ticket browser now (worker shutdown). */
export const closeTicketBrowser = () => {
  if (idle) clearTimeout(idle);
  return close();
};

async function runOnce<T>(fn: (call: ApiCall) => Promise<T>): Promise<T> {
  if (idle) clearTimeout(idle);
  try {
    const { page } = await open();
    return await fn(apiCall(page));
  } catch (e) {
    // A crashed page or a dead browser: start fresh next time.
    if (!shared?.browser.connected || shared.page.isClosed()) await close();
    throw e;
  } finally {
    idle = setTimeout(() => void close(), IDLE_MS);
    idle.unref();
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
