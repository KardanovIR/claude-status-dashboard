# AgStatus installer for Windows.
#
#   irm https://agstatus.online/install.ps1 | iex
#
# `irm | iex` cannot take parameters: the pipe hands Invoke-Expression a string,
# and there is nowhere to hang `-Code` off. The conventional idiom is to compile
# the downloaded text into a script block and call *that* with arguments:
#
#   & ([scriptblock]::Create((irm https://agstatus.online/install.ps1))) -Code XXXX-XXXX
#
# Both forms work here because the param() block below is the first statement in
# the file, so Invoke-Expression and [scriptblock]::Create() bind to the same
# parameters; piped with no arguments they simply come through empty.
#
# param() below is a *simple* parameter block, so anything PowerShell cannot
# bind to one of those four parameters is dropped into $args rather than
# refused. Step 0 of the installer rejects whatever ends up there, because the
# alternative is installing happily with a mistyped flag silently ignored.
#
# Shape of this file, and why:
#   - everything that *does* something lives in Invoke-AgStatusInstall, which is
#     called on the very last line. A truncated download either fails to parse
#     (unbalanced braces - nothing runs) or stops before that last line (only
#     definitions exist - nothing runs). A half-installed tree is the one outcome
#     this shape rules out.
#   - the helpers above it are definitions only, with no side effects, for the
#     same reason.
#   - nothing at top level assigns to a preference variable. Invoke-Expression
#     evaluates in the *caller's* scope, so a top-level
#     `$ErrorActionPreference = 'Stop'` would leak into the user's shell and stay
#     there. Function scope contains it.
#
# It targets Windows PowerShell 5.1 (Desktop), which is what Windows 10 and 11
# ship and what `irm | iex` lands in from a stock terminal. So: no `??`, no
# ternary `? :`, no `&&` / `||`, no `-SkipHttpErrorCheck`, no
# `ConvertFrom-Json -AsHashtable`, no three-argument `Join-Path`.
#
# The file is deliberately pure ASCII. Two separate reasons, both real:
#   - Invoke-RestMethod on 5.1 decodes a response body as ISO-8859-1 when the
#     server sends no charset in Content-Type, so a UTF-8 checkmark in a string
#     literal arrives as mojibake before the script ever runs;
#   - the legacy console host renders at codepage 437/1252, so even a correctly
#     decoded checkmark prints as garbage.
# Hence [ok] / [!] / -> instead of the glyphs used elsewhere in this repo.
#
# What it installs (the layout contract, identical to the POSIX installer except
# for the prefix):
#   %LOCALAPPDATA%\AgStatus\bin\agstatus.cmd          the launcher shim
#   %LOCALAPPDATA%\AgStatus\lib\agstatus\dist\cli.js  the CLI entry point
#   %LOCALAPPDATA%\AgStatus\lib\agstatus\assets\      the hook
#   %LOCALAPPDATA%\AgStatus\lib\node_modules\         the one runtime dependency
#   %LOCALAPPDATA%\AgStatus\LICENSE                   the MIT licence it ships under
#
# That prefix is the same directory the hook already uses for its Windows state
# (cli/src/listener/config.ts defaultStateDir, docs/design/focus-protocol.md
# 3.1: machine.json, sessions/). Upgrades therefore replace bin\ and lib\ and
# must leave everything else under the prefix alone.

param(
    # Pair with a board created elsewhere, e.g. in the mobile app: `-Code XXXX-XXXX`.
    [string] $Code,
    # Self-hosted server base URL.
    [string] $Url,
    # Webhook secret, for self-hosted single-tenant servers.
    [string] $Secret,
    # Send tool names only, never command text.
    [switch] $Minimal
)

function Get-AgStatusLatestVersion {
    <#
      Resolve the newest release from the 302 that
      /releases/latest serves, rather than from api.github.com/releases/latest.
      The HTML endpoint is a plain unauthenticated redirect with no rate limit
      worth the name; the API endpoint is 60 requests/hour/IP, which a shared
      office NAT or a CI runner burns through without trying.

      Why [Net.HttpWebRequest] and not `Invoke-WebRequest -MaximumRedirection 0`:
      the two PowerShell generations disagree about what a suppressed redirect
      means. Windows PowerShell 5.1 treats the 302 as a terminating error, so the
      Location header has to be dug out of the thrown WebException's .Response.
      PowerShell 7 returns the 302 as an ordinary response object and throws
      nothing. Code covering both ends up with a try/catch whose *success* path is
      the catch block on one host and the try block on the other - easy to get
      subtly wrong, and impossible to test here. HttpWebRequest with
      AllowAutoRedirect = $false behaves the same on both: only >= 400 raises a
      WebException, a 3xx just comes back, and we always read .Headers['Location'].
    #>
    param([Parameter(Mandatory = $true)][string] $LatestUrl)

    $req = [Net.HttpWebRequest] ([Net.WebRequest]::Create($LatestUrl))
    $req.Method = 'GET'
    $req.AllowAutoRedirect = $false
    $req.Timeout = 30000
    # GitHub is content without one, but a named agent makes this install
    # identifiable in any proxy log that a user is asked to hand over.
    $req.UserAgent = 'agstatus-installer (PowerShell)'

    $location = $null
    $resp = $null
    try {
        $resp = $req.GetResponse()
        $status = [int] $resp.StatusCode
        if (($status -lt 300) -or ($status -gt 399)) {
            throw "expected a redirect from $LatestUrl but got HTTP $status. Is there a published release yet?"
        }
        $location = $resp.Headers['Location']
    } finally {
        if ($resp -ne $null) { $resp.Close() }
    }

    if ([string]::IsNullOrWhiteSpace($location)) {
        throw "the redirect from $LatestUrl carried no Location header."
    }
    # RFC 7231 allows a relative Location. GitHub sends an absolute one, but
    # resolving against the request URI costs a line and removes the assumption.
    if ($location -notmatch '^https?://') {
        $location = (New-Object Uri(([Uri] $LatestUrl), $location)).AbsoluteUri
    }

    # Strict on purpose: the tag is about to be pasted into a download URL, so
    # anything that is not exactly vMAJOR.MINOR.PATCH at the end of the path is
    # treated as a redirect we did not expect rather than as a version.
    $m = [regex]::Match($location, '/releases/tag/v(\d+\.\d+\.\d+)$')
    if (-not $m.Success) {
        throw "could not read a version tag out of the redirect target '$location'."
    }
    return $m.Groups[1].Value
}

