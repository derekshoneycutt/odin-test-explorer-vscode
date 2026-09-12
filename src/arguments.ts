import * as path from 'node:path';
import * as vscode from 'vscode';
import { ProcessOptions, ProcessResult, runProcess } from './process';

/** Arguments and environment used for one Odin test invocation. */
export interface TestInvocationOptions {
  /** Additional compiler arguments inserted after extension-owned arguments. */
  readonly arguments: readonly string[];
  /** Environment variables added to the Odin compiler and test process. */
  readonly environment: Readonly<Record<string, string>>;
  /** Workspace folder containing the package, or the package itself when unowned. */
  readonly workspacePath: string;
}

/** Configured command that computes arguments for one package or workspace. */
export interface ArgumentProviderConfiguration {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly scope?: 'package' | 'workspace';
}

/** Structured output accepted from an argument provider. */
export interface ArgumentProviderResult {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

/** Configuration values relevant to one package. */
export interface TestArgumentSettings {
  readonly testArguments: readonly string[];
  readonly argumentProvider?: ArgumentProviderConfiguration;
}

/** Injectable resolver boundaries used by deterministic tests. */
export interface TestArgumentResolverServices {
  readonly getSettings: (packagePath: string) => TestArgumentSettings;
  readonly getWorkspacePath: (packagePath: string) => string;
  readonly isWorkspaceTrusted: () => boolean;
  readonly run: (
    command: string,
    args: readonly string[],
    token: vscode.CancellationToken,
    options: ProcessOptions,
  ) => Promise<ProcessResult>;
}

/** A user configuration conflicts with extension-owned Odin arguments. */
export class TestConfigurationError extends Error {}

/** A configured argument provider could not produce usable options. */
export class ArgumentProviderError extends Error {
  public constructor(message: string, public readonly stderr = '') {
    super(message);
  }
}

/** Resolves and caches argument providers for exactly one VS Code test run. */
export class TestArgumentResolver {
  private readonly providerOperations = new Map<string, Promise<ArgumentProviderResult>>();

  /**
   * Creates a resolver scoped to one test run.
   * @param token Test-run cancellation token.
   * @param onProviderStderr Receives provider diagnostics, including successful runs.
   */
  public constructor(
    private readonly token: vscode.CancellationToken,
    private readonly onProviderStderr: (text: string) => void,
    private readonly services: TestArgumentResolverServices = defaultResolverServices,
  ) {}

  /** Resolves static and generated compiler options for one package. */
  public async resolve(packagePath: string): Promise<TestInvocationOptions> {
    const workspacePath = this.services.getWorkspacePath(packagePath);
    const settings = this.services.getSettings(packagePath);
    const staticArguments = settings.testArguments;
    validateUserArguments(staticArguments, 'odinTestExplorer.testArguments');
    const provider = settings.argumentProvider;

    if (!provider) {
      return { arguments: staticArguments, environment: {}, workspacePath };
    }
    validateProviderConfiguration(provider);
    if (!this.services.isWorkspaceTrusted()) {
      throw new ArgumentProviderError('Trust this workspace to run the configured Odin test argument provider');
    }

    const scope = provider.scope ?? 'package';
    const cacheKey = `${scope}:${scope === 'workspace' ? workspacePath : packagePath}`;
    let operation = this.providerOperations.get(cacheKey);
    if (!operation) {
      operation = this.runProvider(provider, packagePath, workspacePath);
      this.providerOperations.set(cacheKey, operation);
      void operation.catch(() => this.providerOperations.delete(cacheKey));
    }
    const generated = await operation;
    return {
      arguments: [...staticArguments, ...generated.arguments],
      environment: generated.environment,
      workspacePath,
    };
  }

