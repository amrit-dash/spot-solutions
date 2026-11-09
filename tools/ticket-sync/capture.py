"""Phase 0 capture: open a visible Chromium, let the human log in, record a HAR.

Usage:
    uv run capture.py <platform> <start_url>

You type credentials and any OTP yourself in the window. Then click through to
the events/sales view and any Reports/Export button. Come back to the terminal
and press Enter: the session cookies are saved to state/<platform>.json and the
full network log to captures/<platform>-<timestamp>.har. Both are gitignored
and written with owner-only permissions. Nothing is printed from them here.
"""

import os
import sys
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
CAPTURES = ROOT / "captures"
DONE = CAPTURES / ".done"


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: uv run capture.py <platform> <start_url>")
    platform, start_url = sys.argv[1], sys.argv[2]

    for d in (STATE, CAPTURES):
        d.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    har_path = CAPTURES / f"{platform}-{stamp}.har"
    state_path = STATE / f"{platform}.json"

    with sync_playwright() as p:
        # Real Chrome channel if installed (looks like a normal browser to bot checks);
        # falls back to bundled Chromium.
        try:
            browser = p.chromium.launch(headless=False, channel="chrome")
        except Exception:
            browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            # Reuse a saved session so a second capture doesn't need another login/OTP.
            storage_state=str(state_path) if state_path.exists() else None,
            record_har_path=str(har_path),
            record_har_content="embed",
            record_har_mode="full",
            viewport={"width": 1400, "height": 900},
        )
        page = context.new_page()
        page.goto(start_url)

        print(f"\nBrowser open at {start_url}")
        print("1. Log in (type credentials + any OTP yourself).")
        print("2. Open the events / sales view. Open one event's sales detail.")
        print("3. Click any Reports / Export / Download button you see.")
        print(f"\nFinish by closing the browser window, or: touch {DONE.relative_to(ROOT)}", flush=True)
        DONE.unlink(missing_ok=True)
        while not DONE.exists() and browser.is_connected() and context.pages:
            time.sleep(1)
        DONE.unlink(missing_ok=True)

        try:
            context.storage_state(path=str(state_path))
        except Exception as exc:
            print(f"WARNING: could not save session state ({type(exc).__name__}). "
                  "Next time finish with the .done file instead of closing the window.")
        try:
            context.close()  # flushes the HAR
            browser.close()
        except Exception:
            pass

    for f in (state_path, har_path):
        if f.exists():
            os.chmod(f, 0o600)
    print(f"\nSaved session: {state_path.relative_to(ROOT)}")
    print(f"Saved HAR:     {har_path.relative_to(ROOT)}")
    print(f"Next: uv run analyze_har.py {har_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
