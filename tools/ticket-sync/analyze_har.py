"""Phase 0 analysis: summarize a captured HAR without leaking secrets.

Usage:
    uv run analyze_har.py captures/<file>.har [--bodies]

Prints, for XHR/fetch/document calls on first-party hosts:
  - auth/login/OTP-looking requests and the cookie names they set
  - bot-check / signing signals
  - JSON responses that look like event lists, with candidate field names
  - file downloads (CSV/XLSX exports)
All header, cookie and token values are masked (first 4 chars + length).
--bodies also prints a truncated, masked sample of each candidate JSON body.
"""

import json
import re
import sys
from collections import Counter
from urllib.parse import urlsplit, parse_qsl

STATIC = re.compile(r"\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map|mp4)(\?|$)", re.I)
NOISE_HOSTS = re.compile(
    r"(google|gstatic|doubleclick|facebook|fbcdn|clarity|hotjar|segment|mixpanel|"
    r"amplitude|sentry|newrelic|nr-data|branch\.io|appsflyer|moengage|clevertap|"
    r"webengage|cloudflareinsights|youtube|twitter|linkedin|bing|criteo)",
    re.I,
)
AUTH_WORDS = re.compile(r"(login|signin|sign-in|auth|otp|verify|token|session|password|sso|oauth|refresh)", re.I)
EXPORT_TYPES = re.compile(r"(csv|spreadsheet|excel|octet-stream|vnd\.openxml|pdf)", re.I)
SECRET_KEYS = re.compile(r"(token|auth|cookie|session|secret|password|otp|key|sig|csrf|xsrf|jwt|bearer)", re.I)
FIELD_HINTS = {
    "id": re.compile(r"(^id$|_id$|Id$|eventcode|event_code|code$)", re.I),
    "name": re.compile(r"(name|title)", re.I),
    "link": re.compile(r"(slug|url|link|permalink|share)", re.I),
    "sold": re.compile(r"(sold|booked|booking|sales|count|qty|quantity|tickets|seats|capacity|available)", re.I),
    "datetime": re.compile(r"(date|time|start|showtime|schedule)", re.I),
}


def mask(v) -> str:
    s = str(v)
    if len(s) <= 6:
        return "***"
    return f"{s[:4]}…({len(s)})"


def mask_json(obj, depth=0):
    if depth > 6:
        return "…"
    if isinstance(obj, dict):
        return {k: (mask(v) if SECRET_KEYS.search(k) and not isinstance(v, (dict, list)) else mask_json(v, depth + 1))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask_json(x, depth + 1) for x in obj[:2]] + ([f"…+{len(obj) - 2} more"] if len(obj) > 2 else [])
    return obj


def find_lists(obj, path="$"):
    """Yield (path, list) for lists of dicts anywhere in a JSON document."""
    if isinstance(obj, list):
        if obj and all(isinstance(x, dict) for x in obj[:5]):
            yield path, obj
        for i, x in enumerate(obj[:3]):
            yield from find_lists(x, f"{path}[{i}]")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from find_lists(v, f"{path}.{k}")


def all_keys(d, prefix=""):
    for k, v in d.items():
        yield prefix + k
        if isinstance(v, dict):
            yield from all_keys(v, prefix + k + ".")


