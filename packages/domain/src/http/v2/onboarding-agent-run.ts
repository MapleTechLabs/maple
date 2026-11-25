import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	ONBOARDING_AGENT_NOTE_MAX,
	ONBOARDING_AGENT_SERVICES_MAX,
	ONBOARDING_SERVICE_NAME_MAX,
	ONBOARDING_SERVICE_NAME_PATTERN,
	OnboardingAgentReportedStatus,
	OnboardingAgentRunClosedError,
	OnboardingAgentRunNotFoundError,
	OnboardingAgentRunRateLimitedError,
	OnboardingAgentRunStatus,
	OnboardingAgentRunUnavailableError,
	OnboardingAgentStage,
	OnboardingAgentStageStatus,
} from "../../onboarding-agent-run"
import { EndpointAccess } from "../endpoint-access"
import { AuthorizationV2 } from "./auth"
import { Timestamp, wireExample } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"

export const V2OnboardingAgentStage = Schema.Struct({
	object: Schema.Literal("onboarding_agent_stage").annotate({
		description: 'The object type, always `"onboarding_agent_stage"`.',
		examples: ["onboarding_agent_stage"],
	}),
	id: OnboardingAgentStage.annotate({ description: "The stage.", examples: ["instrument_app"] }),
	status: OnboardingAgentStageStatus.annotate({
		description: "`pending` until the agent first reports the stage, then the status it reported last.",
		examples: ["active"],
	}),
	note: Schema.NullOr(Schema.String).annotate({
		description: "The agent's short note on the stage, or `null`.",
		examples: ["Instrumenting 3 services"],
	}),
	updated_at: Schema.NullOr(Timestamp).annotate({ description: "When the agent last reported the stage." }),
}).annotate({
	identifier: "OnboardingAgentStage",
	title: "Onboarding agent stage",
	description: "One stage of a coding agent's Maple setup.",
})
export type V2OnboardingAgentStage = Schema.Schema.Type<typeof V2OnboardingAgentStage>

export const V2OnboardingAgentRun = Schema.Struct({
	object: Schema.Literal("onboarding_agent_run").annotate({
		description: 'The object type, always `"onboarding_agent_run"`.',
		examples: ["onboarding_agent_run"],
	}),
	status: OnboardingAgentRunStatus.annotate({
		description:
			"`waiting_for_agent` until the first report, `in_progress` after it, `completed` or `failed` once the agent says so. `expired` when no agent signed in with the code before it lapsed, a day after the run started, or once a newer run replaced it.",
		examples: ["in_progress"],
	}),
	created_at: Timestamp.annotate({ description: "When the prompt was copied." }),
	expires_at: Timestamp.annotate({ description: "When the run stops taking reports." }),
	last_reported_at: Schema.NullOr(Timestamp).annotate({
		description: "The agent's latest report, or `null`.",
	}),
	stages: Schema.Array(V2OnboardingAgentStage).annotate({ description: "Every stage, in setup order." }),
	service_names: Schema.Array(Schema.String).annotate({
		description: "The `service.name` values the agent configured.",
		examples: [["checkout-api", "web"]],
	}),
	trace_id: Schema.NullOr(Schema.String).annotate({
		description: "The verification trace the agent found in Maple, or `null`.",
		examples: ["4bf92f3577b34da6a3ce929d0e0e4736"],
	}),
}).annotate({
	identifier: "OnboardingAgentRun",
	title: "Onboarding agent run",
	description:
		"A coding agent's Maple setup, reported by the agent stage by stage. Self-reported progress, shown on the connect step.",
	examples: [
		wireExample({
			object: "onboarding_agent_run",
			status: "in_progress",
			created_at: "2026-11-22T10:00:00.000Z",
			expires_at: "2026-11-23T10:00:00.000Z",
			last_reported_at: "2026-11-22T10:04:00.000Z",
			stages: [
				{
					object: "onboarding_agent_stage",
					id: "connect_agent",
					status: "completed",
					note: null,
					updated_at: "2026-11-22T10:01:00.000Z",
				},
				{
					object: "onboarding_agent_stage",
					id: "instrument_app",
					status: "active",
					note: "Instrumenting 2 services",
					updated_at: "2026-11-22T10:04:00.000Z",
				},
			],
			service_names: ["checkout-api"],
			trace_id: null,
		}),
	],
})
export type V2OnboardingAgentRun = Schema.Schema.Type<typeof V2OnboardingAgentRun>

