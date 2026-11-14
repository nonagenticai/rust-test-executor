#!/usr/bin/env node
'use strict';

/**
 * rust-repo-run: one Rust repo evaluation, run as a k8s Job (one container per run).
 *
 * Env in:  ARCHIVE_URL (required, tar.gz of the working tree),
 *          ARCHIVE_TOKEN (optional, sent verbatim as the X-Run-Token header),
 *          PRESETS (comma list of test,clippy,fmt,audit,deny,coverage; default all),
 *          WORKDIR (optional sub-crate path), TIMEOUT_S (1..14400, default 900),
 *          NEXTEST_EXTRA_ARGS (optional JSON array of strings, appended to the
 *          nextest argv), DATABASE_URL (optional, passed through to every tool).
 * Out:     exactly one stdout line `RESULT_JSON:<json>`; tool output goes nowhere
 *          else, logs go to stderr. Exit 0 whenever the run happened (failing
 *          tests included); exit 2 for runner errors (bad env, download,
 *          unreadable archive, no Cargo.toml), still with a RESULT_JSON line.
 *
 * Fresh run dir + CARGO_HOME (seeded from the image's crate cache); each tool
 * invoked as its own binary with fixed args. The repo's own tool config is
 * honoured (the Job pod is the security boundary); the platform deny.toml and
 * nextest profile are the defaults underneath it.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const tar = require('tar');
const { XMLParser } = require('fast-xml-parser');

const PRESETS = ['test', 'clippy', 'fmt', 'audit', 'deny', 'coverage'];
const MAX_TIMEOUT_S = 14400;
const MAX_RESULT_BYTES = 250 * 1024;
const DEFAULT_TIMEOUT_S = 900;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_TEXT = 1000;

const PLATFORM_DIR = process.env.RTE_PLATFORM_DIR || '/opt/rust-test-executor';
const DENY_CONFIG = path.join(PLATFORM_DIR, 'deny.toml');
const REPO_DENY_CONFIGS = ['deny.toml', '.deny.toml', '.cargo/deny.toml'];
const NEXTEST_CONFIG = path.join(PLATFORM_DIR, 'nextest.toml');
const NEXTEST_PROFILE = 'rte';
const WORK_ROOT = process.env.RTE_WORK_ROOT || os.tmpdir();
const IMAGE_CARGO_HOME = process.env.CARGO_HOME || '/usr/local/cargo';

/** A runner error; `preset` prefixes its errors[] line (default "runner"). */
class InputError extends Error {
    constructor(message, preset = 'runner') {
        super(message);
        this.preset = preset;
    }
}

// ── archive extraction ───────────────────────────────────────────────────────

/**
 * Extract a tar.gz into `dest` with node-tar's defaults: no absolute paths, no
 * `..` members, never writes through a symlink. Symlinks are kept as-is (a
 * workspace's `.venv/bin/python -> /usr/bin/python3` is normal); the Job pod
 * (non-root, uid 65532) is the boundary.
 */
async function extractArchive(buf, dest) {
    await new Promise((resolve, reject) => {
        const x = tar.x({ cwd: dest, preserveOwner: false });
        x.on('error', reject);
        x.on('close', resolve);
        x.end(buf);
    }).catch((e) => {
        throw new InputError(`archive rejected: ${e.message}`);
    });
}

// ── process execution ────────────────────────────────────────────────────────

function capped() {
    const chunks = [];
    let size = 0;
    return {
        push(c) {
            const room = MAX_STREAM_BYTES - size;
            if (room <= 0) return;
            if (c.length > room) c = c.subarray(0, room);
            chunks.push(c);
            size += c.length;
        },
        text() { return Buffer.concat(chunks).toString('utf8'); },
    };
}

/** Run a binary with fixed args (no shell). Never rejects. */
function run(bin, args, { cwd, env, deadline }) {
    return new Promise((resolve) => {
        const ms = deadline - Date.now();
        if (ms <= 0) return resolve({ code: null, stdout: '', stderr: '', timedOut: true });
        const out = capped();
        const err = capped();
        let timedOut = false;
        let child;
        try {
            child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            return resolve({ code: null, stdout: '', stderr: String(e.message), timedOut: false });
        }
        const timer = setTimeout(() => {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }, ms);
        child.stdout.on('data', (c) => out.push(c));
        child.stderr.on('data', (c) => err.push(c));
        child.on('error', (e) => err.push(Buffer.from(String(e.message))));
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: out.text(), stderr: err.text(), timedOut });
        });
    });
}