function Assert-AgStatusZipSafe {
    <#
      Zip-slip guard, run *before* anything is written to disk.

      Microsoft.PowerShell.Archive's Expand-Archive on 5.1 joins each entry's
      name onto the destination without checking where it lands, so an entry
      named ..\..\..\Windows\System32\... escapes the staging directory. We never
      roll such an archive, but the check is what makes "verified hash, then
      expand" a real boundary rather than a slogan: enumerate the entries,
      reject anything rooted, drive-qualified, colon-bearing (NTFS alternate data
      streams) or containing a .. segment, and only then hand the file to
      Expand-Archive.
    #>
    param([Parameter(Mandatory = $true)][string] $ZipPath)

    # .NET Framework does not load System.IO.Compression.FileSystem by default;
    # .NET Core already has the type and may refuse the Add-Type by name. Either
    # outcome is fine as long as the type resolves on the next line.
    try { Add-Type -AssemblyName 'System.IO.Compression.FileSystem' } catch { }

    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ($name -match '^[\\/]') {
                throw "archive entry '$name' is an absolute path."
            }
            if ($name -match '^[A-Za-z]:') {
                throw "archive entry '$name' is drive-qualified."
            }
            if ($name -match '(^|[\\/])\.\.([\\/]|$)') {
                throw "archive entry '$name' escapes the destination directory."
            }
            if ($name.Contains(':')) {
                throw "archive entry '$name' contains a colon (alternate data stream)."
            }
        }
    } finally {
        $zip.Dispose()
    }
}

function Find-AgStatusPayloadRoot {
    <#
      The release archive may be flat (bin\, lib\ at its root) or wrapped in one
      top-level directory (agstatus-<version>\bin, ...\lib), depending on how it
      was rolled. Rather than assume, look for the one file the layout contract
      fixes - lib\agstatus\dist\cli.js - at the root and then one level down.
    #>
    param([Parameter(Mandatory = $true)][string] $StagingDir)

    # Note the single two-argument Join-Path with a multi-segment child: 5.1's
    # Join-Path takes -Path and -ChildPath only, no third positional segment.
    $marker = 'lib\agstatus\dist\cli.js'
    $candidates = @($StagingDir)
    foreach ($dir in @(Get-ChildItem -LiteralPath $StagingDir -Directory)) {
        $candidates += $dir.FullName
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate $marker)) { return $candidate }
    }
    throw "the downloaded archive does not contain $marker - it is not an AgStatus release artifact."
}

