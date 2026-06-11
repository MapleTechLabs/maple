import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AnomalyForbiddenError, CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AnomalyDetectionService } from "../services/AnomalyDetectionService"
import { requireAdmin } from "../lib/auth"

export const HttpAnomaliesLive = HttpApiBuilder.group(MapleApi, "anomalies", (handlers) =>
	Effect.gen(function* () {
		const anomalies = yield* AnomalyDetectionService

		return handlers
			.handle("listIncidents", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						status: query.status ?? "all",
						signalType: query.signalType ?? "all",
					})
					const response = yield* anomalies.listIncidents(tenant.orgId, {
						status: query.status,
						signalType: query.signalType,
						service: query.service,
						deploymentEnv: query.deploymentEnv,
						startTime: query.startTime,
						endTime: query.endTime,
						limit: query.limit,
					})
					yield* Effect.annotateCurrentSpan("incidentCount", response.incidents.length)
					return response
				}).pipe(Effect.withSpan("HttpAnomalies.listIncidents")),
			)
			.handle("getIncident", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({
						orgId: tenant.orgId,
						incidentId: params.incidentId,
					})
					return yield* anomalies.getIncident(tenant.orgId, params.incidentId)
				}).pipe(Effect.withSpan("HttpAnomalies.getIncident")),
			)
			.handle("getSettings", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* anomalies.getSettings(tenant.orgId)
				}).pipe(Effect.withSpan("HttpAnomalies.getSettings")),
			)
			.handle("updateSettings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					yield* requireAdmin(
						tenant.roles,
						() =>
							new AnomalyForbiddenError({
								message: "Only org admins can manage anomaly detector settings",
							}),
					)
					return yield* anomalies.updateSettings(tenant.orgId, tenant.userId, payload)
				}).pipe(Effect.withSpan("HttpAnomalies.updateSettings")),
			)
	}),
)
