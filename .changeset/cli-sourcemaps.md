---
"@maple/cli": minor
---

New `maple sourcemaps inject <dir>` and `maple sourcemaps upload <dir>`. `inject` gives every built JS file that has a source map a debug id (derived from the file's content, so re-running changes nothing) and writes it into the map; `--dry-run` reports without writing. `upload` sends each map to the logged-in workspace, matched by debug id or by `--service`, `--release` (defaults to the current git commit) and the file path, with `--url-prefix` for the path the files are served under. Maps over 15 MiB are skipped with a warning.
