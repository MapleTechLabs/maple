import * as PG from "@maple-dev/effect-orm/postgres"
import {
	CustomIngestKeyId,
	IngestKeyResourceAttribute,
	IngestKeySignal,
	OrgId,
	UserId,
} from "@maple/domain/primitives"
import { Schema } from "effect"

// Named ingest keys an org creates beside its default pair. Only the HMAC hash is stored;
// the ingest gateway reads this table directly (apps/ingest), so column changes must ship there too.
export const OrgIngestCustomKeys = PG.table("org_ingest_custom_keys", {
	columns: {
		id: PG.brand(PG.text, CustomIngestKeyId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		keyHash: PG.column(PG.text, { name: "key_hash" }),
		keyPrefix: PG.column(PG.text, { name: "key_prefix" }),
		// null = every signal.
		allowedSignals: PG.column(PG.nullable(PG.jsonb(Schema.Array(IngestKeySignal))), {
			name: "allowed_signals",
		}),
		// Fleet-wide requests per second; null = unlimited.
		rateLimitRps: PG.column(PG.nullable(PG.int4), { name: "rate_limit_rps" }),
		resourceAttributes: PG.column(PG.jsonb(Schema.Array(IngestKeyResourceAttribute)), {
			name: "resource_attributes",
			defaultExpr: "'[]'::jsonb",
		}),
		expiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "expires_at" }),
		// Paused keys are accepted but their data is dropped. paused_until null = until resumed.
		pausedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "paused_at" }),
		pausedUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "paused_until" }),
		// Written by the gateway at most once a minute per key and instance.
		lastUsedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_used_at" }),
		rolledAt: PG.column(PG.timestamptzMillis, { name: "rolled_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("org_ingest_custom_keys_key_hash_unique", ["keyHash"]),
		PG.index("org_ingest_custom_keys_org_id_idx", ["orgId"]),
	],
	tenantColumn: "orgId",
})

export type OrgIngestCustomKeyRow = PG.SelectRowOf<typeof OrgIngestCustomKeys>
export type OrgIngestCustomKeyInsert = PG.InsertRowOf<typeof OrgIngestCustomKeys>
