import * as assert from 'assert';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiscoveredTest } from '../discovery';
import { HelperManager } from '../helperManager';
import {
  SelectedTest,
  TestInvocationPlan,
  TestRunnerServices,
  buildOdinArguments,
  collectRequestedTests,
  createInvocationPlans,
  findReportResult,
  parseOdinDiagnostics,
  parseReport,
  runTests,
} from '../runner';

suite('Test runner', () => {
  test('batches suite packages and keeps unconfigured packages separate', () => {
    const tests = [selected('a', '/one/src/a', 'alpha'), selected('b', '/one/src/b', 'beta')];
    const suitePlans = createInvocationPlans(tests, () => ({
      workspacePath: '/one',
      suites: [{ name: 'Application', path: 'src', arguments: ['-all-packages'] }],
    }));
    assert.strictEqual(suitePlans.length, 1);
    assert.strictEqual(suitePlans[0].sourcePath, path.resolve('/one/src'));
    assert.deepStrictEqual(suitePlans[0].suiteArguments, ['-all-packages']);
    assert.strictEqual(suitePlans[0].tests.length, 2);

    const packagePlans = createInvocationPlans(tests, () => ({ workspacePath: '/one', suites: [] }));
    assert.strictEqual(packagePlans.length, 2);
  });

  test('never batches suites across workspace folders', () => {
    const plans = createInvocationPlans(
      [selected('a', '/one/src/a', 'alpha'), selected('b', '/two/src/b', 'beta')],
      (packagePath) => ({
        workspacePath: packagePath.startsWith('/one/') ? '/one' : '/two',
        suites: [{ name: 'Application', path: 'src', arguments: ['-all-packages'] }],
      }),
    );
    assert.strictEqual(plans.length, 2);
    assert.deepStrictEqual(plans.map((plan) => plan.workspacePath), ['/one', '/two']);
  });

  test('deduplicates overlapping parent and child selections', () => {
    const leaf = fakeItem('leaf');
    const parent = fakeItem('parent', [leaf]);
    const controller = fakeController([parent]);
    const request = { include: [parent, leaf] } as unknown as vscode.TestRunRequest;
    const metadata = new Map([[leaf.id, discovered('/workspace/pkg', 'sample')]]);

    const selectedTests = collectRequestedTests(controller, request, metadata);

    assert.strictEqual(selectedTests.length, 1);
    assert.strictEqual(selectedTests[0].item.id, 'leaf');
  });

  test('builds owned filters while preserving spaced linker arguments', () => {
    const plan: TestInvocationPlan = {
      name: 'Application',
      sourcePath: '/workspace/src',
      workspacePath: '/workspace',
      suiteArguments: ['-all-packages'],
      tests: [selected('a', '/workspace/src/a', 'alpha')],
    };
    const args = buildOdinArguments(plan, '/tmp/report.json', {
      arguments: ['-extra-linker-flags:-L/a path/lib -ljulia'],
      environment: {},
      workspacePath: '/workspace',
    });

    assert.ok(args.includes('-define:ODIN_TEST_NAMES=pkg.alpha'));
    assert.ok(args.includes('-define:ODIN_TEST_JSON_REPORT=/tmp/report.json'));
    assert.strictEqual(args.filter((argument) => argument.includes('-extra-linker-flags')).length, 1);
    assert.ok(args.includes('-extra-linker-flags:-L/a path/lib -ljulia'));
  });

  test('maps suite reports and identifies missing entries', () => {
    const report = parseReport(JSON.stringify({
      packages: { pkg: [{ name: 'alpha', success: true }] },
    }));
    assert.strictEqual(findReportResult(report, discovered('/workspace/a', 'alpha')), true);
    assert.strictEqual(findReportResult(report, discovered('/workspace/b', 'missing')), undefined);
  });

  test('parses relative and absolute Odin diagnostic locations', () => {
    const diagnostics = parseOdinDiagnostics(
      'src/main.odin(12:7) Error: Unknown identifier\n/other/lib.odin(3:2) Warning: Deprecated',
      '/workspace',
    );
    assert.deepStrictEqual(diagnostics[0], {
      filePath: path.resolve('/workspace/src/main.odin'),
      line: 12,
      column: 7,
      severity: 'Error',
      message: 'Unknown identifier',
    });
    assert.strictEqual(diagnostics[1].filePath, path.normalize('/other/lib.odin'));
  });

  test('runs fake Odin from workspace root with provider environment and cleans reports', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'odin-runner-test-'));
    const leaf = fakeItem('leaf');
    const controller = fakeController([leaf]);
    const recorder = controller.createTestRun({} as vscode.TestRunRequest) as unknown as RunRecorder;
    let cwd = '';
    let environment: Readonly<Record<string, string>> = {};
    let commandArguments: readonly string[] = [];
    const services = fakeServices(async (_command, args, _token, _onOutput, options) => {
      cwd = options.cwd;
      environment = options.env;
      commandArguments = args;
      const reportArgument = args.find((argument) => argument.startsWith('-define:ODIN_TEST_JSON_REPORT='));
      assert.ok(reportArgument);
      await fs.writeFile(reportArgument.slice(reportArgument.indexOf('=') + 1), JSON.stringify({
        packages: { pkg: [{ name: 'sample', success: true }] },
      }));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    try {
      await runTests(
        controller,
        { include: [leaf] } as unknown as vscode.TestRunRequest,
        new vscode.CancellationTokenSource().token,
        new Map([[leaf.id, discovered('/workspace/src/pkg', 'sample')]]),
        fakeHelper(),
        vscode.Uri.file(storagePath),
        services,
      );

      assert.strictEqual(cwd, '/workspace');
      assert.deepStrictEqual(environment, { TEST_ASSET_ROOT: '/workspace/assets' });
      assert.ok(commandArguments.includes('-extra-linker-flags:-L/a path -llib'));
      assert.deepStrictEqual(recorder.passedIds, ['leaf']);
      assert.deepStrictEqual(await fs.readdir(storagePath), []);
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  test('invokes a configured suite once and errors omitted report entries', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'odin-suite-test-'));
    const alpha = fakeItem('alpha');
    const beta = fakeItem('beta');
    const controller = fakeController([alpha, beta]);
    const recorder = controller.createTestRun({} as vscode.TestRunRequest) as unknown as RunRecorder;
    let invocations = 0;
    const services = fakeServices(async (_command, args) => {
      invocations += 1;
      const reportArgument = args.find((argument) => argument.startsWith('-define:ODIN_TEST_JSON_REPORT='));
      assert.ok(reportArgument);
      await fs.writeFile(reportArgument.slice(reportArgument.indexOf('=') + 1), JSON.stringify({
        packages: { pkg: [{ name: 'alpha', success: true }] },
      }));
      return { exitCode: 1, stdout: '', stderr: 'beta did not report' };
    });
    const suiteServices: TestRunnerServices = {
      ...services,
      getInvocationPlanContext: () => ({
        workspacePath: '/workspace',
        suites: [{ name: 'Application', path: 'src', arguments: ['-all-packages'] }],
      }),
    };
    try {
      await runTests(
        controller,
        { include: [alpha, beta] } as unknown as vscode.TestRunRequest,
        new vscode.CancellationTokenSource().token,
        new Map([
          [alpha.id, discovered('/workspace/src/a', 'alpha')],
          [beta.id, discovered('/workspace/src/b', 'beta')],
        ]),
        fakeHelper(),
        vscode.Uri.file(storagePath),
        suiteServices,
      );

      assert.strictEqual(invocations, 1);
      assert.deepStrictEqual(recorder.passedIds, ['alpha']);
      assert.strictEqual(recorder.erroredMessages[0].message, 'Missing test report entry: pkg.beta');
      assert.deepStrictEqual(await fs.readdir(storagePath), []);
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  test('creates located compilation errors and skips cancelled tests', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'odin-runner-errors-'));
    try {
      const compileLeaf = fakeItem('compile');
      const compileController = fakeController([compileLeaf]);
      const compileRecorder = compileController.createTestRun({} as vscode.TestRunRequest) as unknown as RunRecorder;
      await runTests(
        compileController,
        { include: [compileLeaf] } as unknown as vscode.TestRunRequest,
        new vscode.CancellationTokenSource().token,
        new Map([[compileLeaf.id, discovered('/workspace/src/pkg', 'sample')]]),
        fakeHelper(),
        vscode.Uri.file(storagePath),
        fakeServices(async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'src/pkg/main.odin(4:9) Error: Undeclared name',
        })),
      );
      assert.strictEqual(compileRecorder.erroredMessages.length, 1);
      assert.strictEqual(compileRecorder.erroredMessages[0].location?.uri.fsPath, '/workspace/src/pkg/main.odin');
  assert.strictEqual(compileRecorder.erroredMessages[0].location?.range.start.line, 3);

      const cancelledLeaf = fakeItem('cancelled');
      const cancelledController = fakeController([cancelledLeaf]);
      const cancelledRecorder = cancelledController.createTestRun({} as vscode.TestRunRequest) as unknown as RunRecorder;
      const cancellation = new vscode.CancellationTokenSource();
      await runTests(
        cancelledController,
        { include: [cancelledLeaf] } as unknown as vscode.TestRunRequest,
        cancellation.token,
        new Map([[cancelledLeaf.id, discovered('/workspace/src/pkg', 'sample')]]),
        fakeHelper(),
        vscode.Uri.file(storagePath),
        fakeServices(async () => {
          cancellation.cancel();
          return { exitCode: -1, stdout: '', stderr: '' };
        }),
      );
      assert.deepStrictEqual(cancelledRecorder.skippedIds, ['cancelled']);
      assert.deepStrictEqual(await fs.readdir(storagePath), []);
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });
});

