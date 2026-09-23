# ============================================================
# colab-clockburst.py — Clock-Burst runner, PURE stdlib Python.
# No git clone, no Node, no npm, no Playwright. One paste in Colab.
#
# The HTML manager injects your live settings below (same values as
# the Node bot: clockBurst window/perAccount/preArm, spoof IP mode +
# country, pacing, tripDate/destination, enabled accounts).
# You can also fill CONFIG_JSON / ACCOUNTS_JSON by hand.
#
# Protocol mirror of visa-bot-api-multi-account-FIXED.js:
#   login  = POST egyiam.../token (grant_type=password,
#            client_id=aa-visasys-public, scope=openid profile email)
#   check  = GET egyapi.../planning/v1/checks?officeId=&visaId=
#            &serviceLevelId=1  -> JSON true  = APPOINTMENT FOUND
#   401    = soft (token still fresh -> keep, no refresh) or expired
#   429    = park account (Retry-After), 400 "office hours" = night mode
# ============================================================
import base64
import concurrent.futures as cf
import datetime as dt
import email.utils
import gzip
import http.client
import json
import os
import random
import socket
import ssl
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request

try:
    from curl_cffi import requests as _cr
    HAVE_CURL = True
except Exception:
    _cr = None
    HAVE_CURL = False

# ---- injected by the HTML manager (Generate standalone Python) ----
CONFIG_B64 = "__CONFIG_B64__"
ACCOUNTS_B64 = "__ACCOUNTS_B64__"

# ---- fallback: paste JSON directly if you run this file by hand ----
CONFIG_JSON = ""
ACCOUNTS_JSON = ""

# ============================ constants =============================
TOKEN_URL = ("https://egyiam.almaviva-visa.it/realms/"
             "oauth2-visaSystem-realm-pkce/protocol/openid-connect/token")
CHECKS_URL = ("https://egyapi.almaviva-visa.it/reservation-manager"
              "/api/planning/v1/checks?officeId={office}&visaId={visa}"
              "&serviceLevelId=1")
CLIENT_ID = "aa-visasys-public"
OFFICE_ID = {"Cairo": 1, "Alexandria": 2}
VISA_ID = {
    "Tourism Visa": 1, "Tourism Visa (C)": 1,
    "Business Visa": 5, "Business Visa (C)": 5,
    "Sport Visa": 10, "Sport Visa (C)": 10,
    "Study Visa (C)": 9, "Study Visa (D)": 8,
    "Medical Visa": 15, "Re-entry Visa (D)": 4,
    "Employment (record number 2025)": 31,
    "Employment (record number 2026)": 32,
    "Family Reunion": 19, "Research": 33,
}
EGY_RANGES = [((41, 32), 47), ((41, 64), 79), ((197, 32), 39),
              ((102, 40), 47), ((41, 36), 39)]
ITA_RANGES = [((79, 0), 15), ((82, 48), 63), ((87, 0), 15),
              ((151, 16), 31), ((5, 90), 93), ((37, 159), 163),
              ((95, 232), 239), ((93, 56), 63)]
NTP_HOSTS = ["pool.ntp.org", "time.google.com", "time.cloudflare.com"]
UA_T = ("Mozilla/5.0 ({plat}) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36")
PLATS = ["Windows NT 10.0; Win64; x64",
         "Macintosh; Intel Mac OS X 10_15_7",
         "X11; Linux x86_64"]
SEC_CH_UA = '"Not-A.Brand";v="24", "Chromium";v="146"'

FOUND_FILE = "appointment-found.json"


def log(*a):
    print(*a, flush=True)


def load_payload():
    cfg = json.loads(CONFIG_JSON) if CONFIG_JSON.strip() else None
    acc = json.loads(ACCOUNTS_JSON) if ACCOUNTS_JSON.strip() else None
    if cfg is None:
        cfg = json.loads(base64.b64decode(CONFIG_B64).decode("utf-8"))
    if acc is None:
        acc = json.loads(base64.b64decode(ACCOUNTS_B64).decode("utf-8"))
    return cfg, acc


