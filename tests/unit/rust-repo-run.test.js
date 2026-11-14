// rust-repo-run (the Job entrypoint): everything that must be refused BEFORE any
// Rust tool runs. The real script runs as a subprocess against a real local
// HTTP server serving real tar.gz archives — no mocks. Tool runs themselves are
// exercised in the built image by tests/image/run-image-tests.js.
const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const tar = require('tar');
const { compact } = require('../../src/rust_repo_run');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'rust_repo_run.js');
let tmp;
let server;
let base;
const served = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = served[req.url];
    if (req.url === '/private' && req.headers['x-run-token'] !== 's3cret') {
      res.statusCode = 401;
      return res.end();
    }
    if (!body) { res.statusCode = 404; return res.end(); }
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rrr-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function crate(files, root = path.join(tmp, 'crate')) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

async function tgz(cwd, entries, opts = {}) {
  const out = path.join(tmp, `${Math.random()}.tgz`);
  await tar.c({ gzip: true, cwd, file: out, ...opts }, entries);
  return fs.readFileSync(out);
}

function runner(env) {
  return new Promise((resolve) => {
    execFile('node', [SCRIPT], {
      env: { PATH: process.env.PATH, RTE_WORK_ROOT: tmp, ...env },
      maxBuffer: 1 << 20,
    }, (err, stdout, stderr) => {
      const lines = stdout.trim().split('\n');
      const last = lines[lines.length - 1];
      resolve({
        code: err ? err.code : 0,
        lines,
        result: last.startsWith('RESULT_JSON:') ? JSON.parse(last.slice('RESULT_JSON:'.length)) : null,
        stderr,
      });
    });
  });
}

const okCrate = () => crate({ 'Cargo.toml': '[package]\nname = "a"\n' });

