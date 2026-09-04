import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiscoveryResponse, parseDiscoveryResponse } from './discovery';
import { runProcess } from './process';

/** Builds, caches, and invokes the bundled Odin discovery helper. */
export class HelperManager {
  /** Shared build operation used to serialize concurrent discovery requests. */
  private buildPromise: Promise<string> | undefined;

  /**
   * Creates a helper manager for the active extension installation.
   * @param context Extension paths and persistent storage.
   * @param output Diagnostic output channel.
   */
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  /**
   * Discovers tests in one Odin package.
   * @param packagePath Absolute package directory.
   * @returns Discovered tests and protocol metadata.
   */
  public async discover(packagePath: string): Promise<DiscoveryResponse> {
    const executable = await this.ensureBuilt();
    const result = await runProcess(executable, [packagePath]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Discovery helper exited with code ${result.exitCode}`);
    }
    return parseDiscoveryResponse(result.stdout);
  }

  /**
   * Returns the configured Odin executable.
   * @returns Compiler command or path.
   */
  public getOdinPath(): string {
    return vscode.workspace.getConfiguration('odinTestExplorer').get<string>('odinPath', 'odin');
  }

  /**
   * Builds the helper once for concurrent callers.
   * @returns Cached helper executable path.
   */
  private ensureBuilt(): Promise<string> {
    this.buildPromise ??= this.build();
    return this.buildPromise.catch((error: unknown) => {
      this.buildPromise = undefined;
      throw error;
    });
  }

  /**
   * Builds or reuses the helper for the current source and Odin version.
   * @returns Helper executable path.
   */
  private async build(): Promise<string> {
    const sourceDirectory = vscode.Uri.joinPath(this.context.extensionUri, 'helper').fsPath;
    const storageDirectory = this.context.globalStorageUri.fsPath;
    const executable = path.join(storageDirectory, process.platform === 'win32' ? 'odin-test-discovery.exe' : 'odin-test-discovery');
    const marker = `${executable}.key`;
    await fs.mkdir(storageDirectory, { recursive: true });

    const versionResult = await runProcess(this.getOdinPath(), ['version']);
    if (versionResult.exitCode !== 0) {
      throw new Error(versionResult.stderr.trim() || 'Unable to run the configured Odin compiler');
    }

    const sourceNames = (await fs.readdir(sourceDirectory)).filter((name) => name.endsWith('.odin')).sort();
    // The cache key binds the executable to both helper source and parser ABI.
    const hash = createHash('sha256').update(versionResult.stdout);
    for (const sourceName of sourceNames) {
      hash.update(sourceName);
      hash.update(await fs.readFile(path.join(sourceDirectory, sourceName)));
    }
    const cacheKey = hash.digest('hex');

    const cachedKey = await fs.readFile(marker, 'utf8').catch(() => '');
    const executableExists = await fs.access(executable).then(() => true, () => false);
    if (cachedKey === cacheKey && executableExists) {
      return executable;
    }

    this.output.appendLine('Building Odin test discovery helper...');
    const buildResult = await runProcess(this.getOdinPath(), ['build', sourceDirectory, `-out:${executable}`]);
    if (buildResult.exitCode !== 0) {
      this.output.appendLine(buildResult.stderr);
      throw new Error('Failed to build the Odin test discovery helper. Check odinTestExplorer.odinPath.');
    }
    await fs.writeFile(marker, cacheKey);
    return executable;
  }
}