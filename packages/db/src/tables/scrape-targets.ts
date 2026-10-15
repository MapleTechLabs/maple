import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, ScrapeTargetId } from "@maple/domain/primitives"
import { Schema } from "effect"

export const ScrapeTargets = PG.table("scrape_targets", {
	columns: {
		id: PG.brand(PG.text, ScrapeTargetId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		serviceName: PG.column(PG.nullable(PG.text), { name: "service_name" }),
		url: PG.text,
		targetType: PG.column(PG.text, { name: "target_type", default: "prometheus" }),
		discoveryConfigJson: PG.column(PG.nullable(PG.jsonb()), { name: "discovery_config_json" }),
		scrapeIntervalSeconds: PG.column(PG.int4, { name: "scrape_interval_seconds", default: 15 }),
		labelsJson: PG.column(PG.nullable(PG.jsonb(Schema.Record(Schema.String, Schema.String))), {
			name: "labels_json",
		}),
		authType: PG.column(PG.text, { name: "auth_type", default: "none" }),
		/**
		 * Integration ownership marker: null for user-created targets;
		 * `"planetscale:{connectionId}"` when auto-provisioned (and torn down) by
		 * the PlanetScale integration. Managed rows are hidden from the generic
		 * scrape-target UI and edited through the integration card instead.
		 */
		managedBy: PG.column(PG.nullable(PG.text), { name: "managed_by" }),
		authCredentialsCiphertext: PG.column(PG.nullable(PG.text), { name: "auth_credentials_ciphertext" }),
		authCredentialsIv: PG.column(PG.nullable(PG.text), { name: "auth_credentials_iv" }),
		authCredentialsTag: PG.column(PG.nullable(PG.text), { name: "auth_credentials_tag" }),
		enabled: PG.column(PG.bool, { default: true }),
		lastScrapeAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_scrape_at" }),
		lastScrapeError: PG.column(PG.nullable(PG.text), { name: "last_scrape_error" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("scrape_targets_org_idx", ["orgId"]),
		PG.index("scrape_targets_org_enabled_idx", ["orgId", "enabled"]),
	],
	tenantColumn: "orgId",
})

export type ScrapeTargetRow = PG.SelectRowOf<typeof ScrapeTargets>
export type ScrapeTargetInsert = PG.InsertRowOf<typeof ScrapeTargets>

/**
 * One row per scheduled scrape attempt, reported by the scraper via
 * `POST /api/internal/scrape-results`. Durable check history for the
 * connectors UI, pruned to 24h with a per-target row cap.
 */
export const ScrapeTargetChecks = PG.table("scrape_target_checks", {
	columns: {
		// generatedByDefault (not generatedAlways) so the D1→Postgres import can
		// carry over existing ids; setval() realigns the sequence afterwards.
		id: PG.column(PG.int4, { identity: "by default" }),
		targetId: PG.column(PG.brand(PG.text, ScrapeTargetId), { name: "target_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Sub-target discriminator (e.g. PlanetScale branch); empty string for plain targets. */
		subTargetKey: PG.column(PG.text, { name: "sub_target_key", default: "" }),
		checkedAt: PG.column(PG.timestamptzMillis, { name: "checked_at" }),
		/** Null on success; pretty-printed failure otherwise. */
		error: PG.nullable(PG.text),
		durationMs: PG.column(PG.nullable(PG.int4), { name: "duration_ms" }),
		samplesScraped: PG.column(PG.nullable(PG.int4), { name: "samples_scraped" }),
		samplesPostRelabel: PG.column(PG.nullable(PG.int4), { name: "samples_post_relabel" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("scrape_target_checks_target_checked_idx", ["targetId", "checkedAt"])],
	foreignKeys: [
		PG.foreignKey({
			columns: ["targetId"],
			references: ScrapeTargets,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type ScrapeTargetCheckRow = PG.SelectRowOf<typeof ScrapeTargetChecks>
export type ScrapeTargetCheckInsert = PG.InsertRowOf<typeof ScrapeTargetChecks>
