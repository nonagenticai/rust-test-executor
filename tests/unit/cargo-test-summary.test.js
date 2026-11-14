const { parseTestOutput } = require('../../src/rust_test_service');

// The EXACT bytes from the live pod on 2026-08-16, on the first /execute that
// ever got past dependency resolution. `cargo test` prints one summary per
// TARGET — lib, each bin, each integration test, and doc-tests — and the
// doc-test summary comes LAST. For a scaffolded project that last one is always
// "0 passed; 0 failed", so assigning instead of accumulating made every run
// report zero tests, which fails the `tests.total > 0` success gate. A green run
// was reported as a failure.
const LIVE_OUTPUT = [
    '',
    'running 0 tests',
    '',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
    '',
    'running 0 tests',
    '',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
    '',
    'running 1 test',
    'test adds ... ok',
    '',
    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
    '',
    'running 0 tests',
    '',
    'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
    '',
].join('\n');

describe('parseTestOutput accumulates across cargo targets', () => {
    test('the live output reports the ONE test that ran, not the last target', () => {
        const r = parseTestOutput(LIVE_OUTPUT);
        expect(r.total).toBe(1);
        expect(r.passed).toBe(1);
        expect(r.failed).toBe(0);
        // The per-test line was always parsed correctly — that is what made the
        // zeroed counters so easy to miss.
        expect(r.testResults).toEqual([{ name: 'adds', status: 'ok', success: true }]);
    });

    test('failures in an earlier target are not erased by a clean later one', () => {
        const r = parseTestOutput(
            [
                'test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s',
                'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
            ].join('\n')
        );
        expect(r).toMatchObject({ total: 3, passed: 2, failed: 1 });
    });

    test('ignored tests count toward the total', () => {
        const r = parseTestOutput(
            'test result: ok. 1 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s'
        );
        expect(r).toMatchObject({ total: 3, passed: 1, failed: 0, ignored: 2 });
    });

    test('a run with genuinely no tests still reports zero', () => {
        const r = parseTestOutput(
            'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
        );
        expect(r).toMatchObject({ total: 0, passed: 0, failed: 0 });
    });
});
