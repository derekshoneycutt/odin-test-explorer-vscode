import * as vscode from 'vscode';
import { HelperManager } from './helperManager';
import { OdinTestController } from './testController';

/**
 * Activates Odin Test Explorer.
 * @param context Extension lifecycle context.
 * @returns A promise that resolves after registration.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Odin Test Explorer');
  const helper = new HelperManager(context, output);
  const controller = new OdinTestController(context, helper, output);

  context.subscriptions.push(output, controller);
}

/**
 * Deactivates Odin Test Explorer.
 * @returns Nothing.
 */
export function deactivate(): void {}
