const request = require('supertest');
const { app } = require('../../src/rust_test_service');
const childProcess = require('child_process');
const fs = require('fs').promises;

// Mock child_process.exec for the execute endpoint
jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    exec: jest.fn(),
    spawn: jest.fn(),
  };
});

// Mock fs.promises for file operations in /execute
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

beforeEach(() => {
  jest.clearAllMocks();
  // Default: suppress setTimeout cleanup
  jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
    // Don't run the cleanup timer in tests
    return 999;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /execute', () => {
  test('fast path: code = "// test" returns quick success', async () => {
    const res = await request(app)
      .post('/execute')
      .send({ code: '// test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toContain('Fast-path');
    expect(res.body.tests).toBe(0);
    expect(res.body.passed).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.compilation.success).toBe(true);
    expect(res.body.executionId).toBeDefined();
    expect(typeof res.body.duration).toBe('number');
  });

  test('fast path with testCode: reports 1 test passed', async () => {
    const res = await request(app)
      .post('/execute')
      .send({ code: '// test', testCode: '#[test] fn it_works() {}' });

    expect(res.body.success).toBe(true);
    expect(res.body.tests).toBe(1);
    expect(res.body.passed).toBe(1);
  });

  test('short fn main() with no tests is NOT auto-passed (loophole closed)', async () => {
    // The old fast-path auto-passed short `fn main()` code without cargoToml
    // and without running anything. Now it runs the full pipeline and, since
    // no test ran (0 passed/0 failed), the verdict is success=false.
    const testOutput = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: 'Created binary project', stderr: '' }, // cargo init
      { stdout: '', stderr: '' },                       // cargo check
      { stdout: testOutput, stderr: '' },               // cargo test (0 tests)
      { stdout: '', stderr: '' },                       // llvm-cov
      { stdout: '', stderr: '' },                       // clippy
      { stdout: '', stderr: '' },                       // audit
      { stdout: '', stderr: '' },                       // deny
      { stdout: '', stderr: '' },                       // fmt
    ]);
    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({ code: 'fn main() { println!("hi"); }' });

    expect(res.status).toBe(200);
    // Real pipeline ran (no synthetic fast-path top-level output).
    expect(res.body.output).toBeUndefined();
    expect(res.body.compilation).toBeDefined();
    expect(res.body.tests.total).toBe(0);
    expect(res.body.success).toBe(false);
  });

  test('missing both code AND testCode returns 400', async () => {
    const res = await request(app)
      .post('/execute')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('code or testCode is required');
  });

  test('full pipeline: successful compilation and tests', async () => {
    const testOutput = [
      'running 2 tests',
      'test add_test ... ok',
      'test sub_test ... ok',
      'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n');

    // Pipeline steps: cargo init, cargo check, cargo test, llvm-cov, clippy, audit, deny, fmt
    mockExecForPipeline([
      { stdout: 'Created binary project', stderr: '' },       // cargo init
      { stdout: '', stderr: '' },                              // cargo check
      { stdout: testOutput, stderr: '' },                      // cargo test
      { stdout: 'Coverage: 85%', stderr: '' },                 // llvm-cov
      { stdout: '', stderr: '' },                              // clippy
      { stdout: 'No vulnerabilities found', stderr: '' },      // audit
      { stdout: '', stderr: '' },                              // deny
      { stdout: '', stderr: '' },                              // fmt
    ]);

    // Mock readFile for coverage XML
    fs.readFile.mockResolvedValue('<counter type="LINE" covered="85" missed="15"/>');

    const res = await request(app)
      .post('/execute')
      .send({ code: 'pub fn add(a: i32, b: i32) -> i32 { a + b }' });

    expect(res.status).toBe(200);
    expect(res.body.compilation).toBeDefined();
    expect(res.body.compilation.success).toBe(true);
    expect(res.body.tests).toBeDefined();
    expect(res.body.tests.passed).toBe(2);
    expect(res.body.tests.failed).toBe(0);
    expect(res.body.success).toBe(true);
    expect(res.body.executionId).toBeDefined();
    expect(typeof res.body.duration).toBe('number');
  });

  test('compilation failure stops pipeline early', async () => {
    mockExecForPipeline([
      { stdout: '', stderr: '' },                                     // cargo init
      { error: true, exitCode: 1, stdout: '', stderr: 'error[E0308]: mismatched types' }, // cargo check fails
    ]);

    // Use code that does NOT trigger the fast path (needs cargoToml or be > 100 chars
    // or not contain fn main). The fast path activates for short fn main() code without cargoToml.
    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn broken_function() { let x: i32 = "not a number"; }',
        cargoToml: '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"',
      });

    expect(res.status).toBe(200);
    expect(res.body.compilation.success).toBe(false);
    expect(res.body.compilation.errors).toContain('mismatched types');
    // Tests should not have run
    expect(res.body.tests).toBeNull();
    expect(res.body.success).toBe(false);
  });

  test('test failure marks overall success as false', async () => {
    const testOutput = [
      'running 1 test',
      'test it_fails ... FAILED',
      'test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n');

    mockExecForPipeline([
      { stdout: '', stderr: '' },                      // cargo init
      { stdout: '', stderr: '' },                      // cargo check
      { error: true, exitCode: 101, stdout: testOutput, stderr: '' }, // cargo test fails
      { stdout: '', stderr: '' },                      // llvm-cov
      { stdout: '', stderr: '' },                      // clippy
      { stdout: '', stderr: '' },                      // audit
      { stdout: '', stderr: '' },                      // deny
      { stdout: '', stderr: '' },                      // fmt
    ]);

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({ code: 'pub fn broken() {}', testCode: '#[test] fn it_fails() { panic!(); }' });

    expect(res.status).toBe(200);
    expect(res.body.tests.failed).toBe(1);
    expect(res.body.success).toBe(false);
  });

  test('coverage failure is handled gracefully', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    mockExecForPipeline([
      { stdout: '', stderr: '' },             // cargo init
      { stdout: '', stderr: '' },             // cargo check
      { stdout: testOutput, stderr: '' },     // cargo test
    ]);

    // After cargo test, llvm-cov exec throws
    let callCount = 0;
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      callCount++;
      if (callCount <= 3) {
        // First 3 calls succeed (init, check, test)
        if (callCount === 3) {
          process.nextTick(() => callback(null, testOutput, ''));
        } else {
          process.nextTick(() => callback(null, '', ''));
        }
      } else if (cmd.includes('llvm-cov')) {
        // Tarpaulin fails with rejection
        process.nextTick(() => {
          const err = new Error('llvm-cov not found');
          err.code = 127;
          callback(err, '', 'llvm-cov not found');
        });
      } else {
        // Remaining commands succeed
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockRejectedValue(new Error('File not found'));

    const res = await request(app)
      .post('/execute')
      .send({ code: 'pub fn ok() -> bool { true }' });

    expect(res.status).toBe(200);
    // Coverage should be present but may show failure
    // The rest of the pipeline should still work
    expect(res.body.compilation.success).toBe(true);
  });

  test('only code provided (no testCode)', async () => {
    const testOutput = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: '', stderr: '' },           // cargo init
      { stdout: '', stderr: '' },           // cargo check
      { stdout: testOutput, stderr: '' },   // cargo test
      { stdout: '', stderr: '' },           // llvm-cov
      { stdout: '', stderr: '' },           // clippy
      { stdout: '', stderr: '' },           // audit
      { stdout: '', stderr: '' },           // deny
      { stdout: '', stderr: '' },           // fmt
    ]);

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({ code: 'pub fn hello() {}' });

    expect(res.status).toBe(200);
    expect(res.body.compilation.success).toBe(true);
    // Compiles fine, but zero tests ran — nothing was actually verified, so the
    // overall verdict is NOT a pass (a green run must execute at least one test).
    expect(res.body.success).toBe(false);
  });

  test('only testCode provided (no code)', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: '', stderr: '' },           // cargo init
      { stdout: '', stderr: '' },           // cargo check
      { stdout: testOutput, stderr: '' },   // cargo test
      { stdout: '', stderr: '' },           // llvm-cov
      { stdout: '', stderr: '' },           // clippy
      { stdout: '', stderr: '' },           // audit
      { stdout: '', stderr: '' },           // deny
      { stdout: '', stderr: '' },           // fmt
    ]);

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({ testCode: '#[test] fn it_works() { assert!(true); }' });

    expect(res.status).toBe(200);
    expect(res.body.compilation.success).toBe(true);
  });

  test('with dependencies generates Cargo.toml with deps', async () => {
    const testOutput = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: '', stderr: '' },           // cargo init
      { stdout: '', stderr: '' },           // cargo check
      { stdout: testOutput, stderr: '' },   // cargo test
      { stdout: '', stderr: '' },           // llvm-cov
      { stdout: '', stderr: '' },           // clippy
      { stdout: '', stderr: '' },           // audit
      { stdout: '', stderr: '' },           // deny
      { stdout: '', stderr: '' },           // fmt
    ]);

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn hello() {}',
        dependencies: { serde: '1.0', tokio: '1.0' },
      });

    expect(res.status).toBe(200);
    // Verify writeFile was called with Cargo.toml containing dependencies
    const writeFileCalls = fs.writeFile.mock.calls;
    const cargoTomlCall = writeFileCalls.find(c => c[0].endsWith('Cargo.toml'));
    expect(cargoTomlCall).toBeDefined();
    expect(cargoTomlCall[1]).toContain('serde = "1.0"');
    expect(cargoTomlCall[1]).toContain('tokio = "1.0"');
  });

  test('options to skip coverage, analysis, audit, and formatting', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    // Only cargo init + cargo check + cargo test — no llvm-cov/clippy/audit/fmt
    mockExecForPipeline([
      { stdout: '', stderr: '' },           // cargo init
      { stdout: '', stderr: '' },           // cargo check
      { stdout: testOutput, stderr: '' },   // cargo test
    ]);

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn hello() { /* do stuff */ }',
        options: {
          generateCoverage: false,
          runStaticAnalysis: false,
          runSecurityAudit: false,
          checkFormatting: false,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.coverage).toBeNull();
    expect(res.body.staticAnalysis).toBeNull();
    expect(res.body.security).toBeNull();
    expect(res.body.formatting).toBeNull();
  });

  test('clippy exception is caught gracefully', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      if (cmd.includes('clippy')) {
        // Simulate a thrown exception within the promise (exec never calls callback)
        // This gets caught by the try/catch around clippy
        process.nextTick(() => {
          const err = new Error('clippy crashed');
          err.code = 1;
          callback(err, '', 'clippy crashed');
        });
      } else if (cmd.includes('cargo test')) {
        process.nextTick(() => callback(null, testOutput, ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn x() {}',
        options: {
          generateCoverage: false,
          runSecurityAudit: false,
          checkFormatting: false,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.compilation.success).toBe(true);
    // staticAnalysis should be present with success: false from the error exit code
    expect(res.body.staticAnalysis).toBeDefined();
    expect(res.body.staticAnalysis.success).toBe(false);
  });

  test('coverage executeCommand rejection triggers catch block', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      if (cmd.includes('llvm-cov')) {
        // Throw synchronously from exec to make executeCommand's Promise reject
        throw new Error('llvm-cov exploded');
      } else if (cmd.includes('cargo test')) {
        process.nextTick(() => callback(null, testOutput, ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn x() {}',
        options: {
          runStaticAnalysis: false,
          runSecurityAudit: false,
          checkFormatting: false,
        },
      });

    expect(res.status).toBe(200);
    // Coverage should show failure
    expect(res.body.coverage).toBeDefined();
    expect(res.body.coverage.success).toBe(false);
    expect(res.body.coverage.error).toContain('Coverage generation failed');
  });

  test('static analysis exception is caught', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      if (cmd.includes('clippy')) {
        // Throw synchronously to trigger the catch (clippyError)
        throw new Error('clippy not installed');
      } else if (cmd.includes('cargo test')) {
        process.nextTick(() => callback(null, testOutput, ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn y() {}',
        options: {
          generateCoverage: false,
          runSecurityAudit: false,
          checkFormatting: false,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.staticAnalysis).toBeDefined();
    expect(res.body.staticAnalysis.success).toBe(false);
    expect(res.body.staticAnalysis.error).toContain('clippy not installed');
  });

  test('security audit exception is caught', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      if (cmd.includes('cargo audit')) {
        throw new Error('audit not available');
      } else if (cmd.includes('cargo test')) {
        process.nextTick(() => callback(null, testOutput, ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn z() {}',
        options: {
          generateCoverage: false,
          runStaticAnalysis: false,
          checkFormatting: false,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.security).toBeDefined();
    expect(res.body.security.success).toBe(false);
    expect(res.body.security.error).toContain('audit not available');
  });

  test('formatting exception is caught', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      if (cmd.includes('cargo fmt')) {
        throw new Error('fmt not installed');
      } else if (cmd.includes('cargo test')) {
        process.nextTick(() => callback(null, testOutput, ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn w() {}',
        options: {
          generateCoverage: false,
          runStaticAnalysis: false,
          runSecurityAudit: false,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.formatting).toBeDefined();
    expect(res.body.formatting.success).toBe(false);
    expect(res.body.formatting.error).toContain('fmt not installed');
  });

  test('deny failure in security audit step is handled', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';

    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      if (cmd.includes('cargo deny')) {
        throw new Error('deny not installed');
      } else if (cmd.includes('cargo test')) {
        process.nextTick(() => callback(null, testOutput, ''));
      } else {
        process.nextTick(() => callback(null, '', ''));
      }
      return child;
    });

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn v() {}',
        options: {
          generateCoverage: false,
          runStaticAnalysis: false,
          checkFormatting: false,
        },
      });

    expect(res.status).toBe(200);
    // Security audit should succeed, but deny should be null
    expect(res.body.security).toBeDefined();
    expect(res.body.security.audit).toBeDefined();
    expect(res.body.security.deny).toBeNull();
  });

  test('cleanup setTimeout runs and handles rmdir error', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: testOutput, stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
    ]);

    fs.readFile.mockResolvedValue('');
    fs.rmdir.mockRejectedValue(new Error('cleanup failed'));

    // Capture the setTimeout callback so we can invoke it
    let cleanupFn = null;
    jest.restoreAllMocks(); // remove the beforeEach setTimeout mock
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
      if (delay === 120000) {
        cleanupFn = fn;
      }
      return 999;
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'pub fn t() {}' });

    expect(res.status).toBe(200);

    // Now invoke the cleanup callback
    if (cleanupFn) {
      await cleanupFn();
    }
    // Should not throw - error is caught internally

    jest.restoreAllMocks();
  });

  test('cleanup setTimeout success path', async () => {
    const testOutput = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: testOutput, stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
    ]);

    fs.readFile.mockResolvedValue('');
    fs.rmdir.mockResolvedValue(undefined); // rmdir succeeds

    let cleanupFn = null;
    jest.restoreAllMocks();
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay) => {
      if (delay === 120000) {
        cleanupFn = fn;
      }
      return 999;
    });

    const res = await request(app)
      .post('/execute')
      .send({ code: 'pub fn t2() {}' });

    expect(res.status).toBe(200);

    if (cleanupFn) {
      await cleanupFn();
    }
    // rmdir was called and succeeded
    expect(fs.rmdir).toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  test('fn main() code with cargoToml does NOT trigger fast path', async () => {
    const testOutput = 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n';
    mockExecForPipeline([
      { stdout: '', stderr: '' },           // cargo init
      { stdout: '', stderr: '' },           // cargo check
      { stdout: testOutput, stderr: '' },   // cargo test
      { stdout: '', stderr: '' },           // llvm-cov
      { stdout: '', stderr: '' },           // clippy
      { stdout: '', stderr: '' },           // audit
      { stdout: '', stderr: '' },           // deny
      { stdout: '', stderr: '' },           // fmt
    ]);

    fs.readFile.mockResolvedValue('');

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'fn main() {}',
        cargoToml: '[package]\nname="t"\nversion="0.1.0"\nedition="2021"',
      });

    expect(res.status).toBe(200);
    // Should NOT have fast-path output because cargoToml is provided
    expect(res.body.output).toBeUndefined();
    expect(res.body.compilation).toBeDefined();
  });

  test('top-level exception in execute returns 500', async () => {
    // Make fs.mkdir throw to trigger the top-level catch
    // This must be the LAST test because it corrupts the mock state
    fs.mkdir.mockRejectedValueOnce(new Error('disk full'));

    const res = await request(app)
      .post('/execute')
      .send({
        code: 'pub fn crash() {}',
        cargoToml: '[package]\nname="t"\nversion="0.1.0"\nedition="2021"',
      });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('disk full');
    expect(res.body.executionId).toBeDefined();
  });
});
