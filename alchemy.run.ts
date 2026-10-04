// The Maple stack: each Worker is its app's `src/worker.ts`; the ECS services (ingest,
// electric) are `create*` factories. Decision history lives in docs/infra.md.
import { appendFileSync } from "node:fs"
import path from "node:path"
import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as Planetscale from "alchemy/Planetscale"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { ConfigError } from "effect/Config"
import { SourceError } from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	AwsRegionMismatchError,
	resolveAwsRegion,
	stageDeploysElectric,
	stageDeploysIngest,
} from "@maple/infra/aws"
import {
	ApiWorker,
	AiWorker,
	SandboxWorker,
	stageDeploysSandbox,
	formatMapleDeployment,
	ManagedMapleDb,
	type MapleDbConsumer,
	type MapleRegion,
	MapleStack,
	type MapleStackContext,
	type MapleStage,
	parseMapleDeploymentEffect,
	regionHostsSharedApps,
	resolveDatabaseMode,
	resolveMapleDomainsEffect,
	resolvePlanetscaleDatabase,
	resolveWorkerName,
	stageMigratesDatabase,
} from "@maple/infra/cloudflare"
import * as Acm from "@maple/infra/acm"
import { optionalPlain, plainWithDefault } from "@maple/infra/env"
import * as Portless from "@maple/alchemy-portless"
import { DEV_PROCESS_APPS, selectedDevApps, type DevApp } from "@maple/infra/dev-urls"
import MapleAiLive, { MapleAi } from "./apps/ai/src/worker.ts"
import Alerting from "./apps/alerting/src/worker.ts"
import ChatBotLive, { ChatBot } from "./apps/chat-bot/src/worker.ts"
import MapleApi from "./apps/api/src/worker.ts"
import MapleSandbox from "./apps/sandbox/alchemy.run.ts"
import { createMapleElectric } from "./apps/electric/alchemy.run.ts"
import ElectricSync from "./apps/electric-sync/src/worker.ts"
import { createMapleIngest } from "./apps/ingest/alchemy.run.ts"
import Landing from "./apps/landing/src/worker.ts"
import LocalUi from "./apps/local-ui/src/worker.ts"
import Web from "./apps/web/src/worker.ts"

// Infisical defines CLOUDFLARE_DEFAULT_ACCOUNT_ID; alchemy reads CLOUDFLARE_ACCOUNT_ID.
if (!process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID) {
	process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
}

// Inter-app URLs must be plain strings at plan time (`worker.url` is a lazy Output), so
// deployed stages use custom domains and dev stages fall back to env-supplied URLs.
const resolveUrl = (domain: string | undefined, envKey: string, fallback = "") =>
	domain
		? Effect.succeed(`https://${domain}`)
		: Effect.map(plainWithDefault(envKey, fallback), (record) => record[envKey] ?? fallback)

/** A typed deploy-setting failure as the `ConfigError` the stack can surface; the original is the cause. */
const asConfigError = (error: { readonly message: string }) =>
	Effect.fail(new ConfigError(new SourceError({ message: error.message, cause: error })))

/** Append `key=value` lines to the GitHub Actions step-output file, if any. */
const appendStepOutputs = (lines: string[]): void => {
	const file = process.env.GITHUB_OUTPUT
	if (file) {
		appendFileSync(file, `${lines.join("\n")}\n`)
	}
}

/**
 * `alchemy dev` sets ALCHEMY_DEV on its exec child. Not stage-derived: a dev
 * stage can still be deployed, and this must stay false when it is.
 */
const isDevServer = process.env.ALCHEMY_DEV === "true"

/** The apps this dev run serves; undefined on a deploy, which is never partial. */
const devApps = isDevServer ? selectedDevApps() : undefined

/** Every resource is declared on every run; a subset run only leaves the others unserved. */
const workerDev = (app: DevApp) =>
	devApps === undefined ? undefined : devApps.has(app) ? Portless.workerDev(app) : Portless.workerUnserved

