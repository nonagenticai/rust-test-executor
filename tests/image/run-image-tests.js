#!/usr/bin/env node
/**
 * Image test: runs the BUILT image exactly as the k8s Job does (rust-repo-run,
 * env in, RESULT_JSON out, archive fetched over HTTP from a sibling container)
 * and checks /execute snippet mode. Real tools, no mocks.
 *
 *   node tests/image/run-image-tests.js <image-ref>
 *
 * Needs docker and outbound network inside the container (crates.io for
 * smallvec, the RustSec advisory db). Used as the CI build_smoke.
 */
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const image = process.argv[2];
if (!image) {
    console.error('usage: run-image-tests.js <image-ref>');
    process.exit(2);
}
const FIXTURE = path.join(__dirname, 'fixture-crate');
const HEADERS = { 'content-type': 'application/json', 'x-tenant-id': 'image-test' };

function sh(cmd, args, opts = {}) {
    // COPYFILE_DISABLE: macOS bsdtar would otherwise add ._* AppleDouble files,
    // and tests/._basic.rs would be compiled as an integration test.
    const env = { ...process.env, COPYFILE_DISABLE: '1' };
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env, ...opts }).trim();
}

/** tar.gz of `dir` (optionally with extra files, or `{ symlink }` entries, written into a copy first). */
function archive(dir, extra = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-img-'));
    try {
        const root = path.join(tmp, 'crate');
        fs.cpSync(dir, root, { recursive: true });
        for (const [rel, content] of Object.entries(extra)) {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            if (content.symlink) fs.symlinkSync(content.symlink, path.join(root, rel));
            else fs.writeFileSync(path.join(root, rel), content);
        }
        const out = path.join(tmp, 'a.tgz');
        sh('tar', ['-czf', out, '-C', root, '.']);
        return fs.readFileSync(out).toString('base64');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

async function post(base, route, body) {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    const json = await res.json();
    return { status: res.status, body: json };
}

const PORT = 18000 + (process.pid % 1000);
const SERVER_JS = `
const http = require('http'), fs = require('fs');
http.createServer((q, s) => {
  if (q.headers['x-run-token'] !== 'image-test') { s.statusCode = 401; return s.end(); }
  fs.createReadStream('/tmp/served' + q.url).on('error', () => { s.statusCode = 404; s.end(); }).pipe(s);
}).listen(${PORT}, '127.0.0.1');`;

/**
 * Run the image exactly as the Job does; return the parsed RESULT_JSON + exit
 * code. Host networking: inside the CI runner's dind, bridge networks stall
 * TLS transfers (crates.io "transfer too slow ... 0 bytes", measured), while
 * the runner pod's own namespace has working egress. The archive server
 * listens on that namespace's loopback.
 */
function job(env) {
    const args = [
        'run', '--rm', '--network', 'host', '--user', '65532:65532', '--read-only',
        '--tmpfs', '/tmp:rw,exec,size=4g', '-e', 'HOME=/tmp/home',
    ];
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push(image, 'rust-repo-run');
    let stdout;
    let code = 0;
    try {
        stdout = sh('docker', args);
    } catch (e) {
        stdout = String(e.stdout || '');
        code = e.status;
    }
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, `expected exactly one stdout line, got ${lines.length}: ${stdout.slice(0, 500)}`);
    assert.ok(lines[0].startsWith('RESULT_JSON:'), lines[0].slice(0, 200));
    assert.ok(Buffer.byteLength(lines[0]) < 256 * 1024);
    return { code, result: JSON.parse(lines[0].slice('RESULT_JSON:'.length)) };
}

function caseStatus(test, suffix) {
    const c = test.cases.find((x) => x.name.endsWith(suffix));
    assert.ok(c, `no test case ending in ${suffix}: ${JSON.stringify(test.cases)}`);
    return c.status;
}

async function main() {
    const tag = `rte-img-${process.pid}`;
    const srv = `${tag}-srv`;
    let cid = null;
    let failed = false;
    try {
        sh('docker', ['run', '-d', '--name', srv, '--network', 'host', image, 'node', '-e', SERVER_JS]);
        sh('docker', ['exec', srv, 'mkdir', '-p', '/tmp/served']);
        for (let i = 0; ; i++) {
            try {
                sh('docker', ['exec', srv, 'node', '-e', `fetch('http://127.0.0.1:${PORT}/').then(() => process.exit(0), () => process.exit(1))`]);
                break;
            } catch {
                if (i > 30) throw new Error('archive server did not start');
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        const put = (name, b64) => {
            const f = path.join(os.tmpdir(), `${tag}-${name}`);
            fs.writeFileSync(f, Buffer.from(b64, 'base64'));
            sh('docker', ['cp', f, `${srv}:/tmp/served/${name}`]);
            fs.rmSync(f);
            return `http://127.0.0.1:${PORT}/${name}`;
        };
        const auth = { ARCHIVE_TOKEN: 'image-test' };

        // 1. Full run over the fixture: real counts from every tool.
        const full = job({ ARCHIVE_URL: put('full.tgz', archive(FIXTURE)), TIMEOUT_S: '1200', ...auth });
        console.log(JSON.stringify(full.result, null, 1).slice(0, 6000));
        assert.equal(full.code, 0);
        const p = full.result.presets;
        assert.deepEqual(full.result.errors, []);
        assert.deepEqual(
            { passed: p.test.passed, failed: p.test.failed, total: p.test.total, completed: p.test.completed },
            { passed: 1, failed: 1, total: 2, completed: true },
        );
        assert.equal(caseStatus(p.test, 'fails_on_purpose'), 'failed');
        assert.equal(caseStatus(p.test, 'adds'), 'passed');
        assert.deepEqual(p.clippy.findings.map((f) => [f.code, f.file]), [['clippy::len_zero', 'src/lib.rs']]);
        assert.deepEqual(p.fmt.files, ['src/messy.rs']);
        assert.ok(p.audit.completed && p.audit.advisories.some((a) => a.id === 'RUSTSEC-2021-0003' && a.package === 'smallvec'),
            `audit missed RUSTSEC-2021-0003: ${JSON.stringify(p.audit)}`);
        assert.ok(p.deny.completed && p.deny.advisories.some((a) => a.id === 'RUSTSEC-2021-0003'),
            `deny missed RUSTSEC-2021-0003: ${JSON.stringify(p.deny)}`);
        assert.deepEqual(p.deny.licenses, []);
        assert.ok(p.coverage.completed && p.coverage.lines.count > 0 && p.coverage.lines.covered > 0,
            `coverage: ${JSON.stringify(p.coverage)}`);
        assert.ok(p.coverage.files.some((f) => f.file === 'src/lib.rs'));
        for (const t of ['cargo', 'rustc', 'cargo-nextest', 'cargo-clippy', 'rustfmt', 'cargo-audit', 'cargo-deny', 'cargo-llvm-cov']) {
            assert.ok(full.result.tool_versions[t], `missing tool version ${t}`);
        }
        assert.ok(full.result.errors.every((e) => typeof e === 'string'));
        assert.ok(Object.values(full.result.tool_versions).every((v) => /^\d+\.\d+\.\d+/.test(v)),
            `tool_versions: ${JSON.stringify(full.result.tool_versions)}`);
        assert.ok(p.test.cases.every((c) => typeof c.duration === 'number'));

        // 2. The repo's own tool config is honoured: rustfmt.toml's hard_tabs
        //    makes the (space-indented) sources diffs, the repo's deny.toml
        //    (empty licence allow-list) replaces the platform policy, and a repo
        //    nextest [store] dir does not hide the JUnit.
        const own = job({
            ARCHIVE_URL: put('own.tgz', archive(FIXTURE, {
                '.config/nextest.toml': '[store]\ndir = "elsewhere"\n',
                'rustfmt.toml': 'hard_tabs = true\n',
                'deny.toml': '[licenses]\nallow = []\n',
            })),
            PRESETS: 'test,fmt,deny',
            ...auth,
        });
        console.log(JSON.stringify(own.result, null, 1).slice(0, 3000));
        assert.equal(own.code, 0);
        assert.deepEqual(own.result.errors, []);
        assert.equal(own.result.presets.test.total, 2);
        assert.equal(own.result.presets.test.failed, 1);
        assert.deepEqual(own.result.presets.fmt.files, ['src/lib.rs', 'src/messy.rs', 'tests/basic.rs']);
        assert.ok(own.result.presets.deny.completed);
        assert.ok(own.result.presets.deny.licenses.length > 0, `repo deny.toml not honoured: ${JSON.stringify(own.result.presets.deny)}`);
        assert.deepEqual(Object.keys(own.result.presets).sort(), ['deny', 'fmt', 'test']);

        // 2b. A workspace with an absolute, outward symlink (a PyO3 repo's
        //     .venv) runs normally; an #[ignore] test is reported as skipped.
        const venv = job({
            ARCHIVE_URL: put('venv.tgz', archive(FIXTURE, {
                '.venv/bin/python': { symlink: '/usr/bin/python3' },
                'tests/ign.rs': '#[test]\n#[ignore]\nfn skipped_one() {}\n',
            })),
            PRESETS: 'test',
            ...auth,
        });
        assert.equal(venv.code, 0);
        assert.deepEqual(venv.result.errors, []);
        assert.equal(venv.result.presets.test.total, 3);
        assert.equal(venv.result.presets.test.skipped, 1);
        assert.equal(caseStatus(venv.result.presets.test, 'skipped_one'), 'skipped');

        // 2c. DATABASE_URL reaches the tests, and NEXTEST_EXTRA_ARGS is appended
        //     to nextest: the filter drops fails_on_purpose, so 2 run, 2 pass.
        const db = job({
            ARCHIVE_URL: put('db.tgz', archive(FIXTURE, {
                'tests/db.rs': '#[test]\nfn db_url_is_set() { assert_eq!(std::env::var("DATABASE_URL").unwrap(), "postgres://image-test/db"); }\n',
            })),
            PRESETS: 'test',
            DATABASE_URL: 'postgres://image-test/db',
            NEXTEST_EXTRA_ARGS: JSON.stringify(['-E', 'test(db_url_is_set) | test(adds)']),
            ...auth,
        });
        console.log(JSON.stringify(db.result.presets.test));
        assert.equal(db.code, 0);
        assert.deepEqual(db.result.errors, []);
        assert.deepEqual(
            { passed: db.result.presets.test.passed, failed: db.result.presets.test.failed, total: db.result.presets.test.total },
            { passed: 2, failed: 0, total: 2 },
        );
        assert.equal(caseStatus(db.result.presets.test, 'db_url_is_set'), 'passed');

        // 2d. WORKDIR = one member of a two-crate workspace -> only that crate's
        //     tests run (no --workspace), and fmt does not report the sibling
        //     crate's unformatted file (no --all).
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rte-ws-'));
        const member = (name) => ({
            [`${name}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\npublish = false\n`,
            [`${name}/src/lib.rs`]: 'pub fn f() {}\n',
            [`${name}/tests/t.rs`]: `#[test]\nfn ${name}_ok() {}\n`,
        });
        const wsTgz = archive(ws, {
            'Cargo.toml': '[workspace]\nmembers = ["one", "two"]\nresolver = "2"\n',
            ...member('one'),
            ...member('two'),
            'two/src/lib.rs': 'pub fn  messy( ){}\n',
        });
        fs.rmSync(ws, { recursive: true, force: true });
        const one = job({ ARCHIVE_URL: put('ws.tgz', wsTgz), WORKDIR: 'one', PRESETS: 'test,fmt', ...auth });
        console.log(JSON.stringify(one.result.presets.test));
        assert.equal(one.code, 0);
        assert.deepEqual(one.result.errors, []);
        assert.deepEqual(one.result.presets.test.cases.map((c) => c.name.split('::').pop()), ['one_ok']);
        assert.ok(one.result.presets.fmt.completed);
        assert.deepEqual(one.result.presets.fmt.files, []);

        // 3. Timeout: a test that sleeps past TIMEOUT_S -> still exactly one
        //    RESULT_JSON line, exit 0, completed:false and a string error.
        const slow = job({
            ARCHIVE_URL: put('slow.tgz', archive(FIXTURE, {
                'tests/slow.rs': '#[test]\nfn sleeps() { std::thread::sleep(std::time::Duration::from_secs(600)); }\n',
            })),
            PRESETS: 'test',
            TIMEOUT_S: '5',
            ...auth,
        });
        console.log(JSON.stringify(slow.result));
        assert.equal(slow.code, 0);
        assert.equal(slow.result.presets.test.completed, false);
        assert.ok(slow.result.errors.some((e) => typeof e === 'string' && / timed out$/.test(e)), JSON.stringify(slow.result.errors));

        // 4. Runner error: wrong token -> exit 2, one RESULT_JSON line naming it.
        const denied = job({ ARCHIVE_URL: `http://127.0.0.1:${PORT}/full.tgz`, ARCHIVE_TOKEN: 'wrong' });
        assert.equal(denied.code, 2);
        assert.deepEqual(denied.result.errors, ['runner: archive download failed: HTTP 401']);

        // /execute (snippet mode) still runs from the service CMD.
        cid = sh('docker', [
            'run', '-d', '-p', '127.0.0.1::8089', '--user', '65532:65532', '--read-only',
            '--tmpfs', '/tmp:rw,exec,size=1g', '--tmpfs', '/app/test_workspace:rw,exec,size=2g,uid=65532,gid=65532',
            '-e', 'HOME=/tmp/home', image,
        ]);
        const port = sh('docker', ['port', cid, '8089/tcp']).split('\n')[0].split(':').pop();
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; ; i++) {
            try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
            if (i > 60) throw new Error('service did not become healthy');
            await new Promise((r) => setTimeout(r, 1000));
        }

        // 5. /execute accepts snake_case test_code (coding-testing's spelling).
        const ex = await post(base, '/execute', {
            code: 'pub fn add(a: i32, b: i32) -> i32 { a + b }',
            test_code: '#[test]\nfn t() { assert_eq!(3, rust_lib::add(1, 2)); }\n',
            cargoToml: '[package]\nname = "rust_lib"\nversion = "0.1.0"\nedition = "2021"\n',
            options: { runSecurityAudit: false },
        });
        console.log(JSON.stringify({ tests: ex.body.tests && { total: ex.body.tests.total, passed: ex.body.tests.passed }, coverage: ex.body.coverage && ex.body.coverage.metrics }));
        assert.equal(ex.status, 200);
        assert.equal(ex.body.tests.total, 1);
        assert.equal(ex.body.tests.passed, 1);
        assert.equal(ex.body.success, true);
        assert.ok(ex.body.coverage.metrics.lines.total > 0, `execute coverage: ${JSON.stringify(ex.body.coverage)}`);

        // 6. /run-tool is gone.
        assert.equal((await fetch(`${base}/run-tool`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ tool: 'cargo', command: 'id' }) })).status, 404);
        console.log('image tests: all passed');
    } catch (e) {
        failed = true;
        console.error(e);
        if (cid) { try { console.error(sh('docker', ['logs', '--tail', '80', cid])); } catch { /* ignore */ } }
    } finally {
        for (const c of [cid, srv]) if (c) { try { sh('docker', ['rm', '-f', c]); } catch { /* gone */ } }
    }
    process.exit(failed ? 1 : 0);
}

main();
