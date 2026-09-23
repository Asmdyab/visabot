<#
  probe-path.ps1 — قياس زمن المسار الفعلي لسيرفر المواعيد (من الجهاز المحلي)

  بيقيس نفس الحاجات اللي colab-probe.py بيقيسها بالظبط، عشان المقارنة تكون عادلة:
    1) TCP connect
    2) TLS handshake
    3) أول بايت من الرد
    4) انزياح ساعة الويندوز عن NTP  (مهم: ntp-clock.js بيستخدم ساعة الويندوز)

  الاستخدام:
    powershell -ExecutionPolicy Bypass -File .\probe-path.ps1
    powershell -ExecutionPolicy Bypass -File .\probe-path.ps1 -HostName egyapi.almaviva-visa.it -Iterations 10

  ملاحظة: القياس ده مباشر (direct) — لو البوت بتاعك بيعدي على بروكسي، المسار بتاعه مختلف.
#>
param(
  [string]$HostName = 'egyapi.almaviva-visa.it',
  [int]$Port = 443,
  [int]$Iterations = 8,
  [string]$NtpHost = 'time.windows.com'
)

$ErrorActionPreference = 'Stop'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

function Get-Stats {
  param([double[]]$Values)
  if (-not $Values -or $Values.Count -eq 0) { return [pscustomobject]@{ Min = 0; Avg = 0; P95 = 0 } }
  $sorted = $Values | Sort-Object
  $p95Index = [Math]::Max(0, [Math]::Ceiling(0.95 * $sorted.Count) - 1)
  return [pscustomobject]@{
    Min = [Math]::Round(($sorted | Measure-Object -Minimum).Minimum, 1)
    Avg = [Math]::Round(($sorted | Measure-Object -Average).Average, 1)
    P95 = [Math]::Round($sorted[$p95Index], 1)
  }
}

Write-Host ""
Write-Host "=== مسار المواعيد — قياس محلي ===" -ForegroundColor Cyan
Write-Host "Target     : $HostName`:$Port"
Write-Host "Iterations : $Iterations"
Write-Host "Machine    : $env:COMPUTERNAME  |  $([Environment]::OSVersion.VersionString)"
Write-Host "Node       : $(try { (node --version) } catch { 'n/a' })"
Write-Host ""

$tcp = @(); $tls = @(); $first = @(); $total = @(); $errCount = 0

for ($i = 1; $i -le $Iterations; $i++) {
  $client = $null
  $ssl = $null
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $client = New-Object System.Net.Sockets.TcpClient
    $connectTask = $client.ConnectAsync($HostName, $Port)
    if (-not $connectTask.Wait(15000)) { throw 'TCP connect timeout' }
    $t1 = $sw.Elapsed.TotalMilliseconds

    $ssl = New-Object System.Net.Security.SslStream(
      $client.GetStream(), $false,
      ([System.Net.Security.RemoteCertificateValidationCallback]{ param($s, $c, $ch, $e) return $true })
    )
    $ssl.AuthenticateAsClient($HostName)
    $t2 = $sw.Elapsed.TotalMilliseconds

    $req = "HEAD / HTTP/1.1`r`nHost: $HostName`r`nUser-Agent: probe-path/1.0`r`nConnection: close`r`n`r`n"
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
    $ssl.Write($bytes, 0, $bytes.Length)
    $ssl.Flush()

    $buf = New-Object byte[] 64
    $null = $ssl.Read($buf, 0, $buf.Length)
    $t3 = $sw.Elapsed.TotalMilliseconds

    $tcp += [Math]::Round($t1, 1)
    $tls += [Math]::Round($t2 - $t1, 1)
    $first += [Math]::Round($t3 - $t2, 1)
    $total += [Math]::Round($t3, 1)

    Write-Host ("  #{0,-2} tcp {1,7} ms | tls {2,7} ms | first-byte {3,7} ms | total {4,8} ms" -f `
      $i, [Math]::Round($t1, 1), [Math]::Round($t2 - $t1, 1), [Math]::Round($t3 - $t2, 1), [Math]::Round($t3, 1))
  }
  catch {
    $errCount++
    Write-Host ("  #{0,-2} FAILED: {1}" -f $i, $_.Exception.Message) -ForegroundColor Yellow
  }
  finally {
    if ($ssl) { try { $ssl.Dispose() } catch {} }
    if ($client) { try { $client.Close() } catch {} }
    Start-Sleep -Milliseconds 400
  }
}

Write-Host ""
Write-Host "--- النتيجة ---" -ForegroundColor Cyan
if ($tcp.Count -gt 0) {
  $sTcp = Get-Stats $tcp
  $sTls = Get-Stats $tls
  $sFirst = Get-Stats $first
  $sTotal = Get-Stats $total
  $warm = @()
  if ($total.Count -gt 1) { $warm = $total[1..($total.Count - 1)] }
  $sWarm = Get-Stats $warm
  Write-Host ("TCP connect      : min {0,6} | avg {1,6} | p95 {2,6} ms" -f $sTcp.Min, $sTcp.Avg, $sTcp.P95)
  Write-Host ("TLS handshake    : min {0,6} | avg {1,6} | p95 {2,6} ms" -f $sTls.Min, $sTls.Avg, $sTls.P95)
  Write-Host ("First byte       : min {0,6} | avg {1,6} | p95 {2,6} ms" -f $sFirst.Min, $sFirst.Avg, $sFirst.P95)
  Write-Host ("Total (cold)     : min {0,6} | avg {1,6} | p95 {2,6} ms" -f $sTotal.Min, $sTotal.Avg, $sTotal.P95)
  Write-Host ("Total (warm, بلا أول طلب): min {0,6} | avg {1,6} | p95 {2,6} ms" -f $sWarm.Min, $sWarm.Avg, $sWarm.P95)
  Write-Host ""
  Write-Host ("تكلفة TLS وحدها = ~{0} ms (ده اللي preArmSec=180 بيشيله)" -f $sTls.Avg) -ForegroundColor Gray
} else {
  Write-Host "مفيش قياسات ناجحة." -ForegroundColor Red
}
Write-Host "فشل: $errCount / $Iterations"

Write-Host ""
Write-Host "--- دقة ساعة النظام (ntp-clock.js بيعتمد على ساعة الويندوز) ---" -ForegroundColor Cyan
try {
  $raw = & w32tm /stripchart /computer:$NtpHost /samples:1 /dataonly 2>&1
  $line = ($raw | Where-Object { $_ -match '([+-]?\d+\.\d+)s' } | Select-Object -First 1)
  if ($line -and ($line -match '([+-]?\d+\.\d+)s')) {
    $offsetSec = [double]$Matches[1]
    $offsetMs = [Math]::Round($offsetSec * 1000, 1)
    $verdict = if ([Math]::Abs($offsetMs) -lt 50) { 'ممتاز' } elseif ([Math]::Abs($offsetMs) -lt 250) { 'مقبول' } else { 'خطر — نافذة الـ burst 5 ثواني بس' }
    Write-Host ("انزياح الساعة عن {0}: {1} ms  [{2}]" -f $NtpHost, $offsetMs, $verdict)
  } else {
    Write-Host "مش قادر أقرأ الانزياح (w32tm مش متاح أو مفيش رد)." -ForegroundColor Yellow
  }
  $status = & w32tm /query /status 2>&1
  ($status | Select-String -Pattern 'Source|Last Successful|Poll' | Select-Object -First 3) | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) -ForegroundColor DarkGray }
} catch {
  Write-Host "تخطي فحص الساعة: $($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host ""
