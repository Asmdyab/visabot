// check-clock.js — قياس انزياح ساعة الجهاز عن الوقت الحقيقي (NTP)
//
// ليه ده مهم لمشروعك:
//   ntp-clock.js فيه USE_WINDOWS_CLOCK = true  =>  ntpNow() بترجّع Date.now() مباشرة
//   و syncNtpClock() بتصفّر ntpOffsetMs (بتتجاهل NTP عن قصد)
//   يعني أي drift في ساعة الويندوز بينتقل 1:1 لتوقيت ضربة البوت.
//
// ملاحظة مهمة: مبنيتش القياس على getAccurateUtcMs() من ntp-clock.js
//   لأن مسار السايت فيها بيرجّع headerMs + 500 (نص ثانية مقصودة)،
//   ودقة هيدر Date ثانية كاملة. فمينفعش تقيس بيه انزياح 500ms.
//   هنا بنسأل NTP مباشرة (دقة أجزاء من الثانية + تصحيح RTT/2).
//
// الاستخدام:
//   node check-clock.js
//   node check-clock.js --samples 4

import dgram from 'dgram';
import https from 'https';

const NTP_HOSTS = ['time.google.com', 'time.cloudflare.com', 'time.windows.com', 'pool.ntp.org'];
const SITE_URL = 'https://egyapi.almaviva-visa.it/';

const args = process.argv.slice(2);
const samplesIdx = args.indexOf('--samples');
const SAMPLES_PER_HOST = samplesIdx !== -1 ? parseInt(args[samplesIdx + 1], 10) || 2 : 2;
const DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- ألوان بدون مكتبات خارجية ----
const c = (code, t) => (process.stdout.isTTY === false ? t : `\x1b[${code}m${t}\x1b[0m`);
const green = (t) => c('32', t);
const yellow = (t) => c('33', t);
const red = (t) => c('31', t);
const cyan = (t) => c('36', t);
const gray = (t) => c('90', t);

function fmtMs(ms) {
  const sign = ms >= 0 ? '+' : '-';
  return `${sign}${Math.abs(ms).toFixed(0)}ms`;
}

function verdictFor(absMs) {
  if (absMs < 50) return { label: 'ممتاز', code: 'OK' };
  if (absMs < 150) return { label: 'مقبول', code: 'WARN' };
  if (absMs < 400) return { label: 'سيء — نافذة الضربة عندك 5 ثواني', code: 'BAD' };
  return { label: 'خطر شديد', code: 'CRITICAL' };
}

// ---- سؤال NTP مباشرة (نفس معادلة ntp-clock.js) ----
function ntpQuery(host, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;
    const t0 = Date.now(); // ساعة الجهاز عند الإرسال
    let done = false;

    const finish = (err, result) => {
      if (done) return;
      done = true;
      try { client.close(); } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    client.once('error', (err) => { clearTimeout(timer); finish(err); });
    client.once('message', (msg) => {
      clearTimeout(timer);
      const t3 = Date.now();
      if (!msg || msg.length < 48) return finish(new Error('رد NTP غير صالح'));
      const seconds = msg.readUInt32BE(40);
      const fraction = msg.readUInt32BE(44);
      const trueUtcMs = (seconds - 2208988800) * 1000 + (fraction / 0x100000000) * 1000;
      const rttMs = t3 - t0;
      finish(null, { trueUtcMs, rttMs, t0 });
    });

    client.send(packet, 0, 48, 123, host, (err) => {
      if (err) { clearTimeout(timer); finish(err); }
    });
  });
}

