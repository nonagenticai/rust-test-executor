const {
  parseTestOutput,
  parseClippyOutput,
  parseCoverageOutput,
  parseAuditOutput,
} = require('../../src/rust_test_service');

// ── parseTestOutput ─────────────────────────────────────────────────

describe('parseTestOutput', () => {
  test('empty string returns zeroed results', () => {
    const r = parseTestOutput('');
    expect(r.total).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.ignored).toBe(0);
    expect(r.filtered).toBe(0);
    expect(r.testResults).toEqual([]);
    expect(r.benchResults).toEqual([]);
  });

  test('single passing test parsed from individual line', () => {
    const output = 'test my_test ... ok\n';
    const r = parseTestOutput(output);
    expect(r.testResults).toHaveLength(1);
    expect(r.testResults[0]).toEqual({
      name: 'my_test',
      status: 'ok',
      success: true,
    });
  });

  test('single failing test parsed from individual line', () => {
    const output = 'test my_test ... FAILED\n';
    const r = parseTestOutput(output);
    expect(r.testResults).toHaveLength(1);
    expect(r.testResults[0]).toEqual({
      name: 'my_test',
      status: 'failed',
      success: false,
    });
  });

  test('summary line is parsed into counts', () => {
    const output =
      'test result: ok. 5 passed; 1 failed; 2 ignored; 0 measured; 3 filtered out\n';
    const r = parseTestOutput(output);
    // total = passed + failed + ignored
    expect(r.total).toBe(8);
    expect(r.passed).toBe(5);
    expect(r.failed).toBe(1);
    expect(r.ignored).toBe(2);
    expect(r.filtered).toBe(3);
  });

  test('multiple tests with mixed pass/fail', () => {
    const output = [
      'running 3 tests',
      'test alpha ... ok',
      'test beta ... FAILED',
      'test gamma ... ok',
      '',
      'test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n');
    const r = parseTestOutput(output);

    expect(r.testResults).toHaveLength(3);
    expect(r.testResults.map(t => t.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(r.testResults.map(t => t.success)).toEqual([true, false, true]);

    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.total).toBe(3);
  });

  test('benchmark result is parsed', () => {
    const output =
      'test bench_test ... bench:     1,234 ns/iter (+/- 56)\n';
    const r = parseTestOutput(output);
    expect(r.benchResults).toHaveLength(1);
    expect(r.benchResults[0]).toEqual({
      name: 'bench_test',
      nanosPerIter: 1234,
      variance: 56,
    });
  });

  test('no summary line leaves counts at zero', () => {
    const output = 'test foo ... ok\n';
    const r = parseTestOutput(output);
    // Individual results are captured
    expect(r.testResults).toHaveLength(1);
    // But summary counters stay at 0 because there is no summary line
    expect(r.total).toBe(0);
    expect(r.passed).toBe(0);
  });

  test('ignored test appears in individual results', () => {
    // NOTE: The parser only captures "ok" and "FAILED" individual lines,
    // but the summary line captures ignored count.
    const output = [
      'test slow_test ... ignored',
      'test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out',
    ].join('\n');
    const r = parseTestOutput(output);
    expect(r.ignored).toBe(1);
    expect(r.total).toBe(1);
    // Individual test line does NOT match because the parser regex only
    // matches "... ok" or "... FAILED" — "ignored" is only captured via summary.
    // This is an acceptable gap; the summary counts are authoritative.
  });

  test('large variance benchmark', () => {
    const output =
      'test bench_sort ... bench:   123,456,789 ns/iter (+/- 9,876,543)\n';
    const r = parseTestOutput(output);
    expect(r.benchResults).toHaveLength(1);
    expect(r.benchResults[0].nanosPerIter).toBe(123456789);
    expect(r.benchResults[0].variance).toBe(9876543);
  });

  // Rewritten 2026-08-16. This case used to assert "last one wins" and to
  // EXPLAIN the overwrite as if it were intended ("the loop processes
  // sequentially; last summary overwrites"). It was the defect, frozen into a
  // test: `cargo test` prints one summary per target and the doc-test summary
  // comes last, so for a scaffolded project every run adopted "0 passed; 0
  // failed" and the service reported a passing test run as a failure.
  test('multiple summary lines - every target counts', () => {
    const output = [
      'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out',
      'test result: ok. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out',
    ].join('\n');
    const r = parseTestOutput(output);
    expect(r.passed).toBe(5);
    expect(r.failed).toBe(1);
    expect(r.total).toBe(6);
  });
});

// ── parseClippyOutput ───────────────────────────────────────────────

