# Oasis - Backend Server Startup PowerShell Script
#
# This copy ships with a self-contained runtime bundled alongside the script:
#   python\   Python 3.11 + all backend dependencies (no install needed)
#   bin\ffmpeg.exe   static FFmpeg
# So there is nothing to download or install on the user's machine except Google
# Chrome (used by Selenium for downloads), which we check for below.

$ScriptRoot = $PSScriptRoot
if (-not $ScriptRoot) {
    $ScriptRoot = Get-Location
}

# Set console title
$host.UI.RawUI.WindowTitle = "Oasis - Backend Server Startup"

# Tracks which step is running so any crash can tell the user exactly where it
# failed. Updated at the top of every step below.
$CurrentStep = "startup"

# Catch ANY unexpected terminating error (missing file, bad launch, etc.) so the
# window never slams shut before the user can read what went wrong. Every planned
# exit below already pauses on its own; this is the safety net.
trap {
    Write-Host ""
    Write-Host "======================================================" -ForegroundColor Red
    Write-Host "  [FATAL] The script stopped during: $CurrentStep" -ForegroundColor Red
    Write-Host "  Reason : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Line   : $($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor Red
    Write-Host "======================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Take a screenshot of the red text above and send it for help." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "======================================================"
Write-Host "  Oasis -- Windows Backend Server Startup"
Write-Host "======================================================"
Write-Host ""

# Put the bundled runtime first on PATH so `ffmpeg` (and anything else in bin\)
# resolves to our copies, never to whatever might be installed system-wide.
$BinDir = Join-Path $ScriptRoot "bin"
$PythonDir = Join-Path $ScriptRoot "python"
$env:Path = "$BinDir;$PythonDir;$env:Path"

# Refresh PATH from the registry so a tool installed during this run (e.g. git via
# winget below) becomes visible without restarting the window.
function Update-SessionPath {
    $MachinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$BinDir;$PythonDir;$MachinePath;$UserPath"
}

# -------------------------------------------------------------
# Step 1: Verify the bundled runtime is present
# -------------------------------------------------------------
$CurrentStep = "Step 1/3: Verifying bundled runtime"
Write-Host "[1/3] Verifying bundled runtime..." -ForegroundColor Cyan
$PythonExe = Join-Path $PythonDir "python.exe"
$FfmpegExe = Join-Path $BinDir "ffmpeg.exe"

function Show-RuntimeFail($Missing) {
    Write-Host "  [ERROR] This copy of Oasis is missing its bundled runtime:" -ForegroundColor Red
    Write-Host "          $Missing" -ForegroundColor Red
    Write-Host ""
    Write-Host "  This usually means only part of the folder was copied/extracted." -ForegroundColor Yellow
    Write-Host "  Please re-download the FULL Oasis zip and extract all of it, then" -ForegroundColor Yellow
    Write-Host "  run oasis-portal.bat again." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

if (-not (Test-Path $PythonExe)) { Show-RuntimeFail $PythonExe }
if (-not (Test-Path $FfmpegExe)) { Show-RuntimeFail $FfmpegExe }
Write-Host "  [SUCCESS] Python and FFmpeg are bundled and ready." -ForegroundColor Green
$Version = & $PythonExe --version 2>&1
Write-Host "  $Version"
Write-Host ""

# -------------------------------------------------------------
# Step 2: Keep the project up to date (Git) -- optional
# -------------------------------------------------------------
$CurrentStep = "Step 2/3: Checking for updates (Git)"
Write-Host "[2/3] Checking for updates..." -ForegroundColor Cyan

# git isn't required to run the app, so an absent/failed install is non-fatal --
# we just skip the update and keep going with the local copy.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "  [WARN] Git is not installed. Attempting to install via winget..." -ForegroundColor Yellow
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Git.Git --silent --accept-source-agreements --accept-package-agreements
        Update-SessionPath
        if (Get-Command git -ErrorAction SilentlyContinue) {
            Write-Host "  [SUCCESS] Git installed." -ForegroundColor Green
        }
    } else {
        Write-Host "  [INFO] winget unavailable -- skipping automatic Git install." -ForegroundColor Yellow
    }
}

