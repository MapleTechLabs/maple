# Infrastructure notes

Operational reference for the Alchemy stack (`alchemy.run.ts`, the per-app Worker modules
and factories, and `packages/infra`). Stack files keep only the rationale a reader needs in
order not to break the code; incidents, measurements and retired designs live in
`docs/infra-history.md`.

## The AI Worker (`maple-ai`)

`apps/ai` hosts every agent surface: the MCP transport and its tools, and the `ChatSession`
Durable Object, which also runs every investigation's autonomous pass. `apps/api` keeps the
hostname and forwards `/mcp`, `/api/chat/*` and `/internal/chat/*` to it over a service
binding, so the OAuth issuer and the RFC 8707 resource identifiers never move off api's
origin.

Two things a future change here needs to know:

- **The `ChatSession` class carries `transferredFrom: "api"`.** Dropping a locally hosted
  Durable Object class while keeping a cross-script reference is the shape that destroys a
  namespace, and alchemy refuses it before uploading. The property is inert once a stage
  has transferred, so it stays.
- **A Workflow has no equivalent.** Moving one to a new script mints a new physical
  workflow and orphans in-flight runs. `ClickHouseSchemaApplyWorkflow` stays on `api`.

## Layout

- `alchemy.run.ts`: the root stack. Provides `MapleStack` (stage, region, domains, public
  URLs, the `bun dev` blocks, the prd database branch) once, yields one module per app, and
  returns the deploy summary (also emitted as GitHub step outputs).
- `apps/<app>/src/worker.ts`: a Worker as one module. It is the alchemy Worker class the
  root yields, whose props are an Effect over `MapleStack`, and the bundle alchemy deploys
  (`api`, `ai`, `alerting`, `chat-bot`, `electric-sync`, `web`, `landing`, `local-ui`; see
  "Single-module Workers" below).
- `apps/<app>/alchemy.run.ts`: a `create*` factory for the apps that are not Workers
  (`ingest`, `electric` on ECS), owning that app's resources and nothing else's. `sandbox`
  also keeps its declaration here, because its `src/worker.ts` must stay a plain bundle
  entry (see "The sandbox Worker" below). The one api resource the ingest gateway shares
  (the replay bucket) is `apps/api/src/resources/replay-blobs.ts`.
