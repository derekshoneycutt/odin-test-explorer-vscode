import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

/** Captured result of a completed child process. */
export interface ProcessResult {
  /** Numeric process exit code, or -1 when no code was reported. */
  readonly exitCode: number;
  /** Complete standard-output text. */
  readonly stdout: string;
  /** Complete standard-error text. */
  readonly stderr: string;
}

/** Optional child-process execution settings. */
export interface ProcessOptions {
  /** Working directory used by the child process. */
  readonly cwd?: string;
  /** Environment variables merged over the extension host environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs a child process without shell interpolation.
 * @param command Executable path.
 * @param args Process arguments.
 * @param token Optional cancellation token.
 * @param onOutput Optional streaming output callback.
 * @param options Optional working directory and environment overrides.
 * @returns Captured process result.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  token?: vscode.CancellationToken,
  onOutput?: (text: string) => void,
  options?: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // Argument-array spawning prevents package paths and selectors from being
    // interpreted by a shell.
    const child = spawn(command, args, {
      cwd: options?.cwd,
      detached: process.platform !== 'win32',
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let forceKillTimer: NodeJS.Timeout | undefined;
    let terminationRequested = false;
    const terminate = (): void => {
      if (!terminationRequested) {
        terminationRequested = true;
        forceKillTimer = terminateProcessTree(child.pid);
      }
    };
    const cancellation = token?.onCancellationRequested(terminate);

    // Preserve complete output for diagnostics while forwarding chunks to the
    // live Test Results stream.
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text);
    });
    child.once('error', (error) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      cancellation?.dispose();
      reject(error);
    });
    child.once('close', (exitCode) => {
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      cancellation?.dispose();
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });

    if (token?.isCancellationRequested) {
      terminate();
    }
  });
}

/** Terminates a spawned process and its descendants where the platform permits. */
function terminateProcessTree(processId: number | undefined): NodeJS.Timeout | undefined {
  if (processId === undefined) {
    return undefined;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(processId), '/t', '/f'], { windowsHide: true });
    killer.unref();
    return undefined;
  }
  try {
    process.kill(-processId, 'SIGTERM');
  } catch {
    try {
      process.kill(processId, 'SIGTERM');
    } catch {
      // The process may have exited between cancellation and termination.
    }
  }
  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-processId, 'SIGKILL');
    } catch {
      // The process group exited after SIGTERM.
    }
  }, 1000);
  forceKillTimer.unref();
  return forceKillTimer;
}

/**
 * Normalizes process output for VS Code's terminal renderer.
 * @param text Raw process output.
 * @returns CRLF-normalized output.
 */
export function normalizeOutput(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}