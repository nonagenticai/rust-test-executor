const request = require('supertest');
const { app } = require('../../src/rust_test_service');
const childProcess = require('child_process');

// Mock child_process.exec
jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    exec: jest.fn(),
  };
});

// Mock fs.promises
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      rmdir: jest.fn().mockResolvedValue(undefined),
    },
  };
});

function mockExecSuccess(stdout = '', stderr = '') {
  childProcess.exec.mockImplementation((cmd, opts, callback) => {
    const child = { killed: false, kill: jest.fn() };
    process.nextTick(() => callback(null, stdout, stderr));
    return child;
  });
}

function mockExecFailure(exitCode = 1, stdout = '', stderr = '') {
  childProcess.exec.mockImplementation((cmd, opts, callback) => {
    const child = { killed: false, kill: jest.fn() };
    process.nextTick(() => {
      const err = new Error('Command failed');
      err.code = exitCode;
      callback(err, stdout, stderr);
    });
    return child;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /validate', () => {
  test('no code field returns 400', async () => {
    const res = await request(app)
      .post('/validate')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContain('No code provided');
    expect(res.body.validationId).toBeDefined();
  });

  test('null code returns 400', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: null });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContain('No code provided');
  });

  test('empty code returns valid: false (200, not 400)', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: '' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContain('Empty code is not valid Rust');
  });

  test('whitespace-only code returns valid: false', async () => {
    const res = await request(app)
      .post('/validate')
      .send({ code: '   \n\t  ' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContain('Empty code is not valid Rust');
  });

  test('valid Rust code with successful cargo check', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() { println!("hello"); }' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toEqual([]);
    expect(res.body.validationId).toBeDefined();
  });

  test('invalid code with cargo check failure', async () => {
    mockExecFailure(1, '', 'error[E0308]: mismatched types\ncould not compile');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() { let x: i32 = "string"; }' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors.some(e => e.includes('error'))).toBe(true);
  });

  test('code with warnings but no errors is valid (warnings returned)', async () => {
    mockExecSuccess('', 'warning: unused variable `x`');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() { let x = 5; }' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.warnings).toBeDefined();
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });

  test('code with crateType=lib uses lib.rs', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'pub fn add(a: i32, b: i32) -> i32 { a + b }', crateType: 'lib' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('validationId is unique per request', async () => {
    mockExecSuccess('', '');

    const res1 = await request(app).post('/validate').send({ code: 'fn main() {}' });
    const res2 = await request(app).post('/validate').send({ code: 'fn main() {}' });

    expect(res1.body.validationId).toBeDefined();
    expect(res2.body.validationId).toBeDefined();
    expect(res1.body.validationId).not.toBe(res2.body.validationId);
  });

  test('code with "// Missing semicolon" comment is flagged invalid', async () => {
    // Even if cargo check passes, the special case forces invalid
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() { } // Missing semicolon' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Missing semicolon')])
    );
  });

  test('internal error returns 500', async () => {
    // Make exec throw synchronously by having the mock throw
    childProcess.exec.mockImplementation(() => {
      throw new Error('exec blew up');
    });

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() {}' });

    expect(res.status).toBe(500);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toContain('exec blew up');
  });
});
