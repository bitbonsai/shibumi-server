#!/usr/bin/env bash
set -euo pipefail

if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  accent=$'\033[38;5;208m'
  danger=$'\033[38;5;167m'
  reset=$'\033[0m'
else
  accent=""
  danger=""
  reset=""
fi

line() {
  printf '  %s%-9s%s %s\n' "$1" "$2" "$reset" "$3"
}

fail() {
  line "$danger" "failed" "$1" >&2
  exit 1
}

printf '\n%s渋み%s  shibumi-server\n\n' "$accent" "$reset"

[[ "$(uname -s)" == "Linux" ]] || fail "Installation requires Linux"
(( EUID != 0 )) || fail "Run as your deployment user, not root"
command -v curl >/dev/null || fail "curl is required"
[[ -n "${HOME:-}" ]] || fail "HOME is not set"
line "$accent" "checked" "Linux"

bun_bin="$(command -v bun || true)"
if [[ -z "$bun_bin" ]]; then
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  line "$accent" "install" "Bun"
  curl -fsSL https://bun.sh/install | bash
  bun_bin="$BUN_INSTALL/bin/bun"
  [[ -x "$bun_bin" ]] || fail "Bun installation did not create $bun_bin"
else
  line "$accent" "checked" "Bun $("$bun_bin" --version)"
fi

if ! exec 3</dev/tty 2>/dev/null; then
  fail "Interactive installation requires a terminal"
fi

line "$accent" "setup" "Starting interactive installer"
printf '\n'
exec "$bun_bin" x shibumi-server@latest <&3