/** Inter-app URLs handed to the Workers as env, so `.env.local` cannot override them. */
const devEnv = devApps
	? {
			MAPLE_API_BASE_URL: Portless.routeUrl("api"),
			MAPLE_APP_BASE_URL: Portless.routeUrl("web"),
			MAPLE_ELECTRIC_SYNC_URL: Portless.routeUrl("electric-sync"),
			MAPLE_INGEST_URL: Portless.routeUrl("ingest"),
		}
	: undefined

/**
 * prd's `main` branch (its deploy applies migrations). On EU, also a role and a Hyperdrive
 * config per consumer on the role's direct origin; US prd binds dashboard configs by id.
 */
const declareMapleDb = (stage: MapleStage, region: MapleRegion) =>
	Effect.gen(function* () {
		const mode = resolveDatabaseMode(stage, region)
		if (!stageMigratesDatabase(mode)) return undefined
		const database = resolvePlanetscaleDatabase(region)
		const schema = yield* Planetscale.PostgresBranch("maple-db-main", {
			database,
			name: "main",
			migrations: "packages/db/drizzle",
		}).pipe(RemovalPolicy.retain())
		if (mode !== "declared") return { schema, hyperdrives: undefined }
		// Distinct ids on purpose: alchemy keys state by id alone, across resource types.
		const hyperdrive = (consumer: MapleDbConsumer) =>
			Effect.gen(function* () {
				const role = yield* Planetscale.PostgresRole(`db-${consumer}-role`, {
					database,
					branch: schema,
					inheritedRoles: ["postgres"],
				})
				return yield* Cloudflare.Hyperdrive.Connection(`db-${consumer}`, {
					name: resolveWorkerName(`db-${consumer}`, stage, region),
					origin: role.origin,
					caching: { disabled: true },
					// EU cluster max_connections=25, shared with Electric and the gateway.
					originConnectionLimit: 8,
				})
			})
		// alerting has its own config; the rest share api's (docs/infra.md).
		const api = yield* hyperdrive("api")
		const alerting = yield* hyperdrive("alerting")
		return { schema, hyperdrives: { api, ai: api, "chat-bot": api, alerting } }
	})

/** What this deploy is, read by the Worker classes' props. */
const MapleStackLive = Layer.effect(
	MapleStack,
	Effect.gen(function* () {
		// The stage string (`prd`, `prd-eu`) names the instance; alchemy keys state by it.
		const { stage, region } = yield* parseMapleDeploymentEffect(yield* Alchemy.Stage)
		const domains = yield* resolveMapleDomainsEffect(stage, region)
		const context: MapleStackContext = {
			stage,
			region,
			domains,
			urls: {
				api: devEnv?.MAPLE_API_BASE_URL ?? (yield* resolveUrl(domains.api, "MAPLE_API_BASE_URL")),
				// Web's browser SDK posts here; without the dev branch, local telemetry
				// would go to production ingest.
				ingest:
					devEnv?.MAPLE_INGEST_URL ??
					(yield* resolveUrl(domains.ingest, "VITE_INGEST_URL", "https://ingest.maple.dev")),
				electricSync:
					devEnv?.MAPLE_ELECTRIC_SYNC_URL ??
					(yield* resolveUrl(domains.sync, "MAPLE_ELECTRIC_SYNC_URL")),
			},
			workerDev,
			devEnv,
			db: yield* declareMapleDb(stage, region),
		}
		return context
	}),
)

const serveWorker = (app: DevApp, worker: Cloudflare.Worker) =>
	devApps?.has(app)
		? Effect.asVoid(Portless.Route(`${app}-route`, { name: app, port: Portless.workerPort(worker.url) }))
		: Effect.void

