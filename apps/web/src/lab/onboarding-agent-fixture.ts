import { timestamp, type V2OnboardingAgentHandoff, type V2OnboardingAgentRun } from "@maple/domain/http/v2"
import {
	ONBOARDING_AGENT_STAGES,
	type OnboardingAgentStage,
	type OnboardingAgentStageStatus,
} from "@maple/domain/onboarding-agent-run"
import { Array as Arr, Schema } from "effect"

// `/lab/onboarding?step=connect&agent=<state>`: sample agent runs for the connect step's progress list.

export const LAB_AGENT_STATES = [
	"none",
	"control",
	"waiting",
	"progress",
	"completed",
	"expired",
	"unclaimed",
] as const
export const LabAgentState = Schema.Literals(LAB_AGENT_STATES)
export type LabAgentState = typeof LabAgentState.Type

const NOTES = {
	connect_agent: null,
	analyze_project: "Found 2 services: checkout-api and web",
	instrument_app: "Added OpenTelemetry to checkout-api",
	send_verification: "Sent GET /checkout from the running app",
	receive_verification: null,
	prepare_production: "You chose to deploy later",
} as const satisfies Record<OnboardingAgentStage, string | null>

const run = (
	status: V2OnboardingAgentRun["status"],
	statuses: ReadonlyArray<OnboardingAgentStageStatus>,
	extra: Partial<Pick<V2OnboardingAgentRun, "service_names" | "trace_id">> & {
		readonly notes?: Partial<Record<OnboardingAgentStage, string>>
	} = {},
): V2OnboardingAgentRun => ({
	object: "onboarding_agent_run",
	status,
	created_at: timestamp("2026-11-22T10:00:00.000Z"),
	expires_at: timestamp("2026-11-23T10:00:00.000Z"),
	last_reported_at: statuses.length === 0 ? null : timestamp("2026-11-22T10:04:00.000Z"),
	stages: Arr.map(ONBOARDING_AGENT_STAGES, (id, index) => {
		const stageStatus = statuses[index] ?? "pending"
		return {
			object: "onboarding_agent_stage",
			id,
			status: stageStatus,
			note: stageStatus === "pending" ? null : (extra.notes?.[id] ?? NOTES[id]),
			updated_at: stageStatus === "pending" ? null : timestamp("2026-11-22T10:04:00.000Z"),
		}
	}),
	service_names: extra.service_names ?? [],
	trace_id: extra.trace_id ?? null,
})

/** The sample run of a lab state with one (`none` and `control` show the prompt alone). */
export const labAgentRun = (state: Exclude<LabAgentState, "none" | "control">): V2OnboardingAgentRun => {
	switch (state) {
		case "waiting":
			return run("waiting_for_agent", [])
		case "progress":
			return run("in_progress", ["completed", "completed", "completed", "failed", "active"], {
				service_names: ["checkout-api"],
				notes: { send_verification: "The dev server would not start on port 3000" },
			})
		case "completed":
			return run(
				"completed",
				["completed", "completed", "completed", "completed", "completed", "skipped"],
				{
					service_names: ["checkout-api", "web"],
					trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
				},
			)
		case "expired":
			return run("expired", ["completed", "active"])
		case "unclaimed":
			return run("expired", [])
	}
}

/** Copy prompt in the lab: a sample code and a fresh waiting run, nothing is minted. */
export const labHandoff = (): V2OnboardingAgentHandoff => ({
	object: "onboarding_agent_handoff",
	handoff_code: "maple_ho_lab_sample_code",
	handoff_expires_at: timestamp("2026-11-22T12:00:00.000Z"),
	run: { ...run("waiting_for_agent", []), created_at: timestamp("2026-11-22T11:00:00.000Z") },
})
