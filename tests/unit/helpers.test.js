const childProcess = require('child_process');

// We need to test executeCommand, but it uses child_process.exec directly.
// We'll mock child_process at module level.
jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    exec: jest.fn(),
  };
});

const { executeCommand } = require('../../src/rust_test_service');

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('executeCommand', () => {
  test('successful command returns success: true, exitCode: 0', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      process.nextTick(() => callback(null, 'hello world', ''));
      return child;
    });

    const result = await executeCommand('echo hello');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('failed command returns success: false with exit code', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      process.nextTick(() => {
        const err = new Error('Command failed');
        err.code = 2;
        callback(err, '', 'some error');
      });
      return child;
    });

    const result = await executeCommand('false');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('some error');
  });

  test('error with no code defaults to exitCode 1', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      process.nextTick(() => {
        const err = new Error('Command failed');
        // No err.code set → should default to 1
        callback(err, '', '');
      });
      return child;
    });

    const result = await executeCommand('bad-command');
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  test('uses custom cwd option', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      // Verify the cwd was passed through
      expect(opts.cwd).toBe('/tmp/custom');
      process.nextTick(() => callback(null, '', ''));
      return child;
    });

    await executeCommand('ls', { cwd: '/tmp/custom' });
    expect(childProcess.exec).toHaveBeenCalledTimes(1);
  });

  test('uses custom timeout option', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      expect(opts.timeout).toBe(5000);
      process.nextTick(() => callback(null, '', ''));
      return child;
    });

    // Mock setTimeout to avoid the internal timeout logic interfering
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => 999);

    await executeCommand('ls', { timeout: 5000 });
    expect(childProcess.exec).toHaveBeenCalledTimes(1);

    jest.restoreAllMocks();
  });

  test('maxBuffer is set to 20MB', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      expect(opts.maxBuffer).toBe(20 * 1024 * 1024);
      process.nextTick(() => callback(null, '', ''));
      return child;
    });

    // Mock setTimeout to prevent internal timer
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => 999);

    await executeCommand('ls');

    jest.restoreAllMocks();
  });

  test('stdout and stderr from successful command are captured', async () => {
    childProcess.exec.mockImplementation((cmd, opts, callback) => {
      const child = { killed: false, kill: jest.fn() };
      process.nextTick(() => callback(null, 'out-data', 'err-data'));
      return child;
    });

    const result = await executeCommand('some-cmd');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('out-data');
    expect(result.stderr).toBe('err-data');
  });
});
