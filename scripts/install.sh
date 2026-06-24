#!/usr/bin/env bash
set -euo pipefail

REPO="iamakbarsha1/burn-watch"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="burnwatch"
TMP_DIR=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[burnwatch]${NC} $1"; }
warn()  { echo -e "${YELLOW}[burnwatch]${NC} $1"; }
error() { echo -e "${RED}[burnwatch]${NC} $1"; exit 1; }

# Detect platform
detect_platform() {
  local os arch

  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)      error "Unsupported OS: $os (only macOS and Linux supported)" ;;
  esac

  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *)             error "Unsupported architecture: $arch" ;;
  esac

  # No linux-arm64 build yet
  if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
    error "Linux ARM64 not supported yet. Use x64."
  fi

  echo "${os}-${arch}"
}

# Get latest release tag
get_latest_version() {
  local version
  version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')" || error "Failed to fetch latest release"

  [ -z "$version" ] && error "No releases found. Ask your admin to create a release first."
  echo "$version"
}

main() {
  info "Detecting platform..."
  local platform version download_url

  platform="$(detect_platform)"
  info "Platform: $platform"

  info "Fetching latest release..."
  version="$(get_latest_version)"
  info "Version: $version"

  download_url="https://github.com/${REPO}/releases/download/${version}/burnwatch-${platform}"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  info "Downloading burnwatch-${platform}..."
  curl -fSL --progress-bar -o "${TMP_DIR}/${BINARY_NAME}" "$download_url" \
    || error "Download failed. Check that release ${version} has a binary for ${platform}."

  chmod +x "${TMP_DIR}/${BINARY_NAME}"

  info "Installing to ${INSTALL_DIR}/${BINARY_NAME}..."
  if [ -w "$INSTALL_DIR" ]; then
    mv "${TMP_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    warn "Need sudo to write to ${INSTALL_DIR}"
    sudo mv "${TMP_DIR}/${BINARY_NAME}" "${INSTALL_DIR}/${BINARY_NAME}"
  fi

  # Verify
  if command -v burnwatch &> /dev/null; then
    info "Installed successfully! $(burnwatch --version)"
  else
    warn "Installed to ${INSTALL_DIR}/${BINARY_NAME} but not in PATH."
    warn "Add ${INSTALL_DIR} to your PATH, or move the binary."
  fi

  echo ""
  info "Next steps:"
  echo "  burnwatch register --api-url https://your-api-url.com"
  echo "  burnwatch sync --last-7    # backfill last 7 days"
  echo ""
}

main
