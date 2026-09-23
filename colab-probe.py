# ============================================================
# colab-probe.py — قياس المسار من Google Colab (خلية واحدة)
# ============================================================
# الصقه في خلية Colab وشغّله. بيقيس نفس حاجات probe-path.ps1 بالظبط
# عشان تقارن أرقام Colab بأرقام جهازك بشكل عادل.
#
# بيقيس:
#   1) TCP connect
#   2) TLS handshake
#   3) أول بايت من الرد + بيفحص إنه رد HTTP حقيقي (مش اتصال مقفول)
#   4) انزياح ساعة الـ VM عن NTP  <-- ده اللي بوتك معتمد عليه
#      ولو UDP 123 محجوب (بيحصل في Colab) بيجرّب بديل عبر هيدر Date
#   5) مكان الـ VM التقريبي (egress IP / المدينة / المشغّل) + عدد الأنوية
#
# ملاحظة: ده قياس/تشخيص للمسار — مش تشغيل البوت.
#
# تنبيه مهم (من تجربة حقيقية على Colab):
#   لو ظهر first-byte بأرقام زي 0.1ms فده *مش* رد حقيقي — معناه الاتصال
#   اتقفل فوراً (RST) والسيرفر مردّش. النسخة دي بتكتشف الحالة دي وبتستبعد
#   العينة بدل ما تلوّث الإحصائيات وتطلّع أرقام مضللة.
# ============================================================

import email.utils
import json
import math
import os
import platform
import socket
import ssl
import struct
import statistics
import time
import urllib.request

HOST = "egyapi.almaviva-visa.it"
PORT = 443
ITERATIONS = 8
NTP_HOSTS = ["pool.ntp.org", "time.google.com", "time.cloudflare.com"]
NTP_SAMPLES = 3          # عينات لكل مصدر (بناخد الـ median بعدها)
HTTP_TIME_URLS = ["https://egyapi.almaviva-visa.it/", "https://www.google.com"]
EGRESS_URL = "https://ipinfo.io/json"


def stats(values, label):
    if not values:
        print(f"  {label:<18}: لا توجد قياسات")
        return
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, math.ceil(0.95 * len(ordered)) - 1))
    print(
        f"  {label:<18}: min {ordered[0]:>7.1f} | avg {statistics.mean(values):>7.1f} | "
        f"p95 {ordered[idx]:>7.1f} ms"
    )


def _ntp_query_ms(host, timeout=5.0):
    """عينة واحدة: انزياح ساعة الجهاز عن host — نفس معادلة ntp-clock.js"""
    packet = b"\x1b" + 47 * b"\x00"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        t0 = time.time()
        s.sendto(packet, (host, 123))
        data, _ = s.recvfrom(48)
        t3 = time.time()
    finally:
        s.close()
    if len(data) < 48:
        raise ValueError("رد NTP غير صالح")
    unpacked = struct.unpack("!12I", data)
    server_time = unpacked[10] + float(unpacked[11]) / 2 ** 32 - 2208988800
    return (server_time - (t0 + t3) / 2) * 1000.0


def measure_clock_offset():
    """يقيس من كذا مصدر NTP × كذا عينة ويرجّع الـ median.

    الإرجاع: (median_ms أو None, تفاصيل, أخطاء)
    """
    samples = []
    details = []
    errors = []
    for host in NTP_HOSTS:
        for _ in range(NTP_SAMPLES):
            try:
                value = _ntp_query_ms(host)
                samples.append(value)
                details.append(f"{host.split('.')[1]}:{value:+.0f}")
            except Exception as exc:
                errors.append(f"{host}:{type(exc).__name__}")
    if not samples:
        return None, details, errors
    return statistics.median(samples), details, errors