# ============================ clock ================================
# Africa/Cairo via system tz database when present, else Egypt's DST rule
# (DST = last Friday of April 00:00 -> last Thursday of October 00:00
# local, UTC+3 in DST, UTC+2 otherwise). Marks are minute-based so any
# whole-hour zone gives identical instants — but labels must be Cairo.
try:
    from zoneinfo import ZoneInfo
    _CAIRO_TZ = ZoneInfo("Africa/Cairo")
except Exception:
    _CAIRO_TZ = None

CLOCK_OFFSET_MS = 0.0


def _last_weekday(year, month, weekday, last=True):
    """weekday: Monday=0..Sunday=6. Egypt: Fri=4 (Apr), Thu=3 (Oct)."""
    import calendar as _cal
    days = _cal.monthrange(year, month)[1]
    if last:
        d = dt.date(year, month, days)
        while d.weekday() != weekday:
            d -= dt.timedelta(days=1)
        return d
    d = dt.date(year, month, 1)
    while d.weekday() != weekday:
        d += dt.timedelta(days=1)
    return d


def cairo_offset_seconds(ms):
    if _CAIRO_TZ is not None:
        d = dt.datetime.fromtimestamp(
            ms / 1000.0, tz=dt.timezone.utc).astimezone(_CAIRO_TZ)
        return d.utcoffset().total_seconds()
    utc = dt.datetime.fromtimestamp(ms / 1000.0, tz=dt.timezone.utc)
    y = utc.year
    # transitions at ~midnight local ~= 21:00/22:00 UTC previous day;
    # day-level accuracy is enough for labels.
    start = _last_weekday(y, 4, 4)
    end = _last_weekday(y, 10, 3)
    return 3 * 3600 if (start <= utc.date() < end) else 2 * 3600


def _ntp_once(host, timeout=4.0):
    pkt = b"\x1b" + 47 * b"\x00"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        t0 = time.time()
        s.sendto(pkt, (host, 123))
        data, _ = s.recvfrom(48)
        t3 = time.time()
    finally:
        s.close()
    if len(data) < 48:
        raise ValueError("bad NTP reply")
    u = struct.unpack("!12I", data)
    srv = u[10] + float(u[11]) / 2 ** 32 - 2208988800
    return (srv - (t0 + t3) / 2) * 1000.0


def sync_clock():
    """One-shot offset measurement (UDP NTP, else HTTP Date fallback)."""
    global CLOCK_OFFSET_MS
    samples = []
    for h in NTP_HOSTS:
        for _ in range(2):
            try:
                samples.append(_ntp_once(h))
            except Exception:
                pass
    if samples:
        samples.sort()
        CLOCK_OFFSET_MS = samples[len(samples) // 2]
        off_h = cairo_offset_seconds(now_ms()) / 3600
        log(f"  clock: NTP offset {CLOCK_OFFSET_MS:+.0f} ms "
            f"({len(samples)} samples) | Cairo {cairo_hms()} "
            f"(UTC+{off_h:g})")
        return
    log("  clock: UDP NTP blocked, trying HTTP Date fallback...")
    for url in ("https://egyapi.almaviva-visa.it/",
                "https://www.google.com"):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "colab-clockburst/1.0"})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=8) as r:
                hdr = r.headers.get("Date")
                t1 = time.time()
            if not hdr:
                continue
            hms = email.utils.parsedate_to_datetime(hdr).timestamp() * 1000.0
            mid = t0 * 1000.0 + (t1 - t0) * 1000.0 / 2.0
            CLOCK_OFFSET_MS = (hms - mid) + 500.0
            off_h = cairo_offset_seconds(now_ms()) / 3600
            log(f"  clock: Date-header offset {CLOCK_OFFSET_MS:+.0f} ms "
                f"(+/-500ms accuracy) | Cairo {cairo_hms()} "
                f"(UTC+{off_h:g})")
            return
        except Exception as e:
            log(f"  clock: {url} failed ({e}), next...")
    log("  clock: WARNING no time source, using VM clock as-is")


def now_ms():
    return time.time() * 1000.0 + CLOCK_OFFSET_MS


def cairo_hms(ms=None):
    """Cairo wall-clock HH:MM:SS for logs and mark labels."""
    ms = now_ms() if ms is None else ms
    if _CAIRO_TZ is not None:
        return dt.datetime.fromtimestamp(
            ms / 1000.0, tz=dt.timezone.utc).astimezone(
            _CAIRO_TZ).strftime("%H:%M:%S")
    return dt.datetime.fromtimestamp(
        (ms + cairo_offset_seconds(ms) * 1000.0) / 1000.0,
        tz=dt.timezone.utc).strftime("%H:%M:%S")


