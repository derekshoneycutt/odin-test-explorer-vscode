import * as assert from 'assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runProcess } from '../process';

suite('Process execution', () => {
  test('preserves spaced arguments and propagates cwd and environment', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'odin-process-test-'));
    try {
      const result = await runProcess(
        process.execPath,
        ['-e', 'console.log(JSON.stringify({cwd:process.cwd(),value:process.env.ODIN_FAKE,arg:process.argv[1]}))', 'two words'],
        undefined,
        undefined,
        { cwd, env: { ODIN_FAKE: 'present' } },
      );
      const output = JSON.parse(result.stdout) as { cwd: string; value: string; arg: string };
      assert.strictEqual(output.cwd, cwd);
      assert.strictEqual(output.value, 'present');
      assert.strictEqual(output.arg, 'two words');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  test('cancels an active process', async () => {
    const cancellation = new vscode.CancellationTokenSource();
    const operation = runProcess(
      process.execPath,
      ['-e', "console.log('ready');setInterval(()=>{},1000)"],
      cancellation.token,
      (text) => {
        if (text.includes('ready')) {
          cancellation.cancel();
        }
      },
    );

    const result = await operation;
    assert.strictEqual(cancellation.token.isCancellationRequested, true);
    assert.notStrictEqual(result.exitCode, 0);
  });
});
