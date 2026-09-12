import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ArgumentProviderError,
  TestArgumentResolver,
  TestConfigurationError,
  TestInvocationOptions,
  resolveWorkspacePath,
  validateUserArguments,
} from './arguments';
import { DiscoveredTest } from './discovery';
import { HelperManager } from './helperManager';
import { normalizeOutput, ProcessResult, runProcess } from './process';

/** A selected VS Code test and its Odin discovery metadata. */
export interface SelectedTest {
  readonly item: vscode.TestItem;
  readonly test: DiscoveredTest;
}

/** User-defined source root that can compile multiple Odin packages together. */
export interface TestSuiteConfiguration {
  readonly name: string;
  readonly path: string;
  readonly arguments?: readonly string[];
}

/** One Odin process planned for a group of selected tests. */
export interface TestInvocationPlan {
  readonly name: string;
  readonly sourcePath: string;
  readonly workspacePath: string;
  readonly suiteArguments: readonly string[];
  readonly tests: readonly SelectedTest[];
}

/** Workspace-specific inputs used while grouping test invocations. */
export interface InvocationPlanContext {
  readonly workspacePath: string;
  readonly suites: readonly TestSuiteConfiguration[];
}

/** Argument resolver behavior consumed by the runner. */
export interface InvocationOptionResolver {
  readonly resolve: (packagePath: string) => Promise<TestInvocationOptions>;
}

/** Injectable process boundaries used by deterministic runner tests. */
export interface TestRunnerServices {
  readonly createArgumentResolver: (
    token: vscode.CancellationToken,
    onProviderStderr: (text: string) => void,
  ) => InvocationOptionResolver;
  readonly run: (
    command: string,
    args: readonly string[],
    token: vscode.CancellationToken,
    onOutput: (text: string) => void,
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => Promise<ProcessResult>;
  readonly getInvocationPlanContext?: (packagePath: string) => InvocationPlanContext;
}

/** Per-test status entry in Odin's JSON test report. */
export interface ReportTest {
  readonly name: string;
  readonly success: boolean;
}

/** Parsed compiler diagnostic with a source location. */
export interface OdinDiagnostic {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly severity: string;
  readonly message: string;
}

/** Runs selected Odin tests and publishes their results. */
export async function runTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  metadata: ReadonlyMap<string, DiscoveredTest>,
  helper: HelperManager,
  storageUri: vscode.Uri,
  services: TestRunnerServices = defaultRunnerServices,
): Promise<void> {
  const run = controller.createTestRun(request);
  const selected = collectRequestedTests(controller, request, metadata);
  const completed = new Set<string>();
  selected.forEach(({ item }) => run.enqueued(item));
  let runDirectory: string | undefined;

  try {
    await fs.mkdir(storageUri.fsPath, { recursive: true });
    runDirectory = await fs.mkdtemp(path.join(storageUri.fsPath, 'run-'));
    const resolver = services.createArgumentResolver(token, (text) => {
      run.appendOutput(normalizeOutput(`[argument provider]\n${text}`));
    });
    const plans = createInvocationPlans(selected, services.getInvocationPlanContext ?? getInvocationPlanContext);

    for (const plan of plans) {
      if (token.isCancellationRequested) {
        break;
      }
      plan.tests.forEach(({ item }) => run.started(item));
      try {
        await executeInvocation(run, token, plan, resolver, helper, runDirectory, completed, services);
      } catch (error) {
        if (token.isCancellationRequested) {
          markSkipped(run, plan.tests, completed);
        } else {
          markErrored(run, plan.tests, completed, formatExecutionError(error));
        }
      }
    }
  } catch (error) {
    if (!token.isCancellationRequested) {
      markErrored(run, selected, completed, formatExecutionError(error));
    }
  } finally {
    if (token.isCancellationRequested) {
      markSkipped(run, selected, completed);
    }
    if (runDirectory) {
      await fs.rm(runDirectory, { recursive: true, force: true });
    }
    run.end();
  }
}

