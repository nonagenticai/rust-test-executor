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
      readFile: jest.fn().mockResolvedValue(''),
      rmdir: jest.fn().mockResolvedValue(undefined),
      rm: jest.fn().mockResolvedValue(undefined),
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

// Every shell command the handler ran, as plain strings.
function execCommands() {
  return childProcess.exec.mock.calls.map(call => call[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// A non-string `code` used to reach `code.trim()` and surface as an opaque
// HTTP 500 ("code.trim is not a function"). It must be a 400 that names the
// field and the type actually received.
describe('POST /validate - code type contract', () => {
  const cases = [
    ['object', { a: 1 }, 'object'],
    ['array', ['fn main() {}'], 'array'],
    ['number', 42, 'number'],
    ['boolean', true, 'boolean'],
  ];

  test.each(cases)('%s code returns 400, not 500', async (_label, value, expectedType) => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: value });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.validationId).toBeDefined();
    expect(res.body.output).toBe('');
    expect(res.body.errors).toEqual([
      `Field 'code' must be a string, received ${expectedType}`,
    ]);
    // The 500 path put the raw TypeError on `error`; there must be none.
    expect(res.body.error).toBeUndefined();
    expect(execCommands()).toEqual([]);
  });

  test('pre-existing null/undefined 400s are unchanged', async () => {
    const missing = await request(app).post('/validate').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.valid).toBe(false);
    expect(missing.body.errors).toEqual(['No code provided']);
    expect(missing.body.output).toBe('');

    const explicitNull = await request(app).post('/validate').send({ code: null });
    expect(explicitNull.status).toBe(400);
    expect(explicitNull.body.valid).toBe(false);
    expect(explicitNull.body.errors).toEqual(['No code provided']);
    expect(explicitNull.body.output).toBe('');

    expect(execCommands()).toEqual([]);
  });

  test('empty string code still returns 200 valid:false (not the type 400)', async () => {
    const res = await request(app).post('/validate').send({ code: '   ' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors).toContain('Empty code is not valid Rust');
  });
});

// crateType is interpolated into the `cargo init --<crateType>` command
// string, so it must be constrained to the two values the handler supports.
describe('POST /validate - crateType contract', () => {
  test('unsupported crateType returns 400 and runs no cargo command', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() {}', crateType: 'wasm' });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.output).toBe('');
    expect(res.body.errors).toEqual([
      'Unsupported crateType: wasm. Supported types: lib, bin',
    ]);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  test('shell metacharacters in crateType never reach the shell', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() {}', crateType: 'bin; touch /tmp/pwned' });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  test('non-string crateType is rejected as unsupported', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() {}', crateType: ['lib'] });

    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(childProcess.exec).not.toHaveBeenCalled();
  });

  test("crateType 'lib' still works", async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'pub fn add(a: i32, b: i32) -> i32 { a + b }', crateType: 'lib' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(execCommands().some(cmd => cmd.includes('cargo init --lib'))).toBe(true);
  });

  test("crateType 'bin' still works", async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() {}', crateType: 'bin' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(execCommands().some(cmd => cmd.includes('cargo init --bin'))).toBe(true);
  });

  test('omitted crateType defaults to bin and still works', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/validate')
      .send({ code: 'fn main() {}' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(execCommands().some(cmd => cmd.includes('cargo init --bin'))).toBe(true);
  });
});

describe('POST /execute - code type contract', () => {
  const cases = [
    ['object', { a: 1 }, 'object'],
    ['array', ['fn main() {}'], 'array'],
    ['number', 42, 'number'],
    ['boolean', false, 'boolean'],
  ];

  test.each(cases)('%s code returns 400, not 500', async (_label, value, expectedType) => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/execute')
      .send({ code: value, testCode: '#[test] fn t() {}' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.executionId).toBeDefined();
    expect(typeof res.body.duration).toBe('number');
    expect(res.body.error).toBe(
      `Field 'code' must be a string, received ${expectedType}`
    );
    expect(execCommands()).toEqual([]);
  });

  test('non-string code is rejected even with no testCode', async () => {
    mockExecSuccess('', '');

    const res = await request(app).post('/execute').send({ code: { a: 1 } });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Field 'code' must be a string, received object");
    expect(execCommands()).toEqual([]);
  });

  test('pre-existing "neither code nor testCode" 400 is unchanged', async () => {
    const res = await request(app).post('/execute').send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('At least one of code or testCode is required');
    expect(res.body.executionId).toBeDefined();
    expect(typeof res.body.duration).toBe('number');
    expect(execCommands()).toEqual([]);
  });

  test('null code with testCode still runs the full pipeline (not a type 400)', async () => {
    mockExecSuccess('', '');

    const res = await request(app)
      .post('/execute')
      .send({ code: null, testCode: '#[test] fn t() { assert!(true); }' });

    expect(res.status).not.toBe(400);
  });

  test('the "// test" fast path still works', async () => {
    const res = await request(app)
      .post('/execute')
      .send({ code: '// test', testCode: '#[test] fn t() {}' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toBe('Fast-path response for minimal test');
    expect(res.body.tests).toBe(1);
    expect(res.body.passed).toBe(1);
    // The fast path is a liveness probe: it must not shell out at all.
    expect(childProcess.exec).not.toHaveBeenCalled();
  });
});