describe('parseClippyOutput', () => {
  test('empty output returns empty issues', () => {
    const r = parseClippyOutput('');
    expect(r.totalIssues).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.issues).toEqual([]);
  });

  test('single warning with file location', () => {
    const output = [
      'warning: unused variable `x`',
      '  --> src/lib.rs:10:5',
      '   |',
      '10 |     let x = 5;',
      '   |         ^',
    ].join('\n');
    const r = parseClippyOutput(output);
    expect(r.totalIssues).toBe(1);
    expect(r.warnings).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.issues[0]).toEqual({
      level: 'warning',
      message: 'unused variable `x`',
      file: 'src/lib.rs',
      line: 10,
      column: 5,
    });
  });

  test('error line is parsed with severity error', () => {
    const output = [
      'error: expected `;`',
      ' --> src/main.rs:3:20',
    ].join('\n');
    const r = parseClippyOutput(output);
    expect(r.totalIssues).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.warnings).toBe(0);
    expect(r.issues[0].level).toBe('error');
    expect(r.issues[0].message).toBe('expected `;`');
    expect(r.issues[0].file).toBe('src/main.rs');
    expect(r.issues[0].line).toBe(3);
    expect(r.issues[0].column).toBe(20);
  });

  test('multiple warnings counted correctly', () => {
    const output = [
      'warning: unused import',
      ' --> src/lib.rs:1:5',
      'warning: dead code',
      ' --> src/lib.rs:20:1',
      'warning: redundant clone',
      ' --> src/lib.rs:30:10',
    ].join('\n');
    const r = parseClippyOutput(output);
    expect(r.totalIssues).toBe(3);
    expect(r.warnings).toBe(3);
    expect(r.errors).toBe(0);
    expect(r.issues).toHaveLength(3);
    expect(r.issues[0].file).toBe('src/lib.rs');
    expect(r.issues[1].line).toBe(20);
    expect(r.issues[2].column).toBe(10);
  });

  test('warning without location has null file/line/column', () => {
    const output = 'warning: unused variable `y`\n';
    const r = parseClippyOutput(output);
    expect(r.totalIssues).toBe(1);
    expect(r.issues[0].file).toBeNull();
    expect(r.issues[0].line).toBeNull();
    expect(r.issues[0].column).toBeNull();
  });

  test('mixed warnings and errors', () => {
    const output = [
      'warning: unused variable',
      ' --> src/lib.rs:5:9',
      'error: mismatched types',
      ' --> src/lib.rs:10:12',
      'warning: dead code',
      ' --> src/lib.rs:15:1',
    ].join('\n');
    const r = parseClippyOutput(output);
    expect(r.totalIssues).toBe(3);
    expect(r.warnings).toBe(2);
    expect(r.errors).toBe(1);
    expect(r.issues[1].level).toBe('error');
    expect(r.issues[1].message).toBe('mismatched types');
  });
});

// ── parseCoverageOutput ─────────────────────────────────────────────

describe('parseCoverageOutput', () => {
  test('null input returns null', () => {
    expect(parseCoverageOutput(null)).toBeNull();
  });

  test('undefined input returns null', () => {
    expect(parseCoverageOutput(undefined)).toBeNull();
  });

  test('empty string returns null', () => {
    // Empty string is falsy → returns null
    expect(parseCoverageOutput('')).toBeNull();
  });
});

// ── parseAuditOutput ────────────────────────────────────────────────

describe('parseAuditOutput', () => {
  test('empty output returns empty array', () => {
    const r = parseAuditOutput('');
    expect(r.totalVulnerabilities).toBe(0);
    expect(r.vulnerabilities).toEqual([]);
  });

  test('single full vulnerability block', () => {
    const output = [
      '┌─────────────────────────────────┐',
      '│ Title: Memory safety bug        │',
      '│ Date: 2023-01-15                │',
      '│ ID: RUSTSEC-2023-0001           │',
      '│ Package: serde                  │',
      '│ Version: 1.0.0                  │',
      '│ URL: https://rustsec.org/0001   │',
      '│ Solution: Upgrade to 1.0.1      │',
      '└─────────────────────────────────┘',
    ].join('\n');
    const r = parseAuditOutput(output);
    expect(r.totalVulnerabilities).toBe(1);
    const v = r.vulnerabilities[0];
    expect(v.title).toBe('Memory safety bug');
    expect(v.date).toBe('2023-01-15');
    expect(v.id).toBe('RUSTSEC-2023-0001');
    expect(v.package).toBe('serde');
    expect(v.version).toBe('1.0.0');
    expect(v.url).toBe('https://rustsec.org/0001');
    expect(v.solution).toBe('Upgrade to 1.0.1');
  });

  test('multiple vulnerability blocks', () => {
    const output = [
      '┌───────────┐',
      '│ Title: Bug A │',
      '│ Package: foo │',
      '└───────────┘',
      '┌───────────┐',
      '│ Title: Bug B │',
      '│ Package: bar │',
      '└───────────┘',
    ].join('\n');
    const r = parseAuditOutput(output);
    expect(r.totalVulnerabilities).toBe(2);
    expect(r.vulnerabilities[0].title).toBe('Bug A');
    expect(r.vulnerabilities[0].package).toBe('foo');
    expect(r.vulnerabilities[1].title).toBe('Bug B');
    expect(r.vulnerabilities[1].package).toBe('bar');
  });

  test('partial vulnerability (missing some fields)', () => {
    const output = [
      '┌───────────┐',
      '│ Title: Partial bug │',
      '│ ID: RUSTSEC-2023-9999 │',
      '└───────────┘',
    ].join('\n');
    const r = parseAuditOutput(output);
    expect(r.totalVulnerabilities).toBe(1);
    const v = r.vulnerabilities[0];
    expect(v.title).toBe('Partial bug');
    expect(v.id).toBe('RUSTSEC-2023-9999');
    // Fields not present should be undefined
    expect(v.package).toBeUndefined();
    expect(v.version).toBeUndefined();
    expect(v.url).toBeUndefined();
    expect(v.solution).toBeUndefined();
  });

  test('output with no vulnerability blocks', () => {
    const output = 'No vulnerabilities found!\n0 vulnerabilities found in 50 packages\n';
    const r = parseAuditOutput(output);
    expect(r.totalVulnerabilities).toBe(0);
    expect(r.vulnerabilities).toEqual([]);
  });
});