- `packages/infra`: stage/region/domain/naming logic, the shared deploy-time env groups, and
  the few resources several Worker modules bind.
    - `region.ts`: `MapleRegion` (`us` | `eu`), the one axis both clouds key on. See
      "Regions" below.
    - `cloudflare/stage.ts`: `MapleStage`, `parseMapleDeployment` (stage and region off the
      alchemy stage string), domains, worker names, placement, storage jurisdiction,
      Hyperdrive resolution. Pure functions, unit-tested, no cloud calls.
    - `cloudflare/stack.ts`: `MapleStack`, what the root stack tells the Worker classes.
    - `cloudflare/observability.ts`: the Workers Observability destinations, declared once
      and yielded from every module that binds them (alchemy registers a resource by id, so
      a second yield returns the first's).
    - `aws/stage.ts`: AWS region, naming, EC2 and task sizing, Cloud Map, and which stages
      get an ingest fleet, a collector or Electric.
    - `aws/acm-dns-validation.ts` (`@maple/infra/acm`): ACM validation through the
      Cloudflare zone, and `publishProxiedCname` for each ALB's public hostname.
    - `env.ts`: the deploy-time env primitives and the shared groups the Workers spread.
    - `cloudflare/maple-db.ts`: `MAPLE_DB` in the stage's flavor (`MapleDb`, yielded from a
      Worker's init, or `mapleDbEnv` from its props) and the runtime read of the binding
      (`readMapleDbBinding`).
    - `config-helpers.ts`, `cloudflare/worker-runtime.ts`, `cloudflare/workers-cache.ts`:
      the _runtime_ (in-Worker) side, each behind its own subpath export so a Worker bundle
      never reaches the deploy graph through `./cloudflare`. `worker-runtime.ts` is the
      `WorkerEnvironment` tag (alchemy's key, typed `Record<string, unknown>`) and
      `workerEnvLayer(env)`, the env plus its `ConfigProvider` for a graph built over one
      env record. Nothing reaches for `cloudflare:workers`.

**Read deploy-time config through `@maple/infra/env`, not `process.env`.** Alchemy resolves
config through a ConfigProvider built as `fromDotEnv(--env-file ?? ".env")` **orElse**
`fromEnv()` (`alchemy/Util/ConfigProvider.ts`), and never copies the file-sourced values
into `process.env`. A `process.env` read therefore silently ignores `.env` and
`--env-file`. It does so _selectively_: alchemy's own settings (`CLOUDFLARE_ACCOUNT_ID`,
`CI`, …) still pick them up, so half the deploy sees the file and half does not. `Config`
also reports every missing key in one pass instead of throwing on the first, and keeps the
failure in the typed error channel. `packages/alchemy-maple`'s `MapleEnvironment` is the
same pattern inside a provider. The runtime Worker env schemas use
`@maple/infra/config-helpers`, which `env.ts` builds on.

## Regions: one stack, one instance per deploy

A geographic instance is the whole stack (every Worker, the ingest fleet, Electric, the
replay bucket, the chat Durable Object) deployed against that instance's own Tinybird
workspace, application database and secrets. There is no per-org routing anywhere. An org's
region is the instance it was created on, and an EU hostname cannot reach a US resource
because the EU Workers are bound to none. Plan and rationale: `docs/eu-region-plan.md`.

- **The alchemy stage string carries the region.** `prd` is the US instance and `prd-eu`
  the EU one (`dev_makisuo-eu` is a dev stage of it; PR previews are US-only). Alchemy keys
  its state by stage, so the two instances never plan against each other's resources, and
  nothing has to set a second variable in lockstep. `parseMapleDeployment` is the one
  parser. `MapleStack` carries `region` to every Worker module.
- **`us` is unsuffixed** everywhere (Worker names, AWS names, hostnames), so adding `eu`
  renamed nothing: `maple-api` / `maple-api-eu`, `app.maple.dev` / `app.eu.maple.dev`,
  `maple-ingest` / `maple-ingest-eu`. `regionSuffix` in `region.ts` is the single rule.
- **Placement is a hint, jurisdiction is a pin.** `resolveWorkerPlacement` steers each
  instance's Workers beside its own database (us-east-1 / eu-central-1), best effort.
  `resolveStorageJurisdiction` puts the EU instance's R2 bucket and its Durable Objects in
  Cloudflare's `eu` jurisdiction, which is a hard storage guarantee on every plan. The DO
  jurisdiction is a property of the object id, so it is applied where ids are minted
  (`chatSessionStub`, reading the stack-derived `MAPLE_REGION`), not on the binding.
  Regional Services, the contractual execution guarantee, is an Enterprise add-on the
  account does not carry. The residency claim says so.
- **Shared apps stay on `us`.** The marketing site and the local-mode SPA hold no customer
  data and there is one `maple.dev`, so `profile.deploys.sharedApps` keeps them off the EU
  deploy.
- **Secrets** come from a per-instance Infisical environment (`prod`, `prod-eu`) holding the
  same variable names with that instance's values. `deploy-prd-instance.yml` picks the
  environment, the stage and the AWS region from one `region` input, and the stack refuses
  an `AWS_REGION` that disagrees with the stage. The EU deploy is opt-in through the
  `MAPLE_DEPLOY_EU` repository variable until its accounts exist.
- **The EU database is declared, not pasted.** The `database` in `resolveMapleProfile` is `"declared"` for the
  EU prd. The deploy adopts `maple-eu`'s `main` branch, declares a `Planetscale.PostgresRole`
  per consumer on it and a `Cloudflare.Hyperdrive.Connection` on each role's direct origin
  (`declareMapleDb`), and the Workers bind theirs from their props (`mapleDbEnv`). The US
  prd stays `"ref"`, on the dashboard configs it was measured on. Moving it is the same
  switch plus new config ids for its Workers.
- **AI on the EU instance goes through OpenRouter's EU endpoint** (`eu.openrouter.ai`,
  `apps/ai/src/platform/Llm.ts`, #1052). Workers AI has no region pin, so
  `MAPLE_LLM_PROVIDER` stays unset there.

## Local dev: one `alchemy dev` stack

`bun dev` (`scripts/dev.ts`) runs the whole local stack as a single `alchemy dev`:

```bash
bun dev             # everything
bun dev api web     # a subset of: api, ai, alerting, chat-bot, electric-sync, web, landing, ingest, local-ui, scraper
```

The Workers (**api, ai, alerting, chat-bot, electric-sync, web**) are served by alchemy's
local runtime from the same Worker classes that deploy them. web is a vite-source Worker,
so alchemy runs its vite dev server itself. Everything else (landing and local-ui as
vite/astro dev servers, ingest via `cargo run`, and the scraper) runs as a `Command.Dev`
child of the same stack (`DEV_PROCESS_APPS` in `@maple/infra/dev-urls`). Each child is that
app's own `dev` script, started by `createDevProcess` in `alchemy.run.ts`, kept alive across
stack restarts, and stopped with the stack. `Command.Dev` is a no-op on a deploy, so this is
dev-only by construction. The asset Workers' deploy shape (`Command.Build` plus an assets
Worker) never runs in dev.

Portless provides what alchemy's local runtime does not: named HTTPS hosts that several
worktrees share without anyone caring about ports. The routes are alchemy resources:
`Portless.Route` from `lib/alchemy-portless`, one per app the run serves (`serveWorker` and
the dev-process loop in `alchemy.run.ts`). A route reserves a loopback port, registers
`portless alias <hostname> <port>`, and removes the route again when it is torn down: with
the dev session, on a config change, or on `alchemy destroy`. Its `port` attribute feeds a
child process's `PORT` like any other Output. A Worker binds its port at plan time
(`Portless.workerDev`) and its route follows the Worker. The provider lives in alchemy's dev
sidecar, so a route survives a hot reload of the stack file.