def cairo_minute(ms):
    """Cairo wall-clock minute-of-hour (burst marks live here)."""
    ms = now_ms() if ms is None else ms
    if _CAIRO_TZ is not None:
        return dt.datetime.fromtimestamp(
            ms / 1000.0, tz=dt.timezone.utc).astimezone(
            _CAIRO_TZ).minute
    return dt.datetime.fromtimestamp(
        (ms + cairo_offset_seconds(ms) * 1000.0) / 1000.0,
        tz=dt.timezone.utc).minute


# ============================ spoof IPs =============================
def pick_ip(country):
    ranges = ITA_RANGES if country == "italy" else EGY_RANGES
    (a, b0), bmax = random.choice(ranges)
    return f"{a}.{random.randint(b0, bmax)}.{random.randint(0, 255)}.{random.randint(0, 255)}"


def spoof_headers(mode, country):
    if mode == "different":
        base = pick_ip(country)
        ips = [base] + [pick_ip(country) for _ in range(5)]
    else:  # 'same' and 'egyptian': one fresh ISP IP in all 6 headers
        ips = [pick_ip(country)] * 6
    return {
        "X-Forwarded-For": ips[0],
        "X-Real-IP": ips[1],
        "Client-IP": ips[2],
        "True-Client-IP": ips[3],
        "CF-Connecting-IP": ips[4],
        "Forwarded": f"for={ips[5]};proto=https",
    }


def account_ua(email):
    plat = PLATS[abs(hash(email.lower())) % len(PLATS)]
    return UA_T.format(plat=plat)


def check_headers(token, email, cfg, waf_cookie):
    h = {
        "Host": "egyapi.almaviva-visa.it",
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": account_ua(email),
        "Accept-Language": "en",
        "Origin": "https://egy.almaviva-visa.it",
        "Sec-Fetch-Site": "same-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": "https://egy.almaviva-visa.it/",
        "Accept-Encoding": "gzip, deflate, br",
        "Priority": "u=1, i",
        "Connection": "keep-alive",
        "Sec-Ch-Ua": SEC_CH_UA,
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Ch-Ua-Mobile": "?0",
    }
    if waf_cookie:
        h["Cookie"] = f"cookiesession1={waf_cookie}"
    if cfg.get("useSpoofedIPHeaders", True):
        h.update(spoof_headers(cfg.get("ipHeaderMode", "egyptian"),
                               "italy" if cfg.get("ipHeaderCountry",
                                                 "italy") == "italy"
                               else "egypt"))
    return h


