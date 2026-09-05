#Requires -Version 5.1

<#
.SYNOPSIS
Installs the newest local x64 T3 Code release and relaunches the desktop app.

.DESCRIPTION
The normal entry point finds the most recently modified
release\T3-Code-*-x64.exe beneath the current directory. It then hands the work
to a temporary per-user scheduled task which can outlive a T3 Code terminal,
closes the packaged desktop app when the script was launched from it, installs
the release silently, and asks the electron-builder NSIS installer to launch
the new app.

The -Install parameters are an internal handoff used by the detached process.
#>

[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = "Main")]
param(
  [Parameter(ParameterSetName = "Main")]
  [string] $ReleaseDirectory = (Join-Path -Path (Get-Location).Path -ChildPath "release"),

  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [switch] $Install,

  [Parameter(ParameterSetName = "Install", Mandatory = $true)]
  [string] $InstallerPath,

  [Parameter(ParameterSetName = "Install")]
  [int] $DesktopProcessId = 0,

  [Parameter(ParameterSetName = "Install")]
  [long] $DesktopProcessStartTimeUtcTicks = 0,

  [Parameter(ParameterSetName = "Install")]
  [string] $DesktopExecutablePath = "",

  [Parameter(ParameterSetName = "Install")]
  [string] $ScheduledTaskName = "",

  [Parameter(ParameterSetName = "Install")]
  [string] $LogPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-T3DesktopAncestor {
  $currentProcessId = $PID
  $desktopAncestor = $null

  for ($depth = 0; $depth -lt 32 -and $currentProcessId -gt 0; $depth++) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $currentProcessId"
    if ($null -eq $process) {
      break
    }

    $executableName = [System.IO.Path]::GetFileName([string] $process.ExecutablePath)
    if ($executableName -like "T3 Code*.exe") {
      # Keep walking: the packaged backend uses the same executable as the
      # Electron main process, and the root-most matching ancestor owns the UI.
      $desktopAncestor = $process
    }

    $parentProcessId = [int] $process.ParentProcessId
    if ($parentProcessId -eq $currentProcessId) {
      break
    }
    $currentProcessId = $parentProcessId
  }

  if ($null -eq $desktopAncestor) {
    return $null
  }

  $desktopProcess = Get-Process -Id ([int] $desktopAncestor.ProcessId)
  return [pscustomobject] @{
    ProcessId = [int] $desktopProcess.Id
    StartTimeUtcTicks = [long] $desktopProcess.StartTime.ToUniversalTime().Ticks
    ExecutablePath = [string] $desktopProcess.Path
  }
}

function Get-MatchingDesktopProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ExecutablePath
  )

  $executableName = [System.IO.Path]::GetFileNameWithoutExtension($ExecutablePath)
  $candidates = @(Get-Process -Name $executableName -ErrorAction SilentlyContinue)
  return @(
    $candidates | Where-Object {
      try {
        [string]::Equals(
          [string] $_.Path,
          $ExecutablePath,
          [System.StringComparison]::OrdinalIgnoreCase
        )
      } catch {
        $false
      }
    }
  )
}

