import MapleAi from "./apps/ai/src/worker"
import { AiWorker } from "@maple/infra/cloudflare"
// The Maple stack: one module per app, composed here — every Worker is its own
// `src/worker.ts` (an alchemy Worker class, `yield* Alerting`); the two ECS
// services (ingest, electric) are `create*` factories.
//
// Comments in these files explain what a reader needs in order not to break the
// code. The history behind those decisions — the #378 deploy hang, the
// CONNECT_TIMEOUT cold-start regression, the Hyperdrive split measurements, the
// v1→v2 equivalences, the cost calls, and the local-dev/`alchemy dev` state of
// play — lives in `docs/infra.md`.
import { appendFileSync } from "node:fs"
import path from "node:path"
import * as Alchemy from "alchemy"
import * as AWS from "alchemy/AWS"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Command from "alchemy/Command"
import * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
	parseMapleRegion,
	resolveAwsRegion,
	stageDeploysElectric,
	stageDeploysIngest,
} from "@maple/infra/aws"
import {
	ApiWorker,
	SandboxWorker,
	stageDeploysSandbox,
	formatMapleStage,
	ManagedMapleDb,
	MapleStack,
	type MapleStackContext,
	parseMapleStage,
	resolveDatabaseMode,
	resolveMapleDomains,
} from "@maple/infra/cloudflare"
import * as Acm from "@maple/infra/acm"
import { optionalPlain, plainWithDefault } from "@maple/infra/env"
import * as Portless from "@maple/alchemy-portless"
import { DEV_PROCESS_APPS, selectedDevApps, type DevApp } from "@maple/infra/dev-urls"
import Alerting from "./apps/alerting/src/worker.ts"
import MapleApi from "./apps/api/src/worker.ts"
import MapleSandbox from "./apps/sandbox/alchemy.run.ts"
import { createMapleElectric } from "./apps/electric/alchemy.run.ts"
import ElectricSync from "./apps/electric-sync/src/worker.ts"
import { createMapleIngest } from "./apps/ingest/alchemy.run.ts"
import Landing from "./apps/landing/src/worker.ts"
import LocalUi from "./apps/local-ui/src/worker.ts"
import Web from "./apps/web/src/worker.ts"

// v1 read the account id from CLOUDFLARE_DEFAULT_ACCOUNT_ID (the name Infisical
// still defines); v2's auth provider reads CLOUDFLARE_ACCOUNT_ID. Bridge the
// old name so CI keeps working without an Infisical rename.
if (!process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID) {
	process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
}

// Inter-app URLs must be plain strings at plan time: alchemy v2 resource
// attributes (e.g. `worker.url`) are lazy Outputs that only resolve when fed
// into other resources' props — they cannot be string-interpolated here. Every
// deployed stage therefore gets custom domains (see resolveMapleDomains); dev
// stages fall back to env-supplied URLs (cloud-deploying a dev stage is rare —
// local dev runs through portless instead).
const resolveUrl = (domain: string | undefined, envKey: string, fallback = "") =>
	domain
		? Effect.succeed(`https://${domain}`)
		: Effect.map(plainWithDefault(envKey, fallback), (record) => record[envKey] ?? fallback)

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
		}
	: undefined

/**
 * What this deploy is, for the Worker classes (`yield* Alerting`, …) whose
 * props read it instead of taking factory arguments.
 */