function tail(s, n = MAX_TEXT) {
    s = s || '';
    return s.length > n ? s.slice(s.length - n) : s;
}

function clip(s, n = MAX_TEXT) {
    s = s == null ? '' : String(s);
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

function jsonLines(text) {
    const out = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try { out.push(JSON.parse(t)); } catch { /* non-JSON noise */ }
    }
    return out;
}

// ── parsers ──────────────────────────────────────────────────────────────────

const xml = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => ['testsuite', 'testcase', 'failure', 'error'].includes(name),
});

function parseJunit(text) {
    const doc = xml.parse(text);
    const suites = (doc.testsuites && doc.testsuites.testsuite) || doc.testsuite || [];
    const res = { passed: 0, failed: 0, skipped: 0, total: 0, cases: [], junit_truncated: false };
    for (const suite of suites) {
        for (const tc of suite.testcase || []) {
            let status = 'passed';
            let message = '';
            const fail = (tc.failure || tc.error || [])[0];
            if (fail) {
                status = 'failed';
                message = typeof fail === 'string' ? fail : (fail.message || fail['#text'] || fail.type || '');
            } else if (tc.skipped !== undefined) {
                status = 'skipped';
            }
            res[status] += 1;
            res.total += 1;
            res.cases.push({
                name: `${tc.classname ? `${tc.classname}::` : ''}${tc.name}`,
                status,
                duration: tc.time !== undefined ? Number(tc.time) : null,
                ...(message ? { message: clip(message) } : {}),
            });
        }
    }
    return res;
}

function relFile(file, root) {
    if (!file) return file;
    return path.isAbsolute(file) ? path.relative(root, file) : file;
}

