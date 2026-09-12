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
| `odinTestExplorer.testArguments` | `[]` | Additional Odin compiler arguments. |
| `odinTestExplorer.argumentProvider` | unset | Trusted-workspace command that generates additional arguments and environment variables. |
| `odinTestExplorer.testSuites` | `[]` | Source roots whose packages can be compiled in one Odin invocation. |
| `odinTestExplorer.exclude` | `**/{.git,node_modules,out,dist}/**` | Glob pattern excluded from test discovery. |

Example workspace configuration:

```json
{
  "odinTestExplorer.odinPath": "/opt/odin/odin",
  "odinTestExplorer.testArguments": ["-debug"]
}
```

Settings in `.vscode/settings.json` apply to that project. Every `odin test` process and
its resulting test executable run with that workspace folder as their working directory.
This makes runtime paths such as `assets/config.json` relative to the workspace root even
when the tested package is nested below it.

In a multi-root workspace, `testArguments`, `argumentProvider`, and `testSuites` are
resolved independently for the folder containing each package. Processes and cached
provider results are never shared across workspace folders.

### Dynamic Test Arguments

For toolchains that discover compiler or linker settings at runtime, configure an
argument provider:

```json
{
  "odinTestExplorer.argumentProvider": {
    "command": "./scripts/odin-test-arguments",
    "args": ["${packagePath}"],
    "cwd": "${workspaceFolder}",
    "scope": "package"
  }
}
```

Providers that require an interpreter should invoke it explicitly instead of relying
on the script's shebang. Environment overrides are merged over the extension host
environment, and `${pathSeparator}` uses the host platform's PATH delimiter:

```json
{
  "odinTestExplorer.argumentProvider": {
    "command": "julia",
    "args": ["${workspaceFolder}/tools/odin-test-arguments.jl"],
    "environment": {
      "PATH": "${userHome}/.juliaup/bin${pathSeparator}${env:PATH}"
    },
    "cwd": "${workspaceFolder}",
    "scope": "workspace"
  }
}
```

The provider runs once for each tested package and must print JSON to stdout. It may
return a string array:

```json
["-debug", "-extra-linker-flags:-L/opt/julia/lib -ljulia"]
```

It may instead return arguments together with environment variables inherited by the
Odin compiler and test process:

```json
{
  "arguments": ["-extra-linker-flags:-L/opt/julia/lib -ljulia"],
  "environment": {
    "LD_LIBRARY_PATH": "/opt/julia/lib"
  }
}
```

Provider scope is `package` by default: it runs once per tested package per VS Code test
run. With `"scope": "workspace"`, it runs once per workspace folder per test run and its
result is reused for every package in that folder. Workspace-scoped providers may not use
`${packagePath}` because no single package represents the invocation; use
`${workspaceFolder}` instead. Failed and cancelled provider operations are not cached.

Provider diagnostics belong on stderr because stdout is reserved for JSON. Stderr is
preserved in Test Results even when the provider succeeds. The provider's `cwd` controls
only the provider process and is independent of the workspace-root cwd used by Odin.
VS Code must trust the workspace before the extension runs a provider.

### Test Suites

Configure a suite when one Odin source root can compile several discovered packages:

```json
{
  "odinTestExplorer.testSuites": [
    {
      "name": "Application",
      "path": "src",
      "arguments": ["-all-packages"]
    }
  ]
}
```

Relative suite paths resolve from the containing workspace folder. Tests in that source
root are compiled once and selected with `ODIN_TEST_NAMES`; package, file, and individual
test selections use the same batching where possible. Packages outside configured suites
retain package-by-package execution. If suites overlap, the most specific path wins.

For a multi-root workspace, place the appropriate `testSuites` setting in each folder's
`.vscode/settings.json`. A suite never includes packages from another workspace folder.

### Managed Arguments And Diagnostics

The extension owns the test source path, `-out`, `ODIN_TEST_JSON_REPORT`, and
`ODIN_TEST_NAMES`. Do not provide these through `testArguments`, an argument provider, or
suite arguments; conflicting values are reported as configuration errors. Each configured
array entry is one process argument, so a value such as
`-extra-linker-flags:-L/path with spaces -ljulia` remains intact.

Test Results shows the resolved Odin command, workspace cwd, and names of overridden
environment variables without displaying their values. Odin diagnostics in
`file.odin(line:column) Error: message` form become source-located test messages.
Provider, configuration, compilation, test, and missing-report failures are identified
separately.

Cancellation terminates the active provider or Odin process tree where supported, marks
tests that did not finish as skipped, and removes per-run reports. Linux and macOS use a
process group; Windows uses `taskkill` for descendant termination.

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
