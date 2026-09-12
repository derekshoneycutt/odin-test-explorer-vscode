import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ArgumentProviderError,
  TestArgumentResolver,
  TestArgumentResolverServices,
  selectWorkspacePath,
  validateUserArguments,
} from '../arguments';
import { ProcessResult } from '../process';

suite('Test arguments', () => {
  test('selects single-root and nested workspace cwd', () => {
    assert.strictEqual(selectWorkspacePath('/work/src/pkg', ['/work']), '/work');
    assert.strictEqual(selectWorkspacePath('/work/src/pkg', ['/work', '/work/src']), '/work/src');
    assert.strictEqual(selectWorkspacePath('/other/pkg', ['/work']), '/other/pkg');
  });

  test('caches workspace providers within one run and isolates workspace folders', async () => {
    const calls: string[] = [];
    const services = createServices('workspace', async (_command, _args, _token, options) => {
      calls.push(options.cwd ?? '');
      return successResult();
    });
    const resolver = new TestArgumentResolver(new vscode.CancellationTokenSource().token, () => {}, services);

    await resolver.resolve('/one/pkg-a');
    await resolver.resolve('/one/pkg-b');
    await resolver.resolve('/two/pkg-c');

    assert.deepStrictEqual(calls, ['/one', '/two']);
  });

  test('runs package providers once per package', async () => {
    let calls = 0;
    const services = createServices('package', async () => {
      calls += 1;
      return successResult();
    });
    const resolver = new TestArgumentResolver(new vscode.CancellationTokenSource().token, () => {}, services);

    await resolver.resolve('/one/pkg-a');
    await resolver.resolve('/one/pkg-a');
    await resolver.resolve('/one/pkg-b');

    assert.strictEqual(calls, 2);
  });

  test('preserves provider stderr, environment, and arguments containing spaces', async () => {
    let stderr = '';
    let capturedArgs: readonly string[] = [];
    const services = createServices('package', async (_command, args) => {
      capturedArgs = args;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          arguments: ['-extra-linker-flags:-L/a path/lib -ljulia'],
          environment: { JULIA_BINDIR: '/a path/bin' },
        }),
        stderr: 'provider note\n',
      };
    }, ['${packagePath}']);
    const resolver = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      (text) => { stderr += text; },
      services,
    );

    const result = await resolver.resolve('/one/pkg-a');

    assert.deepStrictEqual(capturedArgs, ['/one/pkg-a']);
    assert.deepStrictEqual(result.arguments, ['-extra-linker-flags:-L/a path/lib -ljulia']);
    assert.deepStrictEqual(result.environment, { JULIA_BINDIR: '/a path/bin' });
    assert.strictEqual(stderr, 'provider note\n');
  });

  test('expands provider environment used to resolve an explicit interpreter', async () => {
    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin';
    let command = '';
    let args: readonly string[] = [];
    let environment: Readonly<Record<string, string>> | undefined;
    const services = createServices('workspace', async (resolvedCommand, resolvedArgs, _token, options) => {
      command = resolvedCommand;
      args = resolvedArgs;
      environment = options.env;
      return successResult();
    }, ['${workspaceFolder}/tools/provider.jl'], {
      PATH: '${userHome}/.juliaup/bin${pathSeparator}${env:PATH}',
    });
    const resolver = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      () => {},
      services,
    );

    try {
      await resolver.resolve('/one/pkg');
    } finally {
      process.env.PATH = previousPath;
    }

    assert.strictEqual(command, 'provider');
    assert.deepStrictEqual(args, ['/one/tools/provider.jl']);
    assert.strictEqual(
      environment?.PATH,
      `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/.juliaup/bin${path.delimiter}/usr/bin`,
    );
  });

  test('reports nonzero and malformed provider results', async () => {
    const nonzero = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      () => {},
      createServices('package', async () => ({ exitCode: 2, stdout: '', stderr: 'dependency missing' })),
    );
    await assert.rejects(() => nonzero.resolve('/one/pkg'), ArgumentProviderError);

    const malformed = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      () => {},
      createServices('package', async () => ({ exitCode: 0, stdout: 'not json', stderr: '' })),
    );
    await assert.rejects(() => malformed.resolve('/one/pkg'), /must print valid JSON/);

    const missingExecutable = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      () => {},
      createServices('package', async () => { throw new Error('ENOENT'); }),
    );
    await assert.rejects(() => missingExecutable.resolve('/one/pkg'), /Unable to start argument provider: ENOENT/);
  });

  test('invalidates a cancelled provider operation', async () => {
    const cancellation = new vscode.CancellationTokenSource();
    let calls = 0;
    const services = createServices('package', async (_command, _args, token) => {
      calls += 1;
      return new Promise<ProcessResult>((resolve) => {
        token.onCancellationRequested(() => resolve({ exitCode: -1, stdout: '', stderr: '' }));
      });
    });
    const resolver = new TestArgumentResolver(cancellation.token, () => {}, services);
    const operation = resolver.resolve('/one/pkg');
    cancellation.cancel();

    await assert.rejects(() => operation, /cancelled/);
    await assert.rejects(() => resolver.resolve('/one/pkg'), /cancelled/);
    assert.strictEqual(calls, 2);
  });

  test('rejects package substitution at workspace scope and reserved arguments', async () => {
    const resolver = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      () => {},
      createServices('workspace', async () => successResult(), ['${packagePath}']),
    );
    await assert.rejects(() => resolver.resolve('/one/pkg'), /cannot be used/);
    assert.throws(
      () => validateUserArguments(['-define:ODIN_TEST_JSON_REPORT=mine'], 'test'),
      /extension-owned argument/,
    );
    assert.throws(() => validateUserArguments(['source'], 'test'), /extension-owned argument/);
    assert.doesNotThrow(() => validateUserArguments(['-extra-linker-flags:-L/a path -llib'], 'test'));
  });

  test('does not cache provider output containing reserved arguments', async () => {
    let calls = 0;
    const resolver = new TestArgumentResolver(
      new vscode.CancellationTokenSource().token,
      () => {},
      createServices('workspace', async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout: '["-define:ODIN_TEST_NAMES=other"]',
          stderr: '',
        };
      }),
    );

    await assert.rejects(() => resolver.resolve('/one/pkg-a'), /extension-owned argument/);
    await assert.rejects(() => resolver.resolve('/one/pkg-b'), /extension-owned argument/);
    assert.strictEqual(calls, 2);
  });
});

function createServices(
  scope: 'package' | 'workspace',
  run: TestArgumentResolverServices['run'],
  args: readonly string[] = [],
  environment?: Readonly<Record<string, string>>,
): TestArgumentResolverServices {
  return {
    getSettings: () => ({
      testArguments: [],
      argumentProvider: { command: 'provider', args, environment, scope },
    }),
    getWorkspacePath: (packagePath) => packagePath.startsWith('/one/') ? '/one' : '/two',
    isWorkspaceTrusted: () => true,
    run,
  };
}

function successResult(): ProcessResult {
  return { exitCode: 0, stdout: '[]', stderr: '' };
}

