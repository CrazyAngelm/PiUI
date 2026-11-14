#!/usr/bin/env bash
# Builds the Linux release (.deb + AppImage) of the current commit from a
# Windows checkout, inside WSL with Docker (Ubuntu 22.04, like the release job).
#
#   wsl -d Ubuntu -- bash tools/linux-build/build.sh            # from the repository root
#
# The Windows tree cannot be built in place: its node_modules hold Windows
# binaries and target/ is the Windows cache. The build therefore runs in a
# dedicated Linux checkout ($PIUI_LINUX_CHECKOUT, default ~/build/piui-linux on
# the WSL disk) that is moved to the Windows repository's HEAD commit plus its
# uncommitted changes to tracked files; its node_modules and target/ stay as
# the Linux build cache. Untracked files are not built. The packages are copied into the repository's
# artifacts/ next to the Windows files of the same version, and
# artifacts/SHA256SUMS.txt is rewritten for every file there.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CHECKOUT="${PIUI_LINUX_CHECKOUT:-$HOME/build/piui-linux}"
IMAGE="piui-linux-builder:22.04"

[ -f "$REPO/apps/desktop/src-tauri/tauri.conf.json" ] || { echo "Not the PiUI repository: $REPO" >&2; exit 1; }
case "$CHECKOUT" in
  /mnt/*) echo "The Linux checkout must be on the WSL disk, not $CHECKOUT" >&2; exit 1 ;;
esac

if [ ! -d "$CHECKOUT/.git" ]; then
  mkdir -p "$(dirname "$CHECKOUT")"
  git clone --quiet "$REPO" "$CHECKOUT"
fi
git -C "$CHECKOUT" fetch --quiet "$REPO" HEAD
git -C "$CHECKOUT" checkout --quiet --force --detach FETCH_HEAD
git -C "$CHECKOUT" clean -fdq
echo "Building commit $(git -C "$CHECKOUT" rev-parse --short HEAD) in $CHECKOUT"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
  git -C "$REPO" diff --binary HEAD | git -C "$CHECKOUT" apply --whitespace=nowarn
  echo "With the uncommitted changes to tracked files (untracked files are not included):"
  git -C "$CHECKOUT" status --short
fi

docker build --quiet \
  --build-arg BUILDER_UID="$(id -u)" --build-arg BUILDER_GID="$(id -g)" \
  -t "$IMAGE" "$REPO/tools/linux-build" > /dev/null

# Release signing variables pass through when set; otherwise the unsigned build.
env_args=()
for name in PIUI_UPDATER_PUBKEY PIUI_UPDATER_ENDPOINT TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
            CARGO_BUILD_JOBS; do
  [ -n "${!name:-}" ] && env_args+=(-e "$name")
done

docker run --rm "${env_args[@]}" \
  -v "$CHECKOUT:/src" \
  -v piui-linux-cargo-registry:/home/builder/.cargo/registry \
  -v piui-linux-cargo-git:/home/builder/.cargo/git \
  -v piui-linux-pnpm-store:/home/builder/.pnpm-store \
  "$IMAGE" bash -c 'pnpm install --frozen-lockfile && pnpm release:linux'

out="$REPO/artifacts"
mkdir -p "$out"
[ -L "$out" ] && { echo "$out is a link; refusing to write into it." >&2; exit 1; }
# One Linux release at a time: older Linux packages are replaced.
find "$out" -maxdepth 1 -type f \( -name '*_amd64.deb*' -o -name '*_amd64.AppImage*' \) -delete
for file in "$CHECKOUT"/artifacts/*; do
  [ "$(basename "$file")" = "SHA256SUMS.txt" ] && continue
  cp -- "$file" "$out/"
done
(
  cd "$out"
  export LC_ALL=C
  sums="$(find . -maxdepth 1 -type f ! -name SHA256SUMS.txt -printf '%f\n' | sort | xargs -d '\n' sha256sum --)"
  printf '%s\n' "$sums" > SHA256SUMS.txt
  sha256sum --check --strict SHA256SUMS.txt
)
echo "Linux packages in $out:"
ls -l "$out"