# ============================ HTTP sessions =========================
# Transport priority: curl_cffi (Chrome TLS impersonation, same trick as
# the Node bot's impit) -> stdlib ssl (usually RST by the WAF, kept as
# fallback so the script still runs anywhere).
def ensure_transport():
    """Import curl_cffi, pip-installing it on first run if needed."""
    global _cr, HAVE_CURL
    if HAVE_CURL:
        return True
    log("  transport: installing curl_cffi (Chrome TLS impersonation)...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "curl_cffi"])
        from curl_cffi import requests as _cr2
        _cr = _cr2
        HAVE_CURL = True
        return True
    except Exception as e:
        log(f"  transport: pip install failed ({e}) — "
            f"falling back to stdlib ssl (likely blocked)")
        return False


def _harvest_waf(cookie_headers):
    for v in cookie_headers:
        if "cookiesession1=" in v:
            m = v.split("cookiesession1=")[1].split(";")[0]
            if m:
                return "".join(ch for ch in m if ch.isalnum())
    return None


class CurlSession:
    """Per-account session with Chrome TLS fingerprint (HTTP/2)."""

    def __init__(self, email, timeout, proxy=None):
        self.email = email
        self.timeout = timeout
        self.waf = None
        self.token = None
        self.refresh = None
        self.acquired = 0.0
        self.expires_in = None
        try:
            self.s = _cr.Session(impersonate="chrome")
        except Exception:
            self.s = _cr.Session()
        if proxy:
            self.s.proxies = {"http": proxy, "https": proxy}

    def request(self, method, url, headers, body=None):
        h = dict(headers)
        h.pop("Host", None)  # curl sets Host itself
        data = body.encode() if isinstance(body, str) else body
        r = self.s.request(method, url, headers=h, data=data,
                           timeout=self.timeout)
        try:
            raw_cookies = r.headers.get_list("set-cookie")
        except Exception:
            raw_cookies = [v for k, v in r.headers.items()
                           if k.lower() == "set-cookie"]
        hit = _harvest_waf(raw_cookies)
        if hit:
            self.waf = hit
        return r.status_code, dict(r.headers), r.text

    def close(self):
        try:
            self.s.close()
        except Exception:
            pass


class StdlibSession:
    """One keep-alive HTTPS connection per account (stdlib only)."""

    def __init__(self, email, timeout, proxy=None):
        if proxy:
            log("  WARNING: proxy needs curl_cffi transport — "
                "stdlib session ignores proxy")

    def __init__(self, email, timeout):
        self.email = email
        self.timeout = timeout
        self.conn = None
        self.waf = None
        self.token = None
        self.refresh = None
        self.acquired = 0.0
        self.expires_in = None
        self.ctx = ssl.create_default_context()

    def _conn(self, host):
        if self.conn is None or getattr(self.conn, "_host", None) != host:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = http.client.HTTPSConnection(
                host, 443, timeout=self.timeout, context=self.ctx)
            self.conn._host = host
        return self.conn

    def request(self, method, url, headers, body=None):
        u = urllib.parse.urlsplit(url)
        host = u.hostname
        path = u.path + (("?" + u.query) if u.query else "")
        data = body.encode() if isinstance(body, str) else body
        last = None
        for _ in range(2):  # one reconnect retry on stale keep-alive
            try:
                c = self._conn(host)
                c.request(method, path, body=data, headers=headers)
                r = c.getresponse()
                raw = r.read()
                if r.getheader("Content-Encoding", "") == "gzip":
                    try:
                        raw = gzip.decompress(raw)
                    except Exception:
                        pass
                for k, v in r.getheaders():
                    if k.lower() == "set-cookie" and "cookiesession1=" in v:
                        m = v.split("cookiesession1=")[1].split(";")[0]
                        if m:
                            self.waf = "".join(
                                ch for ch in m if ch.isalnum())
                return r.status, dict(r.getheaders()), raw.decode(
                    "utf-8", "replace")
            except Exception as e:
                last = e
                try:
                    self.conn.close()
                except Exception:
                    pass
                self.conn = None
        raise last

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass
        self.conn = None


# ============================ auth ==================================
def api_login(sess, email, password, timeout):
    body = urllib.parse.urlencode({
        "grant_type": "password",
        "client_id": CLIENT_ID,
        "username": email,
        "password": password,
        "scope": "openid profile email",
    })
    for attempt in range(1, 4):
        try:
            st, _, txt = sess.request(
                "POST", TOKEN_URL,
                {"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json",
                 "User-Agent": account_ua(email),
                 "Connection": "keep-alive"}, body)
            if st == 200:
                d = json.loads(txt)
                if d.get("access_token"):
                    sess.token = d["access_token"]
                    sess.refresh = d.get("refresh_token")
                    sess.expires_in = d.get("expires_in")
                    sess.acquired = now_ms()
                    return True
            log(f"   login {email}: HTTP {st} "
                f"{txt[:120]} (try {attempt}/3)")
        except Exception as e:
            log(f"   login {email}: {type(e).__name__} {e} "
                f"(try {attempt}/3)")
        time.sleep(1)
    return False


def api_refresh(sess, email):
    if not sess.refresh:
        return False
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": sess.refresh,
    })
    try:
        st, _, txt = sess.request(
            "POST", TOKEN_URL,
            {"Content-Type": "application/x-www-form-urlencoded",
             "Accept": "application/json",
             "User-Agent": account_ua(email),
             "Connection": "keep-alive"}, body)
        if st == 200:
            d = json.loads(txt)
            if d.get("access_token"):
                sess.token = d["access_token"]
                if d.get("refresh_token"):
                    sess.refresh = d["refresh_token"]
                sess.expires_in = d.get("expires_in")
                sess.acquired = now_ms()
                return True
        else:
            sess.refresh = None
    except Exception:
        pass
    return False


