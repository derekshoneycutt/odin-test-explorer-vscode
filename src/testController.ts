import * as path from 'node:path';
import * as vscode from 'vscode';
import { createTestId, DiscoveredTest, findPackageDirectories } from './discovery';
import { HelperManager } from './helperManager';
import { runTests } from './runner';

/** Owns Odin test discovery, the VS Code test tree, and the run profile. */
export class OdinTestController implements vscode.Disposable {
  /** Native VS Code controller published to the Testing view. */
  private readonly controller = vscode.tests.createTestController('odinTestExplorer', 'Odin Tests');
  /** Discovery records keyed by leaf TestItem ID for execution. */
  private readonly metadata = new Map<string, DiscoveredTest>();
  /** Debounce timer for saved-file events. */
  private refreshTimer: NodeJS.Timeout | undefined;
  /** In-flight refresh shared by concurrent resolve requests. */
  private refreshPromise: Promise<void> | undefined;

  /**
   * Creates and registers the Odin test controller.
   * @param context Extension lifecycle and storage context.
   * @param helper Discovery helper manager.
   * @param output Diagnostic output channel.
   */
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly helper: HelperManager,
    private readonly output: vscode.OutputChannel,
  ) {
    this.controller.resolveHandler = async () => this.refresh();
    this.controller.createRunProfile(
      'Run Odin Tests',
      vscode.TestRunProfileKind.Run,
      async (request, token) => runTests(
        this.controller,
        request,
        token,
        this.metadata,
        this.helper,
        this.context.globalStorageUri,
      ),
      true,
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.odin');
    watcher.onDidCreate(() => this.scheduleRefresh());
    watcher.onDidChange(() => this.scheduleRefresh());
    watcher.onDidDelete(() => this.scheduleRefresh());
    context.subscriptions.push(watcher);
  }

  /**
   * Disposes the test controller and pending refresh timer.
   * @returns Nothing.
   */
  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.controller.dispose();
  }

  /**
   * Schedules discovery after saved-file activity settles.
   * @returns Nothing.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  /**
   * Refreshes all package tests without overlapping discovery passes.
   * @returns A promise completed after discovery.
   */
  private async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /**
   * Discovers all packages and replaces the published hierarchy.
   * @returns A promise completed after publication.
   */
  private async performRefresh(): Promise<void> {
    const packageDirectories = await findPackageDirectories();
    const roots: vscode.TestItem[] = [];
    const nextMetadata = new Map<string, DiscoveredTest>();

    // Build the replacement tree separately so partial discovery is never
    // exposed while package helpers are still running.
    for (const packageDirectory of packageDirectories) {
      try {
        const response = await this.helper.discover(packageDirectory);
        if (response.tests.length > 0) {
          roots.push(this.createPackageItem(packageDirectory, response.tests, nextMetadata));
        }
      } catch (error) {
        this.output.appendLine(`Discovery failed for ${packageDirectory}: ${String(error)}`);
      }
    }

    this.metadata.clear();
    nextMetadata.forEach((value, key) => this.metadata.set(key, value));
    this.controller.items.replace(roots);
  }

  /**
   * Creates one package subtree.
   * @param packageDirectory Absolute package path.
   * @param tests Tests in the package.
   * @param metadata Destination metadata map.
   * @returns Package TestItem.
   */
  private createPackageItem(
    packageDirectory: string,
    tests: readonly DiscoveredTest[],
    metadata: Map<string, DiscoveredTest>,
  ): vscode.TestItem {
    const packageItem = this.controller.createTestItem(
      createTestId('package', packageDirectory),
      path.basename(packageDirectory),
      vscode.Uri.file(packageDirectory),
    );
    const files = new Map<string, DiscoveredTest[]>();
    for (const test of tests) {
      const fileTests = files.get(test.file_path) ?? [];
      fileTests.push(test);
      files.set(test.file_path, fileTests);
    }

    for (const [filePath, fileTests] of files) {
      const fileItem = this.controller.createTestItem(
        createTestId('file', filePath),
        path.basename(filePath),
        vscode.Uri.file(filePath),
      );
      for (const test of fileTests) {
        const testItem = this.controller.createTestItem(
          createTestId('test', test.package_path, test.name),
          test.name,
          vscode.Uri.file(test.file_path),
        );
        testItem.range = new vscode.Range(
          test.start.line - 1,
          test.start.column - 1,
          test.end.line - 1,
          test.end.column - 1,
        );
        metadata.set(testItem.id, test);
        fileItem.children.add(testItem);
      }
      packageItem.children.add(fileItem);
    }
    return packageItem;
  }
}