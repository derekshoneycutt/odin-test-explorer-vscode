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

/**
 * Runs a child process without shell interpolation.
 * @param command Executable path.
 * @param args Process arguments.
 * @param token Optional cancellation token.
 * @param onOutput Optional streaming output callback.
 * @returns Captured process result.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  token?: vscode.CancellationToken,
  onOutput?: (text: string) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // Argument-array spawning prevents package paths and selectors from being
    // interpreted by a shell.
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const cancellation = token?.onCancellationRequested(() => child.kill());

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
      cancellation?.dispose();
      reject(error);
    });
    child.once('close', (exitCode) => {
      cancellation?.dispose();
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });

    if (token?.isCancellationRequested) {
      child.kill();
    }
  });
}

/**
 * Normalizes process output for VS Code's terminal renderer.
 * @param text Raw process output.
 * @returns CRLF-normalized output.
 */
export function normalizeOutput(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}