/** A non-Worker app's own `dev` script under `Command.Dev`, which is a no-op on deploys. */
const createDevProcess = (app: DevApp, route: Portless.Route) =>
	Command.Dev(`${app}-dev`, {
		command: "bun run --silent dev",
		cwd: path.join(import.meta.dirname, "apps", app),
		env: {
			PORT: Output.map(Output.asOutput(route.port), String),
			PORTLESS_URL: Portless.routeUrl(app),
			MAPLE_API_URL: Portless.routeUrl("api"),
			// The alchemy CLI sets NODE_ENV=production and children inherit it; vite and
			// astro read it for `import.meta.env.DEV`/`PROD`, so dev servers must override it.
			NODE_ENV: "development",
		},
	})

/** Both clouds, unconditionally: stack options are evaluated before the stage is readable. */
const providers =
	// `Acm.providers()` needs the AWS credentials, so it is the layer provided TO.
	Acm.providers().pipe(
		Layer.provideMerge(Cloudflare.providers()),
		Layer.provideMerge(AWS.providers()),
		// Its credential lookup runs when the layer is built, and `bun dev` never yields the branch.
		Layer.provideMerge(isDevServer ? Layer.empty : Planetscale.providers()),
		Layer.provideMerge(Portless.providers()),
	)

export default Alchemy.Stack(
	"maple",
	{
		// AWS_ACCOUNT_ID is REQUIRED in CI: without it alchemy's STS lookup deadlocks
		// silently (docs/infra.md).
		providers,
		// ALCHEMY_LOCAL_STATE=1 uses .alchemy/ file state instead of the account-wide store.
		state: process.env.ALCHEMY_LOCAL_STATE ? Alchemy.localState() : Cloudflare.state(),
	},
	Effect.gen(function* () {
		const { stage, region, domains, urls, db } = yield* MapleStack

		// A mismatched AWS_REGION would split the ACM cert from its ALB and cross the
		// EU residency boundary.
		const { AWS_REGION } = yield* optionalPlain("AWS_REGION")
		const expectedAwsRegion = resolveAwsRegion(region)
		if (AWS_REGION && AWS_REGION !== expectedAwsRegion) {
			return yield* new AwsRegionMismatchError({
				message: `AWS_REGION="${AWS_REGION}" does not match the "${region}" instance (expects "${expectedAwsRegion}").`,
				awsRegion: AWS_REGION,
				mapleRegion: region,
				expectedAwsRegion,
			})
		}

		// The ingest gateway's Postgres role. Changing it is a create-first replace (its id
		// is in the task env).
		const ingestDbRole = db
			? yield* Planetscale.PostgresRole("ingest-gateway", {
					database: resolvePlanetscaleDatabase(region),
					branch: db.schema,
					inheritedRoles: ["postgres"],
				})
			: undefined
		const ingest = stageDeploysIngest(stage)
			? yield* createMapleIngest({ stage, domains, region, dbRole: ingestDbRole })
			: undefined

		// Yielded here first so its `MAPLE_PG_URL` read happens outside any Worker init,
		// where alchemy would bind it as a secret.
		if (resolveDatabaseMode(stage, region) === "managed") yield* ManagedMapleDb

		// Yielded before ai, which binds it as `SANDBOX`.
		const sandbox = stageDeploysSandbox(stage) ? yield* MapleSandbox : undefined
		// Yielded before api, which binds it. The Live layer registers the chat Durable
		// Object class in the bundle's exports.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		const ai = yield* Effect.provide(MapleAi, MapleAiLive).pipe((withLive) =>
			sandbox === undefined ? withLive : Effect.provideService(withLive, SandboxWorker, sandbox),
		)
		yield* serveWorker("ai", ai)
		const api = yield* Effect.provideService(MapleApi, AiWorker, ai)
		yield* serveWorker("api", api)

		// Not wired into electric-sync: it reads `ELECTRIC_URL` from the secret store, so
		// cutover is separate. Electric runs in ingest's VPC, hence `ingest &&`.
		// Id must not be `"electric"` (the ECS service's id): alchemy keys state by id alone.
		const electricDbRole =
			db && stageDeploysElectric(stage)
				? yield* Planetscale.PostgresRole("electric-db-role", {
						database: resolvePlanetscaleDatabase(region),
						branch: db.schema,
						inheritedRoles: ["postgres"],
						withReplication: true,
					})
				: undefined
		const electric =
			ingest && electricDbRole
				? yield* createMapleElectric({
						stage,
						domains,
						region,
						network: ingest.network,
						dbRole: electricDbRole,
					})
				: undefined

		const electricSync = yield* ElectricSync
		yield* serveWorker("electric-sync", electricSync)

		// A vite-source Worker: alchemy owns its build and dev server. Binds api as `API`.
		const web = yield* Effect.provideService(Web, ApiWorker, api)
		yield* serveWorker("web", web)

		// StaticSites run their production build even on `alchemy dev`, so dev uses
		// `DEV_PROCESS_APPS` instead. Shared across instances: deployed by `us` alone.
		const sharedApps = !isDevServer && regionHostsSharedApps(region)
		const landing = sharedApps ? yield* Landing : undefined

		const localUi = sharedApps ? yield* LocalUi : undefined

		const alerting = yield* Effect.provideService(Alerting, AiWorker, ai)
		yield* serveWorker("alerting", alerting)

		// Chat-platform ingress. Its Live layer registers its Durable Object classes.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		const chatBot = yield* Effect.provide(ChatBot, ChatBotLive)
		yield* serveWorker("chat-bot", chatBot)

		// Dev only. Non-Worker processes get their port from the route; Workers bind
		// theirs in `precreate`, so their route follows the Worker.
		for (const app of DEV_PROCESS_APPS) {
			if (!devApps?.has(app)) continue
			const route = yield* Portless.Route(`${app}-route`, { name: app })
			yield* createDevProcess(app, route)
		}

		const summary = {
			stage: formatMapleDeployment({ stage, region }),
			region,
			apiUrl: urls.api,
			ingestUrl: urls.ingest,
			electricSyncUrl: urls.electricSync,
			webUrl: domains.web ? `https://${domains.web}` : "",
			landingUrl: domains.landing ? `https://${domains.landing}` : "",
			localUiUrl: domains.local ? `https://${domains.local}` : "",
		}

		// Plan-time strings only; the ingest URL is written once its Output resolves.
		yield* Effect.sync(() =>
			appendStepOutputs([
				`web_url=${summary.webUrl}`,
				`api_url=${summary.apiUrl}`,
				`sync_url=${summary.electricSyncUrl}`,
			]),
		)

		return {
			...summary,
			// The ALB hostname exists only after apply (plain HTTP on PR previews).
			ingestServiceUrl: ingest?.serviceUrl
				? Output.mapEffect((serviceUrl: string | undefined) =>
						Effect.sync(() => {
							appendStepOutputs([`ingest_url=${serviceUrl ?? ""}`])
							return serviceUrl
						}),
					)(ingest.serviceUrl)
				: undefined,
			ingestCollectorEndpoint: ingest?.collectorEndpoint,
			electricServiceUrl: electric?.serviceUrl,
			apiWorker: api.workerName,
			electricSyncWorker: electricSync.workerName,
			webWorker: web?.workerName,
			landingWorker: landing?.workerName,
			localUiWorker: localUi?.workerName,
			alertingWorker: alerting.workerName,
			chatBotWorker: chatBot.workerName,
		}
	}).pipe(
		// The stack IS the entry point: the one place `MapleStack` is provided.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(MapleStackLive),
		// `Alchemy.Stack` admits only `ConfigError`.
		Effect.catchTags({
			"@maple/infra/MapleStageError": asConfigError,
			"@maple/infra/AwsRegionMismatchError": asConfigError,
		}),
	),
)
