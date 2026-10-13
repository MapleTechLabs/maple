# @maple/cli

## 0.0.24

### Patch Changes

- e248fee: Add `maple changelog` to read what changed in a release (`--since <version>` for every release after one). After an upgrade, the first interactive run names the new version and points at it, and `maple update` prints the command to run.
- 9dfb924: Query output names its timezone: JSON timestamps are ISO-8601 UTC (`2026-10-13T16:09:29.577Z`) and table times end in `Z`. In local mode, `maple traces`, `maple slow-traces`, `maple trace` and `maple logs` include links into the local UI. `maple logs --attributes` returns every log attribute, e.g. `requestId`.
