# Odin Test Explorer

Odin Test Explorer is a VS Code extension that discovers Odin unit tests and integrates them with VS Code's native Testing view.

It really is that simple. This is not trying to be anything more fancy.

## Features

- Discovers `@test` and `@(test)` procedures using Odin's parser and AST packages.
- Organizes discovered tests by package and source file.
- Runs individual tests, files, packages, or every discovered test.
- Reports queued, running, passed, failed, and errored states.
- Streams compiler and test output into VS Code's Test Results output.
- Refreshes test discovery when saved `.odin` files change.

## Requirements

- VS Code 1.136.0 or newer.
- A recent Odin compiler with `core:odin/parser` available.
- The `odin` executable on `PATH`, unless an explicit path is configured.

The extension compiles its bundled Odin discovery helper with your configured compiler. The resulting executable is cached in VS Code's extension storage and rebuilt when the helper source or Odin version changes.

## Install From A VSIX

### Build The VSIX

From the repository root:

```bash
npm install
npm run package:vsix
```

This validates and bundles the extension, then creates `odin-test-explorer.vsix` in the repository root.

### Install With The VS Code CLI

```bash
code --install-extension ./odin-test-explorer.vsix --force
```

Reload VS Code after installation. To remove the extension later:

```bash
code --uninstall-extension derekshoneycutt.odin-test-explorer
```

### Install From The VS Code UI

1. Open the Extensions view with `Ctrl+Shift+X`.
2. Open the Extensions view's `...` menu.
3. Select **Install from VSIX...**.
4. Choose `odin-test-explorer.vsix`.
5. Reload VS Code when prompted.

## Use The Extension

1. Open a folder or workspace containing one or more Odin packages.
2. Save any modified `.odin` files. Discovery operates on files on disk.
3. Open the Testing view from the Activity Bar, or run **View: Show Testing** from the Command Palette.
4. Run a test, source file, package, or all tests using VS Code's standard test controls.

Selecting a test navigates to its declaration. Odin remains authoritative for build constraints, test signature validation, compilation, and execution.

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `odinTestExplorer.odinPath` | `odin` | Compiler command or absolute path to the Odin executable. |
| `odinTestExplorer.testArguments` | `[]` | Additional arguments passed to `odin test` before `--`. |
| `odinTestExplorer.exclude` | `**/{.git,node_modules,out,dist}/**` | Glob pattern excluded from test discovery. |

Example workspace configuration:

```json
{
  "odinTestExplorer.odinPath": "/opt/odin/odin",
  "odinTestExplorer.testArguments": ["-debug"]
}
```

## Development

Install dependencies and validate both parts of the extension:

```bash
npm install
npm test
npm run test:helper
```

Press `F5` in VS Code to compile the extension and open an Extension Development Host. Open its Testing view to exercise discovery and execution against the `helper` package in this repository.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run compile` | Type-check, lint, and create a development bundle. |
| `npm run watch` | Rebuild TypeScript and the extension bundle while files change. |
| `npm test` | Run the extension-host test suite. |
| `npm run test:helper` | Run the Odin helper's self-discovery tests. |
| `npm run package` | Create the production JavaScript bundle in `dist`. |
| `npm run package:vsix` | Validate, bundle, and create the installable VSIX. |

## Troubleshooting

### No Tests Appear

- Save the relevant `.odin` files.
- Confirm the package contains procedures marked with `@test` or `@(test)`.
- Verify the package is not matched by `odinTestExplorer.exclude`.
- Open **Output: Odin Test Explorer** and check for discovery-helper errors.

### The Discovery Helper Does Not Build

Run the configured compiler from a terminal:

```bash
odin version
```

If that command is unavailable, update `odinTestExplorer.odinPath` to the Odin executable's absolute path and reload VS Code.

### Test Failures Have Limited Detail

Odin's JSON test report currently provides per-test status but not individual failure messages or durations. The extension therefore displays captured compiler and test-process output alongside the reported status.

## Current Scope

- Discovery and execution use saved files only.
- Debugging, coverage, and continuous test runs are not currently supported.
- Test discovery is syntactic; invalid test signatures are surfaced when Odin compiles the package.
