import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, SourceId } from "@maple/domain/primitives"
import { Sources } from "./sources"

// NOTE: the manual connector CRUD (CloudflareLogpushService + UI) was removed in favor of the
// account OAuth integration, but this table intentionally stays: the Rust ingest gateway's
// `/v1/logpush/cloudflare/...` receiver resolves connector secrets from it (existing jobs keep
// flowing), OrganizationService purges it on org deletion, and the upcoming OAuth-driven Logpush
// auto-provisioning will create rows here programmatically instead of via manual setup.
export const CloudflareLogpushConnectors = PG.table("cloudflare_logpush_connectors", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// The org's Cloudflare source; null when the org has no Cloudflare connection.
		sourceId: PG.column(PG.nullable(PG.brand(PG.text, SourceId)), { name: "source_id" }),
		name: PG.text,
		zoneName: PG.column(PG.text, { name: "zone_name" }),
		serviceName: PG.column(PG.text, { name: "service_name" }),
		dataset: PG.column(PG.text, { default: "http_requests" }),
		secretCiphertext: PG.column(PG.text, { name: "secret_ciphertext" }),
		secretIv: PG.column(PG.text, { name: "secret_iv" }),
		secretTag: PG.column(PG.text, { name: "secret_tag" }),
		secretHash: PG.column(PG.text, { name: "secret_hash" }),
		enabled: PG.column(PG.bool, { default: true }),
		lastReceivedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_received_at" }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		secretRotatedAt: PG.column(PG.timestamptzMillis, { name: "secret_rotated_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.text, { name: "created_by" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("cloudflare_logpush_connectors_source_idx", ["sourceId"]),
		PG.index("cloudflare_logpush_connectors_org_idx", ["orgId"]),
		PG.index("cloudflare_logpush_connectors_org_enabled_idx", ["orgId", "enabled"]),
		PG.uniqueIndex("cloudflare_logpush_connectors_secret_hash_unique", ["secretHash"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["sourceId"],
			references: Sources,
			foreignColumns: ["id"],
			// Disconnecting Cloudflare leaves a manually configured Logpush job running, unattributed.
			onDelete: "set null",
		}),
	],
	tenantColumn: "orgId",
})

export type CloudflareLogpushConnectorRow = PG.SelectRowOf<typeof CloudflareLogpushConnectors>
export type CloudflareLogpushConnectorInsert = PG.InsertRowOf<typeof CloudflareLogpushConnectors>