function parseClippy(stdout, root) {
    const findings = [];
    const seen = new Set();
    let buildFinished = null;
    for (const m of jsonLines(stdout)) {
        if (m.reason === 'build-finished') buildFinished = m.success;
        if (m.reason !== 'compiler-message' || !m.message) continue;
        const msg = m.message;
        if (!['warning', 'error'].includes(msg.level)) continue;
        const span = (msg.spans || []).find((s) => s.is_primary) || (msg.spans || [])[0];
        if (!span) continue; // summary lines ("aborting due to…") carry no location
        const key = `${msg.code && msg.code.code}|${span.file_name}|${span.line_start}|${span.column_start}|${msg.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
            level: msg.level,
            code: msg.code ? msg.code.code : null,
            message: clip(msg.message),
            file: relFile(span.file_name, root),
            line: span.line_start,
            column: span.column_start,
        });
    }
    return { findings, build_finished_success: buildFinished };
}

function parseFmt(stdout, root) {
    const files = new Set();
    for (const line of stdout.split('\n')) {
        const t = line.trim();
        const m = /^Diff in (.+) at line \d+:$/.exec(t) || /^Diff in (.+?)(?::\d+)?:$/.exec(t);
        if (m) files.add(relFile(m[1], root));
    }
    return [...files].sort();
}

function parseAudit(stdout) {
    const doc = JSON.parse(stdout);
    const advisories = [];
    const add = (kind, item) => {
        const adv = item.advisory || {};
        advisories.push({
            kind,
            id: adv.id || null,
            package: item.package ? item.package.name : adv.package || null,
            version: item.package ? item.package.version : null,
            title: clip(adv.title || ''),
            url: adv.url || null,
            patched: (item.versions && item.versions.patched) || [],
        });
    };
    for (const v of (doc.vulnerabilities && doc.vulnerabilities.list) || []) add('vulnerability', v);
    for (const [kind, list] of Object.entries(doc.warnings || {})) {
        for (const w of list || []) add(kind, w);
    }
    return { advisories, database: doc.database || null };
}

function parseDeny(stderr) {
    const items = [];
    let summary = null;
    for (const m of jsonLines(stderr)) {
        if (m.type === 'summary') { summary = m.fields; continue; }
        if (m.type !== 'diagnostic' || !m.fields) continue;
        const f = m.fields;
        // Errors only: warnings (e.g. multiple-versions) must not fail a run.
        if (f.severity !== 'error') continue;
        const crate = (f.graphs || [])[0];
        items.push({
            severity: f.severity,
            code: f.code || null,
            message: clip(f.message),
            crate: crate && crate.Krate ? `${crate.Krate.name}@${crate.Krate.version}` : null,
            ...(f.advisory ? { id: f.advisory.id, title: clip(f.advisory.title || '') } : {}),
        });
    }
    return { items, summary };
}

function parseCoverage(stdout, root) {
    const doc = JSON.parse(stdout);
    const data = (doc.data || [])[0] || {};
    const pick = (s) => (s ? { count: s.count, covered: s.covered, percent: s.percent } : null);
    const totals = data.totals || {};
    const files = (data.files || []).map((f) => ({
        file: relFile(f.filename, root),
        lines: pick(f.summary && f.summary.lines),
    }));
    return { lines: pick(totals.lines), functions: pick(totals.functions), regions: pick(totals.regions), files };
}


// ── tool versions ────────────────────────────────────────────────────────────

const VERSION_CMDS = {
    rustc: ['rustc', ['--version']],
    cargo: ['cargo', ['--version']],
    'cargo-nextest': ['cargo', ['nextest', '--version']],
    'cargo-clippy': ['cargo', ['clippy', '--version']],
    rustfmt: ['rustfmt', ['--version']],
    'cargo-audit': ['cargo', ['audit', '--version']],
    'cargo-deny': ['cargo', ['deny', '--version']],
    'cargo-llvm-cov': ['cargo', ['llvm-cov', '--version']],
};

/** tool -> version number; a tool whose version cannot be read is omitted. */
async function toolVersions(env) {
    const out = {};
    for (const [name, [bin, args]] of Object.entries(VERSION_CMDS)) {
        const r = await run(bin, args, { cwd: '/', env, deadline: Date.now() + 30000 });
        const m = r.code === 0 && /\d+\.\d+\.\d+\S*/.exec(r.stdout);
        if (m) out[name] = m[0];
    }
    return out;
}

// ── request validation ───────────────────────────────────────────────────────

function parseEnv(env) {
    const url = env.ARCHIVE_URL;
    if (!url || !/^https?:\/\//.test(url)) throw new InputError('ARCHIVE_URL must be an http(s) URL');

    let workdir = '';
    if (env.WORKDIR) {
        if (path.isAbsolute(env.WORKDIR) || env.WORKDIR.split(/[\\/]/).includes('..')) {
            throw new InputError('WORKDIR must be a relative path inside the archive');
        }
        workdir = path.normalize(env.WORKDIR);
    }

    let presets = PRESETS;
    if (env.PRESETS) {
        const want = env.PRESETS.split(',').map((p) => p.trim()).filter(Boolean);
        if (want.length === 0 || want.some((p) => !PRESETS.includes(p))) {
            throw new InputError(`PRESETS must be a non-empty comma list of ${PRESETS.join(', ')}`);
        }
        presets = PRESETS.filter((p) => want.includes(p));
    }

    let timeoutS = DEFAULT_TIMEOUT_S;
    if (env.TIMEOUT_S) {
        timeoutS = Number(env.TIMEOUT_S);
        if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) {
            throw new InputError(`TIMEOUT_S must be an integer between 1 and ${MAX_TIMEOUT_S}`);
        }
    }
    let nextestExtraArgs = [];
    if (env.NEXTEST_EXTRA_ARGS) {
        try { nextestExtraArgs = JSON.parse(env.NEXTEST_EXTRA_ARGS); } catch { nextestExtraArgs = null; }
        if (!Array.isArray(nextestExtraArgs) || nextestExtraArgs.some((a) => typeof a !== 'string')) {
            throw new InputError('invalid NEXTEST_EXTRA_ARGS', 'test');
        }
    }
    return {
        url, token: env.ARCHIVE_TOKEN || '', workdir, presets, timeoutS, nextestExtraArgs,
        databaseUrl: env.DATABASE_URL || '',
    };
}

async function download(url, token, deadline) {
    let res;
    try {
        res = await fetch(url, {
            headers: token ? { 'x-run-token': token } : {},
            signal: AbortSignal.timeout(Math.max(1, Math.min(300000, deadline - Date.now()))),
        });
    } catch (e) {
        const why = e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
        throw new InputError(`archive download failed: ${why}`);
    }
    if (!res.ok) throw new InputError(`archive download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

// ── the run ──────────────────────────────────────────────────────────────────

function runEnv(runDir, databaseUrl) {
    // Built from scratch: nothing from the container's environment (e.g. the
    // CARGO_NET_OFFLINE that /execute needs) leaks into a run, except
    // DATABASE_URL (a with_postgres run's database) when set.
    return {
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        PATH: process.env.PATH,
        HOME: runDir,
        RUSTUP_HOME: process.env.RUSTUP_HOME || '/usr/local/rustup',
        RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN || 'stable',
        CARGO_HOME: path.join(runDir, 'cargo-home'),
        CARGO_TARGET_DIR: path.join(runDir, 'target'),
        CARGO_NET_OFFLINE: 'false',
        CARGO_TERM_COLOR: 'never',
        CARGO_INCREMENTAL: '0',
        NEXTEST_HIDE_PROGRESS_BAR: '1',
        TMPDIR: path.join(runDir, 'tmp'),
    };
}

async function executeRun({ url, token, workdir, presets, timeoutS, nextestExtraArgs = [], databaseUrl = '' }) {
    const started = Date.now();
    const deadline = started + timeoutS * 1000;
    const runDir = await fsp.mkdtemp(path.join(WORK_ROOT, 'rust-repo-run-'));
    const src = path.join(runDir, 'src');
    const env = runEnv(runDir, databaseUrl);
    const errors = [];
    const out = { presets: {}, tool_versions: {}, duration_s: 0, errors };
    try {
        await fsp.mkdir(src);
        await fsp.mkdir(env.CARGO_HOME);
        await fsp.mkdir(env.TMPDIR);
        await extractArchive(await download(url, token, deadline), src);

        const cwd = path.join(src, workdir);
        if (!fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
            throw new InputError(`no Cargo.toml at workdir '${workdir || '.'}'`);
        }
        const realCwd = await fsp.realpath(cwd);

        // Seed the fresh CARGO_HOME with the image's crate cache (fewer downloads).
        await fsp.cp(path.join(IMAGE_CARGO_HOME, 'registry'), path.join(env.CARGO_HOME, 'registry'), { recursive: true })
            .catch(() => {});
        out.tool_versions = await toolVersions(env);
        const opts = { cwd: realCwd, env, deadline };
        const fail = (preset, r, what) => {
            errors.push(`${preset}: ${r.timedOut ? `${what} timed out` : `${what} exited ${r.code}`}`);
            console.error(`${preset}: ${what} stderr (tail):\n${tail(r.stderr)}`);
        };

        // Resolve + download dependencies once (writes Cargo.lock if missing).
        const fetched = await run('cargo', ['fetch'], opts);
        if (fetched.code !== 0) fail('fetch', fetched, 'cargo fetch');

        if (presets.includes('fmt')) {
            const r = await run('cargo-fmt', ['--', '--check'], opts);
            const files = parseFmt(r.stdout, realCwd);
            // exit 1 with diffs = findings; any other non-zero = tool failure.
            const completed = !r.timedOut && (r.code === 0 || (r.code === 1 && files.length > 0));
            if (!completed) fail('fmt', r, 'cargo-fmt');
            out.presets.fmt = { files, exit_code: r.code, completed };
        }

        if (presets.includes('audit')) {
            const r = await run('cargo-audit', ['audit', '--json'], opts);
            let parsed = null;
            try { parsed = parseAudit(r.stdout); } catch { /* reported below */ }
            if (!parsed) fail('audit', r, 'cargo-audit');
            out.presets.audit = {
                advisories: parsed ? parsed.advisories : [],
                database: parsed ? parsed.database : null,
                exit_code: r.code,
                completed: !!parsed,
            };
        }

        if (presets.includes('deny')) {
            // The repo's own deny.toml (crate dir or archive root) wins; the
            // platform policy applies only when the repo has none.
            const repoHasDeny = [realCwd, src].some((d) => REPO_DENY_CONFIGS.some((f) => fs.existsSync(path.join(d, f))));
            const denyConfig = repoHasDeny ? [] : ['--config', DENY_CONFIG];
            const deny = { advisories: [], licenses: [], bans: [], sources: [], exit_code: {}, completed: true };
            for (const check of ['advisories', 'licenses', 'bans', 'sources']) {
                const r = await run('cargo-deny', ['--format', 'json', ...denyConfig, 'check', check], opts);
                const parsed = parseDeny(r.stderr);
                deny[check] = parsed.items;
                deny.exit_code[check] = r.code;
                // A summary line is the evidence the check ran to completion.
                if (!parsed.summary || r.timedOut) {
                    deny.completed = false;
                    fail('deny', r, `cargo-deny check ${check}`);
                }
            }
            out.presets.deny = deny;
        }

        if (presets.includes('test')) {
            // The platform profile is a TOOL config: the repo's own
            // .config/nextest.toml layers above it. The JUnit path is absolute
            // (in the run dir) so a repo [store] dir cannot move it;
            // report-skipped keeps #[ignore] tests in the JUnit (default: dropped).
            const junit = path.join(runDir, 'junit.xml');
            const toolConfig = path.join(runDir, 'nextest.toml');
            await fsp.writeFile(toolConfig, `${await fsp.readFile(NEXTEST_CONFIG, 'utf8')}\n[profile.${NEXTEST_PROFILE}.junit]\npath = ${JSON.stringify(junit)}\nreport-skipped = "ignored"\n`);
            const r = await run('cargo-nextest', [
                // No --workspace: scoped like cargo itself (a member WORKDIR tests
                // that crate). --no-fail-fast only, so the counts are complete;
                // retries / filters / timeouts come from the repo's own config.
                'nextest', 'run', '--no-fail-fast',
                '--tool-config-file', `rte:${toolConfig}`, '--profile', NEXTEST_PROFILE,
                ...nextestExtraArgs,
            ], opts);
            let parsed = null;
            try { parsed = parseJunit(await fsp.readFile(junit, 'utf8')); } catch { /* reported below */ }
            if (!parsed) fail('test', r, 'cargo-nextest');
            out.presets.test = {
                ...(parsed || { passed: 0, failed: 0, skipped: 0, total: 0, cases: [], junit_truncated: false }),
                exit_code: r.code,
                completed: !!parsed && !r.timedOut,
            };
        }

        if (presets.includes('clippy')) {
            const r = await run('cargo-clippy', [
                'clippy', '--all-targets', '--message-format=json', '--', '-D', 'warnings',
            ], opts);
            const parsed = parseClippy(r.stdout, realCwd);
            // build-finished is emitted whether lints fail the build or not;
            // without it clippy did not run to the end.
            const completed = parsed.build_finished_success !== null && !r.timedOut
                && (r.code === 0 || parsed.findings.length > 0);
            if (!completed) fail('clippy', r, 'cargo-clippy');
            out.presets.clippy = { findings: parsed.findings, findings_truncated: false, exit_code: r.code, completed };
        }

        if (presets.includes('coverage')) {
            const r = await run('cargo-llvm-cov', [
                // --ignore-run-fail implies no-fail-fast and still writes the report.
                'llvm-cov', 'nextest', '--json', '--summary-only', '--ignore-run-fail',
            ], opts);
            let parsed = null;
            try { parsed = parseCoverage(r.stdout, realCwd); } catch { /* reported below */ }
            if (!parsed) fail('coverage', r, 'cargo-llvm-cov');
            out.presets.coverage = {
                ...(parsed || { lines: null, functions: null, regions: null, files: [] }),
                exit_code: r.code,
                completed: !!parsed,
            };
        }
        return out;
    } finally {
        out.duration_s = Math.round((Date.now() - started) / 100) / 10;
        await fsp.rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Keep the RESULT_JSON line under MAX_RESULT_BYTES by dropping list tails. */
function compact(result) {
    let line = JSON.stringify(result);
    const lists = [
        ['test', 'cases', 'junit_truncated'], ['coverage', 'files', 'files_truncated'],
        ['clippy', 'findings', 'findings_truncated'], ['audit', 'advisories', 'advisories_truncated'],
        ...['advisories', 'licenses', 'bans', 'sources'].map((k) => ['deny', k, `${k}_truncated`]),
    ];
    while (Buffer.byteLength(line) > MAX_RESULT_BYTES) {
        let shrunk = false;
        for (const [preset, key, flag] of lists) {
            const p = result.presets && result.presets[preset];
            if (p && Array.isArray(p[key]) && p[key].length > 0) {
                p[key] = p[key].slice(0, Math.floor(p[key].length / 2));
                p[flag] = true;
                shrunk = true;
            }
        }
        if (!shrunk) break;
        line = JSON.stringify(result);
    }
    return line;
}

async function main() {
    const started = Date.now();
    let result;
    let code = 0;
    try {
        result = await executeRun(parseEnv(process.env));
    } catch (e) {
        code = 2;
        if (!(e instanceof InputError)) console.error(e);
        result = {
            presets: {}, tool_versions: {},
            duration_s: Math.round((Date.now() - started) / 100) / 10,
            errors: [`${e instanceof InputError ? e.preset : 'runner'}: ${e.message}`],
        };
    }
    process.stdout.write(`RESULT_JSON:${compact(result)}\n`, () => process.exit(code));
}

if (require.main === module) main();

module.exports = {
    PRESETS,
    InputError,
    parseEnv,
    extractArchive,
    executeRun,
    compact,
    parseJunit,
    parseClippy,
    parseFmt,
    parseAudit,
    parseDeny,
    parseCoverage,
};