export const V2OnboardingAgentHandoff = Schema.Struct({
	object: Schema.Literal("onboarding_agent_handoff").annotate({
		description: 'The object type, always `"onboarding_agent_handoff"`.',
		examples: ["onboarding_agent_handoff"],
	}),
	handoff_code: Schema.String.annotate({
		description:
			"Signs the `maple` CLI in as you, once, within an hour: `MAPLE_HANDOFF=<code> maple auth login`. Returned only here; treat it like a password.",
	}),
	handoff_expires_at: Timestamp.annotate({ description: "When the code stops signing a CLI in." }),
	run: V2OnboardingAgentRun,
}).annotate({
	identifier: "OnboardingAgentHandoff",
	title: "Onboarding agent handoff",
	description: "A new onboarding run and the single-use code that hands it to a coding agent.",
})
export type V2OnboardingAgentHandoff = Schema.Schema.Type<typeof V2OnboardingAgentHandoff>

// Any OpenTelemetry `service.name` the user set, without control characters (rendered as text).
const ServiceName = Schema.String.check(
	Schema.isMaxLength(ONBOARDING_SERVICE_NAME_MAX),
	Schema.isPattern(ONBOARDING_SERVICE_NAME_PATTERN),
)
const HexTraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))

export const V2OnboardingAgentReport = Schema.Struct({
	stage: OnboardingAgentStage.annotate({
		description: "The stage being reported.",
		examples: ["instrument_app"],
	}),
	status: OnboardingAgentReportedStatus.annotate({
		description: "Its status now. Retry a `failed` stage by reporting it `active` again.",
		examples: ["completed"],
	}),
	note: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(ONBOARDING_AGENT_NOTE_MAX)).annotate({
			description:
				"A short, plain note for the user. Never file contents, paths, terminal output, telemetry payloads or secrets.",
			examples: ["Instrumenting 2 services"],
		}),
	),
	service_names: Schema.optionalKey(
		Schema.Array(ServiceName).check(Schema.isMaxLength(ONBOARDING_AGENT_SERVICES_MAX)).annotate({
			description: "The `service.name` values configured so far; merged into the run's list.",
		}),
	),
	trace_id: Schema.optionalKey(
		HexTraceId.annotate({
			description: "The verification trace found in Maple, 32 lowercase hex characters.",
			examples: ["4bf92f3577b34da6a3ce929d0e0e4736"],
		}),
	),
	run_status: Schema.optionalKey(
		Schema.Literals(["completed", "failed"]).annotate({
			description:
				"Close the run: `completed` after the last stage, `failed` only when the setup cannot continue.",
		}),
	),
}).annotate({ identifier: "OnboardingAgentReport", title: "Onboarding agent report" })
export type V2OnboardingAgentReport = Schema.Schema.Type<typeof V2OnboardingAgentReport>

export class V2OnboardingAgentRunApiGroup extends HttpApiGroup.make("onboardingAgentRun")
	.add(
		HttpApiEndpoint.post("start", "/", {
			success: V2OnboardingAgentHandoff,
			error: [
				V2InsufficientPermissions.schema,
				...publicErrors(OnboardingAgentRunRateLimitedError, OnboardingAgentRunUnavailableError),
			],
		})
			.annotate(EndpointAccess, "personal")
			.annotateMerge(
				OpenApi.annotations({
					identifier: "startOnboardingAgentRun",
					summary: "Start an onboarding agent run",
					description:
						"Starts a run for the signed-in person, closing any open one, and returns a single-use handoff code that signs the `maple` CLI in as them within the next hour. " +
						"Takes a signed-in session: an API key is refused. Requires the `onboarding:write` scope.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2OnboardingAgentRun,
			error: publicErrors(OnboardingAgentRunNotFoundError, OnboardingAgentRunUnavailableError),
		})
			.annotate(EndpointAccess, "personal")
			.annotateMerge(
				OpenApi.annotations({
					identifier: "getOnboardingAgentRun",
					summary: "Retrieve your onboarding agent run",
					description:
						"Returns the caller's latest onboarding run. Requires the `onboarding:read` scope.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.post("report", "/status", {
			payload: V2OnboardingAgentReport,
			success: V2OnboardingAgentRun,
			error: publicErrors(
				OnboardingAgentRunNotFoundError,
				OnboardingAgentRunClosedError,
				OnboardingAgentRunUnavailableError,
			),
		})
			.annotate(EndpointAccess, "personal")
			.annotateMerge(
				OpenApi.annotations({
					identifier: "reportOnboardingAgentRun",
					summary: "Report onboarding progress",
					description:
						"Records a stage of the caller's latest open run. Answers `409 onboarding_agent_run_closed` once the run is completed, failed or expired: stop reporting then. " +
						"Requires the `onboarding:write` scope.",
				}),
			),
	)
	.prefix("/v2/onboarding/agent_run")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Onboarding Agent Run",
			description:
				"A coding agent's Maple setup: the handoff that starts it and the progress it reports.",
		}),
	) {}
