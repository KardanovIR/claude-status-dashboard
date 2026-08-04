#!/usr/bin/env bash
# Creates the Play upload key and wires the Android build to it.
#
#   scripts/make-upload-keystore.sh
#
# The keystore and its password are written OUTSIDE the repo (they are
# credentials), and android/keystore.properties — which points at them — is
# gitignored. Re-running refuses to overwrite an existing keystore.
#
# With Play App Signing (on by default for new apps) Google holds the real
# app signing key; this upload key only proves that uploads come from you. If
# it is ever lost, Google can reset it — losing it is recoverable, unlike the
# app signing key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${AGSTATUS_SECRETS_DIR:-$HOME/Desktop/claude-status-private}"
KEYSTORE="$SECRETS_DIR/agstatus-upload.jks"
PROPS="$ROOT/android/keystore.properties"
ALIAS="upload"

JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/temurin-17/Contents/Home}"
KEYTOOL="$JAVA_HOME/bin/keytool"
[ -x "$KEYTOOL" ] || { echo "keytool not found at $KEYTOOL — set JAVA_HOME" >&2; exit 1; }

if [ -f "$KEYSTORE" ]; then
  echo "Keystore already exists: $KEYSTORE"
  echo "Refusing to overwrite it. Delete it by hand if you really mean to."
  exit 1
fi

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# A generated password beats a memorable one: nothing has to type it, and it
# is stored next to the keystore it unlocks. Read a fixed number of bytes
# rather than piping into head — under `set -o pipefail` the closed pipe kills
# the producer and takes the whole script with it.
PASSWORD="$(LC_ALL=C head -c 4096 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-40)"

"$KEYTOOL" -genkeypair -v \
  -keystore "$KEYSTORE" \
  -storetype PKCS12 \
  -storepass "$PASSWORD" \
  -keypass "$PASSWORD" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=AgStatus, OU=AgStatus, O=Inal Kardanov, L=, ST=, C=" > /dev/null

chmod 600 "$KEYSTORE"

umask 077
cat > "$SECRETS_DIR/agstatus-upload-password.txt" <<EOF
Play upload keystore for com.kardanov.agstatus
keystore: $KEYSTORE
alias:    $ALIAS
password: $PASSWORD

Back this file and the .jks up somewhere safe (a password manager is ideal).
EOF

cat > "$PROPS" <<EOF
storeFile=$KEYSTORE
storePassword=$PASSWORD
keyAlias=$ALIAS
keyPassword=$PASSWORD
EOF
chmod 600 "$PROPS"

echo "Created:"
echo "  keystore  $KEYSTORE"
echo "  password  $SECRETS_DIR/agstatus-upload-password.txt"
echo "  build ref $PROPS  (gitignored)"
echo
echo "Fingerprint to expect in Play Console:"
"$KEYTOOL" -list -v -keystore "$KEYSTORE" -storepass "$PASSWORD" -alias "$ALIAS" \
  | grep -E "SHA1:|SHA256:" | sed 's/^/  /'
echo
echo "Now build the bundle:  scripts/build-play-bundle.sh"
