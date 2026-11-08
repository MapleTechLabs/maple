import { HttpApiBuilder } from "effect/http-api"
import type { IngestKeysResponse } from "@maple/domain/http"
import { CurrentTenant } from "@maple/domain/http"
import { MapleApiV2, V2InsufficientPermissions } from "@maple/domain/http/v2"
import type { V2IngestKeys, V2PublicIngestKey } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import * as Policy from "@maple/domain/policy"

const toV2IngestKeys = (keys: IngestKeysResponse): V2IngestKeys => ({
	object: "ingest_keys",
	public_key: keys.publicKey,
	private_key: keys.privateKey,
	public_rotated_at: keys.publicRotatedAt,
	private_rotated_at: keys.privateRotatedAt,
})

export const HttpV2IngestKeysLive = HttpApiBuilder.group(MapleApiV2, "ingestKeys", (handlers) =>
	Effect.gen(function* () {
		const ingestKeys = yield* OrgIngestKeysService

		return handlers
			.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "ingest_keys:view", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const keys = yield* ingestKeys.getOrCreate(tenant.orgId, tenant.userId)

					return toV2IngestKeys(keys)
				}),
			)
			.handle("retrievePublic", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "ingest_keys:view_public", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const keys = yield* ingestKeys.getOrCreate(tenant.orgId, tenant.userId)

					return {
						object: "public_ingest_key",
						public_key: keys.publicKey,
						public_rotated_at: keys.publicRotatedAt,
					} satisfies V2PublicIngestKey
				}),
			)
			.handle("rollPublic", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "ingest_keys:roll", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const keys = yield* ingestKeys.rerollPublic(tenant.orgId, tenant.userId)
					yield* recordHttpAudit("ingest_key.rolled", {
						metadata: { key_type: "public" },
					})

					return toV2IngestKeys(keys)
				}),
			)
			.handle("rollPrivate", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					yield* Policy.check(tenant.roles, "ingest_keys:roll", (denial) =>
						V2InsufficientPermissions.make(denial.message),
					)
					const keys = yield* ingestKeys.rerollPrivate(tenant.orgId, tenant.userId)
					yield* recordHttpAudit("ingest_key.rolled", {
						metadata: { key_type: "private" },
					})

					return toV2IngestKeys(keys)
				}),
			)
	}),
)
