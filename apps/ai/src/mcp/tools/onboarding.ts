import { Array as Arr, Effect, Schema } from "effect"
import {
	ONBOARDING_AGENT_NOTE_MAX,
	ONBOARDING_AGENT_SERVICES_MAX,
	ONBOARDING_AGENT_STAGES,
	ONBOARDING_SERVICE_NAME_MAX,
	ONBOARDING_SERVICE_NAME_PATTERN,
} from "@maple/domain/onboarding-agent-run"
import type { OnboardingRunOutput, OnboardingStatusUpdateOutput } from "@maple/domain/mcp-outputs"
import type { OnboardingAgentRunRow } from "@maple/db/tables"
import { IngestSetupService } from "@maple/backend/services/onboarding/IngestSetupService"
import { OnboardingAgentRunService } from "@maple/backend/services/onboarding/OnboardingAgentRunService"
import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const STATUS_TOOL = "onboarding_status_update"
const SETUP_TOOL = "get_ingest_setup"

export const SETUP_GUIDE_URL = "https://maple.dev/SKILL.md"
const REPORTED_STATUSES = ["active", "waiting", "completed", "skipped", "failed"] as const
const TRACE_ID = /^[0-9a-f]{32}$/
// The REST route's `service.name` rule: any printable name, at most 120 characters.
const isServiceName = (name: string): boolean =>
	name.length <= ONBOARDING_SERVICE_NAME_MAX && ONBOARDING_SERVICE_NAME_PATTERN.test(name)

const toRunOutput = (row: OnboardingAgentRunRow): typeof OnboardingRunOutput.Type => ({
	status: row.status,
	stages: Arr.map(row.stages, ({ stage, status, note }) => ({ stage, status, note })),
	serviceNames: row.serviceNames,
	traceId: row.traceId,
})

type StatusUpdate = typeof OnboardingStatusUpdateOutput.Type

const update = (
	outcome: StatusUpdate["outcome"],
	message: string,
	row: OnboardingAgentRunRow | null,
): StatusUpdate => ({ outcome, message, run: row === null ? null : toRunOutput(row) })

const invalid = (parameter: string, message: string) =>
	Effect.fail(new McpInvalidInputError({ message: `${STATUS_TOOL}: ${message}`, parameter }))

