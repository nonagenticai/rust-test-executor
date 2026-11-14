const request = require('supertest');
const { app, RUST_TOOLS } = require('../../src/rust_test_service');
const childProcess = require('child_process');

// Mock child_process.exec so no route can reach a real shell
jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    exec: jest.fn(),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── GET /tools ──────────────────────────────────────────────────────

describe('GET /tools', () => {
  test('returns 200', async () => {
    const res = await request(app).get('/tools');
    expect(res.status).toBe(200);
  });

  test('returns supported tools matching RUST_TOOLS', async () => {
    const res = await request(app).get('/tools');
    const supported = res.body.supported;
    expect(Object.keys(supported)).toEqual(Object.keys(RUST_TOOLS));
    expect(supported.cargo.name).toBe('Cargo');
    expect(supported.clippy.name).toBe('Clippy');
    expect(supported.rustfmt.name).toBe('Rustfmt');
    expect(supported['llvm-cov'].name).toBe('cargo-llvm-cov');
    expect(supported.tarpaulin).toBeUndefined();
    expect(supported.audit.name).toBe('Cargo Audit');
    expect(supported.deny.name).toBe('Cargo Deny');
  });

  test('capabilities include expected flags', async () => {
    const res = await request(app).get('/tools');
    const caps = res.body.capabilities;
    expect(caps.testExecution).toBe(true);
    expect(caps.codeCoverage).toBe(true);
    expect(caps.staticAnalysis).toBe(true);
    expect(caps.securityAudit).toBe(true);
    expect(caps.benchmarking).toBe(true);
    expect(caps.formatting).toBe(true);
  });

  test('each tool has commands object', async () => {
    const res = await request(app).get('/tools');
    for (const [, tool] of Object.entries(res.body.supported)) {
      expect(tool.commands).toBeDefined();
      expect(typeof tool.commands).toBe('object');
      expect(Object.keys(tool.commands).length).toBeGreaterThan(0);
    }
  });
});

// ── GET /frameworks ─────────────────────────────────────────────────

describe('GET /frameworks', () => {
  test('returns 200', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.status).toBe(200);
  });

  test('includes cargo and rusttest in supported', async () => {
    const res = await request(app).get('/frameworks');
    const supported = res.body.supported;
    expect(supported.cargo).toBeDefined();
    expect(supported.cargo.name).toBe('Cargo Test');
    expect(supported.cargo.configFile).toBe('Cargo.toml');
    expect(supported.cargo.testExtensions).toEqual(['.rs']);

    expect(supported.rusttest).toBeDefined();
    expect(supported.rusttest.name).toBe('Rust Built-in Tests');
  });

  test('default and recommended are cargo', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.default).toBe('cargo');
    expect(res.body.recommended).toBe('cargo');
  });

  test('capabilities include assertions list', async () => {
    const res = await request(app).get('/frameworks');
    const caps = res.body.capabilities;
    expect(caps.assertions).toEqual(
      expect.arrayContaining(['assert!', 'assert_eq!', 'assert_ne!'])
    );
  });

  test('tools section has clippy and rustfmt', async () => {
    const res = await request(app).get('/frameworks');
    expect(res.body.tools.clippy).toBeDefined();
    expect(res.body.tools.clippy.command).toBe('cargo clippy');
    expect(res.body.tools.rustfmt).toBeDefined();
    expect(res.body.tools.rustfmt.command).toBe('cargo fmt');
  });
});

// ── GET /info ───────────────────────────────────────────────────────

describe('GET /info (non-existent route)', () => {
  // The source code has no /info route, so it should 404.
  // This tests that unknown routes are handled.
  test('returns 404 for undefined route', async () => {
    const res = await request(app).get('/info');
    expect(res.status).toBe(404);
  });
});

// ── POST /run-tool (removed) ────────────────────────────────────────

describe('POST /run-tool', () => {
  // It ran caller-supplied commands; whole-repo runs are the rust-repo-run Job.
  test('is gone (404) and executes nothing', async () => {
    const res = await request(app)
      .post('/run-tool')
      .send({ tool: 'cargo', command: 'echo pwned', projectPath: '/' });
    expect(res.status).toBe(404);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });
});

// ── Unknown routes ──────────────────────────────────────────────────

describe('Unknown routes', () => {
  test('GET /nonexistent returns 404', async () => {
    const res = await request(app).get('/nonexistent');
    expect(res.status).toBe(404);
  });

  test('POST /nonexistent returns 404', async () => {
    const res = await request(app).post('/nonexistent').send({});
    expect(res.status).toBe(404);
  });
});