def token_age_ok(sess, min_life_s=120):
    if not sess.token:
        return False
    if sess.expires_in:
        try:
            left = float(sess.expires_in) - (now_ms() - sess.acquired) / 1000.0
            return left > min_life_s
        except Exception:
            pass
    return (now_ms() - sess.acquired) < 13 * 60 * 1000


# ============================ checks ================================
def fire_check(sess, email, office_id, visa_id, cfg):
    url = CHECKS_URL.format(office=office_id, visa=visa_id)
    t0 = now_ms()
    try:
        st, hdrs, txt = sess.request(
            "GET", url, check_headers(sess.token, email, cfg, sess.waf))
    except Exception as e:
        return {"net_error": f"{type(e).__name__}: {e}",
                "ms": now_ms() - t0}
    ms = now_ms() - t0
    if st == 200:
        try:
            return ({"found": True, "ms": ms}
                    if json.loads(txt) is True
                    else {"found": False, "ms": ms})
        except Exception:
            return {"found": False, "ms": ms, "note": txt[:80]}
    if st == 401:
        return {"soft401" if token_age_ok(sess) else "expired401": True,
                "ms": ms, "body": txt[:160]}
    if st == 429:
        ra = None
        for k, v in hdrs.items():
            if k.lower() == "retry-after":
                try:
                    ra = int(float(v) * 1000)
                except Exception:
                    ra = None
        return {"rateLimited": True, "ms": ms, "retryAfterMs": ra}
    if st == 400:
        try:
            msg = json.loads(txt).get("message", "")
        except Exception:
            msg = txt[:160]
        if "office hours" in msg.lower():
            return {"outsideHours": True, "ms": ms, "msg": msg[:120]}
        return {"error": msg[:160] or "HTTP 400", "ms": ms}
    return {"error": f"HTTP {st} {txt[:120]}", "ms": ms}