/** Collects requested leaf tests once, even when parent and child selections overlap. */
export function collectRequestedTests(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  metadata: ReadonlyMap<string, DiscoveredTest>,
): SelectedTest[] {
  const selected = new Map<string, SelectedTest>();
  const excluded = new Set(request.exclude?.map((item) => item.id));

  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item.id)) {
      return;
    }
    const test = metadata.get(item.id);
    if (test) {
      selected.set(item.id, { item, test });
      return;
    }
    item.children.forEach(visit);
  };

  (request.include ?? collectionToArray(controller.items)).forEach(visit);
  return [...selected.values()];
}

/** Groups tests into configured suites, retaining package groups elsewhere. */
export function createInvocationPlans(
  tests: readonly SelectedTest[],
  getContext: (packagePath: string) => InvocationPlanContext = getInvocationPlanContext,
): TestInvocationPlan[] {
  const plans = new Map<string, TestInvocationPlan>();
  for (const selectedTest of tests) {
    const packagePath = selectedTest.test.package_path;
    const { workspacePath, suites } = getContext(packagePath);
    const suite = findContainingSuite(packagePath, workspacePath, suites);
    const sourcePath = suite ? resolveSuitePath(suite, workspacePath) : packagePath;
    const key = suite ? `suite:${workspacePath}:${sourcePath}` : `package:${packagePath}`;
    const existing = plans.get(key);
    if (existing) {
      if (!existing.tests.some(({ item }) => item.id === selectedTest.item.id)) {
        (existing.tests as SelectedTest[]).push(selectedTest);
      }
      continue;
    }
    const suiteArguments = suite?.arguments ?? [];
    validateUserArguments(suiteArguments, `odinTestExplorer.testSuites (${suite?.name ?? packagePath})`);
    plans.set(key, {
      name: suite?.name ?? path.basename(packagePath),
      sourcePath,
      workspacePath,
      suiteArguments,
      tests: [selectedTest],
    });
  }
  return [...plans.values()];
}

/** Builds the exact Odin argument array for one planned invocation. */
export function buildOdinArguments(
  plan: TestInvocationPlan,
  reportPath: string,
  options: TestInvocationOptions,
): string[] {
  const selectors = plan.tests.map(({ test }) => `${test.package_name}.${test.name}`).join(',');
  return [
    'test',
    plan.sourcePath,
    `-define:ODIN_TEST_JSON_REPORT=${reportPath}`,
    `-define:ODIN_TEST_NAMES=${selectors}`,
    '-define:ODIN_TEST_FANCY=false',
    ...options.arguments,
    ...plan.suiteArguments,
  ];
}

/** Executes one package or suite process and maps its report to test items. */
async function executeInvocation(
  run: vscode.TestRun,
  token: vscode.CancellationToken,
  plan: TestInvocationPlan,
  resolver: InvocationOptionResolver,
  helper: HelperManager,
  runDirectory: string,
  completed: Set<string>,
  services: TestRunnerServices,
): Promise<void> {
  const options = await resolvePlanOptions(plan, resolver);
  if (token.isCancellationRequested) {
    markSkipped(run, plan.tests, completed);
    return;
  }

  const reportPath = path.join(runDirectory, `${randomUUID()}.json`);
  const args = buildOdinArguments(plan, reportPath, options);
  appendInvocationDetails(run, helper.getOdinPath(), args, plan.workspacePath, options.environment);
  let result: ProcessResult;
  try {
    result = await services.run(
      helper.getOdinPath(),
      args,
      token,
      (text) => run.appendOutput(normalizeOutput(text)),
      { cwd: plan.workspacePath, env: options.environment },
    );
    if (token.isCancellationRequested) {
      markSkipped(run, plan.tests, completed);
      return;
    }
    await publishReport(run, plan.tests, reportPath, result, plan.workspacePath, completed);
  } finally {
    await fs.rm(reportPath, { force: true });
  }
}

