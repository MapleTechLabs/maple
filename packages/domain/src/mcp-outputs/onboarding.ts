import { Schema } from "effect"
import {
	OnboardingAgentRunStatus,
	OnboardingAgentStage,
	OnboardingAgentStageStatus,
} from "../onboarding-agent-run"

export const OnboardingRunOutput = Schema.Struct({
	status: OnboardingAgentRunStatus,
	stages: Schema.Array(
		Schema.Struct({
			stage: OnboardingAgentStage,
			status: OnboardingAgentStageStatus,
			note: Schema.NullOr(Schema.String),
		}),
	),
	serviceNames: Schema.Array(Schema.String),
	traceId: Schema.NullOr(Schema.String),
})

export const OnboardingStatusUpdateOutput = Schema.Struct({
	/** `no_run` and `closed` are not failures: the agent carries on with setup and stops reporting. */
	outcome: Schema.Literals(["reported", "no_run", "closed"]),
	message: Schema.String,
	run: Schema.NullOr(OnboardingRunOutput),
})

export const GetIngestSetupOutput = Schema.Struct({
	/** OTLP/HTTP base URL for the org's region. */
	ingestEndpoint: Schema.String,
	/** The public `maple_pk_…` key: write-only, safe in browser and mobile bundles. */
	publicIngestKey: Schema.String,
	dashboardUrl: Schema.String,
	ingestSettingsUrl: Schema.String,
	setupGuideUrl: Schema.String,
})
