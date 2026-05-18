import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant, MapleApi } from "@maple/domain/http"
import { Effect } from "effect"
import { IngestAttributeMappingService } from "../services/IngestAttributeMappingService"

export const HttpIngestAttributeMappingsLive = HttpApiBuilder.group(
	MapleApi,
	"ingestAttributeMappings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* IngestAttributeMappingService

			return handlers
				.handle("list", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.list(tenant.orgId)
					}),
				)
				.handle("create", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.create(tenant.orgId, payload)
					}),
				)
				.handle("update", ({ params, payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.update(tenant.orgId, params.mappingId, payload)
					}),
				)
				.handle("delete", ({ params }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.delete(tenant.orgId, params.mappingId)
					}),
				)
		}),
)
