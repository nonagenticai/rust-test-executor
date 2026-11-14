/**
 * Zero-collection must be REPORTABLE, not merely non-passing.
 *
 * `total > 0` in the verdict already stops a zero-test run being graded green.
 * What was missing is the ability for the caller to TELL a zero-collection run
 * apart from a genuine failure: both arrived as `success:false` and nothing on
 * the wire named the difference. The orchestrator's three-valued verdict
 * (passed / failed / not_run) therefore had no signal to act on for rust, so
 * the whole mechanism was inert for this language.
 *
 * Every test here asserts THREE outcomes are distinguishable, not two.
 */
const request = require('supertest');
const { app } = require('../../src/rust_test_service');
const childProcess = require('child_process');
const fs = require('fs').promises;

jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return { ...original, exec: jest.fn(), spawn: jest.fn() };
});

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
    },
  };
});

function mockExecForPipeline(responses) {
  let callIndex = 0;
  childProcess.exec.mockImplementation((cmd, opts, callback) => {
    const child = { killed: false, kill: jest.fn() };
    const response = responses[callIndex] || { stdout: '', stderr: '', error: null };
    callIndex++;
    process.nextTick(() => {
      if (response.error) {
        const err = new Error(response.stderr || 'Command failed');
        err.code = response.exitCode || 1;
        callback(err, response.stdout || '', response.stderr || '');
      } else {
        callback(null, response.stdout || '', response.stderr || '');
      }
    });
    return child;
  });
}

// cargo init, cargo check, cargo test, llvm-cov, clippy, audit, deny, fmt
function pipeline(testStep) {
  return [
    { stdout: 'Created binary project', stderr: '' },
    { stdout: '', stderr: '' },
    testStep,
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: '', stderr: '' },
  ];
}

const CODE = 'pub fn add(a: i32, b: i32) -> i32 { a + b }';

beforeEach(() => {
  jest.clearAllMocks();
  fs.readFile.mockResolvedValue('');
});

describe('no_tests_run on the /execute contract', () => {
  // ---- Outcome 1 of 3: zero tests collected -------------------------------
  test('a cargo run that collects nothing reports no_tests_run=true', async () => {
    // This is what `cargo test` genuinely prints when it collects nothing:
    // it COMPILES, EXITS 0, and reports ok with all-zero counts. There is no
    // pytest-style exit 5 to key on, which is why the summary line is parsed.
    const out = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline(pipeline({ stdout: out, stderr: '' }));

    const res = await request(app).post('/execute').send({ code: CODE });

    expect(res.status).toBe(200);
    expect(res.body.tests.total).toBe(0);
    expect(res.body.no_tests_run).toBe(true);
    // Never a pass...
    expect(res.body.success).toBe(false);
  });

  test('a run where every test was filtered out is also a not-run', async () => {
    const out = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out\n';
    mockExecForPipeline(pipeline({ stdout: out, stderr: '' }));

    const res = await request(app).post('/execute').send({ code: CODE });

    expect(res.body.tests.filtered).toBe(3);
    expect(res.body.no_tests_run).toBe(true);
    expect(res.body.success).toBe(false);
  });

  // ---- Outcome 2 of 3: everything passed ----------------------------------
  test('an all-passed run reports no_tests_run=false', async () => {
    const out = 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline(pipeline({ stdout: out, stderr: '' }));

    const res = await request(app).post('/execute').send({ code: CODE });

    expect(res.body.tests.total).toBe(2);
    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.success).toBe(true);
  });

  // ---- Outcome 3 of 3: genuine test failure -------------------------------
  test('a genuine test failure is a FAILURE, not a not-run', async () => {
    const out = 'test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline(pipeline({ stdout: out, stderr: '', error: true, exitCode: 101 }));

    const res = await request(app).post('/execute').send({ code: CODE });

    expect(res.body.tests.failed).toBe(1);
    // The distinction that matters: not a pass, and NOT a not-run either.
    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.success).toBe(false);
  });

  // ---- The two ways "total === 0" can lie ---------------------------------
  test('a crashed cargo test is a FAILURE, not a not-run', async () => {
    // total===0 here too, but the run never got far enough to collect
    // anything. Calling this "no tests were collected" would be a lie, and
    // would hand a genuine crash the one verdict that is never a failure.
    mockExecForPipeline(
      pipeline({ stdout: '', stderr: 'error: process abort', error: true, exitCode: 134 })
    );

    const res = await request(app).post('/execute').send({ code: CODE });

    expect(res.body.tests.total).toBe(0);
    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.success).toBe(false);
  });

  test('a compile failure is a FAILURE, not a not-run', async () => {
    const responses = [
      { stdout: 'Created binary project', stderr: '' },
      { stdout: '', stderr: 'error[E0425]: cannot find value', error: true, exitCode: 101 },
    ];
    mockExecForPipeline(responses);

    const res = await request(app).post('/execute').send({ code: 'fn main() { nope() }' });

    expect(res.body.compilation.success).toBe(false);
    expect(res.body.no_tests_run).toBe(false);
    expect(res.body.success).toBe(false);
  });
});
