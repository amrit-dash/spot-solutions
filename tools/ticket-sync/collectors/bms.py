"""BookMyShow (HostMyShow DIY) collector.

Cloudflare blocks non-browser HTTP clients and headless Chromium, so each run
starts a short-lived real (headed) Chromium placed off-screen, loads the saved
session (state/bms.json), and calls the organizer JSON API from inside the
diy.hostmyshow.com page, exactly as the dashboard does. It closes after the run.
On a Linux server, run it under Xvfb (xvfb-run).

Session upkeep: the access token lasts 24h and BMS offers no refresh grant.
When under 3h remain, the collector logs in again with BMS_USERNAME/BMS_PASSWORD
from .env. If BMS answers with an OTP/MFA step instead of a token, it raises
SessionExpired; a human then runs capture.py bms and types the OTP.

Output: one normalized row per live session (eventCode + sessionId).

Usage:
    uv run python -m collectors.bms            # print rows as JSON
"""

from __future__ import annotations

import base64
import json
import os
import time
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "state" / "bms.json"
ORIGIN = "https://diy.hostmyshow.com"
API = "https://in.bookmyshow.com/api/le-diy"
IST = ZoneInfo("Asia/Kolkata")
APP_HEADERS = {"x-app-code": "WEB", "x-bms-le-app-code": "DIY", "accept": "application/json, text/plain, */*"}


class SessionExpired(Exception):
    """Saved token rejected and no credentials available to log in again."""


def _api(page: Page, method: str, path: str, token: str | None, body: dict | None = None) -> tuple[int, dict | None]:
    """Run a fetch inside the page so it goes through the real browser."""
    headers = dict(APP_HEADERS)
    if token:
        headers["authorization"] = token
    if body is not None:
        headers["content-type"] = "application/json"
    result = page.evaluate(
        """async ([url, method, headers, body]) => {
            const r = await fetch(url, {method, headers, body: body ? JSON.stringify(body) : undefined});
            let data = null;
            try { data = await r.json(); } catch (e) {}
            return [r.status, data];
        }""",
        [API + path, method, headers, body],
    )
    return result[0], result[1]


REFRESH_MARGIN_S = 3 * 3600


def _seconds_left(token: str) -> float:
    try:
        payload = token.split(" ", 1)[-1].split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))["exp"] - time.time()
    except Exception:
        return 0


def _token_from_state(context) -> str | None:
    for c in context.cookies(ORIGIN):
        if c["name"] == "accessToken" and c["value"]:
            t = unquote(c["value"])
            return t if t.lower().startswith("bearer") else "Bearer " + t
    return None


def _login(page: Page, context) -> str:
    """Password login (no OTP on this platform). Credentials come from .env only."""
    load_dotenv(ROOT / ".env")
    user, pw = os.getenv("BMS_USERNAME"), os.getenv("BMS_PASSWORD")
    if not (user and pw):
        raise SessionExpired("BMS session expired. Add BMS_USERNAME/BMS_PASSWORD to .env or rerun capture.py bms.")
    status, data = _api(page, "POST", "/v1/auth/token", None,
                        {"username": user, "password": pw, "grantType": "password"})
    raw = ((data or {}).get("data") or {}).get("accessToken") if isinstance(data, dict) else None
    if status != 200 or not raw:
        code = ((data or {}).get("errors") or {}).get("code") if isinstance(data, dict) else None
        raise SessionExpired(f"BMS wants an interactive login (HTTP {status}, {code or 'OTP/MFA step'}). "
                             "Run: uv run capture.py bms https://diy.hostmyshow.com")
    # Store the token the same way the site does, so the saved session stays usable.
    context.add_cookies([{"name": "accessToken", "value": raw, "domain": "diy.hostmyshow.com", "path": "/",
                          "secure": True, "sameSite": "Lax"}])
    return "Bearer " + raw


def _ist_iso(local: str) -> str:
    return datetime.strptime(local, "%Y-%m-%d %H:%M:%S").replace(tzinfo=IST).isoformat()


def collect() -> list[dict]:
    if not STATE.exists():
        raise SessionExpired("No saved BMS session. Run: uv run capture.py bms https://diy.hostmyshow.com")
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False, args=["--window-position=-2400,-2400", "--window-size=800,600"])
        context = browser.new_context(storage_state=str(STATE))
        try:
            page = context.new_page()
            page.goto(ORIGIN, wait_until="domcontentloaded")
            token = _token_from_state(context)
            if token is None or _seconds_left(token) < REFRESH_MARGIN_S:
                token = _login(page, context)

            status, data = _api(page, "GET", "/diy-event-creation/event-list?listType=live&start=0&limit=100&searchKey=", token)
            if status in (401, 403) and (data is not None or token is None):
                token = _login(page, context)
                status, data = _api(page, "GET", "/diy-event-creation/event-list?listType=live&start=0&limit=100&searchKey=", token)
            if status != 200 or not data:
                raise RuntimeError(f"BMS event-list HTTP {status} (non-JSON means Cloudflare blocked the browser)")

            rows = []
            for ev in data["data"]["list"]:
                code = ev["eventCode"]
                s, rep = _api(page, "GET", f"/v1/reports/event-wise/event/{code}/live", token)
                if s != 200 or not rep:
                    raise RuntimeError(f"BMS report for {code} HTTP {s}")
                for sess in rep["data"]["sessionWiseSummary"]["sessions"]:
                    sid, vnu = sess["sessionId"], sess.get("vnuCode", "")
                    s2, det = _api(page, "GET", f"/v1/reports/session-wise/event/{code}/session/{sid}?vnuCode={vnu}", token)
                    if s2 != 200 or not det:
                        raise RuntimeError(f"BMS session report {code}/{sid} HTTP {s2}")
                    d = det["data"]
                    raw_bookings = (d.get("bookingSummary") or {}).get("bookings") or []
                    bookings = [{
                        "booking_id": b["bookingId"],
                        "booked_at": _ist_iso(b["bookingTimeStamp"]),
                        "qty": int(b["ticketQuantity"]),
                        "category": b.get("ticketCatName"),
                        "amount": b.get("ticketAmount"),
                        "status": b.get("bookingStatus"),
                    } for b in raw_bookings]
                    total_rows = d.get("totalRowsCount")
                    synced = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    rows.append({
                        "platform": "bms",
                        "listing_id": code,
                        "session_id": str(sess["sessionId"]),
                        "listing_key": f"bms:{code}:{sess['sessionId']}",
                        "event_name": ev["eventName"],
                        "venue": sess.get("vnuName") or ev.get("venueName"),
                        "public_url": ev.get("eventUrl") or rep["data"].get("eventUrl"),
                        "show_datetime": _ist_iso(sess["sessionTime"]),
                        "sold": int(sess["ticketsSold"]),
                        "capacity": int(sess["totalInventory"]),
                        "remaining": (d.get("sessionWiseSummary") or {}).get("remainingTickets"),
                        "status": ev.get("status"),
                        "bookings": bookings,
                        # True when BMS capped the list (maxRowsLimit) and some bookings are missing
                        "bookings_truncated": isinstance(total_rows, int) and total_rows > len(raw_bookings),
                        "synced_at": synced,
                    })
            context.storage_state(path=str(STATE))  # keep any refreshed token
            os.chmod(STATE, 0o600)
            return rows
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    try:
        print(json.dumps(collect(), indent=2, ensure_ascii=False))
    except SessionExpired as e:
        sys.exit(f"SESSION: {e}")
