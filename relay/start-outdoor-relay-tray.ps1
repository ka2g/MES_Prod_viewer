# outdoor-relay.exe — 트레이 아이콘 + 숨김 실행 (Win7+, PowerShell 2+)
# 바로가기 예:
#   powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\mes-outdoor-relay\start-outdoor-relay-tray.ps1"

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'outdoor-relay.exe'

if (-not (Test-Path $exe)) {
  [System.Windows.Forms.MessageBox]::Show(
    "outdoor-relay.exe 를 찾을 수 없습니다.`n$dir",
    'MES Outdoor Relay',
    'OK',
    'Error'
  ) | Out-Null
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.WorkingDirectory = $dir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Text = 'MES 실외날씨 중계'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$null = $menu.Items.Add('실행 중 (119 → MES Push/Pull)')
$menu.Items[0].Enabled = $false
$null = $menu.Items.Add('-')
$exitItem = $menu.Items.Add('종료')
$exitItem.Add_Click({
  if ($proc -and -not $proc.HasExited) {
    $proc.Kill()
  }
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu

while (-not $proc.HasExited) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 400
}

$notify.Visible = $false
[void][System.Windows.Forms.MessageBox]::Show(
  'outdoor-relay.exe 가 종료되었습니다. outdoor-relay.env 또는 로그를 확인하세요.',
  'MES Outdoor Relay',
  'OK',
  'Warning'
)
