import * as path from 'node:path';
import * as vscode from 'vscode';

/** A one-based source location emitted by Odin's parser. */
export interface SourcePosition {
  /** One-based source line. */
  readonly line: number;
  /** One-based source column. */
  readonly column: number;
}

/** A test procedure discovered in one Odin package. */
export interface DiscoveredTest {
  /** Declared Odin package name. */
  readonly package_name: string;
  /** Absolute directory containing the package. */
  readonly package_path: string;
  /** Unqualified procedure name. */
  readonly name: string;
  /** Absolute path to the declaring source file. */
  readonly file_path: string;
  /** Start of the procedure identifier. */
  readonly start: SourcePosition;
  /** End of the procedure identifier. */
  readonly end: SourcePosition;
}

/** Versioned response returned by the bundled discovery helper. */
export interface DiscoveryResponse {
  /** Protocol version understood by this extension. */
  readonly version: 1;
  /** Tests found in the requested package. */
  readonly tests: readonly DiscoveredTest[];
}

/**
 * Validates and parses a discovery-helper response.
 * @param text Helper stdout.
 * @returns The validated response.
 */
export function parseDiscoveryResponse(text: string): DiscoveryResponse {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tests)) {
    throw new Error('Unsupported Odin discovery response');
  }

  return { version: 1, tests: value.tests.map(parseDiscoveredTest) };
}

/**
 * Finds unique Odin package directories represented in the workspace.
 * @returns Absolute package directory paths.
 */
export async function findPackageDirectories(): Promise<string[]> {
  const configuration = vscode.workspace.getConfiguration('odinTestExplorer');
  const exclude = configuration.get<string>('exclude', '**/{.git,node_modules,out,dist}/**');
  const files = await vscode.workspace.findFiles('**/*.odin', exclude);
  return [...new Set(files.map((file) => path.dirname(file.fsPath)))].sort();
}

/**
 * Creates a stable identifier for a package, file, or test.
 * @param kind Item kind.
 * @param parts Identity components.
 * @returns Stable item identifier.
 */
export function createTestId(kind: 'package' | 'file' | 'test', ...parts: string[]): string {
  return `${kind}:${parts.map(encodeURIComponent).join(':')}`;
}

/**
 * Converts an unknown value to a discovered test.
 * @param value Candidate object.
 * @returns Validated discovered test.
 */
function parseDiscoveredTest(value: unknown): DiscoveredTest {
  if (!isRecord(value)
    || !isString(value.package_name)
    || !isString(value.package_path)
    || !isString(value.name)
    || !isString(value.file_path)
    || !isPosition(value.start)
    || !isPosition(value.end)) {
    throw new Error('Invalid test in Odin discovery response');
  }

  return value as unknown as DiscoveredTest;
}

/**
 * Checks whether a value is a source position.
 * @param value Candidate value.
 * @returns Whether the value is valid.
 */
function isPosition(value: unknown): value is SourcePosition {
  return isRecord(value)
    && Number.isInteger(value.line)
    && Number.isInteger(value.column)
    && Number(value.line) > 0
    && Number(value.column) > 0;
}

/**
 * Checks whether a value is a non-null object.
 * @param value Candidate value.
 * @returns Whether the value is a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Checks whether a value is a string.
 * @param value Candidate value.
 * @returns Whether the value is a string.
 */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}