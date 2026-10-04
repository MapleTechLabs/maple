# Infrastructure history

Incidents, measurements and retired designs behind the current stack. The operational
reference is `docs/infra.md`; this file is for "why is it like this" and for finding an old
incident again. Git blame does not survive a refactor of the line it annotates, so history
that used to live in stack comments moves here.

## Splitting out the AI Worker (2026-09)

Measured before moving the MCP registry, the chat routes and the two hosted classes from
`api` into `maple-ai` (rolldown, unminified, same tree):

|                   | with AI  | without |
| ----------------- | -------- | ------- |
| worker bundle     | 11.74 MB | 9.34 MB |
| bundle chunks     | 85       | 50      |
| module evaluation | ~336 ms  | ~278 ms |

The per-request half is not in that table: a `/mcp` call no longer builds `AllRoutes` and
`ApiAuthLive`, and a `/v2` call no longer builds 47 tool schemas. A 2026-09-08 attempt that
moved only the transport measured 1.0%. Moving the registry too is what avoided that.

The investigation fan-out Workflow that used to live on `maple-ai` was retired in 2026-09.

## From per-app `wrangler dev` to one `alchemy dev` stack

Local dev used to be per-app `wrangler dev` under turbo + portless. What the single stack
replaced:

- **One definition.** Bindings, crons and exported classes come from the stack, for dev and
  deploy alike. The `wrangler.jsonc` files are gone, along with the crons/DO/KV/rate-limiter
  mirroring that used to drift between them. `wrangler` survives only as an `apps/api`
  devDependency for `bench:startup-cpu`, whose `worker` mode writes a throwaway config for
  `wrangler check startup`.
- **One process tree.** No turbo fan-out, no per-app `portless` wrapper, no `dev:app`
  indirection. Ctrl-C stops all of it.
- **Crons fire on their real schedule**, and `/cdn-cgi/handler/scheduled` triggers one on
  demand (no `--test-scheduled` flag).
- **Almost everything is emulated locally**, where wrangler needed per-app config for each.

The turbo TUI's per-app log panes did not survive the move.

## Single-module Workers: measured cost

