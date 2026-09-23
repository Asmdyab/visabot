# show-notification.ps1 - Shows a Windows balloon notification + alert sound
# Usage: powershell -ExecutionPolicy RemoteSigned -File show-notification.ps1 "Title" "Message"

param(
    [string]$Title = "Notification",
    [string]$Message = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Play an alert sound (not silent even if balloon is missed)
[System.Media.SystemSounds]::Exclamation.Play()

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Warning
$notify.BalloonTipTitle = $Title
$notify.BalloonTipText = $Message
$notify.Visible = $true

# Show balloon for 15 seconds
$notify.ShowBalloonTip(15000)

# Keep process alive until balloon disappears
Start-Sleep -Seconds 16
$notify.Dispose()
