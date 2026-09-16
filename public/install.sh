#!/bin/sh
# AgStatus installer — the one documented way in on macOS and Linux:
#
#   curl -fsSL https://agstatus.online/install.sh | sh
#   curl -fsSL https://agstatus.online/install.sh | sh -s -- --code ABCD-1234
#   curl -fsSL https://agstatus.online/install.sh | AGSTATUS_VERSION=1.3.0 sh
#
# It downloads the release artifact for the current version from GitHub,
# verifies it against that release's SHA256SUMS, unpacks it under
# ${AGSTATUS_HOME:-$HOME/.agstatus}, renders the launcher shim, puts it on
# PATH and then runs `agstatus init`. On macOS it also installs the Focus
# listener (docs/design/focus-protocol.md §5.4) unless --no-focus: it prints
# what Focus puts on the wire (§8) rather than asking, because a script on the
# end of a pipe has no stdin to ask with.
#
# Rules this file lives by:
#
#   * POSIX sh, because `| sh` is dash on Debian/Ubuntu and busybox ash on
#     Alpine: no bashisms, no arrays, and no `local` (ksh93 does not have it).
#   * Every statement lives in a function and `main "$@"` is the last line, so
#     a truncated download can never run half an installer — a copy cut off
#     mid-transfer simply never reaches the call.
#   * It never reads stdin: through a pipe stdin *is* this script. Every choice
#     is a flag, never a question.
#   * Nothing is extracted before its checksum matches, and nothing is written
#     outside the prefix except the one guarded PATH block in a shell profile.
set -eu

# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }

# die <headline> [hint...] — the trap does the cleaning up; this only explains.
# Every exit path through here says what to do next, because the person reading
# it just piped a URL into a shell and has nothing else to go on.
die() {
  printf '\n✖ %s\n' "$1" >&2
  shift
  # Empty arguments are dropped, so a caller can pass an optional detail line
  # (the downloader's last words, say) without branching around it.
  for die_line in "$@"; do
    if [ -n "$die_line" ]; then printf '  %s\n' "$die_line" >&2; fi
  done
  exit 1
}

usage() {
  cat <<'USAGE'
AgStatus installer — live status board for your coding agents.

  curl -fsSL https://agstatus.online/install.sh | sh
  curl -fsSL https://agstatus.online/install.sh | sh -s -- [options]

Options (everything but --focus/--no-focus is passed to `agstatus init`):
  --code XXXX-XXXX  Pair with a board created elsewhere (e.g. the mobile app)
  --url <base>      Server to use (for a self-hosted board)
  --secret <s>      Webhook secret for self-hosted single-tenant servers
  --minimal         Send tool names only, never command text
  --no-qr           Skip the QR code
  --codex           Also set up OpenAI Codex even if ~/.codex isn't detected
  --no-codex        Skip Codex setup (default: auto-configure when detected)
  --no-focus        Don't install the macOS Focus listener (it installs by default)
  --focus           Install it even after an earlier --no-focus (last flag wins)
  --help            This text

Environment:
  AGSTATUS_HOME     Install prefix (default: $HOME/.agstatus)
  AGSTATUS_VERSION  Version to install (default: the latest release)
  AGSTATUS_NODE     Absolute path to the node binary to use
USAGE
}

# ---------------------------------------------------------------------------
# node resolution — emitted once, used twice
# ---------------------------------------------------------------------------