interface RunRecorder extends vscode.TestRun {
  readonly passedIds: string[];
  readonly skippedIds: string[];
  readonly erroredMessages: vscode.TestMessage[];
}

function selected(id: string, packagePath: string, name: string): SelectedTest {
  return { item: fakeItem(id), test: discovered(packagePath, name) };
}

function discovered(packagePath: string, name: string): DiscoveredTest {
  return {
    package_name: 'pkg',
    package_path: packagePath,
    name,
    file_path: path.join(packagePath, `${name}.odin`),
    start: { line: 1, column: 1 },
    end: { line: 1, column: name.length + 1 },
  };
}

function fakeItem(id: string, children: vscode.TestItem[] = []): vscode.TestItem {
  return {
    id,
    children: { forEach: (callback: (item: vscode.TestItem) => unknown) => children.forEach(callback) },
  } as unknown as vscode.TestItem;
}

function fakeController(items: vscode.TestItem[]): vscode.TestController {
  const recorder = {
    passedIds: [] as string[],
    skippedIds: [] as string[],
    erroredMessages: [] as vscode.TestMessage[],
    enqueued: () => {},
    started: () => {},
    passed(item: vscode.TestItem) { this.passedIds.push(item.id); },
    failed: () => {},
    errored(_item: vscode.TestItem, message: vscode.TestMessage) { this.erroredMessages.push(message); },
    skipped(item: vscode.TestItem) { this.skippedIds.push(item.id); },
    appendOutput: () => {},
    end: () => {},
  };
  return {
    items: { forEach: (callback: (item: vscode.TestItem) => unknown) => items.forEach(callback) },
    createTestRun: () => recorder,
  } as unknown as vscode.TestController;
}

function fakeHelper(): HelperManager {
  return { getOdinPath: () => 'fake-odin' } as unknown as HelperManager;
}

function fakeServices(run: TestRunnerServices['run']): TestRunnerServices {
  return {
    createArgumentResolver: () => ({
      resolve: async () => ({
        arguments: ['-extra-linker-flags:-L/a path -llib'],
        environment: { TEST_ASSET_ROOT: '/workspace/assets' },
        workspacePath: '/workspace',
      }),
    }),
    getInvocationPlanContext: () => ({ workspacePath: '/workspace', suites: [] }),
    run,
  };
}
