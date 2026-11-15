const {
    parseClippyOutput,
    parseClippyLocation,
} = require('../../src/rust_test_service');

// Regression tests for alert js/polynomial-redos on the clippy location parser
// (src/rust_test_service.js): /-->\s*([^:]+):(\d+):(\d+)/ shares every split
// of a whitespace run between `\s*` and `[^:]+`, so the alert's named shape
// ('-->' followed by many spaces) is quadratic. The explicit budget is
// deliberately loose so a loaded CI box cannot flake; the linear scanner
// finishes these inputs in milliseconds.
const LINEAR_TIME_BUDGET_MS = 2000;

function measure(fn) {
    const started = process.hrtime.bigint();
    const value = fn();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { value, elapsedMs };
}

describe('clippy location parsing is linear (js/polynomial-redos regression)', () => {
    test("'-->' followed by a very long whitespace run with no colon", () => {
        const output = `warning: x\n-->${' '.repeat(200000)}`;
        const { value, elapsedMs } = measure(() => parseClippyOutput(output));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value.issues).toHaveLength(1);
        expect(value.issues[0].file).toBeNull();
    });

    test("'-->' followed by a very long non-colon run with no colon", () => {
        const output = `warning: x\n--> ${'a'.repeat(200000)}`;
        const { value, elapsedMs } = measure(() => parseClippyOutput(output));

        expect(elapsedMs).toBeLessThan(LINEAR_TIME_BUDGET_MS);
        expect(value.issues[0].file).toBeNull();
    });
});

describe('parseClippyLocation preserves the old regex semantics', () => {
    test.each([
        ['  --> src/main.rs:10:5', 'src/main.rs', 10, 5],
        ['-->x.rs:1:2', 'x.rs', 1, 2],
        ['text --> a.rs:12:34 trailing text', 'a.rs', 12, 34],
        ['--> src/lib.rs:3:7', 'src/lib.rs', 3, 7],
    ])('parseClippyLocation(%j) -> %j', (line, file, lineNumber, column) => {
        expect(parseClippyLocation(line)).toEqual({ file, line: lineNumber, column });
    });

    test.each([
        ['--> a.rs:12'], // no column
        ['--> a.rs:12:'], // empty column
        ['--> a.rs:x:12'], // non-numeric line
        ['--> a.rs::12:34'], // empty line number
        ['--> C:\\x.rs:3:4'], // the drive-letter colon ends the name, then \\ is not a digit
        ['--> just some prose'], // no colon at all
        ['-->'], // nothing after the arrow
    ])('parseClippyLocation(%j) -> null', (line) => {
        expect(parseClippyLocation(line)).toBeNull();
    });

    test('the name run may contain a later arrow, exactly as the greedy group did', () => {
        // `[^:]+` could span spaces and further '-->' tokens; the first colon
        // after the arrow is what ends the name.
        expect(parseClippyLocation('--> bad text --> a.rs:1:2')).toEqual({
            file: 'bad text --> a.rs',
            line: 1,
            column: 2,
        });
    });
});

describe('parseClippyOutput keeps issues and locations working', () => {
    test('warnings and errors each get their own file location', () => {
        const output = [
            'warning: unused variable: `x`',
            '  --> src/main.rs:10:5',
            'error: mismatched types',
            '  --> src/lib.rs:3:7',
        ].join('\n');

        const result = parseClippyOutput(output);

        expect(result.totalIssues).toBe(2);
        expect(result.warnings).toBe(1);
        expect(result.errors).toBe(1);
        expect(result.issues[0]).toMatchObject({
            level: 'warning',
            message: 'unused variable: `x`',
            file: 'src/main.rs',
            line: 10,
            column: 5,
        });
        expect(result.issues[1]).toMatchObject({
            level: 'error',
            file: 'src/lib.rs',
            line: 3,
            column: 7,
        });
    });
});