/** Resolves and merges package-level options needed by one invocation plan. */
async function resolvePlanOptions(
  plan: TestInvocationPlan,
  resolver: InvocationOptionResolver,
): Promise<TestInvocationOptions> {
  const packagePaths = [...new Set(plan.tests.map(({ test }) => test.package_path))];
  const resolved = await Promise.all(packagePaths.map((packagePath) => resolver.resolve(packagePath)));
  const argumentsSet = new Set<string>();
  const environment: Record<string, string> = {};
  for (const options of resolved) {
    options.arguments.forEach((argument) => argumentsSet.add(argument));
    for (const [name, value] of Object.entries(options.environment)) {
      if (environment[name] !== undefined && environment[name] !== value) {
        throw new TestConfigurationError(`Suite packages provide conflicting values for environment variable ${name}`);
      }
      environment[name] = value;
    }
  }
  return { arguments: [...argumentsSet], environment, workspacePath: plan.workspacePath };
}

/** Maps a JSON report to selected tests, including explicit missing entries. */
async function publishReport(
  run: vscode.TestRun,
  tests: readonly SelectedTest[],
  reportPath: string,
  result: ProcessResult,
  cwd: string,
  completed: Set<string>,
): Promise<void> {
  let report: Map<string, ReportTest[]>;
  try {
    report = parseReport(await fs.readFile(reportPath, 'utf8'));
  } catch (error) {
    const diagnostics = parseOdinDiagnostics(`${result.stdout}\n${result.stderr}`, cwd);
    const detail = result.stderr.trim() || errorMessage(error) || `odin test exited with code ${result.exitCode}`;
    const message = createTestMessage(`Compilation failed: ${detail}`, diagnostics[0]);
    for (const { item } of tests) {
      run.errored(item, message);
      completed.add(item.id);
    }
    return;
  }

  for (const selected of tests) {
    const testResult = findReportResult(report, selected.test);
    if (testResult === true) {
      run.passed(selected.item);
    } else if (testResult === false) {
      const output = findTestOutput(`${result.stdout}\n${result.stderr}`, selected.test);
      const diagnostic = parseOdinDiagnostics(output, cwd)[0];
      run.failed(selected.item, createTestMessage(`Test failed: ${output.trim() || selected.test.name}`, diagnostic));
    } else {
      run.errored(selected.item, new vscode.TestMessage(
        `Missing test report entry: ${selected.test.package_name}.${selected.test.name}`,
      ));
    }
    completed.add(selected.item.id);
  }
}

/** Parses source-located diagnostics emitted by Odin. */
export function parseOdinDiagnostics(output: string, cwd: string): OdinDiagnostic[] {
  const diagnostics: OdinDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+):(\d+)\)\s+(Error|Warning|Syntax Error):\s*(.+)$/gmu;
  for (const match of output.matchAll(pattern)) {
    const filePath = path.isAbsolute(match[1]) ? match[1] : path.resolve(cwd, match[1]);
    diagnostics.push({
      filePath,
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4],
      message: match[5],
    });
  }
  return diagnostics;
}

/** Parses package results from an Odin JSON report. */
export function parseReport(text: string): Map<string, ReportTest[]> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !isRecord(value.packages)) {
    throw new Error('Invalid Odin JSON test report');
  }
  const result = new Map<string, ReportTest[]>();
  for (const [packageName, packageValue] of Object.entries(value.packages)) {
    if (!Array.isArray(packageValue) || !packageValue.every(isReportTest)) {
      throw new Error('Invalid Odin package test result list');
    }
    result.set(packageName, packageValue);
  }
  return result;
}

/** Returns one selected test's result, or undefined when omitted from the report. */
export function findReportResult(
  report: ReadonlyMap<string, readonly ReportTest[]>,
  test: DiscoveredTest,
): boolean | undefined {
  return report.get(test.package_name)?.find((entry) => entry.name === test.name)?.success;
}

/** Chooses the most specific configured suite containing a package. */
function findContainingSuite(
  packagePath: string,
  workspacePath: string,
  suites: readonly TestSuiteConfiguration[],
): TestSuiteConfiguration | undefined {
  return suites
    .filter((suite) => {
      if (!suite.name || !suite.path) {
        throw new TestConfigurationError('Each odinTestExplorer.testSuites entry requires name and path');
      }
      return isWithin(resolveSuitePath(suite, workspacePath), packagePath);
    })
    .sort((left, right) => resolveSuitePath(right, workspacePath).length - resolveSuitePath(left, workspacePath).length)[0];
}