def http_date_offset_ms(url, timeout=6.0):
    """بديل لو UDP 123 محجوب: هيدر Date. دقته ثانية واحدة => تقريب ±500ms.

    نفس فكرة fetchSiteHttpDate في ntp-clock.js (اللي بتضيف 500 للتعويض
    عن إن هيدر Date بيقرّب للثانية لتحت).

    الإرجاع: (corrected_ms, raw_ms, header_str)
    """
    req = urllib.request.Request(url, headers={"User-Agent": "colab-probe/1.1"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        header = resp.headers.get("Date")
        t1 = time.time()
    if not header:
        raise ValueError("مفيش هيدر Date")
    header_ms = email.utils.parsedate_to_datetime(header).timestamp() * 1000.0
    rtt_ms = (t1 - t0) * 1000.0
    mid_ms = t0 * 1000.0 + rtt_ms / 2.0
    raw = header_ms - mid_ms
    return raw + 500.0, raw, header


def egress_info(timeout=6.0):
    """مكان الـ VM التقريبي. بيرجع نص، أو None لو الخدمة مش متاحة."""
    try:
        req = urllib.request.Request(EGRESS_URL, headers={"User-Agent": "colab-probe/1.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        loc = ", ".join(x for x in [data.get("city"), data.get("region"), data.get("country")] if x)
        return f"{data.get('ip', '?')} | {loc or '?'} | {data.get('org', '?')}"
    except Exception:
        return None


def probe():
    ctx = ssl.create_default_context()
    tcp_ms, tls_ms, first_ms, total_ms = [], [], [], []
    failures = 0
    invalid = 0
    statuses = {}
    invalid_reasons = []

    for i in range(1, ITERATIONS + 1):
        raw = None
        wrapped = None
        try:
            t0 = time.perf_counter()
            raw = socket.create_connection((HOST, PORT), timeout=15)
            t1 = time.perf_counter()

            wrapped = ctx.wrap_socket(raw, server_hostname=HOST)
            t2 = time.perf_counter()

            request = (
                f"HEAD / HTTP/1.1\r\nHost: {HOST}\r\n"
                "User-Agent: colab-probe/1.1\r\nConnection: close\r\n\r\n"
            )
            wrapped.sendall(request.encode())

            first_chunk = b""
            recv_error = ""
            try:
                first_chunk = wrapped.recv(256)
            except Exception as exc:
                recv_error = type(exc).__name__
            t3 = time.perf_counter()

            if first_chunk.startswith(b"HTTP/"):
                # رد حقيقي => العينة صالحة
                status_line = first_chunk.split(b"\r\n", 1)[0].decode("latin-1", "replace")
                statuses[status_line] = statuses.get(status_line, 0) + 1
                tcp_ms.append((t1 - t0) * 1000)
                tls_ms.append((t2 - t1) * 1000)
                first_ms.append((t3 - t2) * 1000)
                total_ms.append((t3 - t0) * 1000)
                print(
                    f"  #{i:<2} tcp {tcp_ms[-1]:>7.1f} | tls {tls_ms[-1]:>7.1f} | "
                    f"first-byte {first_ms[-1]:>7.1f} | total {total_ms[-1]:>8.1f} ms"
                    f"  | {status_line}"
                )
            else:
                # لا يوجد رد HTTP => العينة غير صالحة، متتحسبش في الإحصائيات
                invalid += 1
                if recv_error:
                    reason = f"خطأ قراءة: {recv_error}"
                elif not first_chunk:
                    reason = "الاتصال اتقفل بدون أي رد (RST/FIN)"
                else:
                    reason = f"رد غير HTTP: {first_chunk[:40]!r}"
                invalid_reasons.append(reason)
                print(
                    f"  #{i:<2} ⚠️ عينة غير صالحة — {reason} "
                    f"(first-byte {(t3 - t2) * 1000:.1f}ms مش رد حقيقي)"
                )
        except Exception as exc:
            failures += 1
            print(f"  #{i:<2} FAILED: {exc}")
        finally:
            for sock in (wrapped, raw):
                try:
                    if sock:
                        sock.close()
                except Exception:
                    pass
            time.sleep(0.4)

    return tcp_ms, tls_ms, first_ms, total_ms, failures, invalid, statuses, invalid_reasons


print("=" * 62)
print("=== مسار المواعيد — قياس من Google Colab ===")
print("=" * 62)
print(f"Target     : {HOST}:{PORT}")
print(f"Iterations : {ITERATIONS}")
print(f"OS         : {platform.platform()}")
print(f"CPU cores  : {os.cpu_count()}")
print(f"Python     : {platform.python_version()}")

_egress = egress_info()
print(f"Egress     : {_egress if _egress else 'غير متاح (تخطي)'}")
print()

tcp_ms, tls_ms, first_ms, total_ms, failures, invalid, statuses, invalid_reasons = probe()

print()
print("--- النتيجة ---")
print(f"  عينات صالحة (رد HTTP حقيقي): {len(total_ms)} / {ITERATIONS}")
print(f"  عينات غير صالحة            : {invalid}")
print(f"  فشل اتصال                  : {failures}")
if statuses:
    print("  ردود السيرفر الفعلية:")
    for line, count in sorted(statuses.items(), key=lambda kv: -kv[1]):
        print(f"    x{count:<3} {line}")
if invalid_reasons:
    print("  أسباب العينات غير الصالحة:")
    for reason in sorted(set(invalid_reasons)):
        print(f"    - {reason}")

if total_ms:
    print()
    stats(tcp_ms, "TCP connect")
    stats(tls_ms, "TLS handshake")
    stats(first_ms, "First byte")
    stats(total_ms, "Total (cold)")
    stats(total_ms[1:], "Total (warm)")
else:
    print()
    print("  ⚠️ مفيش ولا عينة صالحة — متقارنش الأرقام دي بأي حاجة، الاتصال مش بيتجاوب أصلاً.")

print()
print("--- دقة ساعة الـ VM (بوتك بيعتمد على ساعة الجهاز) ---")
offset_val = None
offset_src = None
median_offset, details, ntp_errors = measure_clock_offset()
if median_offset is not None:
    offset_val = median_offset
    offset_src = f"NTP median ({len(details)} عينة)"
    print(f"  عينات NTP: {' '.join(details)}")
else:
    print("  NTP (UDP 123) مش متاح — غالباً محجوب على الشبكة. بجرّب هيدر Date...")
    if ntp_errors:
        print(f"  أخطاء NTP: {', '.join(sorted(set(ntp_errors)))}")
    for url in HTTP_TIME_URLS:
        try:
            corrected, raw, header = http_date_offset_ms(url)
            offset_val = corrected
            offset_src = f"هيدر Date من {url}"
            print(f"  {url}")
            print(f"    Date: {header}")
            print(f"    فرق خام {raw:+.0f} ms | بعد تعويض التقريب {corrected:+.0f} ms (دقة ±500ms)")
            break
        except Exception as exc:
            print(f"  {url}: تخطي ({exc})")

if offset_val is not None:
    abs_off = abs(offset_val)
    if abs_off < 50:
        verdict = "ممتاز"
    elif abs_off < 250:
        verdict = "مقبول"
    else:
        verdict = "خطر — نافذة الضرب عندك 5 ثواني بس"
    print(f"  الانزياح المعتمد: {offset_val:+.1f} ms  [{verdict}]  <= {offset_src}")
    if offset_src and offset_src.startswith("هيدر Date"):
        print("  تنبيه: دقة المصدر ده ثانية واحدة، فالرقم تقريبي بس بيوريك الاتجاه.")
else:
    print("  تعذّر قياس الساعة من كل المصادر.")

print()
print("--- المقارنة مع جهازك ---")
print("  محلياً: powershell -ExecutionPolicy Bypass -File .\\probe-path.ps1 -Iterations 8")
print("  المقارنة العادلة = TCP + TLS (بلا first-byte لو العينات غير صالحة).")
print()
print("  آخر قياس على جهازك (23/09/2026):")
print("    TCP connect avg 60.3 ms | TLS handshake avg 76.8 ms | Total warm 382.4 ms")
print("    انزياح ساعة ويندوز: -508 ms  (خدمة w32time متوقفة)")

print()
summary = {
    "valid_samples": len(total_ms),
    "invalid_samples": invalid,
    "connect_failures": failures,
    "statuses": statuses,
    "tcp_avg": round(statistics.mean(tcp_ms), 1) if tcp_ms else None,
    "tls_avg": round(statistics.mean(tls_ms), 1) if tls_ms else None,
    "first_avg": round(statistics.mean(first_ms), 1) if first_ms else None,
    "total_avg": round(statistics.mean(total_ms), 1) if total_ms else None,
    "total_warm_avg": round(statistics.mean(total_ms[1:]), 1) if len(total_ms) > 1 else None,
    "clock_offset_ms": round(offset_val, 1) if offset_val is not None else None,
    "clock_source": offset_src,
    "egress": _egress,
}
print("COPY-THIS-SUMMARY:")
print(summary)