def hdrs(entry_part):
    return {h["name"].lower(): h["value"] for h in entry_part.get("headers", [])}


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: uv run analyze_har.py <file.har> [--bodies]")
    show_bodies = "--bodies" in sys.argv
    with open(sys.argv[1], encoding="utf-8") as f:
        entries = json.load(f)["log"]["entries"]

    hosts = Counter()
    rows = []
    for e in entries:
        url = e["request"]["url"]
        host = urlsplit(url).netloc
        if STATIC.search(urlsplit(url).path) or NOISE_HOSTS.search(host):
            continue
        hosts[host] += 1
        rows.append(e)

    print("== First-party hosts (request count) ==")
    for h, n in hosts.most_common(15):
        print(f"  {n:4}  {h}")

    print("\n== Auth / login / OTP flow ==")
    for e in rows:
        req, res = e["request"], e["response"]
        u = urlsplit(req["url"])
        if not AUTH_WORDS.search(u.path + "?" + u.query) and not any(
            h["name"].lower() == "set-cookie" for h in res.get("headers", [])
        ):
            continue
        set_cookies = [h["value"].split("=", 1)[0] for h in res.get("headers", []) if h["name"].lower() == "set-cookie"]
        body_keys = ""
        pd = req.get("postData", {}).get("text")
        if pd:
            try:
                body_keys = " body-keys=" + ",".join(json.loads(pd).keys())
            except Exception:
                body_keys = " body-form=" + ",".join(k for k, _ in parse_qsl(pd))[:120]
        print(f"  {req['method']:6} {res['status']} {u.netloc}{u.path}{body_keys}")
        if set_cookies:
            print(f"         set-cookie: {', '.join(set_cookies)}")

    print("\n== Bot-check / signing signals ==")
    signals = Counter()
    for e in entries:
        req, res = e["request"], e["response"]
        rh, sh = hdrs(req), hdrs(res)
        url = req["url"]
        cookie = rh.get("cookie", "")
        for name in ("cf_clearance", "__cf_bm", "_abck", "bm_sz", "ak_bmsc", "datadome", "_px", "incap_ses"):
            if name in cookie:
                signals[f"cookie {name}"] += 1
        if "cf-ray" in sh:
            signals["Cloudflare edge (cf-ray)"] += 1
        if res["status"] in (403, 429, 503) and "cloudflare" in sh.get("server", "").lower():
            signals["Cloudflare block/challenge response"] += 1
        if re.search(r"(recaptcha|hcaptcha|turnstile|challenges\.cloudflare)", url, re.I):
            signals["captcha/turnstile script or call"] += 1
        for k in rh:
            if re.search(r"(csrf|xsrf)", k):
                signals[f"header {k}"] += 1
            if re.search(r"(sign|signature|hmac|nonce|x-timestamp|x-request-id|x-device|fingerprint)", k):
                signals[f"header {k}"] += 1
            if k == "authorization":
                signals[f"header authorization ({rh[k].split(' ')[0]} scheme)"] += 1
    for s, n in signals.most_common():
        print(f"  {n:4}  {s}")
    if not signals:
        print("  none seen")

    print("\n== JSON responses that look like event lists ==")
    seen = set()
    for e in rows:
        req, res = e["request"], e["response"]
        content = res.get("content", {})
        if "json" not in content.get("mimeType", "") or not content.get("text"):
            continue
        try:
            doc = json.loads(content["text"])
        except Exception:
            continue
        u = urlsplit(req["url"])
        for path, lst in find_lists(doc):
            keys = set()
            for item in lst[:5]:
                keys.update(all_keys(item))
            hits = {f: sorted(k for k in keys if rx.search(k.split(".")[-1]))[:8] for f, rx in FIELD_HINTS.items()}
            score = sum(1 for v in hits.values() if v)
            sig = (u.path, path)
            if score < 3 or sig in seen:
                continue
            seen.add(sig)
            rh = hdrs(req)
            auth_hdrs = [k for k in rh if SECRET_KEYS.search(k) or k.startswith("x-")]
            q = ",".join(k for k, _ in parse_qsl(u.query))
            print(f"\n  {req['method']} {res['status']} {u.netloc}{u.path}" + (f"  query-keys={q}" if q else ""))
            print(f"    list at {path}  ({len(lst)} items)")
            print(f"    request headers of interest: {', '.join(auth_hdrs) or 'none'}")
            for f, ks in hits.items():
                print(f"    {f:8}: {', '.join(ks) or '-'}")
            if show_bodies:
                sample = json.dumps(mask_json(lst[0]), indent=2, ensure_ascii=False)
                print("    sample item (masked):\n      " + sample[:1500].replace("\n", "\n      "))

    print("\n== Downloads / exports ==")
    found = False
    for e in rows:
        sh = hdrs(e["response"])
        ct, cd = sh.get("content-type", ""), sh.get("content-disposition", "")
        if "attachment" in cd or EXPORT_TYPES.search(ct):
            found = True
            u = urlsplit(e["request"]["url"])
            print(f"  {e['request']['method']} {e['response']['status']} {u.netloc}{u.path}  type={ct}  disposition={cd[:80]}")
    if not found:
        print("  none seen (if you clicked Export, it may email the file or open a new tab)")


if __name__ == "__main__":
    main()
