import * as assert from 'assert';
import { createTestId, parseDiscoveryResponse } from '../discovery';
import { normalizeOutput } from '../process';

/** Exercises pure extension boundaries without starting an Odin process. */
suite('Odin Test Explorer', () => {
	/** Verifies the supported helper protocol is accepted and preserved. */
	test('parses a valid helper response', () => {
		const response = parseDiscoveryResponse(JSON.stringify({
			version: 1,
			tests: [{
				package_name: 'sample',
				package_path: '/workspace/sample',
				name: 'adds_numbers',
				file_path: '/workspace/sample/math_test.odin',
				start: { line: 5, column: 1 },
				end: { line: 5, column: 13 },
			}],
		}));

		assert.strictEqual(response.tests.length, 1);
		assert.strictEqual(response.tests[0].name, 'adds_numbers');
	});

	/** Verifies incompatible helper protocol versions fail explicitly. */
	test('rejects an unsupported helper response', () => {
		assert.throws(
			() => parseDiscoveryResponse('{"version":2,"tests":[]}'),
			/Unsupported Odin discovery response/,
		);
	});

	/** Verifies ID components cannot collide with ID separators. */
	test('creates unambiguous stable IDs', () => {
		assert.strictEqual(
			createTestId('test', '/workspace/package', 'adds:numbers'),
			'test:%2Fworkspace%2Fpackage:adds%3Anumbers',
		);
	});

	/** Verifies streamed output uses VS Code's expected terminal line endings. */
	test('normalizes output to CRLF', () => {
		assert.strictEqual(normalizeOutput('one\ntwo\r\n'), 'one\r\ntwo\r\n');
	});
});
