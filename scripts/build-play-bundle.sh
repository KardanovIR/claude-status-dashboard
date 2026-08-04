#!/usr/bin/env bash
# Builds the Android App Bundle Google Play expects and drops it next to the
# rest of the submission material.
#
#   scripts/build-play-bundle.sh
#
# Run scripts/make-upload-keystore.sh first; without it the bundle builds
# unsigned and Play will reject the upload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID="$ROOT/android"
DEST="$ROOT/distribution/google-play/release"

export JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/temurin-17/Contents/Home}"
[ -x "$JAVA_HOME/bin/java" ] || { echo "JDK 17 not found at $JAVA_HOME — set JAVA_HOME" >&2; exit 1; }

if [ ! -f "$ANDROID/keystore.properties" ]; then
  echo "warning: android/keystore.properties is missing, so the bundle will be UNSIGNED." >&2
  echo "         Run scripts/make-upload-keystore.sh before uploading to Play." >&2
fi

echo "==> Building release bundle"
( cd "$ANDROID" && ./gradlew :app:bundleRelease --console=plain )

AAB="$ANDROID/app/build/outputs/bundle/release/app-release.aab"
[ -f "$AAB" ] || { echo "No bundle produced at $AAB" >&2; exit 1; }

mkdir -p "$DEST"
cp "$AAB" "$DEST/agstatus-release.aab"

VERSION_NAME="$(grep -m1 'versionName' "$ANDROID/app/build.gradle.kts" | sed 's/.*"\(.*\)".*/\1/')"
VERSION_CODE="$(grep -m1 'versionCode' "$ANDROID/app/build.gradle.kts" | sed 's/[^0-9]//g')"

echo "==> $DEST/agstatus-release.aab"
echo "    versionName $VERSION_NAME, versionCode $VERSION_CODE, $(du -h "$DEST/agstatus-release.aab" | cut -f1)"

# A bundle whose signature block is missing will be rejected on upload; say so
# here rather than after a round trip through Play Console.
if unzip -l "$DEST/agstatus-release.aab" 2>/dev/null | grep -q "META-INF/.*\.RSA\|META-INF/.*\.EC"; then
  echo "    signed: yes"
else
  echo "    signed: NO — run scripts/make-upload-keystore.sh and rebuild"
fi
