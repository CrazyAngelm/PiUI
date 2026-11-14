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

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl file git pkg-config xz-utils \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
      libxdo-dev libssl-dev patchelf xdg-utils \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
 && curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
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
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}" --component clippy,rustfmt \
 && rustc --version \
 && mkdir -p /home/builder/.cargo/registry /home/builder/.cargo/git /home/builder/.pnpm-store
# Named cache volumes start from these builder-owned folders.
ENV npm_config_store_dir=/home/builder/.pnpm-store

# The bundler's linuxdeploy is itself an AppImage; containers have no FUSE.
ENV APPIMAGE_EXTRACT_AND_RUN=1 CI=true
WORKDIR /src