**Ports are sticky, not pinned.** A route prefers a port derived from its identity (a hash
into 40000-49999; Workers use 50000-59999 so the two never collide). It walks forward if that
one is held (a second worktree running the same app), and only then takes an OS-chosen port.
So `api` lands on the same port run after run without anyone writing it down, and two
checkouts never fight over one. Linked worktrees get the branch-prefixed hostnames portless
itself produces (last branch segment, none for `main`: `fix-ui.api.localhost`). Each
non-Worker child is told its own name through `PORTLESS_URL`, which is how the vite/astro
configs find the api and ingest (`siblingUrl`).

What is left in `scripts/dev.ts` is a shim: `bun dev api web` becomes
`MAPLE_DEV_APPS=api,web`, then `alchemy dev`. A subset run still declares every resource (a
resource absent from the plan would be deleted from the account). It only leaves the other
Workers unserved (`dev: { mode: "external" }`) and starts no child process for them. The
stack hands the inter-app URLs to the Workers as env itself, so `.env.local` cannot override
them.

`isDevServer` (`ALCHEMY_DEV=true`, set by `alchemy dev`) switches the stack into this shape,
and `MAPLE_DEV_APPS` narrows it to the requested apps. Neither is stage-derived: a dev
_stage_ can still be deployed to the cloud, and a deploy is never partial.

Bindings, crons and exported classes come from the stack for dev and deploy alike; there are
no `wrangler.jsonc` files. `alchemy dev` runs each Worker's declared crons on their real
schedule, and `/cdn-cgi/handler/scheduled` triggers one on demand. Workers, KV, R2,
Hyperdrive, queues and consumers, Durable Objects, Workflows, rate limiters and `send_email`
(written as `.eml` files under `.alchemy/local/email/`) all come up `(local)`, with storage
under `.alchemy/local/`. The AI Gateway is declared on deployed stages only, since it has no
local emulation.

Gotchas:

- **The dev Hyperdrive origin must set `sslmode: "disable"`.** Alchemy defaults a local
  origin to `sslmode=prefer` (`Cloudflare/Hyperdrive/ConnectBinding.ts`). The driver then
  attempts TLS against the docker Postgres, which has SSL off, and every DB call 503s after
  the dial budget (`error.type = ConnectionError`; `CONNECT_TIMEOUT` under the old
  postgres.js driver). See `ManagedMapleDb`.
- **`MAPLE_OTEL_INGEST_KEY` is optional on dev stages only** (`selfObservabilityEnv`). The
  local stack resolves the same env contract as a deploy, and no developer has a real
  ingest key. Without the exemption the whole stack refuses to start over a key whose only
  job is exporting the Worker's own telemetry.
- Dev stacks run with `ALCHEMY_LOCAL_STATE=1`, so they never touch the account state store.
- `--env-file .env.local` is read once at start. A changed variable needs a restart.
- The children's logs share one terminal.
- A harness that cannot resolve `*.localhost` (the browser-verification preview) uses the
  sticky raw ports `bun dev` prints. `Portless.Route`'s `port` prop pins one outright.
- Ctrl-C stops the whole tree. The shim runs alchemy in its own process group and forwards
  the signal to the group, because alchemy's CLI is several node processes deep and a signal
  to any one of them stops nothing. The routes come off as alchemy tears the session down.
- If portless is not installed or its proxy is down, a route logs a warning and the app is
  reachable on `127.0.0.1:<port>` only. The inter-app URLs still name the `*.localhost`
  hosts, so start the proxy (`portless proxy start`) rather than work around it.

## Single-module Workers