export function registerOnboardingTools(server: McpToolRegistrar) {
	server.define({
		name: STATUS_TOOL,
		title: "Onboarding Status Update",
		description:
			"Report a Maple setup stage to the onboarding run the user started from Maple's connect step, so the dashboard shows progress live. Call it as each stage starts and ends: connect_agent, analyze_project, instrument_app, send_verification, receive_verification, prepare_production. Pass services once known and trace_id once a verification trace is sent; run_status=completed (or failed) ends the run. Never blocks setup: with no run, or a closed one, it says so and you carry on without reporting.",
		parameters: Schema.Struct({
			stage: P.oneOf(ONBOARDING_AGENT_STAGES, "The setup stage this report is about"),
			status: P.oneOf(REPORTED_STATUSES, "Where the stage is now"),
			note: P.optionalText(
				`One short line for the user, at most ${ONBOARDING_AGENT_NOTE_MAX} characters. Never file contents, paths, terminal output, telemetry payloads or secrets`,
			),
			services: P.optionalList(
				`The service.name values the app reports, at most ${ONBOARDING_AGENT_SERVICES_MAX}`,
			),
			trace_id: P.optionalText("The verification trace's id: 32 lowercase hex characters"),
			run_status: P.optionalOneOf(
				["completed", "failed"],
				"Ends the run: the whole setup finished or failed",
			),
		}),
		// Reporting the same stage again overwrites it with the same values.
		hints: { readOnly: false, idempotent: true },
		scopeFamily: "onboarding",
		// Only the caller's own run, reported by the client they signed in.
		permission: "devices:connect",
		aliases: { service_names: "services" },
		phrases: ["Reporting setup progress"],
		handler: Effect.fn("McpTool.onboardingStatusUpdate")(function* (params) {
			if (params.note !== undefined && params.note.length > ONBOARDING_AGENT_NOTE_MAX) {
				return yield* invalid("note", `note is longer than ${ONBOARDING_AGENT_NOTE_MAX} characters.`)
			}
			if (params.services !== undefined && params.services.length > ONBOARDING_AGENT_SERVICES_MAX) {
				return yield* invalid(
					"services",
					`services lists more than ${ONBOARDING_AGENT_SERVICES_MAX} names.`,
				)
			}
			if (params.services !== undefined && !Arr.every(params.services, isServiceName)) {
				return yield* invalid(
					"services",
					`each service must be a service.name of at most ${ONBOARDING_SERVICE_NAME_MAX} characters, with no control or invisible characters.`,
				)
			}
			if (params.trace_id !== undefined && !TRACE_ID.test(params.trace_id)) {
				return yield* invalid("trace_id", "trace_id must be 32 lowercase hex characters.")
			}
			const tenant = yield* CurrentMcpTenant
			const runs = yield* OnboardingAgentRunService
			return yield* runs
				.report(
					// A handoff's key reports only to its own run; OAuth and session callers to their newest.
					{ orgId: tenant.orgId, userId: tenant.userId, apiKeyId: tenant.apiKeyId },
					{
						stage: params.stage,
						status: params.status,
						note: params.note,
						serviceNames: params.services,
						traceId: params.trace_id,
						runStatus: params.run_status,
					},
				)
				.pipe(
					Effect.map((row) =>
						update("reported", `Reported ${params.stage} as ${params.status}.`, row),
					),
					Effect.catchTags({
						"@maple/http/errors/OnboardingAgentRunNotFoundError": () =>
							Effect.succeed(
								update(
									"no_run",
									"No onboarding run for this user, so nothing to report. Carry on with setup and skip further status updates.",
									null,
								),
							),
						"@maple/http/errors/OnboardingAgentRunClosedError": (error) =>
							Effect.succeed(
								update(
									"closed",
									`This onboarding run is ${error.status}. Stop sending status updates; setup itself can carry on.`,
									null,
								),
							),
						"@maple/http/errors/OnboardingAgentRunUnavailableError": () =>
							Effect.fail(
								new McpUnavailableError({
									message: `${STATUS_TOOL}: onboarding runs are temporarily unavailable. Carry on with setup and report again later.`,
									capability: "onboarding_runs",
								}),
							),
					}),
				)
		}),
		render: (output) => ({
			title: "Onboarding Status",
			blocks: [
				doc.text(output.message),
				...(output.run === null
					? []
					: [
							doc.fields([
								["Run", output.run.status],
								[
									"Services",
									output.run.serviceNames.length === 0
										? undefined
										: Arr.join(output.run.serviceNames, ", "),
								],
								["Trace", output.run.traceId ?? undefined],
							]),
							doc.list(
								Arr.map(output.run.stages, (stage) =>
									stage.note === null
										? `${stage.stage}: ${stage.status}`
										: `${stage.stage}: ${stage.status} (${stage.note})`,
								),
							),
						]),
			],
		}),
	})

	server.define({
		name: SETUP_TOOL,
		title: "Get Ingest Setup",
		description:
			"The values a coding agent inlines to send this org's telemetry: the OTLP ingest endpoint for the org's region, the public ingest key (maple_pk_, write-only and safe in browser and mobile code), the dashboard URL and the setup guide. Never returns the private key. Verify the first data with list_services.",
		parameters: Schema.Struct({}),
		// Creates the org's ingest keys on first use, so a read-only token is refused.
		hints: { readOnly: false, idempotent: true },
		scopeFamily: "ingest_keys",
		// What the client the caller signed in needs to send data; never the private key.
		permission: "devices:connect",
		phrases: ["Reading ingest setup"],
		handler: Effect.fn("McpTool.getIngestSetup")(function* () {
			const tenant = yield* CurrentMcpTenant
			const setup = yield* IngestSetupService
			const found = yield* setup.forOrg(tenant.orgId, tenant.userId).pipe(
				Effect.catchTags({
					"@maple/http/errors/IngestKeyPersistenceError": () =>
						Effect.fail(
							new McpUnavailableError({
								message: `${SETUP_TOOL}: ingest keys are temporarily unavailable. Copy the key from Settings > Ingestion instead.`,
								capability: "ingest_keys",
							}),
						),
					"@maple/http/errors/IngestKeyEncryptionError": () =>
						Effect.fail(
							new McpUnavailableError({
								message: `${SETUP_TOOL}: Maple could not read the ingest keys. Copy the key from Settings > Ingestion instead.`,
								capability: "ingest_keys",
							}),
						),
				}),
			)
			return {
				ingestEndpoint: found.ingestEndpoint,
				publicIngestKey: found.publicIngestKey,
				dashboardUrl: found.dashboardUrl,
				ingestSettingsUrl: `${found.dashboardUrl}/settings/ingestion`,
				setupGuideUrl: SETUP_GUIDE_URL,
			}
		}),
		render: (output) => ({
			title: "Ingest Setup",
			blocks: [
				doc.fields([
					["Ingest endpoint", output.ingestEndpoint],
					["Public ingest key", output.publicIngestKey],
					["Dashboard", output.dashboardUrl],
					["Ingest settings", output.ingestSettingsUrl],
					["Setup guide", output.setupGuideUrl],
				]),
				doc.text(
					"Inline the endpoint and the public key in the app's telemetry bootstrap. The public key is write-only and safe in client code.",
				),
			],
			next: [doc.next("list_services", {}, "confirm the app's first telemetry arrived")],
		}),
	})
}
