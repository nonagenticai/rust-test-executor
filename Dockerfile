# syntax=docker/dockerfile:1.7
#
# Rust Test Executor — ONE image, two stages.
#
# This was a two-image chain: Dockerfile.base built `rust-test-executor-base` into the estate's
# private registry, and the app pinned it by digest. For the public repository the chain is folded
# into a single build — `toolchain` is the old base as a stage, `app` is the service. One artefact
# to publish, nothing to pin, and no registry the builder must reach beyond Docker Hub.
#
# The toolchain stage bakes the offline crate cache that /execute relies on (see the bake step's
# comment): /execute runs with CARGO_NET_OFFLINE=true, so those crates must already be in
# CARGO_HOME. That contract is unchanged.
ARG RUST_TOOLCHAIN=1.99.0

FROM docker.io/library/rust:${RUST_TOOLCHAIN}-slim-bookworm AS toolchain

ARG TARGETARCH
ARG RUST_TOOLCHAIN
ARG NEXTEST_VERSION=0.9.149
ARG NEXTEST_SHA256_AMD64=d65c7f14bcb5c1566d1ecd534c5da8dedb81ba58586e478b0ab81c877d2bd8ad
ARG CARGO_AUDIT_VERSION=0.22.2
ARG CARGO_AUDIT_SHA256_AMD64=7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428
ARG CARGO_DENY_VERSION=0.20.2
ARG CARGO_DENY_SHA256_AMD64=9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f
ARG LLVM_COV_VERSION=0.9.1
ARG LLVM_COV_SHA256_AMD64=3fca950394a3c49457657c158b1619cec8dfd2647ae5b48746734c0ab969a522
ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_AMD64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997

# RUSTUP_HOME, CARGO_HOME and PATH come from the upstream image. The toolchain
# is named explicitly: rust_repo_run.js otherwise defaults to `stable`, which is
# not installed and cannot be fetched offline.
ENV RUSTUP_TOOLCHAIN=${RUST_TOOLCHAIN}

# C toolchain + headers for crates that build C (cc / ring / openssl-sys).
# git: cargo-deny 0.20 fetches the RustSec advisory db with the git CLI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git xz-utils build-essential pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
      'curl -fsSL --retry 5 --retry-delay 3 -o "$3" "$1"' \
      'echo "$2  $3" | sha256sum -c -' \
      > /usr/local/sbin/fetch-pinned && chmod 0755 /usr/local/sbin/fetch-pinned

# The upstream image ships the toolchain with rustup's minimal profile.
RUN rustup component add clippy rustfmt llvm-tools-preview

# cargo-nextest, cargo-audit, cargo-deny, cargo-llvm-cov + node.
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) A=x86_64;  NA=x64;   NX="${NEXTEST_SHA256_AMD64}"; AU="${CARGO_AUDIT_SHA256_AMD64}"; \
             DE="${CARGO_DENY_SHA256_AMD64}"; LC="${LLVM_COV_SHA256_AMD64}"; NO="${NODE_SHA256_AMD64}"; \
             AUT=x86_64-unknown-linux-musl ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    d="$(mktemp -d)"; cd "$d"; \
    fetch-pinned "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-${NEXTEST_VERSION}/cargo-nextest-${NEXTEST_VERSION}-${A}-unknown-linux-musl.tar.gz" "$NX" nextest.tgz; \
    fetch-pinned "https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv${CARGO_AUDIT_VERSION}/cargo-audit-${AUT}-v${CARGO_AUDIT_VERSION}.tgz" "$AU" audit.tgz; \
    fetch-pinned "https://github.com/EmbarkStudios/cargo-deny/releases/download/${CARGO_DENY_VERSION}/cargo-deny-${CARGO_DENY_VERSION}-${A}-unknown-linux-musl.tar.gz" "$DE" deny.tgz; \
    fetch-pinned "https://github.com/taiki-e/cargo-llvm-cov/releases/download/v${LLVM_COV_VERSION}/cargo-llvm-cov-${A}-unknown-linux-musl.tar.gz" "$LC" llvmcov.tgz; \
    fetch-pinned "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NA}.tar.xz" "$NO" node.txz; \
    for f in nextest audit deny llvmcov; do mkdir "x-$f"; tar -xzf "$f.tgz" -C "x-$f"; done; \
    for b in cargo-nextest cargo-audit cargo-deny cargo-llvm-cov; do \
      p="$(find "$d" -type f -name "$b" | head -n1)"; \
      [ -n "$p" ] || { echo "binary $b not found in its release archive" >&2; exit 1; }; \
      install -m 0755 "$p" "/usr/local/cargo/bin/$b"; \
    done; \
    tar -xJf node.txz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/include' --exclude='*/share'; \
    cd /; rm -rf "$d"

# ── Offline crate cache for /execute ─────────────────────────────────────────
# /execute scaffolds a Cargo.toml with these dev-dependencies and runs with
# CARGO_NET_OFFLINE=true, so they are baked here. rust-repo-run copies this
# registry into its fresh per-run CARGO_HOME as a seed and runs with network on.
RUN mkdir -p /opt/bake/src /opt/bake/tests && cd /opt/bake \
 && printf '[package]\nname = "bake"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n\n[dev-dependencies]\nproptest = "1.4"\ncriterion = "0.5"\ntokio-test = "0.4"\n' > Cargo.toml \
 && printf 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n' > src/lib.rs \
 && printf '#[test]\nfn t() { assert_eq!(3, bake::add(1, 2)); }\n' > tests/integration_tests.rs \
 && cargo fetch \
 && cargo test --offline >/dev/null \
 && rm -rf /opt/bake \
 && chmod -R a+rX "$CARGO_HOME" "$RUSTUP_HOME" \
 && test -d "$CARGO_HOME/registry/cache" || { echo "FATAL: no crate cache after bake — the image would ship an executor that cannot resolve offline" >&2; exit 1; }

# Build-time smoke: a broken toolchain never reaches the registry.
RUN node --version && npm --version && cargo --version && rustc --version \
 && cargo-clippy clippy --version && rustfmt --version && cargo-fmt --version \
 && cargo-nextest nextest --version && cargo-audit audit --version && cargo-deny --version \
 && cargo-llvm-cov llvm-cov --version \
 && test -x "$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/llvm-profdata"

ENV CARGO_NET_OFFLINE=true

# ── Application ──────────────────────────────────────────────────────────────
FROM toolchain AS app

WORKDIR /app

COPY src/package.json src/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/rust_test_service.js src/rust_repo_run.js src/common.js ./
# Job entrypoint: one container per whole-repo run (see README, "Job contract").
RUN ln -s /app/rust_repo_run.js /usr/local/bin/rust-repo-run

# Platform defaults for rust-repo-run; a repo's own deny.toml / nextest config
# is honoured on top of these.
COPY config/deny.toml config/nextest.toml /opt/rust-test-executor/
RUN mkdir -p /app/test_workspace /app/reports \
    && chown 65532:65532 /app/test_workspace /app/reports

# Numeric non-root user: the runner Job runs under pod-security `restricted`
# (runAsNonRoot, no runAsUser), which the kubelet only admits for a numeric
# USER. Same uid as the executor Deployment. rust-repo-run writes only under
# $TMPDIR (/tmp).
USER 65532:65532

EXPOSE 8089

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8089/health || exit 1

CMD ["node", "rust_test_service.js"]