if (Get-Command git -ErrorAction SilentlyContinue) {
    $GitDir = Join-Path $ScriptRoot ".git"
    if (Test-Path $GitDir) {
        Write-Host "  Updating project files via Git..."
        Push-Location $ScriptRoot
        # Never hang on an interactive credential prompt (offline).
        $env:GIT_TERMINAL_PROMPT = "0"
        git config core.filemode false
        # Public repo: pull the current branch from origin. --ff-only never
        # creates a merge commit or clobbers local edits.
        $Branch = (git rev-parse --abbrev-ref HEAD).Trim()
        # git writes normal progress ("From https://...") to stderr, not just
        # real errors. If PowerShell sees that stderr it wraps each line in an
        # ErrorRecord and paints it red (NativeCommandError) even though the pull
        # succeeded. Let cmd.exe merge stderr into stdout first, so PowerShell
        # only ever receives plain strings -- no ErrorRecords, no red text. The
        # real success/failure signal is the exit code, checked below.
        $Out = (cmd /c "git pull --ff-only origin $Branch 2>&1") | Out-String
        Write-Host $Out.TrimEnd()
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [SUCCESS] Project is up to date." -ForegroundColor Green
        } else {
            Write-Host "  [WARN] Update skipped (couldn't reach GitHub). Continuing with local copy." -ForegroundColor Yellow
        }
        Pop-Location
    } else {
        Write-Host "  [INFO] Not a git repository. Skipping update."
    }
} else {
    Write-Host "  [INFO] Git is not available. Skipping automatic updates." -ForegroundColor Yellow
}
Write-Host ""

# -------------------------------------------------------------
# Step 3: Check Google Chrome (required by Selenium for downloads)
# -------------------------------------------------------------
$CurrentStep = "Step 3/3: Checking / installing Google Chrome"
Write-Host "[3/3] Checking for Google Chrome..." -ForegroundColor Cyan
function Find-Chrome {
    $PathsToCheck = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
    )
    foreach ($Path in $PathsToCheck) {
        if (Test-Path $Path) {
            return $Path
        }
    }
    $ChromeCmd = Get-Command chrome -ErrorAction SilentlyContinue
    if ($ChromeCmd) {
        return $ChromeCmd.Source
    }
    return $null
}

function Show-ChromeFail {
    Write-Host "  [ERROR] Could not auto-install Google Chrome." -ForegroundColor Red
    Write-Host "  Opening Chrome download page..."
    Start-Process "https://www.google.com/chrome/"
    Write-Host "  Please install Google Chrome and run this script again."
    Read-Host "Press Enter to exit"
    exit 1
}

$ChromePath = Find-Chrome
if ($ChromePath) {
    Write-Host "  [SUCCESS] Google Chrome found at: `"$ChromePath`"" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Google Chrome was not found. Chrome is required for video downloads." -ForegroundColor Yellow
    Write-Host "  Attempting to install Google Chrome via winget..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install Google.Chrome --silent --accept-source-agreements --accept-package-agreements
        # Re-verify: winget can report success while the browser lands somewhere
        # we still need to locate before trusting it.
        Update-SessionPath
        $ChromePath = Find-Chrome
        if ($ChromePath) {
            Write-Host "  [SUCCESS] Google Chrome installed at: `"$ChromePath`"" -ForegroundColor Green
        } else {
            Show-ChromeFail
        }
    } else {
        Show-ChromeFail
    }
}
Write-Host ""

# -------------------------------------------------------------
# Execution: Run Server
# -------------------------------------------------------------
$CurrentStep = "Launching backend server (uvicorn)"
Write-Host "======================================================"
Write-Host "  Oasis Backend Server is ready!" -ForegroundColor Green
Write-Host ""
Write-Host "  Local API URL: http://localhost:8000" -ForegroundColor Green
Write-Host "  Open the deployed web frontend to connect."
Write-Host ""
Write-Host "  Press Ctrl+C to shut down the server."
Write-Host "======================================================"
Write-Host ""

& $PythonExe -m uvicorn api:app --app-dir (Join-Path $ScriptRoot "backend") --port 8000

Read-Host "Press Enter to exit"