A Worker is one module, `apps/<app>/src/worker.ts`: the alchemy Worker class the root stack
yields (`export default class Alerting extends Cloudflare.Worker<Alerting>()("alerting",
props, impl) {}`) and the bundle alchemy builds (`main: import.meta.url`). `props` is an
Effect that reads `MapleStack` (`@maple/infra/cloudflare`, provided once by the root from
`Alchemy.Stage`) and yields whatever other resources the Worker binds: its `Command.Build`,
the shared `ManagedMapleDb` or `WorkersObservabilityDestinations` (alchemy registers a
resource by id, so a second module yielding the same one gets the first's). `impl` runs once
per isolate on the first event and returns the handlers. No hand-written `export default
{ fetch }`, no factory arguments. A Worker that binds another (web's `API` service binding to
the api, api's and alerting's `AI_WORKER`) takes it as a service the root provides after
yielding it (`ApiWorker`, `AiWorker` in `@maple/infra/cloudflare`). A `Worker.ref` reads
stored state and cannot see a sibling the same deploy creates.

What each kind of Worker keeps beside the module:

- **Crons** (`alerting`, `api`): `Cloudflare.Workers.cron(expression, handler)` in `impl`,
  under `CronEventSourceLive`, attaches the schedule at plan time and the listener at
  runtime. The source reports every fire as successful, so the platform's retry never
  engages. Nothing is lost: the ticks already log and swallow their own failures, the
  schedules re-fire, and the shell logs a failure outside a tick. alerting's ticks live in
  `src/scheduled.ts` behind a dynamic import, so the layer graph is off the startup path and
  out of the deploy process (where `impl` also runs), and the test imports it without a
  runtime. api's schedules are `src/worker/crons.ts`, with the tick bodies behind the same
  kind of dynamic import (`src/worker/modules.ts`). A cron fire is an event like any other:
  the bridge builds the telemetry into its scope and flushes after it, so the tick graph
  carries no tracer or logger of its own. One there would shadow the bridge's
  (`apps/alerting/src/worker-telemetry.test.ts` pins that a tick's spans export).
- **Queues** (`api`): `Cloudflare.Queues.consumeQueueMessages(queue, settings, handler)` in
  `impl`, under `Queues.EventSourceLive`, yields the `Consumer` resource at plan time and the
  listener at runtime (`src/worker/consumers.ts`, over the declarations in
  `src/resources/queues.ts`). The consumers carry `renamedFrom({ fqn })` with the ids the
  retired api factory declared them under (`vcs-sync-consumer`, …). Alchemy migrates the
  state rows, so the deploy plans a noop instead of re-creating each consumer. Without it,
  the delete of the old row would have removed the physical consumer the new row had
  adopted. Drop the decoration once every stage has deployed past it.
- **Background telemetry** (`api`): queue batches and cron ticks run under their own SDK
  instance (`eventTelemetry` in `@maple/infra/worker-telemetry`, provided around the event),
  so `maple-vcs-sync` and `maple-planetscale-webhooks` keep their own service names.
  Background work sharing `maple-api` skewed its p99 to 32s (2026-09-04). The layer graphs
  those events build carry no tracer or logger of their own.
- **Durable Objects** (`ai`) **and Workflows** (`api`): alchemy's Effect-native forms,
  yielded from the init. `ChatSessionObject` (`apps/ai/src/chat/ChatSession.ts`) is
  `Cloudflare.DurableObject<Self>()("ChatSession", impl)` over the plain `ChatSession`
  class. The outer Effect resolves state and env. It also runs at plan time against a mock
  state, so it must not touch storage. The inner one builds the session and returns its
  methods as Effects, which alchemy's bridge runs per RPC call and hands back as-is. api
  and the other consumers bind it cross-script by class name.
  `ClickHouseSchemaApplyWorkflow` (`apps/api/src/workflows/*.ts`) is
  `Cloudflare.Workflow<Self>()(name, impl)` in the documented shape: the init resolves what
  the run needs, then returns an `Effect.fn` body. The body (`*.run.ts`) is an Effect on
  alchemy's step API. `durableStep` (`packages/backend/src/platform/durable-step.ts`) is
  `Cloudflare.Workflows.task` over an Effect whose failure rejects the step, so Cloudflare
  retries it per config. The body reads `Database`, `Cloudflare.WorkerEnvironment` and
  `Cloudflare.WorkflowStep` as services. The class wraps a run in `withPgConnectionScope` +
  `layerPg` (one Postgres connection per run) and the run's own `eventTelemetry`
  (`maple-schema-apply`), which flushes when alchemy closes the run's scope. The Workflow is
  imported statically (check startup CPU with `apps/api/scripts/bench-startup-cpu.ts`). The
  yield is the
  whole declaration: the binding (named after the class, `ChatSession` or
  `ClickHouseSchemaApplyWorkflow`, which is what the services read off the env), the
  namespace, the physical workflow (`<worker>-<class>-<hash>`, alchemy's
  `makeWorkflowName`) and the generated entry's class export, with no hand-written entry. The
  only reference-form binding left is the cross-script `ChatSession` on the Workers that call it.
- **The chat-bot Worker** (`chat-bot`): chat-platform ingress, and the one Worker in the
  fleet with a **resident** Durable Object. `ConnectorSocket` (`src/socket/ConnectorSocket.ts`)
  holds one outbound WebSocket per socket-ingress connector in `@maple/chat-platform`'s
  registry, addressed by the connector's id. Hibernation covers only sockets the platform
  hands an object (`state.acceptWebSocket`). A socket the object dials itself keeps the
  object in memory for as long as it is open, so each socket connector costs one resident
  object. That is what an @mention costs on a platform that delivers mentions no other way.
  A platform that signs an HTTP webhook uses the same Worker's generic
  `POST /connectors/:connectorId/webhook` route and no Durable Object at all.

    A `* * * * *` cron is the start and recovery trigger. The Worker has no traffic of its
    own, so nothing would ever make a first request, and after a deploy or an eviction the
    next tick calls `ensureConnected` again. Between ticks the object's own alarm serves the
    connector's heartbeat, the reconnect backoff and a one-minute watchdog. A connector's
    fatal directive (a rejected credential, a permission the application was never granted)
    holds it down for six hours rather than forever, so fixing the credential is all a
    recovery needs.

    A second Durable Object, `ConnectorRelay` (`src/relay/ConnectorRelay.ts`), carries the
    turn a mention causes. There is one object per conversation, addressed by connector,
    workspace and channel. It resolves the org, claims a turn on maple-ai's `ChatSession` and
    streams the answer back into the conversation under its own `waitUntil`. An alarm every
    30s keeps it resident while it does, for the same reason the chat session arms one. It
    is a separate object because there is a single socket for the whole deployment: running
    turns there would either block the next frame behind a model run or pile every
    concurrent turn in the system into the object that holds the connection.

    The relay keeps two things in storage. The first is which conversations the bot opened
    itself, which is what lets a message that mentioned nobody still be answered there.
    `src/relay/conversation.ts` holds the whole rule: the conversation is the bot's own, its
    session has held a turn inside the last day, a human wrote the message, and it has text.
    The second is a checkpoint per turn it is relaying (`src/relay/settle.ts`): the turn's
    identity, the cursor it was claimed at and the refs of the platform messages posted for
    it, never what they say. An object evicted or redeployed mid-turn loses only the fiber
    rendering it, and the answer stops streaming. The keep-alive alarm wakes the fresh
    activation, which finds a checkpoint no fiber of its own holds. It leaves it until the
    turn's own `turn-end` is in the session's log (or the session runs nothing), then renders
    the final answer into the same messages in one pass (the ordinary driver: surplus
    messages emptied, a missing tail posted), then clears it. A checkpoint older than the
    session's own staleness ceiling plus a margin, one this build cannot decode, or one
    whose session cannot be reached is dropped. It costs one small storage write per
    platform message posted (not per edit), a delete per turn, and a prefix `list` per 30s
    alarm. Nothing new is resident.

    So the Worker binds, beyond its connector secrets: `ChatSession` cross-script on
    maple-ai; `MAPLE_DB` (the api's Hyperdrive config, one row per mention, read inside a
    connection scope that closes before the turn streams); `MAPLE_APP_BASE_URL` for the
    links a reply carries; and an optional `MAPLE_SHARE_TOKEN_HMAC_KEY`, without which a
    chart in a reply is relayed as text rather than as a picture. On a stage with no
    application database (PR previews) the lookup fails, is logged, and the mention goes
    unanswered rather than being told the workspace is unlinked.

    It takes **one public hostname on production instances** (`domains.chat`:
    `chat.maple.dev`, `chat.eu.maple.dev`). A webhook connector's platform is configured with
    a request URL inside the vendor's own application, and that URL has to keep working
    across deploys. That is what the custom domain buys; the socket half never needed one. A
    dev stage reaches the same route through portless and a PR preview gets none, since a
    connector there would have neither credentials nor a database to resolve a workspace in.
    The Worker is inert on a stage with no connector credentials. Every connector key is
    bound optional, and a connector without its configuration is skipped with one log line,
    so no socket is opened, the webhook route answers 503, and no turn is ever relayed.

    A connector whose install mints a credential per workspace (rather than using one
    deployment-wide secret) has it sealed into `chat_workspaces.credentials_{ciphertext,iv,tag}`,
    AAD-bound to `(org_id, connector, external_workspace_id)`. That is why chat-bot also
    binds `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, optionally. Without it such a workspace fails
    its lookup and the mention goes unanswered, while every other connector runs normally.

- **The sandbox Worker** (`sandbox`): the one Worker in the fleet whose own module is its
  bundle entry. It hosts Cloudflare's Sandbox Durable Object (`@cloudflare/sandbox`), which
  is a class the deployed script must export. An Effect-native Worker cannot export one,
  because alchemy generates its entry (`makeEffectVirtualEntry`) and exports only the bridge
  classes it created. A plain module is used verbatim, so `export { Sandbox }` in
  `apps/sandbox/src/worker.ts` is what binds, and the declaration lives in
  `apps/sandbox/alchemy.run.ts`. A separate app is not the only way to run this image: an
  alchemy `Cloudflare.DurableObject` in the api can front a `Cloudflare.Container` and talk
  to its port directly. That means owning the container's control protocol instead of using
  the vendor client, so this buys the client at the price of an app. It has no route and no
  hostname. maple-ai, whose agents run the sandbox tools, reaches it over a `SANDBOX`
  service binding, provided by the root as `SandboxWorker`. Every request carries
  `SANDBOX_INTERNAL_SERVICE_TOKEN`, deliberately not the shared `INTERNAL_SERVICE_TOKEN`,
  which lets its holder act as any organization.

    Only `prd` gets one (`profile.deploys.sandbox`). A PR preview has no application database,
    so no repository resolves there. On a dev stage, `alchemy dev` would put a
    multi-gigabyte `docker pull` between every developer and `bun dev`.

    What runs inside is one full `git clone` per commit under `/workspace/maple/<sha>`, kept
    to the newest three. The clone is a **background process** the Worker polls, because a
    container request is capped well below what a cold clone of a real repository takes. A
    call that arrives first gets `SandboxRunCheckoutPending` and retries. The credential is a
    GitHub token minted for that one repository with read-only contents, staged through the
    container's file API into a root-only path and read by a git credential helper. It is
    never put in a command, because every process's arguments are readable by the account
    the agent's own commands run as. Commands run through a wrapper (`wrapCommand`): `env -i`
    with a fixed environment, `runuser` to an unprivileged account that does not own the
    tree, `unshare -n` for a network namespace with no egress, and each stream cut to the
    request's bound where it is produced. The command's real exit status and whether the
    namespace opened travel in a trailer, so a command exiting 97 is not mistaken for one
    that never ran.

    **`unshare -n` needs `CAP_SYS_ADMIN`, and whether Cloudflare's container runtime grants
    it is unverified.** Measured against the published image: under default container
    capabilities it fails and the wrapper refuses to run the command. With the capability
    added, the namespace opens and a lookup inside it is denied while the same lookup outside
    succeeds. If the platform withholds it, every sandbox command returns
    `SandboxRunIsolationUnavailable` and the tools are dead until the request stops asking
    for isolation. It fails closed, which is the intended direction, but it needs proving on
    a real deploy.

- **Assets** (`landing`, `local-ui`): the handler reads `Cloudflare.Workers.Request` and
  `env.ASSETS` and hands the web `Response` back through `HttpServerResponse.fromWeb`.
  landing's negotiation is a plain function in `src/handler.ts`, so a test can drive it
  without a runtime.
- **The application database** (`api`, `ai`, `alerting`, `chat-bot`): on dev stages and the
  US prd, `yield* MapleDb(consumer)` in the init binds `MAPLE_DB`:
  `Hyperdrive.Connect(ManagedMapleDb)` on dev stages, `host.bind` of the dashboard-managed
  config by id on the US prd (alchemy has no `env` form for a Hyperdrive it did not create;
  its own `ConnectBinding` attaches the same raw metadata). On the EU prd the props bind the
  declared config through `mapleDbEnv`. Previews get nothing. The api's Workflow yields it
  too, from its outer phase. The root yields `ManagedMapleDb` first on dev stages so its
  `MAPLE_PG_URL` read happens outside any init, where alchemy's plan-time ConfigProvider
  would bind it as a secret. Every Postgres layer reads the `MapleDbConnection` port
  (`packages/backend/src/platform/bindings.ts`), never the env.

**web** is a `Cloudflare.Website.Vite` Worker (`apps/web/src/worker.ts`). Alchemy owns its
vite build and its dev server, and the deployed entry is `src/worker-entry.ts`. Its props
bind the api Worker as `API`, handed over as `ApiWorker`. It carries no `WorkerTelemetry`.

Alchemy evaluates a Worker module in three places (the deploy process, `alchemy dev`, and
the deployed isolate). Two rules keep it honest about which one it is in:

- **Props are a plan-time Effect, guarded for the bundle.** The stage-derived props (`name`,
  `domain`, `env`, the portless `dev` block) read `MapleStack` (`@maple/infra/cloudflare`), a
  service the root stack provides once from `Alchemy.Stage`, so the module never imports
  portless or parses the stage itself. Alchemy also evaluates props inside the deployed
  bundle, where they are inert, so the props Effect returns early under
  `globalThis.__ALCHEMY_RUNTIME__`. Alchemy's bundler folds that to `true`, and the
  stack-side branch plus the `@maple/infra` modules only it reaches are dead-code-eliminated.
  Check by grepping the bundle under `.alchemy/bundles/electric-sync/` for a `maple.dev`
  hostname.
- **The app layer is built on the first request, not in init.** `impl` (init) also runs at
  plan time, and alchemy's plan-time ConfigProvider auto-binds every `Config` it sees read
  during init onto the Worker as a secret. That would override the explicit `env` contract
  (a PR preview deliberately gets no `ELECTRIC_URL`). So the route graph is dynamic-imported
  and built once per isolate on the first `fetch` (`Effect.cached`), against a scope that is
  never closed. workerd has no isolate teardown, so nothing in the layer may need releasing.
- **The bridge serves the router and owns telemetry.** `fetch` is the `HttpRouter.toHttpEffect`
  handler as-is. The bridge renders its typed failures before its tracer runs
  (`RouteNotFound` becomes an Ok span with a 404; a defect becomes a 500, which the SDK
  records as an Error server span per OTel semconv), so no `orDie` sits on the request path.
  The one that did turned every 404 into an Error span.
  `apps/electric-sync/src/worker-bridge.test.ts` drives the real bridge path and pins all
  three outcomes. `apps/api/src/worker-bridge.test.ts` does the same for the api's liveness,
  preflight and graph-failure fast paths. Telemetry is one line on init,
  `Effect.provide(WorkerTelemetry({ serviceName }))` from `@maple/infra/worker-telemetry`, on
  the Workers that do work (api, ai, alerting, chat-bot, electric-sync). The asset Workers
  (landing, local-ui) deliberately have none: a server span per static page view is ingest
  volume spent observing a file read, and it would put the internal ingest key in a
  marketing site's env. Workers Observability covers their logs. `WorkerTelemetry` is the
  published `Maple.Telemetry` from `@maple-dev/alchemy/telemetry` (Maple's counterpart of
  alchemy's `Axiom.Telemetry` sugar) with Maple's own defaults. It registers the SDK's
  `requestLayer` with alchemy's `Telemetry.layer`, which builds it into each request scope
  and flushes after the response. There is no hand-rolled tracer, `waitUntil`, or flush
  shim. The key/endpoint bindings `Maple.Telemetry` can add stay off for our Workers:
  `selfObservabilityEnv(stage)` owns those, with the PR-preview rules.

The root stack imports the Worker modules, so the Alchemy-entrypoints typecheck
(`tsconfig.alchemy.json`) covers their runtime graphs and needs `@maple-dev/effect-sdk`
built first (`ci.yml`).

`apps/api/src/worker.ts` and `apps/ai/src/worker.ts` set rolldown
`strictExecutionOrder: false` so the DB module graph evaluates at script startup, not inside
the first Postgres call of each isolate. If chunking ever regresses into upstream #749
(`ScriptStartupError: Cannot access '<minified>' before initialization`), the deploy fails
loudly at upload: remove the override and warm the DB graph off the request path instead.

### The api Worker's layout (2026-09-07)

`apps/api/src/worker.ts` is the composition root only: props plus an init that reads as a
list of yields. What it composes lives beside it:

- `src/resources/*`: one file per resource the Worker binds, declared at module scope and
  inert until yielded (`queues.ts`, `replay-blobs.ts`, and `env.ts` for the `Config`
  catalog). Stage-derived physical names come from `stageNamed` / `stageProps`
  (`@maple/infra/cloudflare`). They read alchemy's own `Stage`, one of the platform services
  a Worker's init may require (unlike `MapleStack`), behind the same `__ALCHEMY_RUNTIME__`
  guard as a Worker's props, because alchemy evaluates a resource's props Effect wherever it
  is yielded, the bundle included. The ingest factory yields the same `ReplayBlobs`
  declaration to mint the gateway's writer token.
- `src/worker/*`: the runtime shell. `http.ts` (the lazily built route graph and `fetch`),
  `ai-forward.ts` (the forward to maple-ai), `crons.ts`, `consumers.ts`
  (`consumeQueueMessages` over the declarations, so no binding is read back off the host),
  `events.ts`, `modules.ts` (the dynamic imports), and `bindings.ts`.
- **Bindings are alchemy capabilities, read as Maple ports.** The init yields
  `Queues.WriteQueue(VcsSyncQueue)`, `R2.ReadBucket(ReplayBlobs)` and the
  `Cloudflare.RateLimit(...)`s (`worker/bindings.ts`). Each yield attaches the native
  binding at plan time, under the resource's logical id (so the queue and bucket bindings
  are `vcs-sync`, `replay-blobs`, …), and resolves it from the env in the isolate. The
  clients become the ports in `packages/backend/src/platform/bindings.ts` (`VcsSyncQueueProducer`,
  `ApiV2RateLimit`, `ReplayBlobBucket`, `McpSessionStore`, …), which is what the services
  depend on. No service reads a binding off `WorkerEnvironment` by name any more, tests
  provide fakes, and a host without the binding (alerting, the CLI) provides nothing. The
  services that can degrade read the port through `Effect.serviceOption`. The clients'
  methods are colored with alchemy's `RuntimeContext`, a phantom that keeps them out of the
  init phase. The ports discharge it with `RuntimeContext.phantom`, as alchemy's own runtime
  helpers do.
- What stays on `env:`: `EMAIL` on prd, the cross-script `ChatSession` binding, the
  `AI_WORKER` service binding, and the stage partition the rate limiters key under.
  Alchemy's capabilities have no "bound on some stages" form, and the plan/runtime split
  makes a conditional yield lie on one side. `MAPLE_DB` is bound from the init (`MapleDb`,
  above) or the props (`mapleDbEnv`).
- The Worker env reaches a graph once, through the ports (`workerEnvLayer(env)` in
  `apiPorts`). The runtime modules (`vcs-sync-runtime.ts`, …) declare `WorkerEnvironment`
  and `ConfigProvider` as requirements and wire neither. A Durable Object or a Workflow run
  hands its own env record to the same helper.

## AWS: ingest, collector and Electric

The Rust OTLP gateway (`apps/ingest`) runs on an ECS EC2 fleet of Graviton c7gd instances,
one task per host in host networking, with the WAL on the local NVMe instance store. That is
the only ingest path. The OTel collector and Electric (`apps/electric`) run as ECS Fargate
services.

- `AWS.providers()` is registered unconditionally: the `Alchemy.Stack` options are evaluated
  before `Alchemy.Stage` is readable, so it cannot be stage-derived.
- `profile.deploys.ingest` alone decides which stages get a fleet: prd **and PR previews**. Dev
  stages run the gateway through `cargo run` under `bun dev`. Do not reintroduce a global
  on/off env flag; say it in `profile.deploys.ingest`, where it is typed and unit-tested.
- **Every workflow that deploys the stack must set `AWS_ACCOUNT_ID`.** Without it alchemy's
  `CI=true` credential path self-deadlocks on an STS lookup with no log line (#378).
- **The binary is compiled outside the image build** (`build-ingest-binary.yml`, native
  `ubuntu-24.04-arm` runner, inside `rust:1.94-bookworm` to match the runtime's glibc 2.36),
  because alchemy's docker build has no layer cache and would recompile every crate on each
  deploy. `apps/ingest/Dockerfile.prebuilt` copies the result.
- Public hostnames (`ingest`, `electric`) are proxied Cloudflare CNAMEs to the ALB, created
  by `publishProxiedCname`; their ACM certificates are validated in-stack by
  `issueCertificateViaCloudflare` (both in `@maple/infra/acm`).

## Schema migrations run in the deploy

The instance's PlanetScale `main` branch (`maple`, `maple-eu`) is a `Planetscale.PostgresBranch`
yielded into `MapleStack` on prd (`db.schema`), with `migrations` at `packages/db/drizzle`.
Alchemy orders resources only by the Outputs their props reference, and a Hyperdrive bound
by id references nothing. So the api, ai, alerting and chat-bot Workers put the branch name
in their env (`MAPLE_DB_BRANCH`, via `mapleDbEnv`) to upload after it. The ingest gateway's
and Electric's Postgres credentials are `Planetscale.PostgresRole`s on the same branch. See
`docs/persistence.md` for both.

## Hyperdrive: why api and alerting have separate configs

`alerting` issues the large majority of Postgres queries, and sharing one config meant
sharing one origin pool, so the api queued behind the alerting crons. They now have
separate configs.

The configs **partition** the origin's connections rather than creating more. The
per-config `origin_connection_limit`s sum against the branch's `max_connections`, and
Hyperdrive does not coordinate between them, so over-provisioning one starves the other at
the database rather than at the pool.

`prd` is the only stage `resolveHyperdriveRefId` answers for, and `parseMapleStage` rejects
`stg`. A new shared stage needs its own PlanetScale branch and per-consumer configs before
it gets a `MAPLE_DB` binding at all.

Binding a dashboard-managed config by id attaches raw `{ type: "hyperdrive", name, id }`
metadata from the Worker's init (`host.bind` inside `MapleDb`,
`packages/infra/src/cloudflare/maple-db.ts`); no cloud resource is created and the origin
credentials stay in the dashboard.

## Cost decisions

These are cash-flow calls, not design ones. Revisit them rather than treating them as
architecture.

- **No NAT gateway** in the ingest VPC. NAT bills per GB processed on top of egress, and the
  gateway exists to push telemetry outbound. The EC2 hosts (tasks run in host networking)
  therefore carry public IPs, which is why the security-group split between the ALB and the
  hosts is load-bearing. The S3 gateway endpoint keeps ECR image pulls off the public path.
- **Same-region Tinybird.** Same-region egress is $0.01/GB vs $0.09/GB to the internet, and
  export dominates the bill. Verify `TINYBIRD_HOST` before changing `resolveAwsRegion`.
- **The OTel collector is prd-only** (`profile.deploys.collector`). The intent is every stage
  that deploys the gateway. The `preview:collector` label sets `MAPLE_DEPLOY_AWS_COLLECTOR=1`
  for one preview, and `scripts/ingest-preview-verify.sh` checks it.
- **PR previews get an ingest fleet, but no database.** The `pr` profile's `database` is
  `"none"`, so DB-backed routes 500 and the rest of the preview works. The AWS half costs real money, so a preview only
  exists while the PR carries the `preview` label. It has no ingest domain: its ALB answers
  plain HTTP on 80 with no certificate, and the URL is posted on the PR comment.
  `cleanup-preview-orphans.yml` sweeps what a missed teardown leaves.
- **The EU ingest fleet is sized to EU traffic** (`EU_PRD` in `packages/infra/src/profile.ts`):
  one c7gd.medium (autoscaling 1-3) and the collector at the non-prd size; Electric keeps
  the prd size. Managed scaling adds a host to roll a deploy. To scale it, raise the EU
  values there, or point `prd-eu` at `US_PRD`.
- **Graviton (ARM64).** The gateway, collector and Electric run `cpuArchitecture: "ARM64"`
  (`runtimePlatform`), cheaper than x86_64. `build-ingest-binary.yml` compiles natively on
  an arm64 runner.

## Things that have broken a deploy before

Each has a comment at the site.

- **A relative `dockerfile` path.** Alchemy has flipped how it resolves one between
  releases. Use absolute paths.
- **`listenerPort` vs `port` on `ECS.Service`.** `port` is the container port; the listener
  defaults to 443 once `certificateArn` is set. Setting `listenerPort` to the container port
  breaks both the Cloudflare proxy and the health check.
- **A security group that does not admit the listener port.** A stage without a domain gets
  an HTTP listener on 80, not 443.
- **An image whose architecture does not match the task.** Keep `runtimePlatform` explicit.
- **A cargo `--target-dir` inside the image context.** Alchemy's `hashDirectory` ignores
  `.dockerignore` and root-anchored gitignore rules, so the target dir would be hashed on
  every deploy.
- **An unvalidated ACM certificate.** Feed the listener the ARN returned by
  `issueCertificateViaCloudflare`, not the certificate's own, so it waits for `ISSUED`.
- **A missing `AWS_ACCOUNT_ID`** in a deploy workflow (#378 deadlock, see above).