Measured on the electric-sync pilot (#745, local workerd A/B) when Workers moved to the
single-module class form: +15ms startup CPU (41 to 56ms, budget ~1s), ~+8ms cold first
request, ~+0.2ms/request warm. The api Worker evaluated in ~80 ms of the 1 s startup-CPU
budget on alchemy's bundle with the Workflow imported statically
(`apps/api/scripts/bench-startup-cpu.ts`, 2026-09-07).

The bridge used to sit behind an `orDie` on the request path, which turned every 404 into an
Error span. Background work used to share `maple-api`'s SDK instance, which skewed its p99
to 32s (2026-09-04).

## The retired AWS opt-in flag (`MAPLE_DEPLOY_AWS_INGEST`)

The Rust OTLP gateway (`apps/ingest`) moved from Railway to ECS Fargate, and on 2026-09-21
to an ECS EC2 fleet on c7gd instances with local NVMe (instance-store fsync is tens of
microseconds; Fargate's network-backed ephemeral storage was milliseconds). The Fargate
fleet and the `MAPLE_INGEST_FLEETS` switch that ran both side by side have since been
deleted.

While the Railway cut-over was in flight, `MAPLE_DEPLOY_AWS_INGEST=1` gated both
`AWS.providers()` and the ingest resources, so an unset variable produced a byte-identical
pure-Cloudflare stack. The flag was removed in 2026-08 once ECS was the only ingest path.
The spend gate moved to where the spend is: a preview only exists while its PR carries the
`preview` label.

There used to be a separate on-demand ingest preview stack (`scripts/ingest-preview.run.ts`
and `deploy-pr-ingest.yml`), deleted when previews got the full AWS half. Two alchemy stacks
claiming the same `maple-ingest-pr-<n>` physical names is how orphan fleets accumulated.

## The #378 deploy hang

The flag above was _also_ introduced because turning the AWS half on wedged every
production deploy with no log line and no network I/O. alchemy's env-credential path
(`CI=true`) discovered the account with an STS `GetCallerIdentity` issued while its own
`AWSEnvironment` was still being constructed, and that call waited on the half-built
environment for its endpoint resolver: a self-deadlock. Supplying `AWS_ACCOUNT_ID` skips
the lookup. Reproduced locally with `CI=true` and the id unset, on alchemy 2.0.0-beta.64
through beta.74.

## Compiling the ingest binary outside the image build

Alchemy's docker build passes no `--cache-from`, and a fresh runner's layer cache is empty,
so a Dockerfile that runs `cargo build` recompiles all 385 crates on every deploy however
the layers are arranged. Cold cost is **2m54s, measured**. An earlier version of this note
guessed ~20 minutes, which was wrong by ~7x and had already been quoted back as fact in a
code review.

Alternatives considered for the aarch64 build: QEMU on an x86 runner (385 crates under
emulation, 10-30 min a build), or a cross toolchain (jemalloc, ring and the other C deps
each need their own cross compiler setup). A native `ubuntu-24.04-arm` runner won. Before
the Graviton move the deploy workflows cached x86 builds under the same `runner.os` key,
which is why `runner.arch` is now in the cache key.

## Hyperdrive: the api/alerting split

Measured over 6h on prd: `alerting` issued 60,688 Postgres queries/hour against the api's
1,415 (97% versus 2%). Sharing one Hyperdrive config meant sharing one origin connection
pool, and the api spent its time queueing behind the alerting crons. A dial that found a
free slot took 12ms. One that did not stalled until Hyperdrive's 15s connection timeout,
which is what put `maple-api`'s p99 at 15.4s.

## Staging (`stg`), removed 2026-09

`resolveHyperdriveRefId` used to return the prd config for `stg` (owner decision,
2026-07-14), so stg Workers read and wrote the production database and the stg alerting
crons overlapped prod's. The stage was removed in full in 2026-09. Its deploy workflow had
been disabled with no run history and neither `api-staging.maple.dev` nor
`ingest-staging.maple.dev` resolved, so the hazard was the only thing it still cost.
`parseMapleStage` now rejects `stg` outright. A future staging stage needs its own
PlanetScale branch and its own dashboard configs, split per consumer the way prd is, before
it gets a `MAPLE_DB` binding at all.

Staging was also the other stage on the session-replay R2 gate (`stageEnablesReplayBlobs`),
so production would not be the first place the write path ran. That gate used to be "is
`INGEST_REPLAY_R2_ENDPOINT` set?"; once the stack minted the R2 credentials itself, config
presence could no longer express intent, so the gate became an explicit function.

## The cold-start regression (`strictExecutionOrder: false`)

alchemy beta.70 and later set rolldown `strictExecutionOrder: true`, which wraps nearly
every chunk in a lazy `__esmMin` initializer. The DB module graph (drizzle `pgTable`
schemas + Effect Schema ASTs) then evaluated on first use, inside the first Postgres call of
each fresh isolate, instead of at script startup. That stepped the cold dial from ~2s to
~9-11s on 2026-08-08 (deploy 2679ba80) and produced the CONNECT_TIMEOUT incident (see the
2026-08-11 investigation). The override in `apps/api/src/worker.ts` and
`apps/ai/src/worker.ts` moved that cost back to script startup.

## ACM validation before `@maple/infra/acm`

A stage's first deploy with the AWS half on used to fail: each service's ACM certificate
landed `PENDING_VALIDATION` and its 443 listener refused it. The workflows recovered with a
second step that published the validation CNAMEs with `scripts/acm-cert-validate.sh` (curl +
jq against both APIs) and deployed again. `@maple/infra/acm` now does it inside the stack.
The proxied CNAME at each ALB was also added by hand, which is why `publishProxiedCname`
adopts existing records.

## EU ingest sizing

Over 30 days at launch the EU ALB served 34k requests (~2 GB) against the US's 136M (~2.3 TB
in), yet ran the US footprint at ~$300/mo. That is what `isEuPrd` in
`packages/infra/src/aws/stage.ts` sizes down.

## Same-region Tinybird egress

At 200k req/s, exporting from AWS to Tinybird is ~$83k/mo over the public internet ($0.09/GB)
vs ~$16k/mo to a public IP in the same region ($0.01/GB). Tinybird's AWS regions are
us-east-1, us-west-2, eu-central-1, eu-west-1, ap-east-1 and ap-southeast-2; a workspace on
`https://api.tinybird.co` is GCP Frankfurt, where no AWS region colocates.

## Alchemy v1 to v2

The stack was written against alchemy v1 and migrated to v2. Equivalences worth knowing
when reading old code or docs:

- **`HyperdriveRef` has no v2 equivalent.** Binding a dashboard-managed config by ID is
  done by attaching raw `{ type: "hyperdrive", name, id }` binding metadata from the Worker's
  init (`host.bind` inside `MapleDb`, `packages/infra/src/cloudflare/maple-db.ts`). No cloud
  resource is created and the origin credentials stay in the dashboard.
- **`Ai()` became an AI Gateway resource.** v2 emits the `{ type: "ai" }` binding by
  attaching `Cloudflare.AI.Gateway`, which also fronts model calls with caching, rate limits
  and logging. The deploy token needs account-level "AI Gateway: Edit".
- **`eventSources` became `Queues.Consumer`.** The consumer is a sibling resource pointing
  at the Worker by `scriptName`.
- **Resource attributes are lazy Outputs.** `worker.url` and friends cannot be
  string-interpolated at plan time. This is why every deployed stage gets custom domains
  (`resolveMapleDomains`) and why inter-app URLs are plain strings chosen by the stack.
- **DO classes are SQLite-backed by default** in v2.
- **The vendored runtime lib is gone.** `lib/effect-cloudflare` was a hand-copied subset of
  `alchemy-effect`'s `Cloudflare/Workers/*`. ~1600 of its 2520 lines had no consumer and it
  was deleted (#760). The ~250 lines with consumers live in `packages/infra` behind
  runtime-only subpaths (`/worker-runtime`, `/workers-cache`, `/config-helpers`).
- **Alchemy's runtime services were not importable from a hand-written Worker entry.** Its
  exports map has no entry finer than a directory, and the `Cloudflare/Workers` barrel drags
  `fdir`, rolldown glue and `node:module` into a bundle (426 KB against 14 KB for the tag
  alone). With api and alerting on the class form (2026-09-07) the Workers use alchemy's
  binding capabilities directly and the hand-rolled R2 client is gone. The
  `WorkerEnvironment` tag stays only for its stricter type (alchemy's is
  `Record<string, any>`), under alchemy's exact key.
