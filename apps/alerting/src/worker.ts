/**
 * The alerting Worker (alchemy single-module form): one handler per cron. Ticks
 * live in `./scheduled`, imported on the first fire to keep the api graph off
 * startup. Every fire reports success, so ticks must log their own failures.
 */
import {
	AiWorker,
	cachedRecoverable,
	MapleDb,
	mapleDbEnv,
	type MapleDomains,
	type MapleRegion,
	MapleStack,
	type MapleStage,
	mapleWorkerProps,
	StatusSnapshotsBucket,
	StatusSnapshotsKv,
} from "@maple/infra/cloudflare"
import {
	apnsEnv,
	appUrlsEnv,
	authEnv,
	cloudflareOAuthEnv,
	githubAppSourceEnv,
	ingestKeyCryptoEnv,
	merge,
	optionalPlain,
	optionalSecret,
	planetScaleOAuthEnv,
	selfObservabilityEnv,
	supabaseOAuthEnv,
	tinybirdEnv,
} from "@maple/infra/env"
import { WORKER_PURE_OPTIONS } from "@maple/infra/worker-build"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { WorkerTelemetry } from "@maple/infra/worker-telemetry"
import { bindChatSessions } from "@maple/backend/platform/chat-sessions"
import { bindEmailSender } from "@maple/backend/platform/email-sender"
import { chatConnectorOutboundConfigKeys } from "@maple/chat-platform"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Cause, Config, Effect, Layer, Option, Ref } from "effect"
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http"
import { ALERTING_CRONS, scheduleFor } from "./schedule.ts"
import { authorizeTickRequest, dispatchTick, SELF_BINDING } from "./tick-dispatch.ts"
import { lookupColo } from "./worker-colo.ts"
import { CHAT_ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/chat-platform/anticipated"

/**
 * Runtime env, imported type-only by `./scheduled.ts`. Config vars stay `unknown` since they are
 * read through the ConfigProvider (`workerEnvLayer`), never off `env`.
 */
export type AlertingWorkerEnv = Record<string, unknown>

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(effect, RuntimeContext.phantom)

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
		// Linear alert destinations refresh the org's Linear token at delivery time.
		optionalPlain("LINEAR_OAUTH_CLIENT_ID"),
		optionalSecret("LINEAR_OAUTH_CLIENT_SECRET"),
		// Signs the chart image URL in notifications; unset sends them text-only.
		optionalSecret("MAPLE_SHARE_TOKEN_HMAC_KEY"),
		// Push for incidents, plus OAuth refresh for the Cloudflare, PlanetScale and Supabase pollers.
		apnsEnv,
		cloudflareOAuthEnv,
		planetScaleOAuthEnv,
		supabaseOAuthEnv,
		// Sign-in for the Google Cloud metrics poller; unset leaves its tick a no-op.
		optionalSecret("MAPLE_GCP_SERVICE_ACCOUNT_KEY"),
		// Ticks post pull-request replies through the GitHub App; without it each one fails.
		githubAppSourceEnv,
		// Outbound config for `chat` destinations' connectors.
		...chatConnectorOutboundConfigKeys.map((key) =>
			key.secret ? optionalSecret(key.name) : optionalPlain(key.name),
		),
	)

