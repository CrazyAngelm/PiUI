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
#
# Updates: the packages carry the updater (and the AppImage a signature) only when the
# updater key pair is available, by default the one that signs the Windows releases
# (~/.tauri/piui-updater.key on the Windows side). Then the app's About page shows the
# update controls. The build says "Updates: on" or "Updates: OFF" when it ends.
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

# The updater key pair (scripts/release-config.mjs). Without it the build has no
# updater section: the app reports "updates not configured" and its About page shows
# no update controls. Variables in the environment win; otherwise the pair that signs
# the Windows releases is used: PIUI_UPDATER_KEY_FILE (a WSL path), else
# ~/.tauri/piui-updater.key of the Windows user. The container gets the pair read-only
# and only for the release step, never for `pnpm install`, whose dependency scripts
# also run in a container. The key's contents are never printed.
UPDATER_KEY_FILE=""
find_updater_key() {
  [ -z "${PIUI_UPDATER_PUBKEY:-}${TAURI_SIGNING_PRIVATE_KEY:-}" ] || return 0
  local file="${PIUI_UPDATER_KEY_FILE:-}" home=""
  if [ -z "$file" ]; then
    home="$(wslpath -u "$(cmd.exe /c 'echo %USERPROFILE%' 2> /dev/null | tr -d '\r')" 2> /dev/null || true)"
    if [ -n "$home" ]; then file="$home/.tauri/piui-updater.key"; fi
  fi
  if [ -n "$file" ] && [ -f "$file" ] && [ -f "$file.pub" ]; then
    UPDATER_KEY_FILE="$file"
  elif [ -n "${PIUI_UPDATER_KEY_FILE:-}" ]; then
    echo "PIUI_UPDATER_KEY_FILE must name a private key with a matching .pub file." >&2
    exit 1
  fi
}
find_updater_key
# Only the public half identifies the pair in the build state.
KEY_ID=""
if [ -n "$UPDATER_KEY_FILE" ]; then KEY_ID="$(sha256sum < "$UPDATER_KEY_FILE.pub" | cut -c1-8)"; fi

# What the packages are made from: the commit, the uncommitted changes to tracked
# files, the builder's Dockerfile and whether release signing is configured (its
# values stay out of the hash). A secret never reaches the state file.
build_state() {
  printf '%s %s %s %s\n' \
    "$(git -C "$REPO" rev-parse HEAD)" \
    "$(git -C "$REPO" diff --binary HEAD | sha256sum | cut -c1-16)" \
    "$DOCKERFILE_HASH" \
    "$(printf '%s|%s|%s|%s' "${PIUI_UPDATER_PUBKEY:-}" "${PIUI_UPDATER_ENDPOINT:-}" "${TAURI_SIGNING_PRIVATE_KEY:+signing}" "$KEY_ID" | sha256sum | cut -c1-8)"
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

# Release signing variables pass through when set; without them (and without the
# Windows key pair, see find_updater_key) it is the plain build with no updater.
build_env_args=()
if [ -n "${CARGO_BUILD_JOBS:-}" ]; then build_env_args=(-e CARGO_BUILD_JOBS); fi
release_env_args=()
for name in PIUI_UPDATER_PUBKEY PIUI_UPDATER_ENDPOINT TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  [ -n "${!name:-}" ] && release_env_args+=(-e "$name")
done

mkdir -p "$CACHE/cargo-registry" "$CACHE/cargo-git" "$CACHE/pnpm-store" "$CACHE/tauri"

# Runs a script in the builder container; extra arguments go to `docker run`. The
# [time] lines come from inside the script; every line also carries the seconds since
# the build started, which show where a build spends time.
RUN_START=$SECONDS
RUN_LOG="$(mktemp)"
trap 'rm -f "$RUN_LOG"' EXIT
run_in_container() {
  local script="$1"
  shift
  docker run --rm "${build_env_args[@]}" "$@" \
    -v "$CHECKOUT:/src" \
    -v "$CACHE/cargo-registry:/home/builder/.cargo/registry" \
    -v "$CACHE/cargo-git:/home/builder/.cargo/git" \
    -v "$CACHE/pnpm-store:/home/builder/.pnpm-store" \
    -v "$CACHE/tauri:/home/builder/.cache/tauri" \
    "$IMAGE" bash -c "$script" 2>&1 \
    | while IFS= read -r line; do printf '[%4ds] %s\n' $((SECONDS - RUN_START)) "$line"; done \
    | tee -a "$RUN_LOG"
}

run_in_container 'set -euo pipefail; t=$SECONDS; pnpm install --frozen-lockfile; echo "[time] pnpm install: $((SECONDS - t))s"'

key_mounts=()
if [ -n "$UPDATER_KEY_FILE" ]; then
  echo "Updater key pair: $UPDATER_KEY_FILE (read-only, for the release step only)"
  key_mounts=(-v "$UPDATER_KEY_FILE:/home/builder/.tauri/piui-updater.key:ro" -v "$UPDATER_KEY_FILE.pub:/home/builder/.tauri/piui-updater.key.pub:ro")
fi
run_in_container 'set -euo pipefail; t=$SECONDS; pnpm release:linux; echo "[time] release:linux (frontend, cargo, bundles, checksums, cache prune): $((SECONDS - t))s"' "${release_env_args[@]}" "${key_mounts[@]}"
run_in_container 'bash tools/linux-build/verify-appimage-media.sh artifacts/*_amd64.AppImage'
phase "container build"

# Updates on means the build carries plugins.updater (public key + feed) and signed
# update artifacts; the app then shows its update controls.
if [ -n "$UPDATER_KEY_FILE${PIUI_UPDATER_PUBKEY:-}${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if ! grep -q '\] Updates: on' "$RUN_LOG" \
     || ! compgen -G "$CHECKOUT/artifacts/*_amd64.AppImage.sig" > /dev/null \
     || ! compgen -G "$CHECKOUT/artifacts/*_amd64.deb.sig" > /dev/null; then
    echo "Updater signing was requested, but both Linux packages were not signed." >&2
    exit 1
  fi
  echo "Updates: on (AppImage and .deb signed)."
else
  echo "Updates: OFF. No updater key pair was found, so these packages show no update controls." >&2
  echo "  The Windows pair is ~/.tauri/piui-updater.key; PIUI_UPDATER_KEY_FILE names another file." >&2
fi

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
