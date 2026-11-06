import { HttpApiBuilder } from "effect/http-api"
import { AiTriageForbiddenError, CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { AiTriageService } from "@maple/backend/services/errors/AiTriageService"
import * as Policy from "@maple/domain/policy"

export const HttpAiTriageLive = HttpApiBuilder.group(MapleInternalApi, "aiTriage", (handlers) =>
	Effect.gen(function* () {
		const triage = yield* AiTriageService

		return handlers
			.handle("getSettings", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					return yield* triage.getSettings(tenant.orgId)
				}).pipe(Effect.withSpan("HttpAiTriage.getSettings")),
			)
			.handle("updateSettings", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
					yield* Policy.check(
						tenant.roles,
						"ai_triage:configure",
						(denial) =>
							new AiTriageForbiddenError({
								message: denial.message,
							}),
					)
					return yield* triage.updateSettings(tenant.orgId, tenant.userId, payload)
				}).pipe(Effect.withSpan("HttpAiTriage.updateSettings")),
			)
	}),
)