function Add-AgStatusToUserPath {
    <#
      Put <prefix>\bin on the persistent user PATH. Returns 'added' when it
      changed something, 'present' when the entry was already there, and
      'too-long' when the PATH cannot take another entry (see trap (iv)).

      Trap (i) - the destructive one. [Environment]::SetEnvironmentVariable(
      'Path', $v, 'User') always writes REG_SZ. A user PATH is normally
      REG_EXPAND_SZ and routinely holds entries like %USERPROFILE%\.local\bin or
      %JAVA_HOME%\bin; rewriting it as REG_SZ freezes those to whatever they
      happened to expand to today, and they stop tracking the variable forever
      after. Worse, the matching *read*, [Environment]::GetEnvironmentVariable(
      'Path', 'User'), hands back the expanded string, so the naive
      read-append-write loses the %VAR% entries even before the type changes.
      The fix is to go at the registry directly: read the raw value with
      RegistryValueOptions.DoNotExpandEnvironmentNames, and write it back with
      the RegistryValueKind it already had.

      Trap (ii) - re-running the installer must not append a second copy. Compare
      *expanded*, quote-stripped, trailing-backslash-trimmed entries, since our
      target is a literal path and an existing entry may be a %VAR% form of it.
      PowerShell's -eq on strings is case-insensitive, which is what we want on a
      case-insensitive filesystem.

      Trap (iv) - the legacy length limits. setx and a number of older installers
      truncate a PATH past 2047 characters, silently. We cannot fix someone
      else's PATH, but we can warn before we are blamed for it, and near the
      registry string ceiling we leave the PATH alone rather than write a value
      Windows will reject or clip.

      That last case returns 'too-long'; it deliberately does not throw. By the
      time this function is called, lib\ and bin\ are already on disk and
      `agstatus init` has not run yet, so throwing painted a red failure over an
      install that had in fact landed - and skipped the pairing step, which is
      the part the user actually came for. A PATH we cannot extend is a warning
      plus the manual fix, printed here where the length is known.

      Trap (iii) is handled by the caller, which also has to fix up $env:Path.
    #>
    param([Parameter(Mandatory = $true)][string] $Directory)

    $target = $Directory.TrimEnd('\')

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($key -eq $null) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    }
    try {
        $hasPath = $false
        foreach ($name in $key.GetValueNames()) {
            if ($name -eq 'Path') { $hasPath = $true }
        }

        if ($hasPath) {
            $raw = [string] $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $kind = $key.GetValueKind('Path')
        } else {
            # No user PATH at all (a fresh profile). Create it the way Windows
            # itself does, as REG_EXPAND_SZ, so the next tool to append a %VAR%
            # entry finds the type it expects.
            $raw = ''
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        }

        foreach ($entry in ($raw -split ';')) {
            $trimmed = $entry.Trim().Trim('"').TrimEnd('\')
            if ($trimmed.Length -eq 0) { continue }
            $expandedEntry = [Environment]::ExpandEnvironmentVariables($trimmed)
            if ($expandedEntry.TrimEnd('\') -eq $target) { return 'present' }
        }

        # PREPEND, not append - and this is not cosmetic. npm was retired but not
        # unpublished, so %APPDATA%\npm\agstatus.cmd (1.3.0) is still sitting on
        # the PATH of exactly the upgrade population this installer targets, and
        # %APPDATA%\npm normally sits ahead of a freshly appended entry. Appending
        # would print "installed" while `agstatus` in a new terminal silently kept
        # running the old npm shim. install.sh prepends for the same reason.
        $updated = $raw.TrimStart(';').TrimEnd(';')
        if ($updated.Length -gt 0) {
            $updated = $target + ';' + $updated
        } else {
            $updated = $target
        }

        $expandedLength = ([Environment]::ExpandEnvironmentVariables($updated)).Length
        if ($expandedLength -ge 32000) {
            # Nothing is written: the existing PATH is left exactly as it was.
            # The install is finished otherwise, so this is a warning carrying
            # the manual step, not a failure. Returning from inside the try
            # still runs the finally below, so the registry key is closed.
            Write-Host ''
            Write-Host "[!] Adding AgStatus would take your user PATH to $expandedLength characters expanded," -ForegroundColor Yellow
            Write-Host '    past what the registry stores reliably - so your PATH was left exactly as it' -ForegroundColor Yellow
            Write-Host '    was and AgStatus is NOT on it. Nothing else about the install is affected.' -ForegroundColor Yellow
            Write-Host '    To fix it, prune a few entries in' -ForegroundColor Yellow
            Write-Host '      rundll32 sysdm.cpl,EditEnvironmentVariables' -ForegroundColor Yellow
            Write-Host '    and add this directory there, at the top of the list:' -ForegroundColor Yellow
            Write-Host "      $target" -ForegroundColor Yellow
            Write-Host '    Until then, run AgStatus by its full path:' -ForegroundColor Yellow
            Write-Host "      $target\agstatus.cmd" -ForegroundColor Yellow
            return 'too-long'
        }

        $key.SetValue('Path', $updated, $kind)

        if ($expandedLength -gt 2047) {
            Write-Host "[!] Your user PATH is now $expandedLength characters expanded. Windows itself copes," -ForegroundColor Yellow
            Write-Host "    but setx and some older installers truncate past 2047. Worth pruning." -ForegroundColor Yellow
        }
    } finally {
        if ($key -ne $null) { $key.Close() }
    }

    # SetEnvironmentVariable(...,'User') broadcasts WM_SETTINGCHANGE for you; a
    # raw registry write does not, so Explorer and every already-open shell keep
    # their stale copy until the next logon. Broadcast it ourselves. Entirely
    # cosmetic - the value is already persisted - so a failure here is a warning,
    # never an error.
    try {
        if (-not ('AgStatusNative' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgStatusNative {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
'@
        }
        $result = [UIntPtr]::Zero
        # HWND_BROADCAST = 0xFFFF, WM_SETTINGCHANGE = 0x1A, SMTO_ABORTIFHUNG = 0x2.
        [void] [AgStatusNative]::SendMessageTimeout([IntPtr] 0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref] $result)
    } catch {
        Write-Host '[!] Could not broadcast the PATH change; open apps will pick it up after a restart.' -ForegroundColor Yellow
    }

    return 'added'
}

function New-AgStatusShimText {
    <#
      The body of <prefix>\bin\agstatus.cmd, CRLF-terminated.

      bin\ is rendered rather than taken from the archive: the archive's
      bin/agstatus is the POSIX sh launcher, which is no use to cmd.exe.

      The Windows shim has an easier job than its POSIX counterpart. There is no
      LaunchAgent here (see step 10 of the installer), so nothing ever invokes it
      out of an environment cut down to launchd's four default directories, and
      the exhaustive version-manager search the POSIX launcher needs is
      unnecessary. It does still resolve node at run time instead of baking in
      the node.exe the installer happened to find, so that switching Node with
      nvm-windows / fnm / volta, or reinstalling Node somewhere else, does not
      strand the install.

      Every line is single-quoted so %VARS%, %%I and %* reach the file verbatim.
    #>
    $lines = @(
        '@echo off'
        'rem AgStatus launcher - rendered by the AgStatus installer. Do not edit.'
        'rem Node is resolved at run time, never baked in, so switching Node'
        'rem versions or reinstalling Node elsewhere does not strand the install.'
        'setlocal'
        'set "AGSTATUS_CLI=%~dp0..\lib\agstatus\dist\cli.js"'
        'rem An explicit AGSTATUS_NODE wins, matching the POSIX launcher.'
        'if defined AGSTATUS_NODE goto :run'
        'rem %%~$PATH:I is cmd''s built-in PATH search - the batch equivalent of'
        'rem where.exe, without spawning it.'
        'for %%I in (node.exe) do set "AGSTATUS_NODE=%%~$PATH:I"'
        'if defined AGSTATUS_NODE goto :run'
        'if exist "%ProgramFiles%\nodejs\node.exe" set "AGSTATUS_NODE=%ProgramFiles%\nodejs\node.exe"'
        'if defined AGSTATUS_NODE goto :run'
        'if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "AGSTATUS_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"'
        'if defined AGSTATUS_NODE goto :run'
        'echo agstatus: no node.exe found on PATH.>&2'
        'echo   Fix: install Node 18+ from https://nodejs.org, or set AGSTATUS_NODE to a node.exe.>&2'
        'exit /b 127'
        ':run'
        '"%AGSTATUS_NODE%" "%AGSTATUS_CLI%" %*'
        'rem %ERRORLEVEL% expands when this line is parsed, which cmd does only'
        'rem after the previous line has finished - so this is node''s exit code.'
        'exit /b %ERRORLEVEL%'
    )
    return (($lines -join "`r`n") + "`r`n")
}

function Invoke-AgStatusInstall {
    param(
        [string] $Code,
        [string] $Url,
        [string] $Secret,
        [switch] $Minimal,
        # Whatever the param() block at the top of the file could not bind, i.e.
        # the caller's $args. Always a mistake - see step 0.
        [object[]] $ExtraArgs
    )

    # Both assignments are function-scoped, so the caller's shell keeps its own
    # settings even though Invoke-Expression evaluated this file in that shell's
    # scope. $ProgressPreference matters for speed, not tidiness: 5.1 repaints a
    # progress bar for every chunk Invoke-WebRequest reads, which costs more than
    # the transfer on anything but a slow link.
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    $repo = 'https://github.com/KardanovIR/claude-status-dashboard'

    # --- 0a. Arguments ----------------------------------------------------

    # A simple param() block does not reject what it cannot bind: it puts the
    # leftovers in $args and carries on. So `-Secrt s3cr3t` or `-Cde ABCD-1234`
    # used to install an unpaired copy and print [ok], with the flag the user
    # actually typed silently dropped - the one failure that looks exactly like
    # success. Nothing else in this file reads $args, so this is the only place
    # a typo can be caught, and it has to be caught here: before the download
    # and before anything is written, so a mistyped flag costs nothing but the
    # message. install.sh refuses unknown options in the same spot.
    #
    # Not solved by an advanced param block ([CmdletBinding()] or any
    # [Parameter()] attribute): that would hand the user PowerShell's binder
    # error instead of the list of flags this installer actually takes, and it
    # changes how the two supported invocation forms bind. A loop is cheaper
    # than that trade.
    #
    # One false positive is possible, and it is the right way round: `irm | iex`
    # run from inside someone's own function or script, where Invoke-Expression
    # evaluates in *that* scope and $args is theirs rather than ours. That costs
    # a re-run with the script-block form; a silently dropped -Code costs an
    # unpaired install that reports success. At an interactive prompt - which is
    # where the documented one-liner runs - $args is empty.
    $unknownArgs = @()
    foreach ($extra in @($ExtraArgs)) {
        # @($null) is a one-element array holding $null, which is what an unset
        # $args binds to - so both the null and the empty case are filtered here
        # rather than guarded at the call site.
        if ($extra -eq $null) { continue }
        $extraText = [string] $extra
        if ($extraText.Trim().Length -eq 0) { continue }
        $unknownArgs += $extraText
    }
    # POSIX spellings never reach $args: a simple param() block binds them
    # POSITIONALLY, so `--code ABCD-1234` arrives as Code='--code', Url='ABCD-1234'
    # and the loop above sees nothing. That is the likeliest mistake of all,
    # because `--code` is what the sibling installer and the docs tell a
    # cross-platform user to type (install.sh: `sh -s -- --code ABCD-1234`).
    # A real value never begins with a dash, so this is unambiguous.
    $dashed = @()
    foreach ($pair in @(
        @{ Name = '-Code';   Value = $Code },
        @{ Name = '-Url';    Value = $Url },
        @{ Name = '-Secret'; Value = $Secret }
    )) {
        $v = [string] $pair.Value
        if ($v.Trim().StartsWith('-')) { $dashed += ("$($pair.Name) $v") }
    }
    if ($dashed.Count -gt 0) {
        throw @"
That looks like a POSIX-style flag: $($dashed -join ', ')

  This installer uses PowerShell parameter names, not the sh installer's flags:
    -Code XXXX-XXXX   (not --code)
    -Url <base>       (not --url)
    -Secret <s>       (not --secret)
    -Minimal          (not --minimal)

  Options need the script-block form; a bare 'irm ... | iex' cannot carry any:
    & ([scriptblock]::Create((irm https://agstatus.online/install.ps1))) -Code XXXX-XXXX

  Nothing was downloaded and nothing was installed.
"@
    }

    if ($unknownArgs.Count -gt 0) {
        throw @"
Unrecognised argument(s): $($unknownArgs -join ' ')

  This installer takes only these, and all of them are optional:
    -Code XXXX-XXXX   Pair with a board created elsewhere, e.g. in the mobile app
    -Url <base>       Server to use, for a self-hosted board
    -Secret <s>       Webhook secret, for self-hosted single-tenant servers
    -Minimal          Send tool names only, never command text

  Options need the script-block form; a bare 'irm ... | iex' cannot carry any:
    & ([scriptblock]::Create((irm https://agstatus.online/install.ps1))) -Code XXXX-XXXX

  Nothing was downloaded and nothing was installed.
"@
    }

    # --- 0b. Host checks ---------------------------------------------------

    # PowerShell 7 defines $IsWindows; Windows PowerShell 5.1 does not, because
    # 5.1 only ever runs on Windows. Get-Variable rather than a bare $IsWindows
    # so this still works for anyone with Set-StrictMode on.
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $onWindows = Get-Variable -Name 'IsWindows' -ValueOnly -ErrorAction SilentlyContinue
        if (-not $onWindows) {
            throw 'install.ps1 is the Windows installer. On macOS or Linux run:  curl -fsSL https://agstatus.online/install.sh | sh'
        }
    }
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        throw "AgStatus needs Windows PowerShell 5.1 or newer (this is $($PSVersionTable.PSVersion)). Expand-Archive arrived in 5.0."
    }

    # Windows PowerShell 5.1 defaults SecurityProtocol to Ssl3 | Tls (1.0).
    # github.com and objects.githubusercontent.com require TLS 1.2 or better, so
    # without this every download dies as "The underlying connection was closed".
    # -bor rather than assignment, so we do not switch TLS 1.3 back off on a host
    # that already enabled it.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        Write-Host '[!] Could not raise the TLS version; the download may fail on older Windows.' -ForegroundColor Yellow
    }

    # --- 1. Refuse to run elevated ----------------------------------------

    # Everything below lands in the *calling* user's %LOCALAPPDATA% and user
    # PATH. From an elevated prompt that is the administrator's profile, not the
    # profile the agents actually run under, so the install appears to succeed
    # and then `agstatus` is nowhere on PATH in a normal window. Refusing is
    # cheaper than explaining. There is nothing here that needs admin rights.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from a normal, non-elevated PowerShell window. AgStatus installs per-user under %LOCALAPPDATA% and needs no administrator rights; installing as admin puts the files in the wrong profile.'
    }

    Write-Host ''
    Write-Host 'AgStatus installer' -ForegroundColor Cyan
    Write-Host ''

    # --- 2. Node ----------------------------------------------------------

    # -CommandType Application so a stray `node` alias or function in the user's
    # profile cannot be picked up. -All plus a preference for a real .exe because
    # some version managers put a node.cmd wrapper on PATH, and we would rather
    # exec the binary directly than route arguments through a second cmd parse.
    $nodeExe = $null
    $nodeCandidates = @(Get-Command -Name 'node' -CommandType Application -All -ErrorAction SilentlyContinue)
    foreach ($candidate in $nodeCandidates) {
        if ([IO.Path]::GetExtension($candidate.Source) -ieq '.exe') {
            $nodeExe = $candidate.Source
            break
        }
    }
    if (($nodeExe -eq $null) -and ($nodeCandidates.Count -gt 0)) {
        $nodeExe = $nodeCandidates[0].Source
    }
    if ($nodeExe -eq $null) {
        throw @'
No Node.js found on PATH. AgStatus runs on Node 18 or newer.
  Install it from https://nodejs.org (LTS), or:
      winget install OpenJS.NodeJS
  then open a new terminal and re-run this installer.
'@
    }

    # Windows PowerShell 5.1 turns a native command's *redirected* stderr into
    # NativeCommandError records, and 'Stop' escalates those into a thrown error.
    # An fnm / nvm-windows shim that prints a note to stderr would then abort a
    # perfectly good install, so drop to 'Continue' for this one call and judge
    # node purely by what it put on stdout.
    $nodeVersionText = ''
    $previousEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $nodeVersionText = [string] (& $nodeExe '--version' 2>$null | Select-Object -First 1)
    } finally {
        $ErrorActionPreference = $previousEap
    }
    $versionMatch = [regex]::Match($nodeVersionText, '^v(\d+)\.')
    if (-not $versionMatch.Success) {
        throw "could not read a version out of '$nodeExe --version' (it printed '$nodeVersionText')."
    }
    $nodeMajor = [int] $versionMatch.Groups[1].Value
    if ($nodeMajor -lt 18) {
        throw @"
Node $nodeVersionText is too old; AgStatus needs 18 or newer ($nodeExe).
  Upgrade from https://nodejs.org (LTS), or:
      winget install OpenJS.NodeJS
"@
    }
    Write-Host "  Node $nodeVersionText  ($nodeExe)"

    # --- 3. Which version ------------------------------------------------

    $version = Get-AgStatusLatestVersion -LatestUrl "$repo/releases/latest"
    Write-Host "  AgStatus $version"

    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        # Only reachable on a badly-configured or service-hosted profile, but the
        # fallback is exactly what the hook computes in the same situation
        # (cli/src/listener/config.ts defaultStateDir).
        $localAppData = Join-Path $env:USERPROFILE 'AppData\Local'
    }
    $prefix = Join-Path $localAppData 'AgStatus'
    $upgrade = Test-Path -LiteralPath (Join-Path $prefix 'lib\agstatus\dist\cli.js')

    # --- 4. Download ------------------------------------------------------

    # The .zip, never the .tgz: 5.1's Expand-Archive only understands zip, and
    # tar.exe only exists on Windows 10 1803 and later.
    $zipName = "agstatus-$version.zip"
    $downloadBase = "$repo/releases/download/v$version"

    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ('agstatus-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    try {
        $zipPath = Join-Path $tempDir $zipName
        $sumsPath = Join-Path $tempDir 'SHA256SUMS'

        Write-Host "  Downloading $zipName ..."
        Invoke-WebRequest -Uri "$downloadBase/$zipName" -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
        Invoke-WebRequest -Uri "$downloadBase/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing -TimeoutSec 60

        # --- 5. Verify, before anything is expanded -----------------------

        $expectedHash = ''
        foreach ($line in @(Get-Content -LiteralPath $sumsPath)) {
            # sha256sum's format: "<64 hex><space><space><name>", or
            # "<64 hex><space>*<name>" when it was written in binary mode.
            $sumMatch = [regex]::Match($line, '^([0-9a-fA-F]{64})\s+\*?(\S.*)$')
            if (-not $sumMatch.Success) { continue }
            if ([IO.Path]::GetFileName($sumMatch.Groups[2].Value.Trim()) -eq $zipName) {
                $expectedHash = $sumMatch.Groups[1].Value
            }
        }
        if ($expectedHash -eq '') {
            throw "SHA256SUMS from release v$version has no line for $zipName; refusing to install an unverified archive."
        }

        $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
        # Get-FileHash returns upper case, sha256sum writes lower case. Normalise
        # both rather than leaning on PowerShell's -eq being case-insensitive:
        # this comparison is the security boundary, so it should read as one.
        if ($actualHash.ToUpperInvariant() -ne $expectedHash.ToUpperInvariant()) {
            throw "checksum mismatch for $zipName. Expected $expectedHash, got $actualHash. Nothing was installed."
        }
        Write-Host '  SHA-256 verified'

        # --- 6. Expand to staging, then swap ------------------------------

        Assert-AgStatusZipSafe -ZipPath $zipPath

        New-Item -ItemType Directory -Path $prefix -Force | Out-Null

        # Staging goes *inside* the prefix, not in TEMP, so the swap below is a
        # rename on one volume. PowerShell's Move-Item cannot move a directory
        # across volumes (Directory.Move throws), and TEMP is not always on the
        # system drive - redirected TEMP on a D: drive is common on managed
        # machines. Same volume makes the failure mode disappear.
        $staging = Join-Path $prefix ('.staging-' + [Guid]::NewGuid().ToString('N'))
        try {
            Expand-Archive -LiteralPath $zipPath -DestinationPath $staging -Force
            $payloadRoot = Find-AgStatusPayloadRoot -StagingDir $staging

            $libSource = Join-Path $payloadRoot 'lib'
            $libTarget = Join-Path $prefix 'lib'
            if (-not (Test-Path -LiteralPath $libSource)) {
                throw "the release archive has no lib\ directory."
            }

            # The prefix doubles as the hook's Windows state directory
            # (machine.json, sessions\ - docs/design/focus-protocol.md 3.1), so
            # an upgrade replaces lib\ and rewrites bin\ and touches nothing
            # else. Never clear the prefix wholesale.
            $backup = Join-Path $prefix ('.lib-old-' + [Guid]::NewGuid().ToString('N'))
            $movedAside = $false
            if (Test-Path -LiteralPath $libTarget) {
                try {
                    Move-Item -LiteralPath $libTarget -Destination $backup
                    $movedAside = $true
                } catch {
                    # On Windows a directory holding an open file cannot be
                    # renamed, and a running listener or a `node cli.js` has
                    # exactly that. Say so instead of surfacing "Access denied".
                    throw "could not replace $libTarget - an agstatus process is probably still running and holding a file open. Close it and re-run. ($($_.Exception.Message))"
                }
            }
            try {
                Move-Item -LiteralPath $libSource -Destination $libTarget
            } catch {
                # Best-effort rollback: put the previous install back so a failed
                # upgrade leaves a working tree rather than no tree. Silenced
                # because the original failure is the one worth reporting.
                if ($movedAside) {
                    Move-Item -LiteralPath $backup -Destination $libTarget -ErrorAction SilentlyContinue
                }
                throw
            }
            if ($movedAside) {
                Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
            }

            # The artifact carries the MIT licence at its root
            # (.github/workflows/release.yml: cp LICENSE "$ROOT/LICENSE"), and it
            # covers the tree we just installed, so it travels with it. It sits
            # outside lib\, so the swap above cannot bring it along - it has to
            # be copied across explicitly, and it has to happen here, while the
            # staging tree still exists: the finally below deletes it.
            # -ErrorAction overrides this function's 'Stop' for this one call,
            # because a licence file that will not copy is not worth failing an
            # otherwise complete install over. install.sh copies it the same way,
            # for the same reasons.
            $licenseSource = Join-Path $payloadRoot 'LICENSE'
            if (Test-Path -LiteralPath $licenseSource) {
                Copy-Item -LiteralPath $licenseSource -Destination (Join-Path $prefix 'LICENSE') -Force -ErrorAction SilentlyContinue
            }
        } finally {
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
    } finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    $cliJs = Join-Path $prefix 'lib\agstatus\dist\cli.js'
    if (-not (Test-Path -LiteralPath $cliJs)) {
        throw "install finished but $cliJs is missing."
    }

    # cli.js alone is not enough to know the tree arrived whole. qrcode-terminal
    # is the CLI's one runtime dependency and it is imported at the top of
    # cli/src/index.ts, so node resolves it while *loading* the CLI: if it is
    # missing, every agstatus command - starting with the `agstatus init` below -
    # dies with "Cannot find module 'qrcode-terminal'" rather than just losing
    # the QR code. It lives in lib\node_modules\ (not beside the package)
    # because node finds it from dist\cli.js by walking up; that placement is
    # part of the layout contract at the top of this file.
    #
    # Only a warning, and only here: npm and Homebrew are retired as channels,
    # so there is no `npm install` on the user's machine that could repair a
    # short artifact - the honest advice is to re-run and report it. Named
    # before init runs, so the failure that follows has an explanation in front
    # of it. install.sh warns at the same point.
    $qrcodeDir = Join-Path $prefix 'lib\node_modules\qrcode-terminal'
    if (-not (Test-Path -LiteralPath $qrcodeDir)) {
        Write-Host ''
        Write-Host "[!] $qrcodeDir is missing from this build." -ForegroundColor Yellow
        Write-Host '    The CLI loads qrcode-terminal at start-up, so agstatus will not run at all.' -ForegroundColor Yellow
        Write-Host '    Re-run this installer to fetch the release again; if it is still missing the' -ForegroundColor Yellow
        Write-Host '    release artifact itself is short - please report it at' -ForegroundColor Yellow
        Write-Host "      $repo/issues" -ForegroundColor Yellow
    }

    # --- 7. The launcher shim --------------------------------------------

    # Rendered, never taken from the archive - see New-AgStatusShimText for why.
    $binDir = Join-Path $prefix 'bin'
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $shimPath = Join-Path $binDir 'agstatus.cmd'

    # ASCII with no BOM, on purpose: cmd.exe reads a UTF-8 BOM as part of the
    # first command and answers with a "'i..' is not recognized" on line 1.
    [IO.File]::WriteAllText($shimPath, (New-AgStatusShimText), [Text.Encoding]::ASCII)

    # --- 8. PATH ----------------------------------------------------------

    # 'added', 'present' or 'too-long' - and 'too-long' is not a failure: the
    # function has already printed the manual step, and the install carries on
    # to `agstatus init`, which is the part that actually pairs this machine.
    #
    # The catch is the same judgement applied to the other way this can fail: a
    # policy-managed profile where HKCU\Environment refuses the write. By this
    # line lib\ and bin\ are on disk and init has not run, so a PATH we cannot
    # extend - for whichever reason - is a warning carrying the manual step
    # rather than a red error over an install that actually landed.
    try {
        $pathState = Add-AgStatusToUserPath -Directory $binDir
    } catch {
        Write-Host ''
        Write-Host "[!] Could not put $binDir on your user PATH:" -ForegroundColor Yellow
        Write-Host "      $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '    Nothing else about the install is affected. Add it by hand with' -ForegroundColor Yellow
        Write-Host '      rundll32 sysdm.cpl,EditEnvironmentVariables' -ForegroundColor Yellow
        Write-Host '    or run AgStatus by its full path:' -ForegroundColor Yellow
        Write-Host "      $shimPath" -ForegroundColor Yellow
        $pathState = 'failed'
    }

    # Trap (iii): the registry write is persistent, but this process's
    # environment block is a copy taken at start-up. Without this, `agstatus`
    # is not runnable from the very window the user installed from. Done
    # whatever the state above came back as - when the user PATH was too long to
    # extend, this window is the only place `agstatus` resolves at all, which
    # makes it more useful there, not less.
    $sessionPath = [string] $env:Path   # cast, so a (theoretically) unset PATH is '' rather than a null-reference below
    $sessionHasBin = $false
    foreach ($entry in ($sessionPath -split ';')) {
        $trimmed = $entry.Trim().Trim('"').TrimEnd('\')
        if ($trimmed.Length -eq 0) { continue }
        if ([Environment]::ExpandEnvironmentVariables($trimmed) -eq $binDir.TrimEnd('\')) { $sessionHasBin = $true }
    }
    if (-not $sessionHasBin) {
        $sessionPath = $sessionPath.TrimStart(';').TrimEnd(';')
        if ($sessionPath.Length -gt 0) {
            # Prepend here too, matching the registry write above: this window
            # must resolve `agstatus` to what we just installed, not to an
            # %APPDATA%\npm shim that happens to sit earlier.
            $env:Path = $binDir + ';' + $sessionPath
        } else {
            $env:Path = $binDir
        }
    }

    # An older install left on PATH is the one failure that looks like success:
    # everything reports fine and the user keeps running a different agstatus.
    # Name it rather than silently winning, so the fix is obvious. (install.sh
    # warns the same way.)
    try {
        $others = @(Get-Command agstatus -All -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -and ($_.Source -notlike ($binDir.TrimEnd('\') + '\*')) } |
            ForEach-Object { $_.Source })
        if ($others.Count -gt 0) {
            Write-Host ''
            Write-Host '[!] Another agstatus is still on your PATH:' -ForegroundColor Yellow
            foreach ($o in $others) { Write-Host "      $o" -ForegroundColor Yellow }
            Write-Host '    This install now comes first. Remove the old one when convenient' -ForegroundColor Yellow
            Write-Host '    (an npm-installed copy: npm uninstall -g agstatus).' -ForegroundColor Yellow
        }
    } catch {
        # Purely advisory - never fail an otherwise good install over it.
    }

    # --- 9. agstatus init -------------------------------------------------

    # Flags per cli/src/index.ts VALUE_FLAGS / BOOL_FLAGS.
    $initArgs = @('init')
    if (-not [string]::IsNullOrWhiteSpace($Code))   { $initArgs += @('--code', $Code) }
    if (-not [string]::IsNullOrWhiteSpace($Url))    { $initArgs += @('--url', $Url) }
    if (-not [string]::IsNullOrWhiteSpace($Secret)) { $initArgs += @('--secret', $Secret) }
    if ($Minimal) { $initArgs += '--minimal' }

    Write-Host ''
    # Invoke node directly rather than through the shim we just wrote. Calling a
    # .cmd from PowerShell hands the arguments to cmd.exe, which re-parses them
    # and eats & ^ | and %VAR% - and --secret is exactly the argument likely to
    # contain one of those. node.exe takes them straight from PowerShell.
    #
    # 'Continue' for the duration, for the same reason as the node --version probe
    # above: `agstatus init` writes warnings with console.error, and 5.1 will turn
    # those into NativeCommandError records the moment the installer's own output
    # is redirected (`install.ps1 > log.txt 2>&1`). The exit code is the signal we
    # actually want, and it is checked right after.
    $initExit = 0
    $previousEap = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $nodeExe $cliJs @initArgs
        $initExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($initExit -ne 0) {
        # No backtick quoting inside a double-quoted string: there the backtick is
        # PowerShell's escape character, so "`agstatus`" emits a BEL and loses the
        # quotes. Single quotes inside the double-quoted string instead.
        throw "AgStatus is installed at $prefix, but 'agstatus init' exited with $initExit. Fix the problem above and re-run:  agstatus init"
    }

    # A cheap end-to-end check of the one piece the step above could not exercise:
    # that cmd.exe finds node and that the shim's relative path to cli.js is
    # right. `agstatus help` exits 0 and touches nothing. Non-fatal - the install
    # already succeeded; this only tells the user whether the PATH entry works.
    $shimExit = 0
    $previousEap = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 turns a native command's *redirected* stderr into
        # NativeCommandError records, which 'Stop' would escalate into a thrown
        # failure of an install that has already succeeded.
        $ErrorActionPreference = 'Continue'
        $null = & $shimPath 'help' 2>&1
        $shimExit = $LASTEXITCODE
    } catch {
        Write-Host "[!] Could not run $shimPath : $($_.Exception.Message)" -ForegroundColor Yellow
        $shimExit = 0   # already reported; do not warn about it twice below
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($shimExit -ne 0) {
        Write-Host "[!] $shimPath did not run cleanly (exit $shimExit); 'agstatus' on PATH may not work." -ForegroundColor Yellow
    }

    # --- 10. Done ---------------------------------------------------------

    Write-Host ''
    if ($upgrade) {
        Write-Host "[ok] AgStatus updated to $version." -ForegroundColor Green
    } else {
        Write-Host "[ok] AgStatus $version installed." -ForegroundColor Green
    }
    Write-Host "  Command:  $shimPath"
    Write-Host "  Files:    $prefix"
    if ($pathState -eq 'added') {
        Write-Host "  PATH:     added $binDir to your user PATH."
        Write-Host "            Open a new terminal before typing 'agstatus' in one that was already running."
    } elseif ($pathState -eq 'present') {
        Write-Host "  PATH:     $binDir was already on your user PATH."
    } else {
        # 'too-long' or 'failed'. The reason is in the warning above; this block
        # is the part people screenshot, so it has to say plainly that PATH was
        # not touched and that this window is the only one where 'agstatus'
        # resolves until it is fixed by hand.
        Write-Host '  PATH:     NOT changed - see the note above.'
        Write-Host "            This window can run 'agstatus'; a new one needs $binDir"
        Write-Host '            added to your PATH by hand, or the full path to agstatus.cmd.'
    }
    Write-Host ''
    # Focus - tapping a card on the phone to raise that session's terminal - is
    # macOS-only in v1: it ships as a LaunchAgent
    # (docs/design/focus-protocol.md 5.4), and cli/src/listener/install.ts
    # returns 1 on any non-darwin platform. The Windows design (a logon
    # Scheduled Task, Windows Terminal raised through EnumWindows) is sketched in
    # 5.3 but is not built, so this installer deliberately installs no listener.
    Write-Host '  Focus (tap a session on your phone to bring its terminal to the front) is'
    Write-Host '  macOS-only for now, so nothing listener-shaped was installed here. Status,'
    Write-Host '  history and notifications all work on Windows.'
    Write-Host ''
}

Invoke-AgStatusInstall -Code $Code -Url $Url -Secret $Secret -Minimal:$Minimal -ExtraArgs $args
