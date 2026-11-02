# @maple/cli

## 0.3.2

### Patch Changes

- c9fef22: `maple start` no longer refuses with "already running" in a container image without `ps` when a stale PID file names an unrelated live process (such as the container's init). `maple schema` commands run as PID 1 no longer mistake a dead server's PID file for a live server.
- Updated dependencies [1c7c733]
    - @maple-dev/effect-sdk@0.13.1

## 0.3.1

### Patch Changes

- ee8d5de: Maple Local inserts OTLP exports that arrive together in one statement per table, instead of one statement each. Five traces exports sent at once now each answer in about the time one takes alone, where before each waited for the inserts ahead of it. An export still answers only after its rows are committed, and a query reads every row queued before it.
- Updated dependencies [534647e]
- Updated dependencies [ef33c0d]
- Updated dependencies [41da0c2]
- Updated dependencies [13abd6c]
    - @maple-dev/effect-sdk@0.13.0

## 0.3.0

### Minor Changes

- 1da4ff9: Load explicitly configured external projector modules in Maple Local with a versioned registration contract and repeatable `--projector-module` paths, including background starts.

### Patch Changes

- Updated dependencies [bf01691]
- Updated dependencies [1da4ff9]
    - @maple-dev/effect-sdk@0.12.1
    - @maple/eventing-core@0.1.0

## 0.2.0

### Minor Changes

- 830b398: `maple start --in-memory` runs Maple Local with a throwaway store that lasts one run, for CI jobs, tests and quick sessions. It never touches `~/.maple/data`. On Linux the store lives on `/dev/shm` when at least 1 GiB is free there, otherwise in the OS temp dir, and it is deleted when the server stops. The flag can't be combined with `--background`, `--data-dir`, `--reset`, `--checkpoint-interval`, `--on-dirty-store` or `--minimum-raw-telemetry-retention-days`. Stop it with Ctrl-C. The container image accepts `start --in-memory` too; run it with `--shm-size=1g` or more to keep the store in RAM.

## 0.1.0

### Minor Changes

- b17c821: `maple start` can require credentials when it is reachable beyond loopback. Set `MAPLE_LOCAL_INGEST_KEY` to require a key on OTLP ingest (`Authorization: Bearer` or `x-maple-ingest-key`), and `MAPLE_LOCAL_ACCESS_TOKEN` to require sign-in for the dashboard and query API. The bundled dashboard shows a sign-in page, scripts send the token as a Bearer token, and CLI commands send it when the variable is set. Without them, a non-loopback start still runs and the banner warns that it is open.
- 807c8c1: Maple Local ships as a container image, `ghcr.io/mapletechlabs/maple`, for running it on a server or a container platform. It requires `MAPLE_LOCAL_INGEST_KEY` and `MAPLE_LOCAL_ACCESS_TOKEN`, keeps everything on a `/data` volume, runs unprivileged, listens on `$PORT` when the platform sets one, and recovers from an unclean stop on its own. See the Self-hosting docs.

## 0.0.30

### Patch Changes

- Updated dependencies [af2b366]
- Updated dependencies [75a59ca]
- Updated dependencies [f34141f]
- Updated dependencies [c463f5c]
- Updated dependencies [7216bb9]
    - @maple-dev/effect-sdk@0.12.0

## 0.0.29

### Patch Changes

- Updated dependencies [832b7db]
    - @maple-dev/effect-sdk@0.11.0

## 0.0.28

### Patch Changes

- Updated dependencies [737e082]
    - @maple-dev/effect-sdk@0.10.2

## 0.0.27

### Patch Changes

- b2e0da6: `maple service-map` now lists the databases services call (from `db.system.name` and `db.namespace`), and with `-s <service>` that service's external HTTP, messaging and RPC calls, so dependencies that run no OpenTelemetry SDK show up in the terminal too. The JSON output is now an object: `edges`, `databases`, and `external` when `-s` is set. `-s` now keeps only the edges touching that service, inbound and outbound, filtered in the query rather than from the top 200 edges, and an unknown service name lists the known ones. Remote mode prints service edges only, and its `-s` keeps outbound edges.
- Updated dependencies [ed8a412]
    - @maple-dev/effect-sdk@0.10.1

## 0.0.26

### Patch Changes

- 9381435: `maple start` no longer spins when a supervisor restarts it after a failure that retrying cannot fix. It exits with status 78 (tell systemd `RestartPreventExitStatus=78`), waits before exiting when the same failure repeats, and reports it to telemetry at most once an hour. A libchdb the system refuses to load now says so and names the reinstall command.

## 0.0.25

### Patch Changes

- c99708f: Releases are now signed. `maple update` verifies each release's Ed25519 signature before it trusts the checksum, and the installer does the same (on macOS it needs `brew install openssl@3`).

    To install a release from before signing, pass `--insecure-skip-signature` to `maple update` or set `MAPLE_SKIP_SIGNATURE=1` for the installer.

- 3901dab: `maple update` now shows each step as it runs (manifest check, download, checksum, unpack, install) with a spinner, and the download gets a live progress bar with size and speed. Piped or CI output prints only the finished steps.
- 0d53337: The local dashboard looks like Maple again. It bundles the Geist fonts, uses the shared design tokens (amber in light mode, colored JSON highlighting), and no longer flashes dark on a light-mode OS. Service colors now show in the traces list, logs, metrics, span and session panels and every service filter, and severity colors show in the logs filter. Logs strip ANSI color codes, show `+N lines` for multi-line bodies, and only rail errors and warnings. New 5m, 15m, 30m and 12h time ranges. Fixes: the service map panel now matches its node when a service reports several environments, abandoned browser sessions no longer show as active forever, "Throughput by operation" is a per-second rate, and a failed metric preview says so.
- f73ef32: The local service page opens with the same four charts as Maple Cloud: latency (p50/p95/p99), throughput, Apdex and error rate. Error rates on the page are colored from 1% up, not only above 5%, and the per-operation error rate is toned.
- c5f67c5: The local trace page has a real header: the root span as the title, then total duration, span and service counts, status, HTTP code, environment, a copyable trace ID and the per-service time share. The span panel shows where the span sits in the trace, Escape closes it, and loading shows the page's shape instead of a spinner. The traces list gains a Status column. Fixes HTTP status codes going missing for apps on the current HTTP semantic conventions (`http.response.status_code`).

## 0.0.24

### Patch Changes

- e248fee: Add `maple changelog` to read what changed in a release (`--since <version>` for every release after one). After an upgrade, the first interactive run names the new version and points at it, and `maple update` prints the command to run.
- 9dfb924: Query output names its timezone: JSON timestamps are ISO-8601 UTC (`2026-10-13T16:09:29.577Z`) and table times end in `Z`. In local mode, `maple traces`, `maple slow-traces`, `maple trace` and `maple logs` include links into the local UI. `maple logs --attributes` returns every log attribute, e.g. `requestId`.