// ---- قراءة هيدر Date من السايت (للمرجع فقط) ----
function siteDateHeader() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = https.get(SITE_URL, { timeout: 5000 }, (res) => {
      const t1 = Date.now();
      res.resume();
      const headerMs = Date.parse(res.headers.date || '');
      if (!Number.isFinite(headerMs)) return reject(new Error('مفيش هيدر Date'));
      resolve({ headerMs, rttMs: t1 - t0 });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  console.log('');
  console.log(cyan('=== فحص ساعة الجهاز (القياس الأساسي: NTP مباشر) ==='));
  console.log(`العينات/مصدر : ${SAMPLES_PER_HOST}`);
  console.log(gray('البوت عندك: USE_WINDOWS_CLOCK = true => بيعتمد على ساعة الويندوز مباشرة'));
  console.log(gray('القياس: NTP مباشرة (دقة أجزاء من الثانية + تصحيح RTT/2)'));
  console.log('');

  const offsets = [];
  const perHost = [];

  for (const host of NTP_HOSTS) {
    const hostOffsets = [];
    for (let i = 0; i < SAMPLES_PER_HOST; i++) {
      try {
        const { trueUtcMs, rttMs, t0 } = await ntpQuery(host);
        // mid = t0 + rtt/2  =>  offset = الوقت الحقيقي - منتصف الطلب
        const offset = trueUtcMs - (t0 + rttMs / 2);
        hostOffsets.push(offset);
        offsets.push(offset);
        console.log(`  ${host.padEnd(22)} انزياح ${fmtMs(offset).padStart(9)} | rtt ${String(rttMs).padStart(4)}ms`);
      } catch (err) {
        console.log(`  ${host.padEnd(22)} فشل: ${err.message}`);
      }
      await sleep(DELAY_MS);
    }
    if (hostOffsets.length) {
      perHost.push({ host, avg: hostOffsets.reduce((a, b) => a + b, 0) / hostOffsets.length });
    }
  }

  console.log('');
  if (offsets.length === 0) {
    console.log(red('مش قادر أقيس — كل مصادر NTP فشلت (UDP 123 ممكن يكون محجوب على الشبكة).'));
    process.exit(1);
  }

  const avg = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const min = Math.min(...offsets);
  const max = Math.max(...offsets);
  const spread = max - min;
  const v = verdictFor(Math.abs(avg));

  console.log(cyan('--- النتيجة ---'));
  console.log(`عدد القياسات   : ${offsets.length} (${perHost.length} مصدر)`);
  console.log(`متوسط الانزياح : ${fmtMs(avg)}`);
  console.log(`المدى          : ${fmtMs(min)} .. ${fmtMs(max)}  (تشتت ${spread.toFixed(0)}ms)`);
  const colored = v.code === 'OK' ? green(v.label) : v.code === 'WARN' ? yellow(v.label) : red(v.label);
  console.log(`الحكم          : ${colored}`);
  console.log('');
  console.log(gray('الإشارة: موجب = ساعة جهازك متأخرة عن الوقت الحقيقي (بتضرب متأخر)'));
  console.log(gray('        سالب = ساعة جهازك مقدّمة على الوقت الحقيقي (بتضرب بدري)'));

  const absAvg = Math.abs(avg);
  console.log('');
  console.log(cyan('--- أثر ده على الضربة ---'));
  console.log(gray('عندك: نافذة 5 ثواني بتقفل على مضاعفات الـ 5 دقايق | 4 طلبات/حساب | slot كل 1250ms'));
  console.log(gray('والمواعيد بتتاخد بالترتيب — أول طلب يوصل = أول واحد يحجز.'));
  if (avg > 0) {
    console.log(red(`كل طلباتك بتوصل متأخرة ~${absAvg.toFixed(0)}ms عن اللي ساعته مظبوطة.`));
  } else {
    console.log(yellow(`بتضرب قبل الوقت بـ ~${absAvg.toFixed(0)}ms — احتمال السيرفر يرفضها أو تحتسب في النافذة القديمة.`));
  }

  console.log('');
  console.log(cyan('--- مرجع: هيدر Date من السايت (دقته ثانية كاملة) ---'));
  try {
    const { headerMs, rttMs } = await siteDateHeader();
    console.log(`فرق خام (قبل تصحيح)  : ${fmtMs(headerMs - Date.now())} | rtt ${rttMs}ms`);
    console.log(gray('كود ntp-clock.js بيضيف +500 هنا (fetchSiteHttpDate) — فمتستغربش لو الرقم مختلف.'));
    console.log(gray('الرقم ده للمرجع بس — القياس المعتمد فوق من NTP.'));
  } catch (err) {
    console.log(gray(`تخطي: ${err.message}`));
  }

  console.log('');
  if (v.code !== 'OK') {
    console.log(cyan('--- الإصلاح (PowerShell كـ Administrator) ---'));
    console.log(gray('1) شغّل خدمة وقت ويندوز وخليها تلقائية:'));
    console.log('   sc config w32time start= auto');
    console.log('   net start w32time');
    console.log(gray('2) اضبط مصادر المزامنة:'));
    console.log('   w32tm /config /manualpeerlist:"time.windows.com,0x8 pool.ntp.org,0x8" /syncfromflags:manual /reliable:yes /update');
    console.log(gray('3) زامن فوراً:'));
    console.log('   w32tm /resync /force');
    console.log(gray('4) اتأكد:'));
    console.log('   w32tm /stripchart /computer:pool.ntp.org /samples:2 /dataonly');
    console.log('');
    console.log(yellow('وبعدها شغّل الأداة دي تاني: node check-clock.js'));
    console.log(gray('للعلم: خدمة w32time على الجهاز ده متوقفة حالياً (The service has not been started)'));
  } else {
    console.log(green('الساعة مضبوطة — مفيش حاجة تعملها هنا.'));
  }
  console.log('');
}

main().catch((err) => {
  console.error(red(`خطأ: ${err.message}`));
  process.exit(1);
});