# ============================ burst =================================
def next_mark(every_min):
    """Next epoch-ms whose Cairo wall minute is divisible by every_min."""
    t = int(now_ms() // 60000) * 60000
    while True:
        if cairo_minute(t) % every_min == 0 and t > now_ms():
            return t
        t += 60000


def save_found(email, office, visa, trip):
    rec = {"account": email, "office": office, "visaType": visa,
           "tripDate": trip, "foundAt": dt.datetime.now(
               dt.timezone.utc).isoformat()}
    try:
        arr = []
        if os.path.exists(FOUND_FILE):
            d = json.load(open(FOUND_FILE, encoding="utf-8"))
            arr = d if isinstance(d, list) else [d]
        arr.append(rec)
        json.dump(arr, open(FOUND_FILE, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
    except Exception as e:
        log(f"  could not save {FOUND_FILE}: {e}")


# ============================ proxy =================================
def to_proxy_url(entry, scheme):
    """'host:port:user:pass' or full URL -> proxy URL for curl."""
    e = (entry or "").strip()
    if not e:
        return None
    if "://" in e:
        return e
    parts = e.split(":")
    if len(parts) == 4:
        host, port, user, pwd = parts
        return (f"{scheme}://{urllib.parse.quote(user)}:"
                f"{urllib.parse.quote(pwd)}@{host}:{port}")
    if len(parts) == 2:
        return f"{scheme}://{parts[0]}:{parts[1]}"
    return None


def proxy_for_index(idx, cfg):
    if not cfg.get("useProxy"):
        return None
    scheme = "socks5" if cfg.get("proxyProtocol") == "socks5" else "http"
    if cfg.get("proxyMode") == "list":
        lst = cfg.get("ipList") or []
        if not lst:
            return None
        return to_proxy_url(lst[idx % len(lst)], scheme)
    return to_proxy_url(cfg.get("proxyServer", ""), scheme)


def run():
    cfg, accounts = load_payload()
    cb = cfg.get("clockBurst", {})
    every = max(1, int(cb.get("everyMinutes", 5)))
    window_s = min(120, max(2, int(cb.get("windowSec", 10))))
    per_acct = min(10, max(1, int(cb.get("perAccount", 2))))
    prearm_s = min(180, max(15, int(cb.get("preArmSec", 180))))
    timeout = int(cfg.get("requestTimeout", 60000)) / 1000.0
    trip = cfg.get("tripDate", "01/12/2025")

    accts = [a for a in accounts
             if a.get("enabled") and not a.get("foundAt")
             and a.get("email") and a.get("password")]
    if not accts:
        log("No enabled accounts embedded. Abort.")
        return 1
    log(f"Clock-Burst: {len(accts)} accounts | window {window_s}s "
        f"every {every}min | {per_acct}/acct | pre-arm {prearm_s}s | "
        f"spoof {cfg.get('ipHeaderMode')}/{cfg.get('ipHeaderCountry')} | "
        f"proxy {'ON' if cfg.get('useProxy') else 'OFF'}")
    sync_clock()
    use_curl = ensure_transport()
    SessCls = CurlSession if use_curl else StdlibSession
    log(f"  transport: "
        f"{'curl_cffi Chrome-TLS' if use_curl else 'stdlib ssl (WAF may RST)'}")
    proxies = {a["email"]: proxy_for_index(i, cfg)
               for i, a in enumerate(accts)}
    n_px = sum(1 for p in proxies.values() if p)
    if n_px:
        log(f"  proxy: {n_px}/{len(accts)} sessions via "
            f"{cfg.get('proxyProtocol', 'http')} "
            f"({'list' if cfg.get('proxyMode') == 'list' else 'single'})")

    sessions = {}
    found = set()
    parked_until = {}
    cycle = 0
    while True:
        live = [a for a in accts
                if a["email"] not in found
                and parked_until.get(a["email"], 0) < now_ms()]
        if not live:
            log("All accounts found/parked — waiting 60s...")
            time.sleep(60)
            continue
        mark = next_mark(every)
        wstart = mark - window_s * 1000
        prearm_at = wstart - prearm_s * 1000
        if wstart - now_ms() < prearm_s * 1000 + 2000:
            log(f"Window too close (mark {cairo_hms(mark)}) — "
                f"skipping to next")
            time.sleep(max(1, (mark + 1000 - now_ms()) / 1000.0))
            continue
        cycle += 1
        total = per_acct * len(live)
        gap = window_s * 1000.0 / total
        log("=" * 60)
        log(f"Burst #{cycle}: mark {cairo_hms(mark)}, window "
            f"{window_s}s, {len(live)} accts x {per_acct} = {total} "
            f"reqs, slot {gap:.0f}ms")
        wait = (prearm_at - now_ms()) / 1000.0
        if wait > 0:
            time.sleep(wait)

        def prep(a):
            em = a["email"]
            s = sessions.get(em)
            if s is None:
                s = SessCls(em, timeout, proxies.get(em))
                sessions[em] = s
            if token_age_ok(s):
                return (a, s, "fresh")
            if s.refresh and api_refresh(s, em):
                return (a, s, "refreshed")
            if api_login(s, em, a["password"], timeout):
                return (a, s, "login")
            return (a, None, "FAILED")

        with cf.ThreadPoolExecutor(max_workers=len(live)) as ex:
            res = list(ex.map(prep, live))
        ready = [(a, s) for a, s, st in res if s and s.token]
        for a, s, st in res:
            if not (s and s.token):
                log(f"  login FAILED for {a['email']} — out of "
                    f"burst #{cycle}")
        if not ready:
            log("  No sessions — waiting for next mark")
            continue

        wait = (wstart - now_ms()) / 1000.0
        if wait > 0:
            time.sleep(wait)
        t0 = now_ms()
        fired = ok = soft = exp = skip = 0
        for k in range(per_acct * len(ready)):
            a, s = ready[k % len(ready)]
            office = OFFICE_ID.get(a.get("office", "Cairo"), 1)
            vtypes = a.get("enabledVisaTypes") or []
            visa = VISA_ID.get(vtypes[0] if vtypes else "", 1)
            slot_end = wstart + (k + 1) * gap
            if a["email"] in found:
                skip += 1
            else:
                r = fire_check(s, a["email"], office, visa, cfg)
                fired += 1
                if r.get("found"):
                    ok += 1
                    found.add(a["email"])
                    log("")
                    log("  🎉 APPOINTMENT FOUND! "
                        f"{a['email']} | {a.get('office')} | "
                        f"{vtypes[0] if vtypes else '?'}")
                    log("  👉 Book manually NOW: "
                        "https://egy.almaviva-visa.it/")
                    save_found(a["email"], a.get("office", ""),
                               vtypes[0] if vtypes else "", trip)
                elif r.get("rateLimited"):
                    ra = r.get("retryAfterMs") or 60000
                    parked_until[a["email"]] = now_ms() + ra
                    log(f"  429 {a['email']} — parked "
                        f"{int(ra/1000)}s")
                elif r.get("expired401"):
                    s.token = None
                    exp += 1
                elif r.get("soft401"):
                    soft += 1
                elif r.get("outsideHours"):
                    skip += 1
                elif r.get("net_error"):
                    log(f"  net {a['email']}: {r['net_error'][:100]}")
            wait2 = (slot_end - now_ms()) / 1000.0
            if wait2 > 0:
                time.sleep(wait2)
        log(f"  Burst #{cycle} done in {now_ms()-t0:.0f}ms: "
            f"fired={fired} ok={ok} soft401={soft} expired={exp} "
            f"skipped={skip}")
    return 0


if __name__ == "__main__":
    if os.environ.get("SELFTEST") == "1":
        # offline checks: scheduling math + header/IP builders
        CLOCK_OFFSET_MS = 0
        m1, m2 = next_mark(5), next_mark(5)
        assert (m1 // 60000) % 5 == 0 and m1 > now_ms(), "mark math"
        assert m1 == m2, "mark stable"
        assert cairo_minute(m1) % 5 == 0, "mark on Cairo wall minute"
        assert cairo_hms(m1).split(":")[1] == \
            f"{cairo_minute(m1):02d}", "label matches wall minute"
        # Egypt DST: Sep 2026 -> UTC+3, Jan 2026 -> UTC+2
        sep26 = dt.datetime(2026, 9, 23, 12, 0,
                            tzinfo=dt.timezone.utc).timestamp() * 1000.0
        jan26 = dt.datetime(2026, 1, 15, 12, 0,
                            tzinfo=dt.timezone.utc).timestamp() * 1000.0
        assert cairo_offset_seconds(sep26) == 3 * 3600, "DST offset"
        assert cairo_offset_seconds(jan26) == 2 * 3600, "winter offset"
        assert cairo_hms(sep26) == "15:00:00", "Cairo label"
        ips = {pick_ip("italy") for _ in range(50)}
        assert all(i.split(".")[0] in
                   ("79", "82", "87", "151", "5", "37", "95", "93")
                   for i in ips), "italy ranges"
        assert len(ips) > 40, "ip randomness"
        h = check_headers("T", "a@b.c",
                          {"useSpoofedIPHeaders": True,
                           "ipHeaderMode": "egyptian",
                           "ipHeaderCountry": "italy"}, None)
        for k in ("X-Forwarded-For", "X-Real-IP", "Client-IP",
                  "True-Client-IP", "CF-Connecting-IP", "Forwarded",
                  "Authorization", "Referer", "Origin",
                  "Sec-Ch-Ua", "Accept-Language"):
            assert k in h, k
        assert h["Authorization"] == "Bearer T"
        assert _harvest_waf(["x; cookiesession1=AbC123; Path=/"]) == "AbC123"
        assert _harvest_waf(["nothing here"]) is None
        assert to_proxy_url("h:8080:u:p", "http") == \
            "http://u:p@h:8080"
        assert to_proxy_url("socks5://1.2.3.4:1080:u:p", "http") == \
            "socks5://1.2.3.4:1080:u:p"
        assert to_proxy_url("", "http") is None
        assert proxy_for_index(0, {}) is None
        assert proxy_for_index(1, {"useProxy": True, "proxyMode": "list",
                                   "proxyProtocol": "socks5",
                                   "ipList": ["a:1:u:p", "b:2:u:p"]}) == \
            "socks5://u:p@b:2"
        if HAVE_CURL:
            cs = CurlSession("t@e.c", 10)
            assert cs.s is not None
            cs.close()
            log("  curl transport: OK")
        else:
            log("  curl transport: skipped (not installed)")
        log("SELFTEST OK")
    else:
        try:
            sys.exit(run())
        except KeyboardInterrupt:
            log("\nStopped.")