function Wait-DesktopProcessesToExit {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ExecutablePath,

    [Parameter(Mandatory = $true)]
    [int] $TimeoutSeconds
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $remaining = @(Get-MatchingDesktopProcesses -ExecutablePath $ExecutablePath)
    if ($remaining.Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  return $false
}

function Stop-CurrentT3Desktop {
  param(
    [Parameter(Mandatory = $true)]
    [int] $ProcessId,

    [Parameter(Mandatory = $true)]
    [long] $StartTimeUtcTicks,

    [Parameter(Mandatory = $true)]
    [string] $ExecutablePath
  )

  $desktopProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $desktopProcess) {
    return
  }

  if ($desktopProcess.StartTime.ToUniversalTime().Ticks -ne $StartTimeUtcTicks) {
    throw "Refusing to close PID $ProcessId because it has been reused by another process."
  }

  if (
    -not [string]::Equals(
      [string] $desktopProcess.Path,
      $ExecutablePath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to close PID $ProcessId because its executable path changed."
  }

  Write-Host "Closing T3 Code..."
  [void] $desktopProcess.CloseMainWindow()

  if (Wait-DesktopProcessesToExit -ExecutablePath $ExecutablePath -TimeoutSeconds 30) {
    return
  }

  Write-Warning "T3 Code did not exit within 30 seconds; stopping remaining app processes."
  $remaining = @(Get-MatchingDesktopProcesses -ExecutablePath $ExecutablePath)
  if ($remaining.Count -gt 0) {
    $remaining | Stop-Process -Force -ErrorAction SilentlyContinue
  }

  if (-not (Wait-DesktopProcessesToExit -ExecutablePath $ExecutablePath -TimeoutSeconds 10)) {
    throw "T3 Code processes are still running; the installer was not started."
  }
}

function Install-T3Desktop {
  $resolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path

  # Packaged terminals inherit this from the desktop-managed Node backend.
  # Leaving it set would make the NSIS-launched Electron executable start in
  # Node mode instead of reopening the desktop UI.
  Remove-Item -LiteralPath "Env:ELECTRON_RUN_AS_NODE" -ErrorAction SilentlyContinue

  # Give the originating terminal enough time to print the task and log names
  # before the desktop shutdown removes that terminal.
  Start-Sleep -Seconds 1

  if ($DesktopProcessId -gt 0) {
    if ([string]::IsNullOrWhiteSpace($DesktopExecutablePath)) {
      throw "The desktop executable path is required when a desktop process id is supplied."
    }

    Stop-CurrentT3Desktop `
      -ProcessId $DesktopProcessId `
      -StartTimeUtcTicks $DesktopProcessStartTimeUtcTicks `
      -ExecutablePath $DesktopExecutablePath
  }

  Write-Host "Installing $([System.IO.Path]::GetFileName($resolvedInstallerPath))..."
  $installerProcess = Start-Process `
    -FilePath $resolvedInstallerPath `
    -ArgumentList @("/S", "--updated", "--force-run") `
    -PassThru `
    -Wait

  if ($installerProcess.ExitCode -ne 0) {
    throw "The T3 Code installer exited with code $($installerProcess.ExitCode)."
  }

  Write-Host "T3 Code was installed and is restarting."
}

function Restart-PreviousT3Desktop {
  if ([string]::IsNullOrWhiteSpace($DesktopExecutablePath)) {
    return
  }

  if (-not (Test-Path -LiteralPath $DesktopExecutablePath -PathType Leaf)) {
    Write-Warning "The previous T3 Code executable is no longer present at $DesktopExecutablePath"
    return
  }

  if (@(Get-MatchingDesktopProcesses -ExecutablePath $DesktopExecutablePath).Count -gt 0) {
    return
  }

  Write-Warning "Restarting the previous T3 Code installation after the update failure."
  [void] (Start-Process -FilePath $DesktopExecutablePath -PassThru)
}

function ConvertTo-SingleQuotedPowerShellLiteral {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string] $Value
  )

  return "'" + $Value.Replace("'", "''") + "'"
}

function Start-InstallerHandoff {
  param(
    [Parameter(Mandatory = $true)]
    [string] $ResolvedInstallerPath,

    $DesktopAncestor
  )

  $scriptPathLiteral = ConvertTo-SingleQuotedPowerShellLiteral -Value $PSCommandPath
  $installerPathLiteral = ConvertTo-SingleQuotedPowerShellLiteral -Value $ResolvedInstallerPath
  $taskName = "T3-Code-Installer-$([Guid]::NewGuid().ToString('N'))"
  $logPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath "$taskName.log"
  $taskNameLiteral = ConvertTo-SingleQuotedPowerShellLiteral -Value $taskName
  $logPathLiteral = ConvertTo-SingleQuotedPowerShellLiteral -Value $logPath
  $command = "& $scriptPathLiteral -Install -InstallerPath $installerPathLiteral"
  $command += " -ScheduledTaskName $taskNameLiteral -LogPath $logPathLiteral"

  if ($null -ne $DesktopAncestor) {
    $desktopPathLiteral = ConvertTo-SingleQuotedPowerShellLiteral `
      -Value $DesktopAncestor.ExecutablePath
    $command += " -DesktopProcessId $($DesktopAncestor.ProcessId)"
    $command += " -DesktopProcessStartTimeUtcTicks $($DesktopAncestor.StartTimeUtcTicks)"
    $command += " -DesktopExecutablePath $desktopPathLiteral"
  }

  $encodedCommand = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($command)
  )
  $powerShellPath = (Get-Process -Id $PID).Path
  $action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument (
      @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encodedCommand
      ) -join " "
    )
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $currentPrincipal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
  $runLevel = if (
    $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  ) {
    "Highest"
  } else {
    "Limited"
  }
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentIdentity.Name `
    -LogonType Interactive `
    -RunLevel $runLevel
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  try {
    Register-ScheduledTask `
      -TaskName $taskName `
      -Action $action `
      -Principal $principal `
      -Settings $settings `
      -Description "One-time T3 Code local installer handoff" | Out-Null
    Start-ScheduledTask -TaskName $taskName
  } catch {
    Unregister-ScheduledTask `
      -TaskName $taskName `
      -Confirm:$false `
      -ErrorAction SilentlyContinue
    throw
  }

  Write-Host "Installer handoff started as scheduled task $taskName."
  Write-Host "Installer log: $logPath"
}

function Start-T3DesktopInstall {
  if ($Install) {
    Install-T3Desktop
    return
  }

  $installer = Get-ChildItem `
    -LiteralPath $ReleaseDirectory `
    -Filter "T3-Code-*-x64.exe" `
    -File `
    -ErrorAction SilentlyContinue |
    Sort-Object -Property LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if ($null -eq $installer) {
    throw "No x64 T3 Code installer found under $ReleaseDirectory"
  }

  $desktopAncestor = Get-T3DesktopAncestor
  $targetDescription = "install $($installer.Name) and restart T3 Code"
  if (-not $PSCmdlet.ShouldProcess($installer.FullName, $targetDescription)) {
    return
  }

  Write-Host "Selected $($installer.FullName)"
  Start-InstallerHandoff `
    -ResolvedInstallerPath $installer.FullName `
    -DesktopAncestor $desktopAncestor
}

$transcriptStarted = $false
try {
  if ($Install -and -not [string]::IsNullOrWhiteSpace($LogPath)) {
    try {
      Start-Transcript -LiteralPath $LogPath -Append | Out-Null
      $transcriptStarted = $true
    } catch {
      Write-Warning "Could not start the installer transcript at ${LogPath}: $($_.Exception.Message)"
    }
  }

  Start-T3DesktopInstall
} catch {
  Write-Error $_ -ErrorAction Continue
  if ($Install) {
    try {
      Restart-PreviousT3Desktop
    } catch {
      Write-Warning "Could not restart the previous T3 Code installation: $($_.Exception.Message)"
    }
  }
  throw
} finally {
  if ($transcriptStarted) {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
  }

  if ($Install -and -not [string]::IsNullOrWhiteSpace($ScheduledTaskName)) {
    Unregister-ScheduledTask `
      -TaskName $ScheduledTaskName `
      -Confirm:$false `
      -ErrorAction SilentlyContinue
  }
}
