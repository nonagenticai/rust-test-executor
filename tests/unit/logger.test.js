const util = require('util');
const { createLogger } = require('../../src/common');

function capture(sink) {
    const calls = [];
    const spy = jest.spyOn(console, sink).mockImplementation((...args) => calls.push(args));
    return { calls, restore: () => spy.mockRestore() };
}

// console.* treats its first argument as a util.format string, and the
// message is caller-controlled (request- and file-derived values are
// interpolated into it). These tests pin the constant-format-string form:
// a '%' directive in a message is printed literally instead of consuming the
// metadata argument.
describe('createLogger does not use the message as a format string', () => {
    afterEach(() => jest.restoreAllMocks());

    test('a % directive in the message survives verbatim', () => {
        const log = createLogger();
        const { calls } = capture('log');

        log.debug('user said %s and %j', { tenant: 'acme' });

        expect(calls).toHaveLength(1);
        const args = calls[0];
        expect(args[0]).toBe('[DEBUG] %s - %s %s');
        expect(args[2]).toBe('user said %s and %j');

        const rendered = util.format(...args);
        expect(rendered).toContain('[DEBUG] ');
        expect(rendered).toContain('- user said %s and %j');
        expect(rendered).toContain('"tenant": "acme"');
    });

    test('each level writes to its own sink with a constant format string', () => {
        const log = createLogger();
        const out = capture('log');
        const err = capture('error');
        const warn = capture('warn');

        log.info('i');
        log.debug('d');
        log.error('e');
        log.warn('w');

        expect(out.calls.map((args) => args[0])).toEqual(['[INFO] %s - %s %s', '[DEBUG] %s - %s %s']);
        expect(err.calls.map((args) => args[0])).toEqual(['[ERROR] %s - %s %s']);
        expect(warn.calls.map((args) => args[0])).toEqual(['[WARN] %s - %s %s']);
        expect(out.calls[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
});
