# Puts a staged Cue update in place on Windows, after Cue has closed.
#
# Cue starts this hidden and detached as it quits (src/main/update-core.js,
# startWindowsSwap), because a running Windows program cannot replace its own
# folder. It:
#   1. waits for Cue's process to end (up to -TimeoutSec),
#   2. moves the staged folder beside the install as "<Install>.incoming",
#   3. renames the install folder to "<Install>.old" (retrying while Windows
#      still holds a file in it),
#   4. renames "<Install>.incoming" to "<Install>",
#   5. on any failure puts the old folder back and returns the staged folder
#      to where it was, so the next quit can try again without a download,
#   6. writes { ok, version, why, at } to -Result, which Cue reads at its next
#      launch. "<Install>.old" is removed by that launch, not here.
# Nothing is relaunched unless -Relaunch is given (only "Install and reopen").
# -FailAfterAside forces a failure after step 3; only the tests use it.
param(
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][string]$Install,
  [Parameter(Mandatory = $true)][string]$Staged,
  [Parameter(Mandatory = $true)][string]$Result,
  [string]$Version = '',
  [string]$Relaunch = '',
  [int]$TimeoutSec = 90,
  [switch]$FailAfterAside
)
$ErrorActionPreference = 'Stop'

function Say([bool]$ok, [string]$why) {
  $o = [ordered]@{ ok = $ok; version = $Version; why = $why; at = (Get-Date).ToUniversalTime().ToString('o') }
  # WriteAllText writes UTF-8 without a byte-order mark, which JSON.parse needs.
  [System.IO.File]::WriteAllText($Result, ($o | ConvertTo-Json -Compress))
}

function Again() {
  if ($Relaunch -and (Test-Path -LiteralPath $Relaunch)) { Start-Process -FilePath $Relaunch | Out-Null }
}

# Directory.Move is a plain rename: it never moves INTO an existing folder.
function Move-Retry([string]$from, [string]$to, [int]$secs) {
  $until = (Get-Date).AddSeconds($secs)
  while ($true) {
    try { [System.IO.Directory]::Move($from, $to); return $true }
    catch { if ((Get-Date) -gt $until) { return $false }; Start-Sleep -Milliseconds 500 }
  }
}

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }
  if (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { Say $false 'Cue was still running'; exit 1 }

  if (-not (Test-Path -LiteralPath $Staged)) { Say $false 'the staged copy is missing'; exit 1 }
  $incoming = "$Install.incoming"
  $old = "$Install.old"
  if (Test-Path -LiteralPath $incoming) { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $old) { $old = "$Install.old-" + (Get-Date).Ticks }

  $moved = $false
  try { [System.IO.Directory]::Move($Staged, $incoming); $moved = $true }
  catch {
    # Another drive: copy instead, and leave the staged copy where it is.
    try { Copy-Item -LiteralPath $Staged -Destination $incoming -Recurse -Force }
    catch { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction SilentlyContinue; Say $false "copy: $($_.Exception.Message)"; Again; exit 1 }
  }
  function Undo-Incoming() {
    if ($moved) { try { [System.IO.Directory]::Move($incoming, $Staged) } catch {} }
    else { Remove-Item -LiteralPath $incoming -Recurse -Force -ErrorAction SilentlyContinue }
  }

  if (Test-Path -LiteralPath $Install) {
    if (-not (Move-Retry $Install $old 30)) { Undo-Incoming; Say $false 'the old version was still in use'; Again; exit 1 }
  }
  try {
    if ($FailAfterAside) { throw 'test: forced failure after stepping aside' }
    [System.IO.Directory]::Move($incoming, $Install)
  } catch {
    $why = "put in place: $($_.Exception.Message)"
    if ((Test-Path -LiteralPath $old) -and -not (Move-Retry $old $Install 30)) { Say $false "put back FAILED: $why"; exit 2 }
    Undo-Incoming
    Say $false $why
    Again
    exit 1
  }
  Say $true ''
  Again
  exit 0
} catch {
  try { Say $false "unexpected: $($_.Exception.Message)" } catch {}
  exit 3
}