  /** Runs and validates one provider operation. */
  private async runProvider(
    provider: ArgumentProviderConfiguration,
    packagePath: string,
    workspacePath: string,
  ): Promise<ArgumentProviderResult> {
    const variables = { packagePath, workspaceFolder: workspacePath };
    const cwdValue = expandVariables(provider.cwd ?? '${workspaceFolder}', variables);
    const cwd = path.isAbsolute(cwdValue) ? cwdValue : path.resolve(workspacePath, cwdValue);
    const command = expandVariables(provider.command, variables);
    const args = (provider.args ?? []).map((argument) => expandVariables(argument, variables));
    const environment = Object.fromEntries(Object.entries(provider.environment ?? {}).map(([name, value]) => [
      name,
      expandVariables(value, variables),
    ]));
    let result: ProcessResult;
    try {
      result = await this.services.run(command, args, this.token, { cwd, env: environment });
    } catch (error) {
      throw new ArgumentProviderError(
        `Unable to start argument provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.stderr.length > 0) {
      this.onProviderStderr(result.stderr);
    }
    if (this.token.isCancellationRequested) {
      throw new ArgumentProviderError('Argument provider was cancelled', result.stderr);
    }
    if (result.exitCode !== 0) {
      throw new ArgumentProviderError(
        result.stderr.trim() || `Argument provider exited with code ${result.exitCode}`,
        result.stderr,
      );
    }
    try {
      const generated = parseArgumentProviderResult(result.stdout);
      validateUserArguments(generated.arguments, 'odinTestExplorer.argumentProvider output');
      return generated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ArgumentProviderError(message, result.stderr);
    }
  }
}

/** Returns the owning workspace folder, falling back to the package directory. */
export function resolveWorkspacePath(packagePath: string): string {
  return selectWorkspacePath(packagePath, vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []);
}

/** Selects the most specific workspace folder containing a package. */
export function selectWorkspacePath(packagePath: string, workspacePaths: readonly string[]): string {
  const matches = workspacePaths.filter((workspacePath) => isWithin(workspacePath, packagePath));
  return matches.sort((left, right) => right.length - left.length)[0] ?? packagePath;
}

/** Rejects arguments whose values are controlled by the extension. */
export function validateUserArguments(argumentsToValidate: readonly string[], source: string): void {
  for (const argument of argumentsToValidate) {
    const normalized = argument.toLowerCase();
    const isReserved = !argument.startsWith('-')
      || normalized === '-out'
      || normalized.startsWith('-out:')
      || normalized.startsWith('-out=')
      || normalized.startsWith('-define:odin_test_json_report')
      || normalized.startsWith('-define:odin_test_names');
    if (isReserved) {
      throw new TestConfigurationError(`${source} contains extension-owned argument: ${argument}`);
    }
  }
}

/** Parses and validates JSON emitted by an argument provider. */
export function parseArgumentProviderResult(text: string): ArgumentProviderResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Argument provider must print valid JSON to stdout');
  }

  if (isStringArray(value)) {
    return { arguments: value, environment: {} };
  }
  if (!isRecord(value)
    || !isStringArray(value.arguments)
    || (value.environment !== undefined && !isStringRecord(value.environment))) {
    throw new Error('Argument provider output must be a string array or an object with arguments and environment');
  }

  return { arguments: value.arguments, environment: value.environment ?? {} };
}

/** Validates a provider before it can execute project code. */
function validateProviderConfiguration(provider: ArgumentProviderConfiguration): void {
  if (typeof provider.command !== 'string' || provider.command.length === 0) {
    throw new TestConfigurationError('odinTestExplorer.argumentProvider.command must be a non-empty string');
  }
  if (provider.scope !== undefined && provider.scope !== 'package' && provider.scope !== 'workspace') {
    throw new TestConfigurationError('odinTestExplorer.argumentProvider.scope must be package or workspace');
  }
  if (provider.scope === 'workspace') {
    const values = [
      provider.command,
      provider.cwd ?? '',
      ...(provider.args ?? []),
      ...Object.values(provider.environment ?? {}),
    ];
    if (values.some((value) => value.includes('${packagePath}'))) {
      throw new TestConfigurationError(
        '${packagePath} cannot be used by a workspace-scoped argument provider; use ${workspaceFolder}',
      );
    }
  }
}

/** Replaces supported variables in a configured value. */
function expandVariables(
  value: string,
  variables: Readonly<Record<'packagePath' | 'workspaceFolder', string>>,
): string {
  return value
    .replaceAll('${packagePath}', variables.packagePath)
    .replaceAll('${workspaceFolder}', variables.workspaceFolder)
    .replaceAll('${userHome}', process.env.HOME ?? process.env.USERPROFILE ?? '')
    .replaceAll('${pathSeparator}', path.delimiter)
    .replace(/\$\{env:([^}]+)\}/gu, (_match, name: string) => process.env[name] ?? '');
}

/** Checks whether a value is an array containing only strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Checks whether a value is a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Checks whether a value maps string keys to string values. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

/** Tests whether a path is equal to or nested beneath a parent path. */
function isWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Production services backed by VS Code configuration and child processes. */
const defaultResolverServices: TestArgumentResolverServices = {
  getSettings: (packagePath) => {
    const configuration = vscode.workspace.getConfiguration('odinTestExplorer', vscode.Uri.file(packagePath));
    return {
      testArguments: configuration.get<string[]>('testArguments', []),
      argumentProvider: configuration.get<ArgumentProviderConfiguration>('argumentProvider'),
    };
  },
  getWorkspacePath: resolveWorkspacePath,
  isWorkspaceTrusted: () => vscode.workspace.isTrusted,
  run: (command, args, token, options) => runProcess(command, args, token, undefined, options),
};
