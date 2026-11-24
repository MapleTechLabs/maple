---
"@maple/cli": minor
---

New `maple sourcemaps inject <dir>` and `maple sourcemaps upload <dir>`. `inject` gives every built JS file that has a source map a debug id (derived from the file and its map, so re-running changes nothing), registers it on the file's first line so errors thrown while the file loads still carry it, and writes it into the map; `--dry-run` reports without writing. Maps outside the build directory are never touched. `upload` sends each map to the logged-in workspace, once per JS file that uses it, matched by debug id or by `--service`, `--release` (defaults to the build directory's git commit) and the file path, with `--url-prefix` for the path the files are served under. Maps over 15 MiB are skipped with a warning, and a run that uploads nothing fails.
