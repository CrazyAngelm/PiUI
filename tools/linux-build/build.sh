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
#
# Speed (see docs/RELEASING.md): everything slow is kept between builds.
#   * Caches (cargo registry and git, pnpm store, the bundler's downloaded tools)
#     are plain folders under $PIUI_LINUX_CACHE (default ~/build/piui-linux-cache),
#     not Docker volumes: a Docker clean-up cannot take them away.
#   * The builder image is tagged with the hash of its Dockerfile. It is built
#     only when it is missing, and then only from the network (10-30 minutes on a
#     slow link). With PIUI_LINUX_SAVE_IMAGE=1 (and PIUI_LINUX_FORCE=1 when the
#     packages are already up to date) it is also saved as a gzip archive
#     in $PIUI_LINUX_CACHE/image/; a missing image is then loaded from it in
#     about a minute instead of being built again.
#   * Each phase prints its duration, and every container line its elapsed time.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CHECKOUT="${PIUI_LINUX_CHECKOUT:-$HOME/build/piui-linux}"
CACHE="${PIUI_LINUX_CACHE:-$HOME/build/piui-linux-cache}"
BUILDER_UID="$(id -u)"
BUILDER_GID="$(id -g)"
DOCKERFILE_HASH="$(sha256sum "$REPO/tools/linux-build/Dockerfile" | cut -c1-12)"
IMAGE="piui-linux-builder:22.04-$BUILDER_UID-$BUILDER_GID-$DOCKERFILE_HASH"
ARCHIVE="$CACHE/image/piui-linux-builder-22.04-$BUILDER_UID-$BUILDER_GID-$DOCKERFILE_HASH.tar.gz"

