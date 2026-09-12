# Change Log

All notable changes to the "odin-test-explorer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- Run Odin tests from their containing workspace folder, including multi-root workspaces.
- Add package- and workspace-scoped dynamic argument providers with per-run caching.
- Allow providers to override their environment with portable variable expansion.
- Add configurable suite roots for batching multiple packages into one Odin invocation.
- Add reserved-argument validation, source-located diagnostics, command summaries, process-tree cancellation, and per-run report cleanup.