const MapleStackLive = Layer.effect(
	MapleStack,
	Effect.gen(function* () {
		const stage = parseMapleStage(yield* Alchemy.Stage)
		const domains = resolveMapleDomains(stage)
		const context: MapleStackContext = {
			stage,
			domains,
			urls: {
				api: devEnv?.MAPLE_API_BASE_URL ?? (yield* resolveUrl(domains.api, "MAPLE_API_BASE_URL")),
				ingest: yield* resolveUrl(domains.ingest, "VITE_INGEST_URL", "https://ingest.maple.dev"),
				electricSync:
					devEnv?.MAPLE_ELECTRIC_SYNC_URL ??
					(yield* resolveUrl(domains.sync, "MAPLE_ELECTRIC_SYNC_URL")),
			},
			workerDev,
			devEnv,
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
		},
	})

/**
 * Both clouds, unconditionally.
 *
 * `providers` is part of the `Alchemy.Stack` options, which are evaluated
 * before `Alchemy.Stage` is readable inside the stack effect, so this cannot be
 * stage-derived — every stage registers the AWS provider surface even when it
 * creates no AWS resource. Whether a stage actually gets an ingest fleet is
 * `stageDeploysIngest`, below.
 */
const providers =
	// `Acm.providers()` (the ACM-via-Cloudflare validation reads) requires the
	// AWS credentials and HTTP client, so it is the layer being provided TO —
	// `X.pipe(provideMerge(Y))` feeds Y into X, not the other way round.
	Acm.providers().pipe(
		Layer.provideMerge(Cloudflare.providers()),
		Layer.provideMerge(AWS.providers()),
		Layer.provideMerge(Portless.providers()),
	)

export default Alchemy.Stack(
	"maple",
	{
		// Cloudflare hosts the Workers/DO/R2 surface; AWS hosts the Rust OTLP
		// gateway on ECS (`apps/ingest`). AWS credentials arrive as env vars from
		// Infisical exactly like the Cloudflare ones — `AWS.providers()` reads
		// AWS_REGION / AWS_ACCOUNT_ID / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
		//
		// AWS_ACCOUNT_ID is REQUIRED in CI. Without it alchemy's env-credential
		// path looks the account up over STS from inside its own environment
		// construction and deadlocks silently, with no log line and no network
		// I/O — the #378 hang. Every deploy workflow sets it; see deploy-prd.yml.
		providers,
		// Shared account-wide state store (Worker + DO SQLite) — bootstrapped once
		// per Cloudflare account (`alchemy bootstrap cloudflare` or the first
		// `deploy --yes`). ALCHEMY_LOCAL_STATE=1 opts into .alchemy/ file state for
		// throwaway local experiments (dev stages) without touching the account.
		state: process.env.ALCHEMY_LOCAL_STATE ? Alchemy.localState() : Cloudflare.state(),
	},
	Effect.gen(function* () {
		const { stage, domains, urls } = yield* MapleStack

		// Geographic instance this deploy belongs to. `us` today; an EU instance is
		// the same stack deployed with MAPLE_REGION=eu against that instance's own
		// Tinybird workspace and application database. Guarded here because a
		// mismatch between MAPLE_REGION and AWS_REGION would put the ACM
		// certificate in a different region from the ALB that must use it — and
		// worse, would export telemetry across the residency boundary the EU
		// instance exists to enforce.
		const { MAPLE_REGION } = yield* optionalPlain("MAPLE_REGION")
		const { AWS_REGION } = yield* optionalPlain("AWS_REGION")
		const region = parseMapleRegion(MAPLE_REGION)
		const expectedAwsRegion = resolveAwsRegion(region)
		if (AWS_REGION && AWS_REGION !== expectedAwsRegion) {
			throw new Error(
				`AWS_REGION="${AWS_REGION}" does not match MAPLE_REGION="${region}" (expects "${expectedAwsRegion}").`,
			)
		}

		// The Rust OTLP gateway on ECS Fargate (prd/stg/pr — dev stages run it
		// through docker-compose instead). On prd/stg `domains.ingest` reaches it
		// via a Cloudflare CNAME at the ALB, so the URL below stays a plain string
		// and does not depend on the service resource; a PR preview gets no ingest
		// domain, so its ALB answers plain HTTP on 80 at `ingest.serviceUrl`.
		const ingest = stageDeploysIngest(stage)
			? yield* createMapleIngest({ stage, domains, region })
			: undefined

		// The application database. Each Worker binds `MAPLE_DB` from its own init
		// (`MapleDb` in `@maple/infra/cloudflare`: the managed Hyperdrive on dev
		// stages, a dashboard-managed config by id on stg/prd, nothing on previews).
		// The managed declaration is yielded here first so its `MAPLE_PG_URL` read
		// happens outside any Worker init, where alchemy would bind it as a secret.
		if (resolveDatabaseMode(stage) === "managed") yield* ManagedMapleDb

		// The agents' repository sandbox: it hosts Cloudflare's Sandbox Durable
		// Object, and the api binds it as `SANDBOX`. Yielded first so the binding
		// sees a Worker this deploy created rather than stored state, and only on
		// the stages that run it — see `stageDeploysSandbox`.
		const sandbox = stageDeploysSandbox(stage) ? yield* MapleSandbox : undefined
		const ai = yield* MapleAi
		yield* serveWorker("ai", ai)
		const api = yield* (
			sandbox === undefined ? MapleApi : Effect.provideService(MapleApi, SandboxWorker, sandbox)
		).pipe(Effect.provideService(AiWorker, ai))
		yield* serveWorker("api", api)

		// Self-hosted ElectricSQL on ECS Fargate (prd/stg — dev stages use the
		// docker `electric` service, and PR previews have no database to replicate
		// from). Deliberately NOT wired into the sync worker's env here: the worker
		// reads `ELECTRIC_URL` from the secret store, so standing this service up
		// and cutting over to it are two separate, independently revertible acts.
		// Point `ELECTRIC_URL` at `https://${domains.electric}` once it is verified.
		// `ingest &&` is not a stage gate — it is the VPC dependency. Electric runs
		// in the ingest fleet's network (see `createMapleElectric`), so a stage
		// without ingest has no VPC to put it in. Every stage that deploys Electric
		// deploys ingest, so this never silently drops it.
		const electric =
			ingest && stageDeploysElectric(stage)
				? yield* createMapleElectric({ stage, domains, region, network: ingest.network })
				: undefined

		// Standalone ElectricSQL shape-proxy worker (DB-free); its public origin is
		// baked into the web build (VITE_ELECTRIC_SYNC_URL). Like alerting, landing
		// and local-ui below, a single module: its props read `MapleStack` and the
		// module is also the bundle entry.
		const electricSync = yield* ElectricSync
		yield* serveWorker("electric-sync", electricSync)

		// See `isDevServer`: each of these three is gated on a production
		// `Command.Build`, so including them would make `alchemy dev` build the
		// whole frontend before serving anything. web's props bind the api
		// Worker (its `API` service binding), handed over as `ApiWorker`.
		const web = isDevServer ? undefined : yield* Effect.provideService(Web, ApiWorker, api)

		const landing = isDevServer ? undefined : yield* Landing

		const localUi = isDevServer ? undefined : yield* LocalUi

		const alerting = yield* Alerting
		yield* serveWorker("alerting", alerting)

		// Dev only: the vite/astro dev servers, `cargo run`, and the scraper, each
		// handed its route's port. (A Worker binds its port in `precreate`, before
		// Outputs resolve, so a Worker's route follows the Worker instead.)
		for (const app of DEV_PROCESS_APPS) {
			if (!devApps?.has(app)) continue
			const route = yield* Portless.Route(`${app}-route`, { name: app })
			yield* createDevProcess(app, route)
		}

		const summary = {
			stage: formatMapleStage(stage),
			apiUrl: urls.api,
			ingestUrl: urls.ingest,
			electricSyncUrl: urls.electricSync,
			webUrl: domains.web ? `https://${domains.web}` : "",
			landingUrl: domains.landing ? `https://${domains.landing}` : "",
			localUiUrl: domains.local ? `https://${domains.local}` : "",
		}

		// In GitHub Actions, expose the deployed URLs as step outputs so the
		// workflow can attach the web preview to the PR as a clickable deployment.
		// Only plan-time strings belong here — an Output cannot be interpolated
		// (see resolveUrl above); the ingest URL is written after the deploy below.
		yield* Effect.sync(() =>
			appendStepOutputs([
				`web_url=${summary.webUrl}`,
				`api_url=${summary.apiUrl}`,
				`sync_url=${summary.electricSyncUrl}`,
			]),
		)

		// The Workers' names, for the CLI summary.
		return {
			...summary,
			// ALB hostname to CNAME `domains.ingest` at, plus the one-time ACM
			// validation record — both are manual entries in the Cloudflare
			// `maple.dev` zone, surfaced here so they come out of the deploy rather
			// than the AWS console.
			// The ALB hostname only exists once the service does, so `ingest_url`
			// is emitted as this output resolves — after apply — rather than at
			// plan time with the URLs above. On a PR preview this is the ALB's
			// plain-HTTP hostname: the preview has no ingest domain, so there is
			// no certificate and no CNAME.
			ingestServiceUrl: ingest
				? Output.mapEffect((serviceUrl: string | undefined) =>
						Effect.sync(() => {
							appendStepOutputs([`ingest_url=${serviceUrl ?? ""}`])
							return serviceUrl
						}),
					)(ingest.serviceUrl)
				: undefined,
			ingestCollectorEndpoint: ingest?.collectorEndpoint,
			// Same manual-DNS story as ingest: CNAME `domains.electric` at this ALB
			// (proxied), and add the ACM validation record once.
			electricServiceUrl: electric?.serviceUrl,
			electricCertificateValidation: electric?.certificateValidation,
			ingestCertificateValidation: ingest?.certificateValidation,
			apiWorker: api.workerName,
			electricSyncWorker: electricSync.workerName,
			webWorker: web?.workerName,
			landingWorker: landing?.workerName,
			localUiWorker: localUi?.workerName,
			alertingWorker: alerting.workerName,
		}
		// The stack IS the entry point: the one place `MapleStack` is provided.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
	}).pipe(Effect.provide(MapleStackLive)),
)
