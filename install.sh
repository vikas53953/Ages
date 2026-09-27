#!/bin/sh
# Aegis installer for Linux, macOS and cloud containers.
#   curl -fsSL https://raw.githubusercontent.com/vikas53953/Ages/main/install.sh | sh
# Install a branch instead of main:  AEGIS_REF=<branch> sh install.sh
set -eu
repo="vikas53953/Ages"
ref="${AEGIS_REF:-main}"

fail() { printf 'aegis install: %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 22.19 or newer is required (https://nodejs.org)."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || fail "Node.js $(node --version) is too old; Aegis needs 22.19 or newer."
# A GitHub tarball, not "github:…": npm links git installs to a temporary clone it later deletes.
url="https://github.com/$repo/archive/$ref.tar.gz"
printf 'Installing Aegis from %s ...\n' "$url"
npm install -g "$url"
installed="$(aegis --version)" || fail "installed, but 'aegis' is not on PATH. Check: npm prefix -g"

printf '\n  %s installed.\n\n  Start it in the folder you want it to work in:\n    cd /path/to/project\n    aegis\n\n  Then connect a model once (saved to ~/.aegis/.env):\n    /login opencode <your-key>\n\n' "$installed"
