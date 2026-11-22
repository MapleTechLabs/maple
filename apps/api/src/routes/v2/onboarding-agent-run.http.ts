import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, isoTimestamp, isoTimestampOrNull } from "@maple/domain/http/v2"
import type { V2OnboardingAgentRun } from "@maple/domain/http/v2"
import { OnboardingAgentRunUnavailableError } from "@maple/domain/onboarding-agent-run"
import type { OnboardingAgentRunRow } from "@maple/db/tables"
import { Array as Arr, Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CliDeviceAuthService, HANDOFF_DEVICE_NAME } from "@maple/backend/services/auth/CliDeviceAuthService"
import { OnboardingAgentRunService } from "@maple/backend/services/onboarding/OnboardingAgentRunService"
import { requirePerson } from "./require-person"

export const toV2OnboardingAgentRun = (row: OnboardingAgentRunRow): V2OnboardingAgentRun => ({
	object: "onboarding_agent_run",
	status: row.status,
	created_at: isoTimestamp(row.createdAt),
	expires_at: isoTimestamp(row.expiresAt),
	last_reported_at: isoTimestampOrNull(row.lastReportedAt),
	stages: Arr.map(row.stages, (stage) => ({
		object: "onboarding_agent_stage",
		id: stage.stage,
		status: stage.status,
		note: stage.note,
		updated_at: isoTimestampOrNull(stage.updatedAt),
	})),
	service_names: row.serviceNames,
	trace_id: row.traceId,
})

export const HttpV2OnboardingAgentRunLive = HttpApiBuilder.group(
	MapleApiV2,
	"onboardingAgentRun",
	(handlers) =>
		Effect.gen(function* () {
			const runs = yield* OnboardingAgentRunService
			const cliAuth = yield* CliDeviceAuthService
			const auth = yield* AuthService

			return handlers
				.handle("start", () =>
					Effect.gen(function* () {
						// The code signs a CLI in as the caller, so only the caller's own session may mint it.
						yield* requirePerson
						const tenant = yield* CurrentTenant.Context
						const userEmail = yield* auth.getUserEmail(tenant.userId)
						const handoff = yield* cliAuth
							.createHandoff({
								orgId: tenant.orgId,
								userId: tenant.userId,
								roles: tenant.roles,
								userEmail,
							})
							.pipe(
								Effect.mapError(
									(error) =>
										new OnboardingAgentRunUnavailableError({
											message: error.message,
											operation: "handoff",
											cause: null,
										}),
								),
							)
						const run = yield* runs.start({ orgId: tenant.orgId, userId: tenant.userId })
						yield* recordHttpAudit("cli_session.approved", {
							metadata: { deviceName: HANDOFF_DEVICE_NAME, roles: [...tenant.roles] },
						})
						return {
							object: "onboarding_agent_handoff" as const,
							handoff_code: handoff.code,
							handoff_expires_at: isoTimestamp(handoff.expiresAt),
							run: toV2OnboardingAgentRun(run),
						}
					}),
				)
				.handle("retrieve", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const run = yield* runs.current(tenant)
						return toV2OnboardingAgentRun(run)
					}),
				)
				.handle("report", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const row = yield* runs.report(tenant, {
							stage: payload.stage,
							status: payload.status,
							note: payload.note,
							serviceNames: payload.service_names,
							traceId: payload.trace_id,
							runStatus: payload.run_status,
						})
						return toV2OnboardingAgentRun(row)
					}),
				)
		}),
)
