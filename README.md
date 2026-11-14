# rust-test-executor

Remote test execution for Rust code, two ways from one image:

- **Snippet mode** (`POST /execute`): receives Rust source and test code over HTTP, compiles it with `cargo`, runs the Rust toolchain (tests, clippy, cargo-llvm-cov, cargo-audit, cargo-deny, rustfmt) and returns structured results.
- **Repo mode** (`rust-repo-run`): a whole crate/workspace runs as one k8s Job per run and prints one `RESULT_JSON:` line (see the Job contract below).

The `coding-testing` orchestrator calls both.

## Architecture

Node.js (Express) process that shells out to Cargo and Rust toolchain binaries. Each `/execute` request:

1. Creates a temporary Cargo project in `TEST_WORKSPACE`.
2. Writes the submitted source to `src/lib.rs` and tests to `tests/integration_tests.rs`.
3. Runs up to 6 pipeline steps: `cargo check` → `cargo test` → `cargo llvm-cov` → `cargo clippy` → `cargo audit` + `cargo deny` → `cargo fmt --check`.
4. Returns parsed, structured JSON (test counts, coverage metrics, clippy issues, vulnerabilities).
5. Cleans up the project directory after 2 minutes.

Steps 3-6 are individually toggleable via `options` flags.

## API

### `GET /health`

Returns service status, supported tools, and runtime info.

**Response:**
```json
{
  "status": "healthy",
  "service": "rust-test-executor",
  "version": "1.0.0",
  "capabilities": {
    "frameworks": ["cargo", "rusttest"],
    "tools": ["cargo", "clippy", "rustfmt", "nextest", "llvm-cov", "audit", "deny"],
    "features": { "parallelExecution": true, "coverage": true, "debugging": true, "linting": true, "formatting": true, "securityAudit": true }
  },
  "runtime": { "version": "Rust stable", "memory": { "used": 0, "total": 0 }, "uptime": 0 }
}
```

### `POST /execute`

Compiles and tests Rust code through the full pipeline.

**Request body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | one of code/testCode | Source code, written to `src/lib.rs` |
| `testCode` / `test_code` | string | one of code/testCode | Integration tests, written to `tests/integration_tests.rs` |
| `cargoToml` | string | no | Custom `Cargo.toml` contents. Auto-generated if omitted. |
| `dependencies` | object | no | `{ "serde": "1.0" }` — added to `[dependencies]` |
| `features` | string[] | no | Cargo features to enable |
| `options.generateCoverage` | bool | no | Run cargo-llvm-cov (default: true) |
| `options.runStaticAnalysis` | bool | no | Run clippy (default: true) |
| `options.runSecurityAudit` | bool | no | Run cargo-audit + cargo-deny (default: true) |
| `options.checkFormatting` | bool | no | Run rustfmt --check (default: true) |

**Response:**
```json
{
  "executionId": "uuid",
  "startTime": "ISO8601",
  "success": true,
  "duration": 12345,
  "compilation": { "success": true, "output": "...", "errors": "...", "exitCode": 0 },
  "tests": { "total": 5, "passed": 5, "failed": 0, "ignored": 0, "filtered": 0, "testResults": [{ "name": "test_name", "status": "ok", "success": true }] },
  "coverage": { "success": true, "metrics": { "lines": { "covered": 10, "missed": 2, "total": 12, "percentage": "83.33" } } },
  "staticAnalysis": { "success": true, "analysis": { "totalIssues": 0, "warnings": 0, "errors": 0, "issues": [] } },
  "security": { "audit": { "success": true, "analysis": { "totalVulnerabilities": 0, "vulnerabilities": [] } }, "deny": { "success": true } },
  "formatting": { "success": true, "formatted": true }
}
```

Minimal test payloads (e.g. `code: "// test"`) receive a fast-path synthetic response that skips compilation.

### `POST /validate`

Checks whether Rust code compiles without running tests.

**Request body:**
| Field | Type | Required | Description |
|---|---|---|---|
| `code` | string | yes | Rust source code |
| `crateType` | string | no | `"bin"` (default) or `"lib"` |

**Response:**
```json
{
  "validationId": "uuid",
  "valid": true,
  "errors": [],
  "output": "",
  "warnings": ["warning: unused variable ..."]
}
```

