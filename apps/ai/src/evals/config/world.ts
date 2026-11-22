/**
 * The configured org the configuration tasks run in: destinations, ingest sources, an alert rule,
 * a maintenance window, a silence, ingest rules and dashboards, each named so a task can refer to
 * it the way a person would. Seeded through the same services and tools a real org is, so what a
 * task finds is what production stores.
 */
import { Effect, Option, Schema } from "effect"
import { RoleName, WebhookAlertDestinationConfig } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { asCaller, runToolDirect, type EvalRuntime } from "../../mcp/__evals__/eval-runtime"

/** An admin: the role every configuration change is allowed under. */
export const ADMIN_CALLER = { roles: [Schema.decodeSync(RoleName)("org:admin")] }

export const CONFIG_WORLD = {
	/** In use by the alert rule, so deleting it is refused. */
	destination: "ops-webhook",
	/** Used by nothing: the one a cleanup may delete. */
	unusedDestination: "legacy-webhook",
	rule: "Checkout errors",
	/** A second rule, on another service, so "the alert" is never the only one. */
	otherRule: "Subscriptions latency",
	source: "staging-collector",
	otherSource: "payments-worker",
	/** Paused when the world is seeded: the one to resume. */
	pausedSource: "batch-importer",
	window: "Weekly deploy",
	silenceReason: "Load test on checkout",
	dropRule: "Drop health checks",
	redactRule: "Redact emails",
	dashboard: "Checkout overview",
	staleDashboard: "Old experiments",
} as const

/** A tool result that failed, with the message the model would have been shown. */
const decodeFailure = Schema.decodeUnknownOption(
	Schema.Struct({
		isError: Schema.Literal(true),
		content: Schema.Array(Schema.Struct({ text: Schema.String })),
	}),
)

/** Run a seeding tool and fail loudly: a world missing a row makes its tasks unsolvable. */
const seedTool = async (rt: EvalRuntime, name: string, params: unknown): Promise<void> => {
	const result: unknown = await runToolDirect(rt, name, params)
	const failure = decodeFailure(result)
	if (Option.isSome(failure)) {
		throw new Error(`config world: ${name} failed: ${failure.value.content[0]?.text ?? "no message"}`)
	}
}

export const seedConfigWorld = async (base: EvalRuntime): Promise<void> => {
	const rt = asCaller(base, ADMIN_CALLER)
	const { orgId, userId } = rt.tenant

	const [destination] = await rt.runtime.runPromise(
		Effect.gen(function* () {
			const destinations = yield* AlertDestinationsService
			const sources = yield* SourcesService
			const used = yield* destinations.createDestination(
				new WebhookAlertDestinationConfig({
					type: "webhook",
					name: CONFIG_WORLD.destination,
					url: "https://hooks.example.com/maple/ops",
				}),
			)
			yield* destinations.createDestination(
				new WebhookAlertDestinationConfig({
					type: "webhook",
					name: CONFIG_WORLD.unusedDestination,
					url: "https://hooks.example.com/maple/legacy",
				}),
			)
			yield* sources.create(orgId, userId, { name: CONFIG_WORLD.source, platform: "opentelemetry" })
			yield* sources.create(orgId, userId, { name: CONFIG_WORLD.otherSource, platform: "nodejs" })
			const paused = yield* sources.create(orgId, userId, {
				name: CONFIG_WORLD.pausedSource,
				platform: "python",
			})
			yield* sources.pause(orgId, userId, paused.source.id, null)
			return [used] as const
		}).pipe(Effect.provideService(Policy.CurrentActor, rt.tenant)),
	)

	await seedTool(rt, "create_alert_rule", {
		name: CONFIG_WORLD.rule,
		template: "high_error_rate",
		services: ["checkout"],
		destination_ids: [destination.id],
	})
	await seedTool(rt, "create_alert_rule", {
		name: CONFIG_WORLD.otherRule,
		template: "slow_p95",
		services: ["subscriptions-api"],
		destination_ids: [destination.id],
	})
	await seedTool(rt, "manage_maintenance_window", {
		action: "create",
		name: CONFIG_WORLD.window,
		reason: "Thursday release train",
		schedule_type: "weekly",
		days: ["thu"],
		start_time_of_day: "14:00",
		duration_minutes: 60,
		services: ["checkout"],
	})
	await seedTool(rt, "manage_alert_silence", {
		action: "create",
		reason: CONFIG_WORLD.silenceReason,
		services: ["checkout"],
		duration_minutes: 120,
	})
	await seedTool(rt, "manage_ingest_rule", {
		action: "create",
		name: CONFIG_WORLD.dropRule,
		signals: ["traces"],
		conditions: '[{"field":"attribute","key":"http.route","op":"in","values":["/health"]}]',
		rule_action: '{"type":"drop","keep_percent":0}',
	})
	await seedTool(rt, "manage_ingest_rule", {
		action: "create",
		name: CONFIG_WORLD.redactRule,
		signals: ["logs"],
		rule_action:
			'{"type":"redact","keys":[],"detectors":["email"],"patterns":[],"scopes":["body"],"method":"mask"}',
	})
	await seedTool(rt, "create_dashboard", { name: CONFIG_WORLD.dashboard, template: "blank" })
	await seedTool(rt, "create_dashboard", { name: CONFIG_WORLD.staleDashboard, template: "blank" })
}
