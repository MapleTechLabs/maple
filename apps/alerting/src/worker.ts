/**
 * The alerting Worker (alchemy single-module form): one handler per cron. Ticks
 * live in `./scheduled`, imported on the first fire to keep the api graph off
 * startup. Every fire reports success, so ticks must log their own failures.
 */
import {
	AiWorker,
	cachedRecoverable,
	chatSessionBinding,
	MapleDb,
	mapleDbEnv,
	type MapleDeployment,
	type MapleDomains,
	type MapleRegion,
	MapleStack,
	type MapleStage,
	mapleWorkerProps,
} from "@maple/infra/cloudflare"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	ingestKeyCryptoEnv,
	merge,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	selfObservabilityEnv,
	tinybirdEnv,
} from "@maple/infra/env"
import { WORKER_PURE_OPTIONS } from "@maple/infra/worker-build"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import { bindEmailSender } from "@maple/backend/platform/email-sender"
import { chatConnectorOutboundConfigKeys } from "@maple/chat-platform"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Config, Effect, Layer, Option, Ref } from "effect"
import { HttpServerResponse } from "effect/http"

/** Resource bindings, split from config so `InferEnv` can derive `AlertingWorkerEnv`. */
const makeWorkerBindings = (deployment: MapleDeployment) => ({
	// maple-ai's chat DO, where ticks start investigations; read off `env` by class name.
	ChatSession: chatSessionBinding(deployment),
})

/**
 * Runtime env, imported type-only by `./scheduled.ts`. `Partial` because bindings
 * can be absent (ref stages, `alchemy dev`); config vars stay `unknown` since they
 * are read through the ConfigProvider (`workerEnvLayer`), never off `env`.
 */
export type AlertingWorkerEnv = Partial<Cloudflare.InferEnv<ReturnType<typeof makeWorkerBindings>>> &
	Record<string, unknown>

/** Config-sourced env; largely shared with api via `@maple/infra/env`. */
const configuredEnv = (stage: MapleStage, region: MapleRegion, domains: MapleDomains) =>
	merge(
		tinybirdEnv,
		authEnv,
		ingestKeyCryptoEnv,
		appUrlsEnv(domains),
		// MAPLE_ENVIRONMENT must stay stage-derived, not overridable: it gates both the
		// non-prod cron skip and `EmailService.emailAllowed`.
		selfObservabilityEnv(stage, region),
		// "1" runs crons on a non-prod stage (which otherwise skips them).
		optionalPlain("MAPLE_ALERTING_ALLOW_NONPROD"),
		// Dev-only escape hatch from per-org BYO rows (see apps/api/src/resources/env.ts).
		optionalPlain("MAPLE_IGNORE_ORG_CLICKHOUSE"),
		optionalSecret("AUTUMN_SECRET_KEY"),
		optionalSecret("INTERNAL_SERVICE_TOKEN"),
		// Push for incidents, plus OAuth refresh for the Cloudflare and PlanetScale pollers.
		apnsEnv,
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
		// Outbound config for `chat` destinations' connectors.
		...chatConnectorOutboundConfigKeys.map((key) =>
			key.secret ? optionalSecret(key.name) : optionalPlain(key.name),
		),
	)

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const { stage, region, domains, devEnv, db } = stack
	// For `IncidentClassifier`. Yielded, not `Worker.ref`: a ref cannot see a sibling this deploy creates.
	const ai = yield* AiWorker
	const env = yield* configuredEnv(stage, region, domains)
	return {
		main: import.meta.url,
		...mapleWorkerProps("alerting", stack),
		workersDev: false,
		build: { pure: WORKER_PURE_OPTIONS },
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
			...makeWorkerBindings({ stage, region }),
			...mapleDbEnv(db, "alerting"),
			AI_WORKER: ai,
			...env,
			...devEnv,
		},
	}
})

/** Dispatched to tick groups by `selectScheduledProgram`. */
const ALERTING_CRONS = ["* * * * *", "*/5 * * * *", "*/15 * * * *", "0 * * * *"] as const

/**
 * Non-prod stages share live org data, so their crons would iterate real orgs
 * with stage-local credentials (failures, duplicate emails). Off unless overridden.
 */
const CronGate = Config.all({
	environment: Config.option(Config.String("MAPLE_ENVIRONMENT")),
	allowNonProd: Config.option(Config.String("MAPLE_ALERTING_ALLOW_NONPROD")),
})

/** The gate as this fire's env says; a value that is not a string reads as unset, which keeps crons off. */
const cronGateFor = (env: Record<string, unknown>) =>
	CronGate.pipe(
		Effect.map(({ environment, allowNonProd }) => ({
			environment,
			enabled:
				Option.contains(environment, "production") ||
				Option.contains(allowNonProd, "1") ||
				Option.contains(allowNonProd, "true"),
		})),
		Effect.orElseSucceed(() => ({ environment: Option.none<string>(), enabled: false })),
		// The fire's env is the boundary this config belongs to.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(workerEnvLayer(env)),
	)

export default class Alerting extends Cloudflare.Worker<Alerting>()(
	"alerting",
	props,
	Effect.gen(function* () {
		// Lazy and recoverable: a rejected import retries on the next fire.
		const scheduled = yield* cachedRecoverable(Effect.promise(() => import("./scheduled")))
		// Its own Hyperdrive config on prd, so alerting cannot starve api's pool.
		yield* MapleDb("alerting")
		// `send_email`, prd only; handed to each fire's graph as `EmailSender`.
		const email = yield* bindEmailSender
		// Once per isolate, not once per fire.
		const loggedNonProdSkip = yield* Ref.make(false)

		const onFire = (controller: ScheduledController) =>
			Effect.gen(function* () {
				const env = yield* Cloudflare.WorkerEnvironment
				const gate = yield* cronGateFor(env)
				if (!gate.enabled) {
					if (!(yield* Ref.getAndSet(loggedNonProdSkip, true))) {
						yield* Effect.logInfo("Skipping alerting crons on non-production stage").pipe(
							Effect.annotateLogs({
								"maple.environment": Option.getOrElse(gate.environment, () => "unset"),
								hint: "set MAPLE_ALERTING_ALLOW_NONPROD=1 to run them here",
							}),
						)
					}
					return
				}
				const { runScheduled } = yield* scheduled
				yield* runScheduled(controller.cron, env, email).pipe(
					// Interrupts are isolate teardown, not a failed run.
					Effect.catchCause((cause) =>
						Cause.hasInterruptsOnly(cause)
							? Effect.void
							: Effect.logError("Alerting scheduled run failed", cause).pipe(
									Effect.annotateLogs({ "maple.alerting.cron": controller.cron }),
								),
					),
				)
			})

		for (const cron of ALERTING_CRONS) {
			yield* Cloudflare.Workers.cron(cron, onFire)
		}

		return {
			fetch: Effect.succeed(HttpServerResponse.text("maple-alerting: scheduled only", { status: 404 })),
		}
	}).pipe(
		// The init is the entry point: the cron source needs the host Worker.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				Cloudflare.Hyperdrive.ConnectBinding,
				Cloudflare.Email.SendBinding,
				Cloudflare.Workers.CronEventSourceLive,
				WorkerTelemetry({ serviceName: "alerting" }),
			),
		),
	),
) {}