### Whole-repo runs: the `rust-repo-run` Job contract

Not an HTTP route. The same image ships the entrypoint `rust-repo-run`
(`src/rust_repo_run.js`); the dispatcher runs ONE k8s Job (one container) per
run with `command: ["rust-repo-run"]`.

**Env in:**
| Var | Required | Meaning |
|---|---|---|
| `ARCHIVE_URL` | yes | http(s) URL of a tar.gz of the working tree (no `target/`, no `.git`) |
| `ARCHIVE_TOKEN` | no | Sent verbatim as the `X-Run-Token` header (coding-testing's per-run archive token) |
| `PRESETS` | no | Comma list of `test,clippy,fmt,audit,deny,coverage` (default: all) |
| `WORKDIR` | no | Sub-crate path inside the archive (must hold a `Cargo.toml`) |
| `TIMEOUT_S` | no | Whole-run deadline, 1–14400 (default 900); set the Job's `activeDeadlineSeconds` a bit above it |
| `NEXTEST_EXTRA_ARGS` | no | JSON array of strings appended to the nextest argv (test preset only), e.g. `["-E","test(adds)"]`; invalid → exit 2, `errors: ["test: invalid NEXTEST_EXTRA_ARGS"]` |
| `DATABASE_URL` | no | Passed through to every tool (a `with_postgres` run's database) |
| `RTE_WORK_ROOT` | no | Writable scratch dir (default `os.tmpdir()`, i.e. `/tmp`) |

**Out:** exactly one stdout line, `RESULT_JSON:<compact json>` (< 256 KiB; list
tails are dropped and `*_truncated` set if needed). Tool output never reaches
stdout; logs go to stderr. Exit `0` whenever the run happened (failing tests,
lint findings and advisories included); exit `2` for runner errors (bad env,
download failure, unreadable archive, no `Cargo.toml`), still with a RESULT_JSON
line whose `errors` is `["runner: <why>"]`.

Per run: fresh run dir under `RTE_WORK_ROOT` with its own `CARGO_HOME` (seeded
from the image's crate cache) and target dir, network on. Archive extraction
uses node-tar's defaults (no absolute paths, no `..` members, never writes
through a symlink); symlinks are kept as-is, e.g. `.venv/bin/python ->
/usr/bin/python3`. The Job pod (non-root, uid 65532) is the boundary.
The repo's own tool config (`.cargo/config.toml`, `rustfmt.toml`,
`clippy.toml`, `.config/nextest.toml`, `deny.toml`, ...) is honoured: these checks are developer feedback. Tools are
invoked as their own binaries with fixed arguments:

| preset | command |
|---|---|
| test | `cargo-nextest nextest run --no-fail-fast --tool-config-file rte:<run dir>/nextest.toml --profile rte` (JUnit at an absolute path in the run dir; retries/filters/timeouts from the repo's nextest config) |
| clippy | `cargo-clippy clippy --all-targets --message-format=json -- -D warnings` |
| fmt | `cargo-fmt -- --check` |
| audit | `cargo-audit audit --json` |
| deny | `cargo-deny --format json [--config /opt/rust-test-executor/deny.toml] check <advisories\|licenses\|bans\|sources>` (`--config` only when the repo has no `deny.toml`) |
| coverage | `cargo-llvm-cov llvm-cov nextest --json --summary-only --ignore-run-fail` |

Tools run in `WORKDIR` without `--workspace`, so they scope like plain cargo: a
member-crate `WORKDIR` checks that crate; a virtual-manifest root checks every
member.

The platform defaults are `config/deny.toml` (used when the repo has none) and
`config/nextest.toml` (the `rte` profile, layered under the repo's nextest config).

**RESULT_JSON shape:**
```json
{
  "presets": {
    "test": { "passed": 1, "failed": 1, "skipped": 0, "total": 2, "cases": [{ "name": "fixture::basic::adds", "status": "passed", "duration": 0.01 }], "junit_truncated": false, "exit_code": 100, "completed": true },
    "clippy": { "findings": [{ "level": "error", "code": "clippy::len_zero", "message": "...", "file": "src/lib.rs", "line": 14, "column": 5 }], "findings_truncated": false, "exit_code": 101, "completed": true },
    "fmt": { "files": ["src/messy.rs"], "exit_code": 1, "completed": true },
    "audit": { "advisories": [{ "kind": "vulnerability", "id": "RUSTSEC-2021-0003", "package": "smallvec", "version": "1.6.0", "title": "...", "url": "...", "patched": [">=1.6.1"] }], "database": {}, "exit_code": 1, "completed": true },
    "deny": { "advisories": [], "licenses": [], "bans": [], "sources": [], "exit_code": { "advisories": 1 }, "completed": true },
    "coverage": { "lines": { "count": 12, "covered": 10, "percent": 83.3 }, "functions": {}, "regions": {}, "files": [{ "file": "src/lib.rs", "lines": {} }], "exit_code": 0, "completed": true }
  },
  "tool_versions": { "rustc": "1.99.0", "cargo-nextest": "0.9.149" },
  "duration_s": 42.1,
  "errors": ["test: cargo-nextest exited 101"]
}
```
`errors` is a list of `"<preset>: <message>"` strings (the failing tool's stderr
tail goes to the Job log); a tool whose version cannot be read is left out of
`tool_versions`. `completed: false` (plus an `errors` entry) means the tool did not run to the end
— never read it as clean.

**Job needs:** egress TCP 443 to `crates.io`, `index.crates.io`,
`static.crates.io`, `github.com` (RustSec advisory db for cargo-audit and
cargo-deny) and the `ARCHIVE_URL` host; a writable, exec-able `/tmp` (emptyDir)
when the rootfs is read-only.

### `GET /tools`

Lists the tools the image ships and the commands `/execute` runs.

### `GET /frameworks`

Returns supported test frameworks (`cargo`, `rusttest`) with capabilities metadata.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` / `RUST_TEST_PORT` | `8089` | HTTP listen port |
| `EXECUTION_TIMEOUT` | `300` (seconds) | Max time per command before SIGTERM |
| `TEST_WORKSPACE` | `/app/test_workspace` | Directory for temporary Cargo projects |
| `REPORTS_DIR` | `/app/reports` | Directory for report output |

## Dependencies

- **Runtime** (`Dockerfile.base`, `library/rust:1.99.0-slim-bookworm`, Debian 12): rust 1.99.0 (clippy, rustfmt, llvm-tools-preview), cargo-nextest, cargo-llvm-cov, cargo-audit, cargo-deny, Node.js 24
- **npm packages**: express, tar, fast-xml-parser
- **Called by**: `coding-testing` service (env var `RUST_TEST_SERVICE_URL=http://rust-test-executor:8089`)
- **Outbound**: the `rust-repo-run` Job needs HTTPS egress (see the Job contract). `/execute` runs offline from the baked crate cache.

## Docker

```bash
docker compose build    # builds from ./Dockerfile
docker compose up -d    # exposes 8089:8089
```

The Dockerfile is one multi-stage build: the `toolchain` stage starts from `docker.io/library/rust:1.99.0-slim-bookworm`, adds nextest/audit/deny/llvm-cov and node, and bakes the offline crate cache `/execute` runs against; the `app` stage copies the Node service, runs as uid 65532 and starts `node rust_test_service.js`. (This used to be a separately published base image pinned by digest — folded into a single artefact for the public repository.)

## CI/CD

GitHub Actions (`.github/workflows/ci.yml` → `nonagenticai/ci-workflows`'s public `node-service.yml` archetype): secret scan, private-infrastructure scan, `npm ci` + eslint + the jest suite, then the image build, a `/health` smoke against it, and a push to `ghcr.io/nonagenticai/rust-test-executor` from `main` (with a SLSA provenance attestation). There is no deploy job: this service is retired from the estate's cluster, and the repository is published so its tests, toolchain plumbing and job contract stay readable and reproducible.

Image test (real tools, needs docker + network): `node tests/image/run-image-tests.js <image>`.

## Licensing

The code in this repository is Apache-2.0 and needs no licence key to build, test or run.
It contains no licence-enforcement code: the Apache-2.0 licence in [`LICENSE`](LICENSE) is the
only licence that applies, and no licence server is involved.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
