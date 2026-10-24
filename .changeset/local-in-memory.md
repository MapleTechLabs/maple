---
"@maple/cli": minor
---

`maple start --in-memory` runs Maple Local with a throwaway store that lasts one run, for CI jobs, tests and quick sessions. It never touches `~/.maple/data`. On Linux the store lives on `/dev/shm` when at least 1 GiB is free there, otherwise in the OS temp dir, and it is deleted when the server stops. The flag can't be combined with `--background`, `--data-dir`, `--reset`, `--checkpoint-interval`, `--on-dirty-store` or `--minimum-raw-telemetry-retention-days`. Stop it with Ctrl-C. The container image accepts `start --in-memory` too; run it with `--shm-size=1g` or more to keep the store in RAM.
