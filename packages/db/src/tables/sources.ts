import * as PG from "@maple-dev/effect-orm/postgres"
import {
	OrgId,
	SourceId,
	SourceKind,
	SourcePlatform,
	SourceResourceAttribute,
	SourceSignal,
	UserId,
} from "@maple/domain/primitives"
import { Schema } from "effect"

// Everything that sends data to Maple. Token sources carry their own token (only its HMAC is
// stored); the default source stands for the org's public/private pair in `org_ingest_keys`;
// integration sources are owned by an integration row whose `source_id` points here.
// The ingest gateway reads this table directly (apps/ingest), so column changes must ship there too.
export const Sources = PG.table("sources", {
	columns: {
		id: PG.brand(PG.text, SourceId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		platform: PG.brand(PG.text, SourcePlatform),
		kind: PG.brand(PG.text, SourceKind),
		// Null for the default source and pull sources.
		keyHash: PG.column(PG.nullable(PG.text), { name: "key_hash" }),
		keyPrefix: PG.column(PG.nullable(PG.text), { name: "key_prefix" }),
		// null = every signal.
		allowedSignals: PG.column(PG.nullable(PG.jsonb(Schema.Array(SourceSignal))), {
			name: "allowed_signals",
		}),
		// Fleet-wide requests per second; null = unlimited.
		rateLimitRps: PG.column(PG.nullable(PG.int4), { name: "rate_limit_rps" }),
		resourceAttributes: PG.column(PG.jsonb(Schema.Array(SourceResourceAttribute)), {
			name: "resource_attributes",
			defaultExpr: "'[]'::jsonb",
		}),
		expiresAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "expires_at" }),
		// Paused sources are accepted but their data is dropped. paused_until null = until resumed.
		pausedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "paused_at" }),
		pausedUntil: PG.column(PG.nullable(PG.timestamptzMillis), { name: "paused_until" }),
		// Written by the gateway at most once a minute per source and instance (5 minutes for the default source).
		lastUsedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_used_at" }),
		// The gateway's last 403 or 429 for a token source (signal, rate limit), at most once a minute.
		lastRejectedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_rejected_at" }),
		lastRejection: PG.column(PG.nullable(PG.text), { name: "last_rejection" }),
		// Integration sources: the poller's last tick. Error is cleared by the next good tick.
		lastPollAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_poll_at" }),
		lastPollOkAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_poll_ok_at" }),
		lastPollError: PG.column(PG.nullable(PG.text), { name: "last_poll_error" }),
		// Set while the integration's grant is revoked, suspended or rejected.
		disconnectedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "disconnected_at" }),
		// For a source standing for several resources (zones, repos, environments).
		pollResources: PG.column(
			PG.nullable(PG.jsonb(Schema.Struct({ total: Schema.Int, unhealthy: Schema.Int }))),
			{ name: "poll_resources" },
		),
		rolledAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "rolled_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		// Null when Maple created the source (the default source, integration backfills).
		createdBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "created_by" }),
		updatedBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "updated_by" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("sources_key_hash_unique", ["keyHash"]),
		PG.index("sources_org_id_idx", ["orgId"]),
		PG.uniqueIndex("sources_org_default_kind_unique", ["orgId"], { where: ($) => $.kind.eq("default") }),
	],
	tenantColumn: "orgId",
})

export type SourceRow = PG.SelectRowOf<typeof Sources>
export type SourceInsert = PG.InsertRowOf<typeof Sources>