/** `__ALCHEMY_RUNTIME__` folds to `true` in the bundle, so the stack-side branch is tree-shaken. */
const props = Effect.gen(function* () {
	if (globalThis.__ALCHEMY_RUNTIME__) return { main: import.meta.url }
	const stack = yield* MapleStack
	const { stage, region, domains, devEnv, db, awsOidc } = stack
	// For `IncidentClassifier`. Yielded, not `Worker.ref`: a ref cannot see a sibling this deploy creates.
	const ai = yield* AiWorker
	const env = yield* configuredEnv(stage, region, domains)
	return {
		main: import.meta.url,
		...mapleWorkerProps("alerting", stack),
		workersDev: false,
		build: { pure: WORKER_PURE_OPTIONS },
		// Ticks run in the fetch handler (`./tick-dispatch.ts`), which gets 30 s CPU by default where
		// an hourly cron got 15 min. The paid-plan ceiling keeps the long ticks within budget.
		limits: { cpuMs: 300_000 },
		// `devEnv` last, so `.env.local` cannot override the inter-app URLs.
		env: {
			...mapleDbEnv(db, "alerting"),
			AI_WORKER: ai,
			// Cron fires hop through it so their ticks run where placement applies.
			[SELF_BINDING]: Cloudflare.Workers.Self,
			...env,
			...awsOidc,
			...devEnv,
		},
	}
})

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
		// maple-ai's chat Durable Object, where ticks start investigations; handed to each fire's graph.
		const chatSessions = yield* bindChatSessions
		// Where published status pages live; ticks publish snapshots and import break-glass posts.
		const statusKv = yield* Cloudflare.KV.ReadWriteNamespace(StatusSnapshotsKv)
		const statusBucket = yield* Cloudflare.R2.ReadWriteBucket(StatusSnapshotsBucket)
		// Once per isolate, not once per fire.
		const loggedNonProdSkip = yield* Ref.make(false)
		// Once per isolate too: an isolate never changes data center. A failed lookup stays
		// "unknown" for the isolate rather than costing every fire another timeout.
		const http = yield* HttpClient.HttpClient
		const isolateColo = yield* Effect.cached(
			lookupColo().pipe(
				Effect.provideService(HttpClient.HttpClient, http),
				Effect.tapError((error) => Effect.logWarning("Alerting colo lookup failed", error)),
				Effect.orElseSucceed(() => "unknown"),
			),
		)

		const runTick = (cron: string, lane: string, env: Record<string, unknown>) =>
			Effect.gen(function* () {
				const { runScheduled } = yield* scheduled
				const [kv, bucket] = yield* runtime(Effect.all([statusKv.raw, statusBucket.raw]))
				yield* runScheduled(cron, lane, env, email, chatSessions, Option.some({ kv, bucket }))
			}).pipe(
				// Interrupts are isolate teardown, not a failed run.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: Effect.logError("Alerting scheduled run failed", cause).pipe(
								Effect.annotateLogs({
									"maple.alerting.cron": cron,
									"maple.alerting.lane": lane,
								}),
							),
				),
			)

		// One placed invocation per lane, so a stalled lane cannot hold up the others.
		// Answers whether the lane still has to run inline.
		const dispatchLane = (cron: string, lane: string, env: Record<string, unknown>) =>
			dispatchTick(cron, lane, env).pipe(
				Effect.andThen(Effect.annotateCurrentSpan("maple.alerting.dispatch", "placed")),
				Effect.as(false),
				Effect.catchTags({
					"@maple/alerting/errors/TickDispatchUnavailable": () =>
						Effect.annotateCurrentSpan("maple.alerting.dispatch", "inline").pipe(Effect.as(true)),
					// A failed hop is not retried inline: the placed handler may have run part of the lane.
					"@maple/alerting/errors/TickDispatchError": (error) =>
						Effect.logError("Placed alerting tick failed", error).pipe(
							Effect.annotateLogs({ "maple.alerting.cron": cron, "maple.alerting.lane": lane }),
							Effect.andThen(Effect.annotateCurrentSpan("maple.alerting.dispatch", "failed")),
							Effect.as(false),
						),
				}),
				Effect.withSpan("alerting.lane", {
					attributes: { "maple.alerting.cron": cron, "maple.alerting.lane": lane },
				}),
			)

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
				const schedule = scheduleFor(controller.cron)
				if (schedule === undefined) {
					return yield* Effect.logWarning("Skipping unknown alerting cron schedule").pipe(
						Effect.annotateLogs({ cron: controller.cron }),
					)
				}
				// The fire's own colo, beside the placed handler's, says whether the hop moved the tick.
				const fireColo = yield* isolateColo
				const inline = yield* Effect.filter(
					schedule.lanes,
					(lane) =>
						dispatchLane(controller.cron, lane, env).pipe(
							Effect.annotateSpans("maple.alerting.fire_colo", fireColo),
						),
					{
						concurrency: "unbounded",
					},
				)
				// One at a time: inline lanes share this invocation's six outbound
				// connections, and each lane's pool may open up to five.
				yield* Effect.forEach(
					inline,
					(lane) =>
						runTick(controller.cron, lane, env).pipe(
							Effect.annotateSpans({
								"maple.alerting.dispatch": "inline",
								"maple.colo": fireColo,
							}),
						),
					{ discard: true },
				)
			})

		// Reached only through `SELF_BINDING`: the Worker has no route and no workers.dev URL.
		const fetch = Effect.gen(function* () {
			const request = yield* Cloudflare.Request
			const env = yield* Cloudflare.WorkerEnvironment
			const tick = yield* authorizeTickRequest(request, env)
			const colo = yield* isolateColo
			yield* runTick(tick.cron, tick.lane, env).pipe(
				Effect.annotateSpans({
					"maple.alerting.dispatch": "placed",
					"maple.alerting.lane": tick.lane,
					"maple.colo": colo,
				}),
			)
			return HttpServerResponse.empty({ status: 204 })
		}).pipe(
			Effect.catchTag("@maple/alerting/errors/TickRequestRefused", ({ status }) =>
				Effect.succeed(HttpServerResponse.empty({ status })),
			),
		)

		yield* Effect.forEach(ALERTING_CRONS, (cron) => Cloudflare.Workers.cron(cron, onFire), {
			discard: true,
		})

		return { fetch }
	}).pipe(
		// The init is the entry point: the cron source needs the host Worker.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			Layer.mergeAll(
				Cloudflare.Hyperdrive.ConnectBinding,
				Cloudflare.Email.SendBinding,
				Cloudflare.KV.ReadWriteNamespaceBinding,
				Cloudflare.R2.ReadWriteBucketBinding,
				Cloudflare.Workers.CronEventSourceLive,
				FetchHttpClient.layer,
				WorkerTelemetry({
					serviceName: "alerting",
					anticipatedErrorIdentifiers: CHAT_ANTICIPATED_ERROR_IDENTIFIERS,
				}),
			),
		),
	),
) {}
