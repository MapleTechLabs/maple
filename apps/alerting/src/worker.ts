import {
	AlertRuntime,
	AlertsService,
	BucketCacheService,
	DatabaseD1Live,
	DigestService,
	EdgeCacheService,
	EmailService,
	Env,
	ErrorsService,
	HazelOAuthService,
	NotificationDispatcher,
	OnboardingEmailService,
	OnboardingService,
	OrgClickHouseSettingsService,
	QueryEngineService,
	ServiceMapRollupService,
	WarehouseQueryService,
} from "@maple/api/alerting"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { Worker, WorkerEnvironment } from "@maple/effect-cf"
import { Cause, Effect, Layer } from "effect"

// Module-scope construction; `flush(env)` resolves env on first call. The
// in-isolate buffers coalesce concurrent scheduled ticks into one POST per
// signal.
const telemetry = MapleCloudflareSDK.make({ serviceName: "alerting" })

// `Worker.make` supplies the `ConfigProvider` (from the worker `env`) and the
// `WorkerEnvironment` service, so `Env.layer`'s `Config` reads and
// `DatabaseD1Live`'s binding lookup resolve without manual wiring.
const buildLayer = () => {
	const EnvLive = Env.layer

	const DatabaseLive = DatabaseD1Live

	const BaseLive = Layer.mergeAll(EnvLive, DatabaseLive)

	const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(Layer.provide(BaseLive))

	const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, OrgClickHouseSettingsLive)),
	)

	const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provide(EdgeCacheService.layer))

	const QueryEngineServiceLive = QueryEngineService.layer.pipe(
		Layer.provide(WarehouseQueryServiceLive),
		Layer.provide(EdgeCacheService.layer),
		Layer.provide(BucketCacheServiceLive),
	)

	const HazelOAuthServiceLive = HazelOAuthService.layer.pipe(Layer.provide(BaseLive))

	const AlertsServiceLive = AlertsService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				QueryEngineServiceLive,
				WarehouseQueryServiceLive,
				AlertRuntime.layer,
				HazelOAuthServiceLive,
			),
		),
	)

	const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, HazelOAuthServiceLive)),
	)

	const ErrorsServiceLive = ErrorsService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive, NotificationDispatcherLive)),
	)

	const EmailServiceLive = EmailService.layer.pipe(Layer.provide(EnvLive))

	const DigestServiceLive = DigestService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive, EmailServiceLive)),
	)

	const OnboardingServiceLive = OnboardingService.layer.pipe(Layer.provide(BaseLive))

	const OnboardingEmailServiceLive = OnboardingEmailService.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				BaseLive,
				EmailServiceLive,
				OnboardingServiceLive,
				WarehouseQueryServiceLive,
			),
		),
	)

	const ServiceMapRollupServiceLive = ServiceMapRollupService.layer.pipe(
		Layer.provide(Layer.mergeAll(BaseLive, WarehouseQueryServiceLive)),
	)

	return Layer.mergeAll(
		AlertsServiceLive,
		DigestServiceLive,
		OnboardingEmailServiceLive,
		ErrorsServiceLive,
		ServiceMapRollupServiceLive,
	).pipe(Layer.provideMerge(telemetry.layer))
}

const alertTick = Effect.gen(function* () {
	const alerts = yield* AlertsService
	const result = yield* alerts.runSchedulerTick()
	yield* Effect.logInfo("Alerting worker tick complete").pipe(
		Effect.annotateLogs({
			evaluatedCount: result.evaluatedCount,
			processedCount: result.processedCount,
			evaluationFailureCount: result.evaluationFailureCount,
			deliveryFailureCount: result.deliveryFailureCount,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.scheduler_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Alerting worker tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const errorTick = Effect.gen(function* () {
	const errors = yield* ErrorsService
	const result = yield* errors.runTick()
	yield* Effect.logInfo("Errors worker tick complete").pipe(
		Effect.annotateLogs({
			orgsProcessed: result.orgsProcessed,
			issuesTouched: result.issuesTouched,
			incidentsOpened: result.incidentsOpened,
			incidentsResolved: result.incidentsResolved,
			issuesReopened: result.issuesReopened,
			issuesArchived: result.issuesArchived,
			issuesDeleted: result.issuesDeleted,
			retentionRan: result.retentionRan,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.error_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Errors worker tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const digestTick = Effect.gen(function* () {
	const digest = yield* DigestService
	const result = yield* digest.runDigestTick()
	yield* Effect.logInfo("Digest tick complete").pipe(
		Effect.annotateLogs({
			sentCount: result.sentCount,
			errorCount: result.errorCount,
			skipped: result.skipped,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.digest_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Digest tick failed").pipe(Effect.annotateLogs({ error: Cause.pretty(cause) })),
	),
)

const onboardingTick = Effect.gen(function* () {
	const onboardingEmails = yield* OnboardingEmailService
	const result = yield* onboardingEmails.runOnboardingTick()
	yield* Effect.logInfo("Onboarding tick complete").pipe(
		Effect.annotateLogs({
			ensuredCount: result.ensuredCount,
			sentCount: result.sentCount,
			errorCount: result.errorCount,
			firstDataDetected: result.firstDataDetected,
			skipped: result.skipped,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.onboarding_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Onboarding tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const serviceMapRollupTick = Effect.gen(function* () {
	const rollup = yield* ServiceMapRollupService
	const result = yield* rollup.runRollupTick()
	yield* Effect.logInfo("Service map rollup tick complete").pipe(
		Effect.annotateLogs({
			orgsProcessed: result.orgsProcessed,
			hoursRolledUp: result.hoursRolledUp,
			edgesWritten: result.edgesWritten,
			orgFailures: result.orgFailures,
		}),
	)
}).pipe(
	Effect.withSpan("alerting.service_map_rollup_tick"),
	Effect.catchCause((cause) =>
		Effect.logError("Service map rollup tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

const AppLayer = buildLayer()

// Yield one macrotask so Effect's scheduler drains `scheduleTask(fn, 0)` work
// (e.g. span ends) before the OTLP buffer flush, keeping spans non-parentless.
const drainMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const scheduled = (controller: globalThis.ScheduledController) =>
	Effect.gen(function* () {
		const workerCtx = yield* Worker.WorkerContext
		const env = (yield* WorkerEnvironment) as Record<string, unknown>

		// Dispatch the cron tick inside a `gen` so the branches' differing service
		// requirements accumulate into a single unioned `R` (passing the ternary's
		// union of effects to a generic `<R>` param doesn't unify — `R` is
		// contravariant).
		const tick = Effect.gen(function* () {
			switch (controller.cron) {
				case "*/15 * * * *":
					yield* digestTick
					break
				case "0 * * * *":
					yield* serviceMapRollupTick
					break
				case "0 9 * * *":
					yield* onboardingTick
					break
				default:
					yield* Effect.all([alertTick, errorTick], { concurrency: 2, discard: true })
			}
		})

		// Flush always runs — even if a tick escalates to a defect — matching the
		// previous `finally { ctx.waitUntil(telemetry.flush(env)) }`.
		yield* tick.pipe(
			Effect.ensuring(
				workerCtx.waitUntil(
					Effect.promise(() => drainMacrotask().then(() => telemetry.flush(env))),
				),
			),
		)
	})

export default Worker.make(AppLayer, {
	scheduled,
	fetch: Effect.succeed(new Response("maple-alerting: scheduled only", { status: 404 })),
})