/** Resolves a configured suite root against its owning workspace. */
function resolveSuitePath(suite: TestSuiteConfiguration, workspacePath: string): string {
  return path.isAbsolute(suite.path) ? path.normalize(suite.path) : path.resolve(workspacePath, suite.path);
}

/** Tests whether a path is equal to or nested beneath a parent path. */
function isWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Reads suite configuration for the workspace containing a package. */
function getInvocationPlanContext(packagePath: string): InvocationPlanContext {
  const configuration = vscode.workspace.getConfiguration('odinTestExplorer', vscode.Uri.file(packagePath));
  return {
    workspacePath: resolveWorkspacePath(packagePath),
    suites: configuration.get<TestSuiteConfiguration[]>('testSuites', []),
  };
}

/** Writes a reproducible command summary without exposing environment values. */
function appendInvocationDetails(
  run: vscode.TestRun,
  command: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): void {
  run.appendOutput(normalizeOutput(`[odin] cwd: ${cwd}\n`));
  run.appendOutput(normalizeOutput(`[odin] command: ${[command, ...args].map(formatArgument).join(' ')}\n`));
  const names = Object.keys(environment).sort();
  if (names.length > 0) {
    run.appendOutput(normalizeOutput(`[odin] environment overrides: ${names.join(', ')}\n`));
  }
}

/** Creates an optionally source-located VS Code test message. */
function createTestMessage(message: string, diagnostic?: OdinDiagnostic): vscode.TestMessage {
  const testMessage = new vscode.TestMessage(message);
  if (diagnostic) {
    testMessage.location = new vscode.Location(
      vscode.Uri.file(diagnostic.filePath),
      new vscode.Position(Math.max(0, diagnostic.line - 1), Math.max(0, diagnostic.column - 1)),
    );
  }
  return testMessage;
}

/** Extracts lines identifying one failed test, falling back to all output. */
function findTestOutput(output: string, test: DiscoveredTest): string {
  const qualifiedName = `${test.package_name}.${test.name}`;
  const matching = output.split(/\r?\n/).filter((line) => line.includes(qualifiedName) || line.includes(test.name));
  return matching.length > 0 ? matching.join('\n') : output;
}

/** Marks unresolved tests as skipped after cancellation. */
function markSkipped(run: vscode.TestRun, tests: readonly SelectedTest[], completed: Set<string>): void {
  for (const { item } of tests) {
    if (!completed.has(item.id)) {
      run.skipped(item);
      completed.add(item.id);
    }
  }
}

/** Marks unresolved tests as errored. */
function markErrored(
  run: vscode.TestRun,
  tests: readonly SelectedTest[],
  completed: Set<string>,
  message: string,
): void {
  for (const { item } of tests) {
    if (!completed.has(item.id)) {
      run.errored(item, new vscode.TestMessage(message));
      completed.add(item.id);
    }
  }
}

/** Formats one command argument for display only, never shell execution. */
function formatArgument(argument: string): string {
  return /\s/.test(argument) ? JSON.stringify(argument) : argument;
}

/** Converts an unknown error to display text. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Categorizes provider, configuration, and general execution failures. */
function formatExecutionError(error: unknown): string {
  const prefix = error instanceof ArgumentProviderError
    ? 'Argument provider failed'
    : error instanceof TestConfigurationError
      ? 'Invalid Odin test configuration'
      : 'Odin test execution failed';
  return `${prefix}: ${errorMessage(error)}`;
}

/** Checks an individual JSON report result. */
function isReportTest(value: unknown): value is ReportTest {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.success === 'boolean';
}

/** Checks whether a value is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Copies a VS Code test collection into an array. */
function collectionToArray(collection: vscode.TestItemCollection): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
}

/** Production runner boundaries. */
const defaultRunnerServices: TestRunnerServices = {
  createArgumentResolver: (token, onProviderStderr) => new TestArgumentResolver(token, onProviderStderr),
  run: (command, args, token, onOutput, options) => runProcess(command, args, token, onOutput, options),
};
