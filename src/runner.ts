import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiscoveredTest } from './discovery';
import { HelperManager } from './helperManager';
import { normalizeOutput, runProcess } from './process';

/** Per-test status entry in Odin's JSON test report. */
interface ReportTest {
  /** Unqualified Odin procedure name. */
  readonly name: string;
  /** Whether Odin reported the test as successful. */
  readonly success: boolean;
}

/**
 * Runs selected Odin tests and publishes their results.
 * @param controller Test controller that owns the items.
 * @param request Requested test selection.
 * @param token Cancellation token.
 * @param metadata Test metadata by item ID.
 * @param helper Odin helper/compiler manager.
 * @param storageUri Extension storage location.
 * @returns A promise completed after the test run ends.
 */
export async function runTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  metadata: ReadonlyMap<string, DiscoveredTest>,
  helper: HelperManager,
  storageUri: vscode.Uri,
): Promise<void> {
  const run = controller.createTestRun(request);
  try {
    const tests = collectRequestedTests(controller, request, metadata);
    tests.forEach(({ item }) => run.enqueued(item));

    // Odin executes selectors relative to a package, so each package receives
    // one compiler invocation and one JSON report.
    const groups = new Map<string, typeof tests>();
    for (const selectedTest of tests) {
      const group = groups.get(selectedTest.test.package_path) ?? [];
      group.push(selectedTest);
      groups.set(selectedTest.test.package_path, group);
    }
    for (const [packagePath, packageTests] of groups) {
      if (token.isCancellationRequested) {
        break;
      }
      packageTests.forEach(({ item }) => run.started(item));
      try {
        await runPackage(run, token, packagePath, packageTests, helper, storageUri);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        packageTests.forEach(({ item }) => run.errored(item, new vscode.TestMessage(message)));
      }
    }
  } finally {
    run.end();
  }
}

/**
 * Collects leaf tests selected by a request.
 * @param controller Owning test controller.
 * @param request Requested selection.
 * @param metadata Leaf metadata map.
 * @returns Selected test items and metadata.
 */
function collectRequestedTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  metadata: ReadonlyMap<string, DiscoveredTest>,
): Array<{ item: vscode.TestItem; test: DiscoveredTest }> {
  const selected: Array<{ item: vscode.TestItem; test: DiscoveredTest }> = [];
  const excluded = new Set(request.exclude?.map((item) => item.id));

  /**
   * Recursively visits a selected tree node and records discovered leaves.
   * @param item Package, file, or test item to visit.
   * @returns Nothing.
   */
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item.id)) {
      return;
    }
    const test = metadata.get(item.id);
    if (test) {
      selected.push({ item, test });
      return;
    }
    item.children.forEach(visit);
  };

  const roots = request.include ?? collectionToArray(controller.items);
  roots.forEach(visit);
  return selected;
}

/**
 * Runs one package and maps its JSON report to test items.
 * @param run Active VS Code run.
 * @param token Cancellation token.
 * @param packagePath Package directory.
 * @param tests Selected tests in the package.
 * @param helper Compiler manager.
 * @param storageUri Extension storage location.
 * @returns A promise completed after result publication.
 */
async function runPackage(
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  packagePath: string,
  tests: Array<{ item: vscode.TestItem; test: DiscoveredTest }>,
  helper: HelperManager,
  storageUri: vscode.Uri,
): Promise<void> {
  await fs.mkdir(storageUri.fsPath, { recursive: true });
  const reportName = `${createHash('sha256').update(packagePath).digest('hex')}.json`;
  const reportPath = path.join(storageUri.fsPath, reportName);
  // A stale report must never be mistaken for the current process result.
  await fs.rm(reportPath, { force: true });

  const configuration = vscode.workspace.getConfiguration('odinTestExplorer');
  const extraArguments = configuration.get<string[]>('testArguments', []);
  const selectors = tests.map(({ test }) => `${test.package_name}.${test.name}`).join(',');
  const args = [
    'test',
    packagePath,
    `-define:ODIN_TEST_JSON_REPORT=${reportPath}`,
    '-define:ODIN_TEST_FANCY=false',
    ...extraArguments,
    '--',
    `-tests:${selectors}`,
  ];
  const result = await runProcess(helper.getOdinPath(), args, token, (text) => {
    run.appendOutput(normalizeOutput(text));
  });

  if (token.isCancellationRequested) {
    tests.forEach(({ item }) => run.skipped(item));
    return;
  }

  try {
    const report = parseReport(await fs.readFile(reportPath, 'utf8'));
    const packageName = tests[0].test.package_name;
    const results = new Map((report.get(packageName) ?? []).map((test) => [test.name, test.success]));
    // Missing entries are errors rather than failures because Odin did not
    // confirm that the selected procedure ran.
    for (const { item, test } of tests) {
      const success = results.get(test.name);
      if (success === true) {
        run.passed(item);
      } else if (success === false) {
        run.failed(item, new vscode.TestMessage(result.stderr.trim() || 'Odin test failed'));
      } else {
        run.errored(item, new vscode.TestMessage('Odin did not include this test in its JSON report'));
      }
    }
  } catch (error) {
    const message = result.stderr.trim()
      || (error instanceof Error ? error.message : String(error))
      || `odin test exited with code ${result.exitCode}`;
    tests.forEach(({ item }) => run.errored(item, new vscode.TestMessage(message)));
  } finally {
    await fs.rm(reportPath, { force: true });
  }
}

/**
 * Parses package results from an Odin JSON report.
 * @param text Report JSON.
 * @returns Package results by package name.
 */
function parseReport(text: string): Map<string, ReportTest[]> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('packages' in value)) {
    throw new Error('Invalid Odin JSON test report');
  }
  const packages = value.packages;
  if (typeof packages !== 'object' || packages === null) {
    throw new Error('Invalid Odin package test results');
  }

  const result = new Map<string, ReportTest[]>();
  for (const [packageName, packageValue] of Object.entries(packages)) {
    if (!Array.isArray(packageValue)) {
      throw new Error('Invalid Odin package test result list');
    }
    result.set(packageName, packageValue.filter(isReportTest));
  }
  return result;
}

/**
 * Checks an individual JSON report result.
 * @param value Candidate result.
 * @returns Whether the result is valid.
 */
function isReportTest(value: unknown): value is ReportTest {
  return typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof value.name === 'string'
    && 'success' in value
    && typeof value.success === 'boolean';
}

/**
 * Copies a VS Code test collection into an array.
 * @param collection Test item collection.
 * @returns Collection items.
 */
function collectionToArray(collection: vscode.TestItemCollection): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
}