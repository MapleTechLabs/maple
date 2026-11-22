import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"

export const HttpOrgClickHouseSettingsLive = HttpApiBuilder.group(
	MapleInternalApi,
	"orgClickHouseSettings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* OrgClickHouseSettingsService

			return handlers
				.handle("get", () => service.get)
				.handle("upsert", ({ payload }) =>
					Effect.gen(function* () {
						const updated = yield* service.upsert(payload)
						// URL/user/database identify the connection; the password in the
						// payload is write-only and never reaches an audit row.
						yield* recordHttpAudit("warehouse_settings.updated", {
							metadata: { url: payload.url, user: payload.user, database: payload.database },
						})
						return updated
					}),
				)
				.handle("schemaDiff", () => service.schemaDiff)
				.handle("applySchema", () =>
					Effect.gen(function* () {
						const applied = yield* service.applySchema
						yield* recordHttpAudit("warehouse_settings.schema_applied")
						return applied
					}),
				)
				.handle("applySchemaStatus", () => service.applySchemaStatus)
				.handle("collectorConfig", () => service.collectorConfig)
				.handle("delete", () =>
					Effect.gen(function* () {
						const deleted = yield* service.delete
						yield* recordHttpAudit("warehouse_settings.deleted")
						return deleted
					}),
				)
		}),
)
