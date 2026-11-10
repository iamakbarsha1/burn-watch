#!/bin/sh
# Installs the burnwatch agent from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/iamakbarsha1/burn-watch/main/scripts/install.sh | sh
#
# Overrides: BURNWATCH_INSTALL_DIR (default ~/.local/bin), BURNWATCH_VERSION
# (default latest).
set -eu

REPO=iamakbarsha1/burn-watch
INSTALL_DIR="${BURNWATCH_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${BURNWATCH_VERSION:-latest}"

die() {
  echo "burnwatch: $1" >&2
  exit 1
}

os=$(uname -s)
arch=$(uname -m)
case "$os $arch" in
  'Darwin arm64')  asset=burnwatch-darwin-arm64 ;;
  'Darwin x86_64') asset=burnwatch-darwin-x64 ;;
  'Linux x86_64')  asset=burnwatch-linux-x64 ;;
  *) die "no prebuilt binary for $os $arch. Build from source: https://github.com/$REPO/blob/main/docs/INSTALL.md" ;;
esac

command -v curl >/dev/null 2>&1 || die 'curl is required'

# shasum ships with macOS, sha256sum with most Linux distributions. Refusing to
# install beats installing a binary nobody checked.
if command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
else
  die 'neither shasum nor sha256sum found, cannot verify the download'
fi

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "burnwatch: downloading $asset ($VERSION)"
# The binary embeds the Bun runtime and runs to ~100 MB, so a silent curl looks
# like a hang for a minute. Progress bar, not -s.
curl -fSL --progress-bar "$base/$asset" -o "$tmp/burnwatch" || die "could not download $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || die 'could not download checksums.txt'

expected=$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/checksums.txt")
[ -n "$expected" ] || die "checksums.txt has no entry for $asset"
actual=$(checksum "$tmp/burnwatch")
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"

chmod +x "$tmp/burnwatch"
mkdir -p "$INSTALL_DIR"
mv "$tmp/burnwatch" "$INSTALL_DIR/burnwatch"

echo "burnwatch: installed to $INSTALL_DIR/burnwatch"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    # Earlier installs put the binary in /usr/local/bin by hand. If one is
    # still there it wins the PATH lookup, and the user upgrades nothing while
    # being told the upgrade worked.
    found=$(command -v burnwatch || true)
    if [ -n "$found" ] && [ "$found" != "$INSTALL_DIR/burnwatch" ]; then
      echo "burnwatch: warning — $found comes first on your PATH and will run instead."
      echo "  Remove it, or re-run with BURNWATCH_INSTALL_DIR=$(dirname "$found")"
    else
      echo 'burnwatch: next, run  burnwatch register'
    fi
    ;;
  *)
    echo "burnwatch: $INSTALL_DIR is not on your PATH. Add it, then reopen your shell:"
    echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc"
    ;;
esac