[ -f "$REPO/apps/desktop/src-tauri/tauri.conf.json" ] || { echo "Not the PiUI repository: $REPO" >&2; exit 1; }
case "$CHECKOUT" in
  /mnt/*) echo "The Linux checkout must be on the WSL disk, not $CHECKOUT" >&2; exit 1 ;;
esac
case "$CACHE" in
  /mnt/*) echo "The Linux cache must be on the WSL disk, not $CACHE" >&2; exit 1 ;;
esac

out="$REPO/artifacts"
STATE_FILE="$CACHE/last-build.state"

# What the packages are made from: the commit, the uncommitted changes to tracked
# files, the builder's Dockerfile and whether release signing is configured (its
# values stay out of the hash). A secret never reaches the state file.
build_state() {
  printf '%s %s %s %s\n' \
    "$(git -C "$REPO" rev-parse HEAD)" \
    "$(git -C "$REPO" diff --binary HEAD | sha256sum | cut -c1-16)" \
    "$DOCKERFILE_HASH" \
    "$(printf '%s|%s|%s' "${PIUI_UPDATER_PUBKEY:-}" "${PIUI_UPDATER_ENDPOINT:-}" "${TAURI_SIGNING_PRIVATE_KEY:+signing}" | sha256sum | cut -c1-8)"
}
STATE="$(build_state)"

# "Give me the latest Linux build": when nothing changed since the packages in
# artifacts/ were built, and their checksums still match, there is nothing to build.
# PIUI_LINUX_FORCE=1 builds anyway.
if [ "${PIUI_LINUX_FORCE:-}" != 1 ] && [ -f "$STATE_FILE" ] && [ "$(head -n 1 "$STATE_FILE")" = "$STATE" ] \
   && [ -n "$(tail -n +2 "$STATE_FILE")" ] \
   && (cd "$out" 2> /dev/null && tail -n +2 "$STATE_FILE" | sha256sum --check --strict --quiet > /dev/null 2>&1); then
  echo "The Linux packages in $out are up to date for $(git -C "$REPO" rev-parse --short HEAD) (PIUI_LINUX_FORCE=1 rebuilds):"
  tail -n +2 "$STATE_FILE" | while read -r _ name; do ls -l "$out/${name#\*}"; done
  exit 0
fi

PHASE_START=$SECONDS
TOTAL_START=$SECONDS
SUMMARY=()
phase() {
  local took=$((SECONDS - PHASE_START))
  SUMMARY+=("$(printf '%-34s %5ds' "$1" "$took")")
  PHASE_START=$SECONDS
}

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
phase "source checkout"

save_image_archive() {
  mkdir -p "$(dirname "$ARCHIVE")"
  echo "Saving the builder image to $ARCHIVE"
  docker save "$IMAGE" | pigz -3 > "$ARCHIVE.part"
  mv -- "$ARCHIVE.part" "$ARCHIVE"
  # Archives of an older Dockerfile are of no use any more.
  find "$(dirname "$ARCHIVE")" -maxdepth 1 -type f -name 'piui-linux-builder-*.tar.gz' ! -name "$(basename "$ARCHIVE")" -delete
  echo "Image archive: $(du -h "$ARCHIVE" | cut -f1)"
}

image_present() { docker image inspect "$IMAGE" > /dev/null 2>&1; }

if image_present; then
  echo "Builder image: present ($IMAGE)"
else
  if [ -f "$ARCHIVE" ]; then
    echo "Builder image: loading $ARCHIVE"
    pigz -dc "$ARCHIVE" | docker load > /dev/null || true
  fi
  if ! image_present; then
    echo "Builder image: building (needs the network: 10-30 minutes on a slow link)"
    build_log="$(mktemp)"
    if ! docker build --progress=plain \
        --build-arg BUILDER_UID="$BUILDER_UID" --build-arg BUILDER_GID="$BUILDER_GID" \
        -t "$IMAGE" "$REPO/tools/linux-build" > "$build_log" 2>&1; then
      tail -n 60 "$build_log" >&2
      rm -f "$build_log"
      echo "The builder image could not be built." >&2
      exit 1
    fi
    rm -f "$build_log"
  fi
fi
if [ "${PIUI_LINUX_SAVE_IMAGE:-}" = 1 ] && [ ! -f "$ARCHIVE" ]; then
  save_image_archive
fi
# Images of an older Dockerfile or of the former single tag are not needed.
docker image ls --format '{{.Repository}}:{{.Tag}}' piui-linux-builder 2> /dev/null \
  | grep -vxF "$IMAGE" | xargs -r docker rmi > /dev/null 2>&1 || true
phase "builder image"

# Release signing variables pass through when set; otherwise the unsigned build.
env_args=()
for name in PIUI_UPDATER_PUBKEY PIUI_UPDATER_ENDPOINT TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
            CARGO_BUILD_JOBS; do
  [ -n "${!name:-}" ] && env_args+=(-e "$name")
done

mkdir -p "$CACHE/cargo-registry" "$CACHE/cargo-git" "$CACHE/pnpm-store" "$CACHE/tauri"

# The two [time] lines come from inside the container; every line also carries
# the seconds since the container started, which show where a build spends time.
RUN_START=$SECONDS
docker run --rm "${env_args[@]}" \
  -v "$CHECKOUT:/src" \
  -v "$CACHE/cargo-registry:/home/builder/.cargo/registry" \
  -v "$CACHE/cargo-git:/home/builder/.cargo/git" \
  -v "$CACHE/pnpm-store:/home/builder/.pnpm-store" \
  -v "$CACHE/tauri:/home/builder/.cache/tauri" \
  "$IMAGE" bash -c '
    set -euo pipefail
    t=$SECONDS; pnpm install --frozen-lockfile
    echo "[time] pnpm install: $((SECONDS - t))s"
    t=$SECONDS; pnpm release:linux
    echo "[time] release:linux (frontend, cargo, bundles, checksums, cache prune): $((SECONDS - t))s"
  ' 2>&1 | while IFS= read -r line; do printf '[%4ds] %s\n' $((SECONDS - RUN_START)) "$line"; done
phase "container build"

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
{
  printf '%s\n' "$STATE"
  (cd "$out" && find . -maxdepth 1 -type f -name '*_amd64.*' -printf '%f\n' | sort | xargs -d '\n' sha256sum --)
} > "$STATE_FILE.part"
mv -- "$STATE_FILE.part" "$STATE_FILE"
phase "copy and checksums"
echo "Linux packages in $out:"
ls -l "$out"
echo "Phases:"
printf '  %s\n' "${SUMMARY[@]}"
printf '  %-34s %5ds\n' "total" $((SECONDS - TOTAL_START))