# The installer sources this to find a node for itself, and the launcher shim
# embeds the very same text, so the two can never drift apart. The shim has to
# carry its own copy: it runs months later, under launchd, with no installer
# anywhere near it.
#
# Why the shim exists at all: launchd resolves a job's ProgramArguments[0]
# against launchd's own default PATH (/usr/bin:/bin:/usr/sbin:/sbin) and never
# against the job's EnvironmentVariables.PATH — a bare program name found only
# there exits 78 (EX_CONFIG) without ever running. nvm/fnm/volta put node in
# none of those four directories, so ProgramArguments[0] must be an absolute
# path we own and node must be resolved at launch rather than baked in: the
# user upgrades node, and a baked path is gone.
#
# `newest` reverses its arguments so a glob (which sorts ascending) is walked
# newest-first, and takes the first candidate that is executable and reports a
# major >= 18 — which is why a stray v3.1.0, lexically last, never wins.
node_resolver() {
  cat <<'RESOLVER'
ok() {
  [ -n "${1:-}" ] && [ -x "$1" ] &&
    "$1" -e 'process.exit(+process.versions.node.split(".")[0]>=18?0:1)' >/dev/null 2>&1
}
newest() {
  n=$#
  [ "$n" -gt 0 ] || return 1
  for d do set -- "$d" "$@"; done
  i=0
  for c do
    i=$((i + 1)); [ "$i" -gt "$n" ] && break
    ok "$c" && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
find_node() {
  for c in "${AGSTATUS_NODE:-}" "$NODE_HINT" /opt/homebrew/bin/node /usr/local/bin/node \
    /usr/bin/node /opt/local/bin/node "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
    "$HOME/.nodenv/shims/node" "$HOME/.asdf/shims/node" "$HOME/.local/share/mise/shims/node"
  do ok "$c" && { printf '%s\n' "$c"; return 0; }; done
  newest "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node && return 0
  newest "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node && return 0
  newest "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node && return 0
  newest "${N_PREFIX:-/usr/local}/n/versions/node"/*/bin/node && return 0
  newest /opt/homebrew/opt/node@*/bin/node && return 0
  newest /usr/local/opt/node@*/bin/node && return 0
  c=$(command -v node 2>/dev/null) || c=''
  ok "$c" && { printf '%s\n' "$c"; return 0; }
  return 1
}
RESOLVER
}

# Renders <prefix>/bin/agstatus. The two substituted values arrive as $1 (the
# CLI entry point) and $2 (the node found at install time, a hint only), each
# already refused by safe_in_dquotes() if it could break out of the double
# quotes it lands inside.
render_shim() {
  printf '%s\n' \
    '#!/bin/sh' \
    '# AgStatus launcher — rendered by the AgStatus installer. Do not edit.' \
    'set -u' \
    'HOME=${HOME:-/nonexistent}'
  printf 'CLI="%s"\n' "$1"
  printf 'NODE_HINT="%s"\n' "$2"
  node_resolver
  cat <<'SHIMTAIL'
NODE=$(find_node) || {
  echo "agstatus: no Node.js >=18 found. Looked in the usual places and on PATH." >&2
  echo "  Fix: install Node, or set AGSTATUS_NODE=/absolute/path/to/node." >&2
  exit 127
}
exec "$NODE" "$CLI" "$@"
SHIMTAIL
}

# The resolver is written for the shim, which runs under `set -u` alone; here
# it runs under `set -eu`, where a candidate that fails `ok` would abort the
# whole installer and report "no node" on a machine that has one. So the search
# runs with -e off, and only its result is trusted.
resolve_node() {
  NODE_HINT=''
  node_resolver > "$TMP/node-resolve.sh"
  . "$TMP/node-resolve.sh"
  set +e
  NODE=$(find_node)
  set -e
  [ -n "$NODE" ] || die \
    'No Node.js 18 or newer found.' \
    'AgStatus is a Node program; it needs a runtime, not a package manager.' \
    '  macOS:  brew install node       (or https://nodejs.org)' \
    '  Linux:  your distro package, nvm, or https://nodejs.org' \
    'Already have one somewhere unusual? Re-run with AGSTATUS_NODE=/path/to/node.'
  NODE_VERSION=$("$NODE" -v 2>/dev/null) || NODE_VERSION='?'
}

# ---------------------------------------------------------------------------
# validation helpers
# ---------------------------------------------------------------------------

# A value about to be interpolated into a double-quoted sh assignment in the
# rendered shim. Anything that could end the string, start an expansion or hide
# a second line is refused outright — a path like that is rare enough that
# failing is better than guessing at an escape.
safe_in_dquotes() {
  case ${1:-} in
    '') return 1 ;;
    *'"'*|*'\'*|*'$'*|*'`'*) return 1 ;;
  esac
  # Control characters (a newline most of all) would smuggle in a whole
  # statement; comparing against a stripped copy catches every one of them.
  sid_clean=$(printf '%s' "$1" | tr -d '\000-\037\177')
  [ "$sid_clean" = "$1" ]
}

# X.Y.Z and nothing else. This runs before the version reaches a URL or a
# filename, so "../../etc" or a tag with a shell metacharacter never gets that
# far. No pre-release suffixes: release assets are only built for X.Y.Z tags.
valid_version() {
  case ${1:-} in
    '') return 1 ;;
    *[!0-9.]*) return 1 ;;   # digits and dots only
    .*|*.) return 1 ;;       # no leading or trailing dot
    *..*) return 1 ;;        # no empty component
    *.*.*.*) return 1 ;;     # at most three components
    *.*.*) ;;                # ...and at least three
    *) return 1 ;;
  esac
  [ "${#1}" -le 32 ]
}

require_https() {
  case ${1:-} in
    https://*) ;;
    *) die "Refusing to fetch over a non-https URL:" "  ${1:-(empty)}" \
         'Release downloads are https only. Nothing was installed.' ;;
  esac
}

# ---------------------------------------------------------------------------
# cleanup
# ---------------------------------------------------------------------------

# Runs on every exit, success or not. rm -rf is idempotent, so the INT/TERM
# traps calling it before their own exit (which re-enters it through EXIT) is
# harmless. The one piece of real work: if the swap died between its two
# renames, put the old tree back rather than leave a prefix with no lib/.
cleanup() {
  if [ -n "${TMP:-}" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  if [ -n "${SWAP_NEW:-}" ] && [ -d "$SWAP_NEW" ]; then rm -rf "$SWAP_NEW"; fi
  if [ -n "${SWAP_OLD:-}" ] && [ -d "$SWAP_OLD" ]; then
    if [ -e "$PREFIX/lib" ]; then rm -rf "$SWAP_OLD"; else mv "$SWAP_OLD" "$PREFIX/lib"; fi
  fi
  :
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

check_user() {
  if [ "$(id -u)" -eq 0 ]; then
    die 'Do not run this installer as root.' \
      "It installs into a home directory (${AGSTATUS_HOME:-\$HOME/.agstatus}) and sets up hooks" \
      'for the user running the agents — as root that is the wrong user and the wrong home.' \
      'Run it again without sudo.'
  fi
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die \
    'HOME is not set to a directory that exists.' \
    'This installer has nowhere to install to. Set HOME and re-run.'
}

# The launcher interpolates the CLI path into a double-quoted assignment, so a
# prefix that could break out of those quotes is a refusal rather than an
# escaping puzzle. Checked here, before anything is downloaded or created —
# finding out after the prefix is full of files helps nobody.
check_prefix() {
  case $PREFIX in
    /*) ;;
    *) die "AGSTATUS_HOME must be an absolute path:" "  $PREFIX" ;;
  esac
  safe_in_dquotes "$PREFIX/lib/agstatus/dist/cli.js" || die \
    'The install path contains a character the launcher cannot quote safely:' \
    "  $PREFIX" \
    'A quote, backslash, dollar sign, backtick or control character in the path' \
    'would be read as shell syntax in the launcher. Set AGSTATUS_HOME to a plain' \
    'path and re-run. Nothing was created.'
}

detect_platform() {
  OS=$(uname -s 2>/dev/null || echo unknown)
  case $OS in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      die 'This is the macOS and Linux installer; you are on Windows.' \
        'Use the PowerShell one instead:' \
        '  irm https://agstatus.online/install.ps1 | iex' ;;
    *)
      die "Unsupported platform: $OS" \
        'AgStatus installs on macOS, Linux and Windows.' \
        'On a system we do not package for, the CLI still runs anywhere Node 18+ does —' \
        '  open an issue at https://github.com/KardanovIR/claude-status-dashboard/issues' ;;
  esac
}

# curl first: anyone who got here through the documented one-liner has it. wget
# is for the copy that was saved to disk and run on a box that does not.
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER=curl
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER=wget
  else
    die 'Neither curl nor wget is installed.' \
      'One of them is needed to download the release. Install either and re-run.'
  fi
}

# shasum on macOS, sha256sum on most Linuxes; busybox provides sha256sum too.
# Verification is not optional, so a machine with neither stops here rather
# than installing something unverified.
detect_sha() {
  if command -v shasum >/dev/null 2>&1; then
    SHA_TOOL=shasum
  elif command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL=sha256sum
  else
    die 'No sha256 tool found (looked for shasum and sha256sum).' \
      'The download is verified against the release SHA256SUMS before anything is' \
      'unpacked, and that check cannot be skipped. Install coreutils and re-run.'
  fi
}

# The digest, from whichever tool detect_sha() found. A function rather than a
# `$SHA_CMD` string because the arguments have to survive being called from a
# shell that does not word-split unquoted expansions (zsh, when someone runs
# `zsh install.sh` instead of piping it into sh).
sha256_of() {
  if [ "$SHA_TOOL" = shasum ]; then shasum -a 256 "$1"; else sha256sum "$1"; fi
}

# ---------------------------------------------------------------------------
# download
# ---------------------------------------------------------------------------

# One transfer. Prints the HTTP status on stdout; 000 means "no answer at all".
# --proto/--proto-redir keep a redirect from walking off https, which the URL
# string check alone cannot see (busybox wget has no --https-only, hence the
# string check rather than a flag).
http_get() {
  hg_code=''
  if [ "$DOWNLOADER" = curl ]; then
    hg_code=$(curl -sS -L --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 900 \
      -o "$2" -w '%{http_code}' "$1" 2>"$TMP/fetch.err") || hg_code=''
  else
    hg_rc=0
    # A redirect is the hole the URL-string check cannot see: wget follows a
    # 30x to http by default, and an attacker who can inject one controls BOTH
    # SHA256SUMS and the tarball — so the checksum gate would verify their
    # archive against their digest. GNU wget has --https-only; busybox does not
    # and does not follow redirects across schemes, so losing the flag there is
    # safe. Probed once, because an unknown flag is a hard error on GNU.
    if [ -z "${WGET_HTTPS_ONLY+x}" ]; then
      if wget --https-only --help >/dev/null 2>&1; then
        WGET_HTTPS_ONLY='--https-only'
      else
        WGET_HTTPS_ONLY=''
      fi
    fi
    # Unquoted on purpose: empty must expand to no argument at all.
    # shellcheck disable=SC2086
    wget -q $WGET_HTTPS_ONLY -O "$2" "$1" 2>"$TMP/fetch.err" || hg_rc=$?
    # Neither busybox nor every GNU build can be asked for the status line
    # portably, so the exit code stands in: 8 is "the server issued an error
    # response", which for a release asset is a 404 far more often than a 5xx.
    if [ "$hg_rc" -eq 0 ]; then hg_code=200
    elif [ "$hg_rc" -eq 8 ]; then hg_code=404
    fi
  fi
  # Anything that is not three digits is "no answer at all": a curl that died
  # before it could report one, or an old one that choked on a flag. Normalised
  # here so the caller never has to match against two concatenated codes.
  case $hg_code in
    [0-9][0-9][0-9]) printf '%s' "$hg_code" ;;
    *) printf '000' ;;
  esac
}

# Download $1 to $2, or fail with FETCH_CODE set for the caller's message.
# Success is an HTTP 200, never the transfer's exit code: a captive portal or a
# CDN error page is a perfectly successful transfer of the wrong bytes, and it
# would sail past `curl -f`-style error handling into the checksum as garbage.
# 4xx is final — the asset is not there and retrying cannot conjure it — except
# 408 and 429, the two that literally mean "try again".
fetch() {
  require_https "$1"
  fetch_try=1
  while :; do
    rm -f "$2"
    FETCH_CODE=$(http_get "$1" "$2") || FETCH_CODE=000
    case $FETCH_CODE in
      200) return 0 ;;
      408|429) ;;
      4??) return 1 ;;
    esac
    [ "$fetch_try" -lt 3 ] || return 1
    sleep "$fetch_try"
    fetch_try=$((fetch_try + 1))
  done
}

download_failed() {
  # $1 = what we were after, $2 = its URL.
  # The downloader's own last line is worth repeating: "SSL certificate problem"
  # from a corporate proxy is a completely different afternoon than "offline".
  df_detail=''
  if [ -s "$TMP/fetch.err" ]; then
    df_detail=$(tail -n 1 "$TMP/fetch.err" | tr -d '\r' | cut -c1-200)
  fi
  case ${FETCH_CODE:-000} in
    000) die "Could not download $1." \
      "  $2" \
      "$df_detail" \
      'No answer from github.com — offline, behind a proxy, or DNS is down.' \
      'Nothing was installed. Fix the connection and re-run the same command.' ;;
    4??) die "Could not download $1 (HTTP $FETCH_CODE)." \
      "  $2" \
      "There is no such asset on the v$VERSION release." \
      'Pin a version you know exists with AGSTATUS_VERSION=X.Y.Z, or check' \
      '  https://github.com/KardanovIR/claude-status-dashboard/releases' ;;
    *) die "Could not download $1 (HTTP $FETCH_CODE after 3 attempts)." \
      "  $2" \
      'GitHub answered, but not with the file. Nothing was installed — try again shortly.' ;;
  esac
}

# The version, without asking the GitHub API: /releases/latest answers with a
# 302 to /releases/tag/vX.Y.Z, and a redirect costs nothing against the API's
# 60-requests-an-hour unauthenticated budget — which a shared office IP can
# exhaust between two coffees.
resolve_version() {
  if [ -n "${AGSTATUS_VERSION:-}" ]; then
    VERSION=${AGSTATUS_VERSION#v}
    valid_version "$VERSION" || die \
      "AGSTATUS_VERSION is not a release version: ${AGSTATUS_VERSION}" \
      'Expected X.Y.Z, for example AGSTATUS_VERSION=1.3.0.'
    return 0
  fi

  rv_url="https://github.com/$REPO/releases/latest"
  require_https "$rv_url"
  if [ "$DOWNLOADER" = curl ]; then
    rv_raw=$(curl -fsS --proto '=https' --connect-timeout 15 --max-time 60 \
      -o /dev/null -w '%{redirect_url}' "$rv_url" 2>"$TMP/fetch.err") || rv_raw=''
  else
    # wget cannot be asked for a Location header portably (--server-response is
    # GNU-only), so it follows the redirect and the tag is read back out of the
    # page it lands on — the canonical /releases/tag/vX.Y.Z link is the first
    # one there. AGSTATUS_VERSION skips all of this.
    rv_raw=''
    if wget -q -O "$TMP/latest.html" "$rv_url" 2>"$TMP/fetch.err"; then
      rv_tag=$(sed -n 's|.*/releases/tag/\(v[0-9][0-9.]*\).*|\1|p' "$TMP/latest.html" | head -n 1)
      # Left empty when the page held no tag link, so the "no release" message
      # below is the one that comes out rather than a puzzling "/tag/".
      if [ -n "$rv_tag" ]; then rv_raw="/tag/$rv_tag"; fi
    fi
  fi
  [ -n "$rv_raw" ] || die \
    'Could not work out the latest AgStatus version.' \
    "  $rv_url did not answer with a release." \
    'Offline, or behind a proxy that eats redirects? Nothing was installed.' \
    'You can pin one instead:  AGSTATUS_VERSION=1.3.0 sh install.sh'

  # Everything up to and including the last /tag/v goes; a URL that never had
  # one leaves the whole string behind, which valid_version then rejects.
  VERSION=${rv_raw##*/tag/v}
  valid_version "$VERSION" || die \
    'The latest release does not look like a version we can install.' \
    "  $rv_url -> $rv_raw" \
    'Pin a known one:  AGSTATUS_VERSION=1.3.0'
}

fetch_release() {
  TGZ_NAME="agstatus-$VERSION.tgz"
  fr_rel="https://github.com/$REPO/releases/download/v$VERSION"
  TGZ_URL="$fr_rel/$TGZ_NAME"
  SUMS_URL="$fr_rel/SHA256SUMS"

  step "Downloading AgStatus $VERSION"
  note "$TGZ_URL"
  fetch "$SUMS_URL" "$TMP/SHA256SUMS" || download_failed 'SHA256SUMS' "$SUMS_URL"
  fetch "$TGZ_URL" "$TMP/$TGZ_NAME" || download_failed "$TGZ_NAME" "$TGZ_URL"
}

# ---------------------------------------------------------------------------
# verify and unpack
# ---------------------------------------------------------------------------

# Read the expected digest out of SHA256SUMS by exact filename — a `while read`
# over the file rather than a sed pattern built from it, so nothing in the name
# is ever interpreted. Then compare. A mismatch is where this installer stops:
# an archive is a pile of paths and permissions, and unpacking one you cannot
# vouch for is the whole problem.
verify_tarball() {
  step 'Verifying the download'
  vt_want=''
  # CRs out first: a SHA256SUMS written on a Windows runner would otherwise
  # never match a name, and "no checksum for this file" is a confusing way to
  # report a line ending. `*` marks a binary-mode digest, `./` is how some
  # generators spell the same name; neither is part of it.
  tr -d '\r' < "$TMP/SHA256SUMS" > "$TMP/sums"
  while read -r vt_sum vt_file; do
    vt_file=${vt_file#\*}
    vt_file=${vt_file#./}
    if [ "$vt_file" = "$TGZ_NAME" ]; then vt_want=$vt_sum; break; fi
  done < "$TMP/sums"

  case $vt_want in
    *[!0-9a-fA-F]*|'') die \
      "SHA256SUMS has no usable checksum for $TGZ_NAME." \
      'The release is incomplete or the file was tampered with in transit.' \
      'Nothing was unpacked and nothing was installed.' ;;
  esac
  [ "${#vt_want}" -eq 64 ] || die \
    "SHA256SUMS has a malformed checksum for $TGZ_NAME." \
    'Nothing was unpacked and nothing was installed.'

  vt_have=$(sha256_of "$TMP/$TGZ_NAME" | cut -d' ' -f1)
  vt_want=$(printf '%s' "$vt_want" | tr 'A-F' 'a-f')
  vt_have=$(printf '%s' "$vt_have" | tr 'A-F' 'a-f')
  [ "$vt_have" = "$vt_want" ] || die \
    'Checksum mismatch — refusing to unpack the download.' \
    "  expected  $vt_want" \
    "  got       $vt_have" \
    'Usually a truncated or proxy-mangled transfer; occasionally worse.' \
    'Nothing was unpacked and nothing was installed. Re-run to try again; if it' \
    'happens twice, report it at' \
    '  https://github.com/KardanovIR/claude-status-dashboard/issues'
  note "sha256 ok  $vt_have"
}

# tar is told to write inside a staging directory, but "told" is not a
# guarantee worth relying on: the listing is read first and any entry that
# could climb out of it — absolute, a .. component, or ~-relative — stops the
# install. GNU tar strips a leading / and bsdtar refuses .. by default, and
# neither behaviour is something to depend on across the tars in the wild.
extract_tarball() {
  step 'Unpacking'
  STAGE="$TMP/stage"
  mkdir -p "$STAGE"

  tar -tzf "$TMP/$TGZ_NAME" > "$TMP/listing" 2>/dev/null || die \
    'The download is not a readable tar.gz archive.' \
    'Nothing was unpacked and nothing was installed. Re-run to download it again.'
  while read -r et_entry; do
    case $et_entry in
      /*|~*|..|../*|*/../*|*/..) die \
        'The archive contains a path that escapes the install directory:' \
        "  $et_entry" \
        'Refusing to unpack it. Nothing was installed — please report this at' \
        '  https://github.com/KardanovIR/claude-status-dashboard/issues' ;;
    esac
  done < "$TMP/listing"

  tar -xzf "$TMP/$TGZ_NAME" -C "$STAGE" || die \
    'The archive could not be unpacked.' \
    'Nothing was installed. Re-run to download it again.'

  # The artifact may or may not carry a top-level agstatus-<version>/ wrapper;
  # find the root by the file that has to be there either way.
  ROOT=''
  if [ -f "$STAGE/lib/agstatus/dist/cli.js" ]; then
    ROOT="$STAGE"
  else
    for et_dir in "$STAGE"/*; do
      if [ -f "$et_dir/lib/agstatus/dist/cli.js" ]; then ROOT="$et_dir"; break; fi
    done
  fi
  [ -n "$ROOT" ] || die \
    "The archive is not an AgStatus release (no lib/agstatus/dist/cli.js in $TGZ_NAME)." \
    'Nothing was installed. Please report this at' \
    '  https://github.com/KardanovIR/claude-status-dashboard/issues'
  [ -d "$ROOT/lib/node_modules/qrcode-terminal" ] || warn \
    'the artifact has no bundled qrcode-terminal; `agstatus init` will not print a QR code.'
}

# Stage the whole tree beside the live one and swap with two renames, so a
# failure at any point leaves either the old install or the new one — never a
# half-written mixture of both. The copy is what takes time; the swap is two
# renames within one directory, which is as close to atomic as a directory tree
# gets. cleanup() puts the old tree back if the second rename never happens.
install_tree() {
  step "Installing into $PREFIX"
  PREVIOUS=$(installed_version)
  mkdir -p "$PREFIX" || die \
    "Could not create $PREFIX." \
    'Check the path is writable by you, or point AGSTATUS_HOME somewhere that is.' \
    'Nothing was changed.'
  SWAP_NEW="$PREFIX/.lib.new.$$"
  rm -rf "$SWAP_NEW"
  cp -R "$ROOT/lib" "$SWAP_NEW" || die \
    "Could not write into $PREFIX." \
    'Check the directory is yours and has room, then re-run. Nothing was changed.'

  # -e, not -d: a stray file (or a dangling symlink) where lib/ belongs has to
  # move aside too, or the rename below fails with the new tree already staged.
  if [ -e "$PREFIX/lib" ] || [ -L "$PREFIX/lib" ]; then
    SWAP_OLD="$PREFIX/.lib.old.$$"
    rm -rf "$SWAP_OLD"
    mv "$PREFIX/lib" "$SWAP_OLD"
  fi
  mv "$SWAP_NEW" "$PREFIX/lib"
  SWAP_NEW=''
  if [ -n "${SWAP_OLD:-}" ]; then
    rm -rf "$SWAP_OLD"
    SWAP_OLD=''
  fi

  # The artifact carries the MIT licence at its root; keep it with the tree it
  # covers. Outside lib/, so it is copied after the swap rather than staged with
  # it — and a licence file that fails to copy is not worth failing an otherwise
  # complete install over.
  if [ -f "$ROOT/LICENSE" ]; then cp "$ROOT/LICENSE" "$PREFIX/LICENSE" 2>/dev/null || :; fi

  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERSION" ]; then
    note "upgraded $PREVIOUS -> $VERSION"
  elif [ -n "$PREVIOUS" ]; then
    note "reinstalled $VERSION"
  fi
}

# The version already installed, if any — read out of the package.json we ship
# rather than by running the old CLI, which may not have a working node any
# more. Empty when there is nothing there.
installed_version() {
  iv_file="$PREFIX/lib/agstatus/package.json"
  [ -f "$iv_file" ] || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$iv_file" | head -n 1
}

install_shim() {
  CLI="$PREFIX/lib/agstatus/dist/cli.js"
  BIN="$PREFIX/bin/agstatus"
  # A node hint that cannot be quoted is dropped rather than fatal: the shim
  # searches the usual places anyway, and the hint is only a shortcut.
  if safe_in_dquotes "$NODE"; then SHIM_NODE=$NODE; else SHIM_NODE=''; fi

  mkdir -p "$PREFIX/bin"
  # mv into a directory of that name would file the shim *inside* it and the
  # -x test below would still pass (a directory is searchable), leaving an
  # install that cannot run. Say so instead.
  if [ -d "$BIN" ]; then
    die "$BIN is a directory, not the launcher." \
      'Remove it and re-run; the CLI itself is already in place.'
  fi
  render_shim "$CLI" "$SHIM_NODE" > "$TMP/agstatus.shim"
  chmod 0700 "$TMP/agstatus.shim"
  # Into place with a rename: replacing the file a running launcher is reading
  # in situ would hand it half a script.
  mv "$TMP/agstatus.shim" "$BIN"
  [ -x "$BIN" ] || die "Could not make $BIN executable." 'Nothing else was changed.'

  # The launcher is also the right ProgramArguments[0] for the LaunchAgent that
  # `agstatus listener install` writes below: an absolute path AgStatus owns,
  # which re-resolves node at every launch instead of pinning whichever node was
  # current at install time — a plist naming an nvm node is dead at the next
  # `nvm install` (docs/design/focus-protocol.md §5.4). Handed over in the
  # environment so the CLI can prefer it; inert for a CLI that ignores it.
  AGSTATUS_BIN="$BIN"
  export AGSTATUS_BIN
}

# ---------------------------------------------------------------------------
# PATH
# ---------------------------------------------------------------------------

# Which file a login shell of $SHELL will actually read. fish gets its own
# syntax further down; everything unrecognised gets ~/.profile, which is the
# closest thing to a universal answer.
profile_file() {
  pf_shell=$(basename "${SHELL:-/bin/sh}" 2>/dev/null || echo sh)
  case $pf_shell in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # macOS terminals start login shells, which read .bash_profile and not
      # .bashrc; on Linux it is the other way round.
      if [ "$OS" = darwin ]; then printf '%s\n' "$HOME/.bash_profile"
      elif [ -f "$HOME/.bashrc" ]; then printf '%s\n' "$HOME/.bashrc"
      else printf '%s\n' "$HOME/.profile"; fi ;;
    fish) printf '%s\n' "$HOME/.config/fish/config.fish" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

# The literal text of the PATH entry as it goes into the profile: $HOME-relative
# for the default prefix, so a dotfile synced between machines still works (the
# same reason the hook command in settings.json is written with $HOME), and the
# absolute path for a custom AGSTATUS_HOME.
path_entry_literal() {
  if [ "$PREFIX" = "$HOME/.agstatus" ]; then
    printf '%s\n' '$HOME/.agstatus/bin'
  else
    printf '%s\n' "$PREFIX/bin"
  fi
}

# The block appended to a POSIX-ish profile. Guarded, so it is inert when the
# entry is already there (a re-run, or a shell that inherited it), and marked,
# so the next run can see its own work and never write it twice.
path_block_posix() {
  cat <<BLOCK
$PATH_MARKER
# Added by the AgStatus installer. Remove this block to take it out again.
case ":\$PATH:" in
  *":$1:"*) ;;
  *) PATH="$1:\$PATH"; export PATH ;;
esac
# <<< agstatus <<<
BLOCK
}

path_block_fish() {
  cat <<BLOCK
$PATH_MARKER
# Added by the AgStatus installer. Remove this block to take it out again.
if not contains "$1" \$PATH
    set -gx PATH "$1" \$PATH
end
# <<< agstatus <<<
BLOCK
}

setup_path() {
  step 'Putting agstatus on your PATH'

  # An older global copy (npm -g or the retired Homebrew tap) keeps working,
  # but ours goes first. Say so rather than let two agstatus binaries confuse
  # the next person to read `which agstatus`.
  sp_other=$(command -v agstatus 2>/dev/null) || sp_other=''
  if [ -n "$sp_other" ] && [ "$sp_other" != "$BIN" ]; then
    warn "another agstatus is installed at $sp_other"
    note 'This install goes ahead of it on PATH. To remove the old one:'
    note '  npm rm -g agstatus     # if it came from npm'
    note '  brew uninstall agstatus  # if it came from the tap'
  fi

  # For the rest of this run — `agstatus init` below is called by absolute
  # path, but anything it shells out to should find the same binary.
  PATH="$PREFIX/bin:$PATH"
  export PATH

  sp_file=$(profile_file)
  sp_entry=$(path_entry_literal)
  if [ -f "$sp_file" ] && grep -F "$PATH_MARKER" "$sp_file" >/dev/null 2>&1; then
    note "already in $sp_file"
    return 0
  fi

  sp_ok=1
  mkdir -p "$(dirname "$sp_file")" 2>/dev/null || sp_ok=0
  if [ "$sp_ok" = 1 ]; then
    case $sp_file in
      # Both arms lead with a newline: appending to a profile whose last line
      # has no trailing newline would otherwise glue the marker onto the user's
      # own last statement, corrupting the file and losing the PATH with it.
      *config.fish) { printf '\n'; path_block_fish "$sp_entry"; } >> "$sp_file" 2>/dev/null || sp_ok=0 ;;
      *) { printf '\n'; path_block_posix "$sp_entry"; } >> "$sp_file" 2>/dev/null || sp_ok=0 ;;
    esac
  fi

  if [ "$sp_ok" = 1 ]; then
    note "added to $sp_file"
    note 'Open a new terminal (or source that file) for `agstatus` to be found.'
  else
    warn "could not write $sp_file"
    note 'Add this line to your shell profile by hand:'
    note "  export PATH=\"$PREFIX/bin:\$PATH\""
  fi
}

# ---------------------------------------------------------------------------
# setup
# ---------------------------------------------------------------------------

# A hook is already registered when settings.json mentions the marker every
# command we write carries. `agstatus init` replaces those entries in place —
# including the old `npx agstatus`-era ones — so this is a note, not a problem.
existing_hook_note() {
  eh_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  eh_file="$eh_dir/settings.json"
  if [ -f "$eh_file" ] && grep -F 'agstatus-hook' "$eh_file" >/dev/null 2>&1; then
    note "$eh_file already registers an AgStatus hook — it will be pointed at this install."
  fi
}

# `agstatus init` with whatever the user passed through the pipe. A failure
# here is not a failed install: the CLI is on disk and working, only the board
# side did not complete, so say how to finish rather than tearing anything down.
run_init() {
  step 'Setting up hooks'
  existing_hook_note
  ri_rc=0
  "$BIN" init "$@" || ri_rc=$?
  if [ "$ri_rc" -ne 0 ]; then
    say ''
    warn "agstatus init exited with $ri_rc — AgStatus is installed but not connected yet."
    note 'Fix whatever it reported above, then run:'
    note "  $PREFIX/bin/agstatus init"
    return "$ri_rc"
  fi
  return 0
}

# Did this run wire Codex up? Asked of the registration `agstatus init` just
# wrote rather than of the flags, so the answer is right whichever way init
# decided (~/.codex present, --codex, or a Codex setup that failed and
# degraded to a warning). Called with the init arguments only for --no-codex:
# that leaves an older registration in place untouched, still carrying the
# command Codex already trusts, so there is nothing to re-trust.
codex_wired() {
  for cc_arg in "$@"; do
    case $cc_arg in --no-codex) return 1 ;; esac
  done
  cc_file="${CODEX_HOME:-$HOME/.codex}/hooks.json"
  [ -f "$cc_file" ] && grep -F 'agstatus-hook' "$cc_file" >/dev/null 2>&1
}

# Codex trusts a hook by hashing its registered command string, so the command
# this release writes does not match a trusted_hash stored by an older one —
# the hook is simply never run, with no error on either side. `agstatus init`
# says this the moment it wires Codex up (cli/src/index.ts, setupCodex); the
# summary repeats it word for word, because by then the init output has
# scrolled past and this is the one thing left for the user to do.
codex_retrust_notice() {
  say ''
  warn 'One-time step: run /hooks inside Codex to trust the AgStatus hook.'
  note 'Codex trusts a hook by hashing its command, and this release changed'
  note 'that command — an existing install stays silent until you re-run /hooks.'
}

# What Focus puts on the wire, printed before it is turned on. The wording
# follows docs/design/focus-protocol.md §8 and the summary `agstatus listener
# install` prints itself — it is a statement, not a question, because a script
# read from a pipe has no stdin left to read an answer from.
focus_disclosure() {
  say ''
  say 'Focus — tapping a session on your board brings that terminal to the front'
  say 'on this Mac — installs now. Skip it with --no-focus.'
  say ''
  say 'With Focus on, status posts from this machine additionally carry:'
  say '  { "machine": { "id": ..., "name": "Mac" },   ← a short label you choose, and a random'
  say '                                                 id specific to this board and this machine'
  say '    "app": { "slug", "name", "kind" } }        ← the app each session runs in,'
  say '                                                 e.g. {"slug":"agterm","name":"agterm","kind":"terminal"}'
  say ''
  say 'Nothing about your files, folders, terminal or environment leaves the machine:'
  say 'those details stay in a local file only the listener reads. The listener keeps'
  say 'a connection open to your board to receive taps and sends nothing but the'
  say 'acknowledgement of one. Turn it off any time with `agstatus listener uninstall`.'
}

setup_focus() {
  if [ "$OS" != darwin ]; then
    step 'Focus listener'
    if [ "$FOCUS" = yes ] && [ "$FOCUS_EXPLICIT" = yes ]; then
      note 'Skipped: the Focus listener v1 is macOS-only, so --focus has nothing to install here.'
    else
      note 'Skipped: the Focus listener v1 is macOS-only.'
    fi
    return 0
  fi
  if [ "$FOCUS" != yes ]; then
    step 'Focus listener'
    note 'Skipped (--no-focus). Turn it on later with `agstatus listener install`.'
    return 0
  fi

  step 'Focus listener'
  focus_disclosure
  say ''
  sf_rc=0
  "$BIN" listener install || sf_rc=$?
  if [ "$sf_rc" -ne 0 ]; then
    say ''
    warn "agstatus listener install exited with $sf_rc."
    note 'Everything else is installed and working; only Focus is off. Retry with:'
    note "  $PREFIX/bin/agstatus listener install"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  REPO='KardanovIR/claude-status-dashboard'
  PREFIX=${AGSTATUS_HOME:-$HOME/.agstatus}
  # The line setup_path() looks for to know it has already been here.
  PATH_MARKER='# >>> agstatus >>>'
  FOCUS=yes
  FOCUS_EXPLICIT=no
  TMP=''
  SWAP_NEW=''
  SWAP_OLD=''
  FETCH_CODE=000

  # Flags arrive through the pipe as `| sh -s -- --no-focus --code XXXX-XXXX`.
  # Ours are consumed; the init ones are collected verbatim, in order, exactly
  # as cli/src/index.ts parses them (--url/--code/--secret take a value, the
  # rest are booleans; --key=value is accepted for the value flags). Unknown
  # flags stop the install here rather than after a download.
  #
  # The idiom: originals come off the front, keepers go on the back, and when
  # the counter runs out "$@" holds exactly the arguments for `agstatus init`.
  ma_left=$#
  while [ "$ma_left" -gt 0 ]; do
    ma_arg=$1
    shift
    ma_left=$((ma_left - 1))
    case $ma_arg in
      --no-focus) FOCUS=no; FOCUS_EXPLICIT=yes ;;
      --focus) FOCUS=yes; FOCUS_EXPLICIT=yes ;;
      -h|--help) usage; return 0 ;;
      --minimal|--no-qr|--codex|--no-codex)
        set -- "$@" "$ma_arg" ;;
      --url=*|--code=*|--secret=*)
        set -- "$@" "$ma_arg" ;;
      --url|--code|--secret)
        if [ "$ma_left" -eq 0 ]; then
          die "Missing value for $ma_arg." 'Run with --help to see the options.'
        fi
        ma_val=$1
        shift
        ma_left=$((ma_left - 1))
        set -- "$@" "$ma_arg" "$ma_val" ;;
      *)
        die "Unknown option: $ma_arg" \
          'Run with --help to see the options:' \
          '  curl -fsSL https://agstatus.online/install.sh | sh -s -- --help' ;;
    esac
  done

  check_user
  check_prefix
  detect_platform
  detect_downloader
  detect_sha

  TMP=$(mktemp -d 2>/dev/null) || TMP=$(mktemp -d -t agstatus) || TMP=''
  [ -n "$TMP" ] && [ -d "$TMP" ] || die \
    'Could not create a temporary directory.' \
    'Check that TMPDIR points somewhere writable, then re-run.'
  trap 'cleanup' EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM

  say 'AgStatus installer'
  resolve_node
  note "node       $NODE ($NODE_VERSION)"
  resolve_version
  note "version    $VERSION"
  note "prefix     $PREFIX"

  fetch_release
  verify_tarball
  extract_tarball
  install_tree
  install_shim
  setup_path

  ma_rc=0
  run_init "$@" || ma_rc=$?
  if [ "$ma_rc" -eq 0 ]; then setup_focus; fi

  if [ "$ma_rc" -eq 0 ]; then step 'Done'; else step 'Installed, but not connected yet'; fi
  note "agstatus $VERSION  ->  $PREFIX"
  note "launcher   $BIN"
  say ''
  if [ "$ma_rc" -eq 0 ]; then
    say 'Start a Claude Code or Codex session and watch it appear on your board.'
    # Before the sign-off line, not after: on Codex this is the difference
    # between a board that fills up and one that never does.
    if codex_wired "$@"; then
      codex_retrust_notice
      say ''
    fi
  fi
  say 'Re-run this installer any time to upgrade; `agstatus uninstall` removes the hooks.'
  return "$ma_rc"
}

# Brace group, not a bare call: a transfer cut off at exactly `main` would
# otherwise be a syntactically complete script that runs a DEFAULT install with
# every flag silently dropped — including a --no-focus the user explicitly
# asked for. Inside `{ }` any truncation is an unterminated block, so sh
# refuses to run it at all. Verified against every truncation point.
{ main "$@"; }
