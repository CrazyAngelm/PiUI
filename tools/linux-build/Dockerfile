# Linux release builder: the same base as the GitHub release job
# (ubuntu-22.04), so the .deb and AppImage keep the glibc 2.35 floor.
# Used by tools/linux-build/build.sh; see docs/RELEASING.md.
FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG BUILDER_UID=1000
ARG BUILDER_GID=1000
ARG NODE_VERSION=22.23.5
ARG RUST_VERSION=1.94.1
ARG PNPM_VERSION=10.23.0

# A short DNS outage on the Docker network fails every download at once and apt's own
# retries run too quickly to outlast it. The loop pauses between attempts and keeps
# the packages already fetched, so only the missing ones are requested again.
RUN set -e; \
    apt_opts="-o Acquire::Retries=8 -o Acquire::ForceIPv4=true"; \
    for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do \
      if apt-get $apt_opts -o APT::Update::Error-Mode=any update \
         && apt-get $apt_opts install -y --no-install-recommends \
           build-essential ca-certificates curl file git pkg-config squashfs-tools xz-utils \
           libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
           libxdo-dev libssl-dev patchelf xdg-utils \
           gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-alsa; then installed=1; break; fi; \
      echo "apt failed (attempt $attempt), retrying in 20 s"; sleep 20; \
    done; \
    [ "${installed:-}" = 1 ]; \
    rm -rf /var/lib/apt/lists/*

RUN curl --retry 6 --retry-all-errors --retry-delay 10 -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && curl --retry 6 --retry-all-errors --retry-delay 10 -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
 && (cd /tmp && grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sed 's/node-v.*$/node.tar.xz/' | sha256sum --check --strict) \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz /tmp/SHASUMS256.txt \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && node --version && pnpm --version

RUN groupadd --gid "${BUILDER_GID}" builder \
 && useradd --uid "${BUILDER_UID}" --gid "${BUILDER_GID}" --create-home builder
USER builder
ENV CARGO_HOME=/home/builder/.cargo RUSTUP_HOME=/home/builder/.rustup
ENV PATH=/home/builder/.cargo/bin:$PATH
# The installer goes through a file, not `curl | sh`: a failed download would otherwise
# reach sh as an empty script that exits successfully. The toolchain download retries too.
RUN set -e; \
    for attempt in 1 2 3 4 5 6; do \
      if curl --retry 6 --retry-all-errors --retry-delay 10 --proto '=https' --tlsv1.2 -fsSLo /tmp/rustup-init.sh https://sh.rustup.rs \
         && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain "${RUST_VERSION}" --component clippy,rustfmt; then installed=1; break; fi; \
      echo "rustup failed (attempt $attempt), retrying in 20 s"; sleep 20; \
    done; \
    [ "${installed:-}" = 1 ]; \
    rm -f /tmp/rustup-init.sh; \
    rustc --version; \
    mkdir -p /home/builder/.cargo/registry /home/builder/.cargo/git /home/builder/.pnpm-store
# Named cache volumes start from these builder-owned folders.
ENV npm_config_store_dir=/home/builder/.pnpm-store

# The bundler's linuxdeploy is itself an AppImage; containers have no FUSE.
ENV APPIMAGE_EXTRACT_AND_RUN=1 CI=true
WORKDIR /src
