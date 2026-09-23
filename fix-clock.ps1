<#
  fix-clock.ps1 — إصلاح انزياح ساعة الويندوز

  ليه: بوتك بيستخدم USE_WINDOWS_CLOCK = true في ntp-clock.js
       => ntpNow() بترجّع Date.now() مباشرة، وأي drift في ساعة الجهاز
          بينتقل 1:1 لتوقيت الضربة.

  الملف ده بيشغّل خدمة w32time ويضبطها على مصادر NTP ويعمل resync.

  الاستخدام:
    - من PowerShell كـ Administrator:
        powershell -NoProfile -ExecutionPolicy Bypass -File .\fix-clock.ps1
    - عادي (هيطلب منك UAC) :
        powershell -ExecutionPolicy Bypass -File .\fix-clock.ps1
    - للمعاينة بس بدون أي تغيير:
        powershell -ExecutionPolicy Bypass -File .\fix-clock.ps1 -WhatIf
#>
param(
  [switch]$WhatIf,
  [string[]]$Peers = @('time.windows.com,0x8', 'pool.ntp.org,0x8')
)

$ErrorActionPreference = 'Continue'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Step { param($Text) Write-Host "`n>>> $Text" -ForegroundColor Cyan }
function Write-Ok { param($Text) Write-Host "    [OK] $Text" -ForegroundColor Green }
function Write-Warn { param($Text) Write-Host "    [!] $Text" -ForegroundColor Yellow }

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " إصلاح ساعة الويندوز — مشروع المواعيد" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

if (-not (Test-Admin)) {
  Write-Warn "الملف محتاج صلاحيات Administrator."
  if ($WhatIf) {
    Write-Host ""
    Write-Host "الأوامر اللي هتتنفذ (شغّلها في PowerShell كـ Administrator):" -ForegroundColor Cyan
    Write-Host "  sc config w32time start= auto"
    Write-Host "  net start w32time"
    Write-Host ('  w32tm /config /manualpeerlist:"{0}" /syncfromflags:manual /reliable:yes /update' -f ($Peers -join ' '))
    Write-Host "  w32tm /resync /force"
    Write-Host "  w32tm /stripchart /computer:pool.ntp.org /samples:2 /dataonly"
    exit 0
  }
  Write-Host ""
  Write-Host "هحاول أرفع الصلاحيات (هيظهرلك UAC — اضغط Yes)..." -ForegroundColor Yellow
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    )
    Write-Ok "خلصت نافذة الصلاحيات. شغّل node check-clock.js عشان تتأكد من النتيجة."
  } catch {
    Write-Warn "فشل رفع الصلاحيات: $($_.Exception.Message)"
    Write-Warn "افتح PowerShell كـ Administrator وشغّل الملف من هناك."
  }
  exit 0
}

# ---------- إحنا دلوقتي Administrator ----------

Write-Step "1) فحص الحالة الحالية"
$svc = Get-Service w32time -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "    الحالة   : $($svc.Status)"
  Write-Host "    نوع البدء: $($svc.StartType)"
} else {
  Write-Warn "مش لاقي خدمة w32time على الجهاز."
}

Write-Step "2) ضبط خدمة w32time على التبديل التلقائي"
& sc.exe config w32time start= auto | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Ok "اتظبطت على auto" } else { Write-Warn "sc config رجّع كود $LASTEXITCODE" }

Write-Step "3) تشغيل الخدمة"
& net.exe start w32time 2>&1 | ForEach-Object { Write-Host "    $_" }
Start-Sleep -Seconds 2
$svc = Get-Service w32time -ErrorAction SilentlyContinue
if ($svc.Status -eq 'Running') { Write-Ok "الخدمة شغالة" } else { Write-Warn "الخدمة لسه $($svc.Status)" }

Write-Step "4) ضبط مصادر المزامنة"
$peerList = $Peers -join ' '
& w32tm.exe /config /manualpeerlist:$peerList /syncfromflags:manual /reliable:yes /update 2>&1 | ForEach-Object { Write-Host "    $_" }

Write-Step "5) إعادة تشغيل الخدمة لتطبيق الإعدادات"
& net.exe stop w32time 2>&1 | Out-Null
Start-Sleep -Seconds 1
& net.exe start w32time 2>&1 | Out-Null
Start-Sleep -Seconds 2
Write-Ok "اتعملت إعادة تشغيل"

Write-Step "6) مزامنة فورية"
& w32tm.exe /resync /force 2>&1 | ForEach-Object { Write-Host "    $_" }

Write-Step "7) التحقق (الانزياح المفروض يقرب من صفر)"
Start-Sleep -Seconds 2
$raw = & w32tm.exe /stripchart /computer:pool.ntp.org /samples:3 /dataonly 2>&1
$raw | ForEach-Object { Write-Host "    $_" }

$offsets = @()
foreach ($line in $raw) {
  if ($line -match '([+-]?\d+\.\d+)s') { $offsets += [double]$Matches[1] }
}

Write-Host ""
if ($offsets.Count -gt 0) {
  $last = $offsets[$offsets.Count - 1]
  $ms = [Math]::Round($last * 1000, 1)
  if ([Math]::Abs($ms) -lt 50) {
    Write-Host "النتيجة: $ms ms — ممتاز، الساعة مظبوطة" -ForegroundColor Green
  } elseif ([Math]::Abs($ms) -lt 150) {
    Write-Host "النتيجة: $ms ms — مقبول. شغّل resync تاني بعد شوية لو عايز أحسن" -ForegroundColor Yellow
  } else {
    Write-Host "النتيجة: $ms ms — لسه بعيد. ممكن السيرفرات مرفوضة من الشبكة" -ForegroundColor Red
    Write-Host "جرّب: w32tm /resync /force  وبعدها  w32tm /stripchart /computer:time.windows.com /samples:2 /dataonly" -ForegroundColor Gray
  }
} else {
  Write-Warn "مش قادر أقرأ النتيجة من w32tm — اتأكد يدوي بالأمر فوق."
}

Write-Host ""
Write-Host "الخطوة الأخيرة: زامن التحقق من داخل المشروع:" -ForegroundColor Cyan
Write-Host "    node check-clock.js" -ForegroundColor White
Write-Host ""
Write-Host "ملاحظة: بما إن البوت بيطلق على ساعة الجهاز، الأفضل تعمل جدول" -ForegroundColor Gray
Write-Host "      يعمل w32tm /resync /force كل ساعة (Task Scheduler)." -ForegroundColor Gray
Write-Host ""