describe('runner errors exit 2 with exactly one RESULT_JSON line', () => {
  test.each([
    [{ ARCHIVE_URL: '' }, /ARCHIVE_URL/],
    [{ ARCHIVE_URL: 'file:///etc/passwd' }, /ARCHIVE_URL/],
    [{ PRESETS: 'test,miri' }, /PRESETS/],
    [{ PRESETS: ',' }, /PRESETS/],
    [{ TIMEOUT_S: '14401' }, /TIMEOUT_S/],
    [{ TIMEOUT_S: 'abc' }, /TIMEOUT_S/],
    [{ WORKDIR: '../x' }, /WORKDIR/],
    [{ WORKDIR: '/etc' }, /WORKDIR/],
  ])('%j', async (env, msg) => {
    served['/ok'] = await tgz(okCrate(), ['.']);
    const r = await runner({ ARCHIVE_URL: `${base}/ok`, ...env });
    expect(r.code).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.result.errors[0]).toMatch(/^runner: /);
    expect(r.result.errors[0]).toMatch(msg);
  });

  test.each(['not json', '"-E"', '[1]', '{"a":1}'])('NEXTEST_EXTRA_ARGS=%s -> one "test: invalid" error', async (bad) => {
    served['/ok'] = await tgz(okCrate(), ['.']);
    const r = await runner({ ARCHIVE_URL: `${base}/ok`, NEXTEST_EXTRA_ARGS: bad });
    expect(r.code).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.result.errors).toEqual(['test: invalid NEXTEST_EXTRA_ARGS']);
  });

  test('TIMEOUT_S=14400 is accepted (gets past env validation to the download)', async () => {
    const r = await runner({ ARCHIVE_URL: `${base}/missing`, TIMEOUT_S: '14400' });
    expect(r.code).toBe(2);
    expect(r.result.errors).toEqual(['runner: archive download failed: HTTP 404']);
  });

  test('HTTP 404', async () => {
    const r = await runner({ ARCHIVE_URL: `${base}/missing` });
    expect(r.code).toBe(2);
    expect(r.result.errors).toEqual(['runner: archive download failed: HTTP 404']);
  });

  test('unreachable host: fails naming the cause', async () => {
    // A port that was just free: nothing listens, so connect is refused.
    const probe = http.createServer();
    await new Promise((res) => probe.listen(0, '127.0.0.1', res));
    const { port } = probe.address();
    await new Promise((res) => probe.close(res));
    const r = await runner({ ARCHIVE_URL: `http://127.0.0.1:${port}/a.tgz` });
    expect(r.code).toBe(2);
    expect(r.lines).toHaveLength(1);
    expect(r.result.errors).toEqual(['runner: archive download failed: fetch failed (ECONNREFUSED)']);
  });

  test('ARCHIVE_TOKEN is sent raw as the X-Run-Token header (negative: without it, 401)', async () => {
    served['/private'] = await tgz(okCrate(), ['.']);
    const without = await runner({ ARCHIVE_URL: `${base}/private` });
    expect(without.result.errors).toEqual(['runner: archive download failed: HTTP 401']);
    // Downloaded and extracted: it gets to the WORKDIR check.
    const withTok = await runner({ ARCHIVE_URL: `${base}/private`, ARCHIVE_TOKEN: 's3cret', WORKDIR: 'nowhere' });
    expect(withTok.result.errors).toEqual(["runner: no Cargo.toml at workdir 'nowhere'"]);
  });

  test('an absolute symlink (.venv/bin/python -> /usr/bin/python3) does not reject the archive', async () => {
    const root = okCrate();
    fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
    fs.symlinkSync('/usr/bin/python3', path.join(root, '.venv', 'bin', 'python'));
    served['/venv'] = await tgz(root, ['.']);
    // Gets past extraction to the WORKDIR check.
    const r = await runner({ ARCHIVE_URL: `${base}/venv`, WORKDIR: 'nowhere' });
    expect(r.code).toBe(2);
    expect(r.result.errors).toEqual(["runner: no Cargo.toml at workdir 'nowhere'"]);
  });

  test('a ".." member is skipped: nothing lands outside the run dir', async () => {
    // Extraction cwd is <RTE_WORK_ROOT>/rust-repo-run-*/src, so ../../evil.txt
    // would land in RTE_WORK_ROOT (= tmp) itself.
    fs.writeFileSync(path.join(tmp, 'evil.txt'), 'x');
    const inner = path.join(tmp, 'crate', 'inner');
    fs.mkdirSync(inner, { recursive: true });
    served['/dotdot'] = await tgz(inner, ['../../evil.txt'], { preservePaths: true });
    fs.rmSync(path.join(tmp, 'evil.txt'));
    const r = await runner({ ARCHIVE_URL: `${base}/dotdot` });
    expect(r.code).toBe(2);
    expect(r.result.errors).toEqual(["runner: no Cargo.toml at workdir '.'"]);
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('rust-repo-run-'))).toEqual([]);
  });

  test('no Cargo.toml at WORKDIR', async () => {
    served['/wd'] = await tgz(crate({ 'Cargo.toml': '[package]\nname = "a"\n', 'sub/readme': 'x' }), ['.']);
    const r = await runner({ ARCHIVE_URL: `${base}/wd`, WORKDIR: 'sub' });
    expect(r.code).toBe(2);
    expect(r.result.errors).toEqual(["runner: no Cargo.toml at workdir 'sub'"]);
  });
});

describe('compact keeps the RESULT_JSON line under 256 KiB', () => {
  test('drops case-list tails and flags truncation', () => {
    const cases = Array.from({ length: 5000 }, (_, i) => ({ name: `t${i}`.padEnd(100, 'x'), status: 'passed' }));
    const line = compact({ presets: { test: { total: 5000, passed: 5000, cases, junit_truncated: false } }, errors: [] });
    expect(Buffer.byteLength(line)).toBeLessThan(256 * 1024);
    const parsed = JSON.parse(line);
    expect(parsed.presets.test.total).toBe(5000);
    expect(parsed.presets.test.junit_truncated).toBe(true);
    expect(parsed.presets.test.cases.length).toBeGreaterThan(0);
  });

  test('a small result is unchanged', () => {
    const r = { presets: { test: { cases: [{ name: 'a' }] } }, errors: [] };
    expect(JSON.parse(compact(r))).toEqual(r);
  });
});
