import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertIncidentId,
	OrgId,
	StatusPageAutoIncidents,
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageCustomDomainStatus,
	StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageIncidentUpdateId,
	StatusPageUpdateSource,
	UptimeMonitorId,
	UserId,
} from "@maple/primitives"
import {
	DEFAULT_STATUS_PAGE_THEME,
	StatusPageCustomDomainDnsRecord,
	StatusPageTheme,
} from "@maple/domain/status-page"
import { Schema } from "effect"
import { UptimeMonitors } from "./uptime"

/**
 * A public status page. Visitors never read these rows: the publisher turns them into a
 * snapshot in edge storage. `revision` is the outbox: every change a visitor could see bumps
 * it in the same transaction, and the publisher catches up while `published_revision` lags.
 */
export const StatusPages = PG.table("status_pages", {
	columns: {
		id: PG.brand(PG.text, StatusPageId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		name: PG.text,
		/** Globally unique: the hosted address `<slug>.<status domain>`. */
		slug: PG.text,
		description: PG.nullable(PG.text),
		websiteUrl: PG.column(PG.nullable(PG.text), { name: "website_url" }),
		logoUrl: PG.column(PG.nullable(PG.text), { name: "logo_url" }),
		/** Footer links to the customer's own policies; https only. */
		privacyUrl: PG.column(PG.nullable(PG.text), { name: "privacy_url" }),
		termsUrl: PG.column(PG.nullable(PG.text), { name: "terms_url" }),
		/** Colours, appearance, radius and font of the public page. */
		theme: PG.column(PG.jsonb(StatusPageTheme), { default: DEFAULT_STATUS_PAGE_THEME }),
		showPoweredBy: PG.column(PG.bool, { name: "show_powered_by", default: true }),
		autoIncidents: PG.column(PG.brand(PG.text, StatusPageAutoIncidents), {
			name: "auto_incidents",
			default: "off",
		}),
		/** SHA-256 (base64url) of the break-glass token, published so the edge can check it. */
		breakGlassTokenSha256: PG.column(PG.nullable(PG.text), { name: "break_glass_token_sha256" }),
		breakGlassTokenSuffix: PG.column(PG.nullable(PG.text), { name: "break_glass_token_suffix" }),
		/** A draft is never published: the publisher skips it until it is made public. */
		draft: PG.column(PG.bool, { default: false }),
		revision: PG.column(PG.int8, { default: 1 }),
		publishedRevision: PG.column(PG.int8, { name: "published_revision", default: 0 }),
		publishedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "published_at" }),
		lastPublishError: PG.column(PG.nullable(PG.text), { name: "last_publish_error" }),
		/** Hash of the last published content (minus timestamps); an unchanged hash skips the write. */
		publishedHash: PG.column(PG.nullable(PG.text), { name: "published_hash" }),
		/** Last publish attempt, good or not: the sweep takes the longest-waiting pages first. */
		publishAttemptedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "publish_attempted_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("status_pages_org_idx", ["orgId"]),
		PG.uniqueIndex("status_pages_slug_unq", ["slug"]),
		PG.index("status_pages_unpublished_idx", ["revision", "publishedRevision"], {
			where: "revision > published_revision",
		}),
	],
	tenantColumn: "orgId",
})

export type StatusPageRow = PG.SelectRowOf<typeof StatusPages>

/**
 * One line on a page. Its status comes from `monitor_id` (down is a major outage), the
 * `manual_status` override, and active incidents naming it; the worst wins.
 */
export const StatusPageComponents = PG.table("status_page_components", {
	columns: {
		id: PG.brand(PG.text, StatusPageComponentId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		pageId: PG.column(PG.brand(PG.text, StatusPageId), { name: "page_id" }),
		name: PG.text,
		description: PG.nullable(PG.text),
		groupName: PG.column(PG.nullable(PG.text), { name: "group_name" }),
		position: PG.column(PG.int4, { default: 0 }),
		monitorId: PG.column(PG.nullable(PG.brand(PG.text, UptimeMonitorId)), { name: "monitor_id" }),
		manualStatus: PG.column(PG.nullable(PG.brand(PG.text, StatusPageComponentStatus)), {
			name: "manual_status",
		}),
		showUptime: PG.column(PG.bool, { name: "show_uptime", default: true }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("status_page_components_page_idx", ["pageId", "position"]),
		PG.index("status_page_components_monitor_idx", ["monitorId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["pageId"],
			references: StatusPages,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
		PG.foreignKey({
			columns: ["monitorId"],
			references: UptimeMonitors,
			foreignColumns: ["id"],
			onDelete: "set null",
		}),
	],
	tenantColumn: "orgId",
})

export type StatusPageComponentRow = PG.SelectRowOf<typeof StatusPageComponents>

/** A customer-facing incident or scheduled maintenance, separate from internal alert incidents. */
export const StatusPageIncidents = PG.table("status_page_incidents", {
	columns: {
		id: PG.brand(PG.text, StatusPageIncidentId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		pageId: PG.column(PG.brand(PG.text, StatusPageId), { name: "page_id" }),
		kind: PG.brand(PG.text, StatusPageIncidentKind),
		title: PG.text,
		impact: PG.brand(PG.text, StatusPageIncidentImpact),
		status: PG.brand(PG.text, StatusPageIncidentStatus),
		/** Drafts (e.g. auto-opened from a monitor) are not on the page until published. */
		published: PG.column(PG.bool, { default: true }),
		/** The alert incident that auto-opened this one, so its resolve can close it. */
		alertIncidentId: PG.column(PG.nullable(PG.brand(PG.text, AlertIncidentId)), {
			name: "alert_incident_id",
		}),
		scheduledStart: PG.column(PG.nullable(PG.timestamptzMillis), { name: "scheduled_start" }),
		scheduledEnd: PG.column(PG.nullable(PG.timestamptzMillis), { name: "scheduled_end" }),
		startedAt: PG.column(PG.timestamptzMillis, { name: "started_at" }),
		resolvedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "resolved_at" }),
		createdBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "created_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("status_page_incidents_page_idx", ["pageId", "startedAt"]),
		PG.index("status_page_incidents_alert_idx", ["alertIncidentId"]),
		// The minutely sweep that starts and completes maintenance reads only the open windows.
		PG.index("status_page_incidents_open_maintenance_idx", ["scheduledStart"], {
			where: `"kind" = 'maintenance' and "resolved_at" is null`,
		}),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["pageId"],
			references: StatusPages,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type StatusPageIncidentRow = PG.SelectRowOf<typeof StatusPageIncidents>

export const StatusPageIncidentUpdates = PG.table("status_page_incident_updates", {
	columns: {
		id: PG.brand(PG.text, StatusPageIncidentUpdateId),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		incidentId: PG.column(PG.brand(PG.text, StatusPageIncidentId), { name: "incident_id" }),
		status: PG.brand(PG.text, StatusPageIncidentStatus),
		body: PG.text,
		source: PG.brand(PG.text, StatusPageUpdateSource),
		createdBy: PG.column(PG.nullable(PG.brand(PG.text, UserId)), { name: "created_by" }),
		/** The break-glass overlay entry this was imported from; unique so a re-import is a no-op. */
		overlayEntryId: PG.column(PG.nullable(PG.text), { name: "overlay_entry_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("status_page_incident_updates_incident_idx", ["incidentId", "createdAt"]),
		PG.uniqueIndex("status_page_incident_updates_overlay_unq", ["overlayEntryId"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["incidentId"],
			references: StatusPageIncidents,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type StatusPageIncidentUpdateRow = PG.SelectRowOf<typeof StatusPageIncidentUpdates>

export const StatusPageIncidentComponents = PG.table("status_page_incident_components", {
	columns: {
		incidentId: PG.column(PG.brand(PG.text, StatusPageIncidentId), { name: "incident_id" }),
		componentId: PG.column(PG.brand(PG.text, StatusPageComponentId), { name: "component_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
	},
	primaryKey: { columns: ["incidentId", "componentId"], name: "status_page_incident_components_pk" },
	indexes: [PG.index("status_page_incident_components_component_idx", ["componentId"])],
	foreignKeys: [
		PG.foreignKey({
			columns: ["incidentId"],
			references: StatusPageIncidents,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
		PG.foreignKey({
			columns: ["componentId"],
			references: StatusPageComponents,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

/**
 * A page's custom domain (`status.acme.com`), one per page. Its own table, not columns on the
 * page: the Cloudflare lifecycle (hostname and route ids, DNS records, checks, errors) changes on
 * the poll's schedule, not the editor's, and must never bump the page's content revision itself.
 */
export const StatusPageCustomDomains = PG.table("status_page_custom_domains", {
	columns: {
		pageId: PG.column(PG.brand(PG.text, StatusPageId), { name: "page_id" }),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		/** Lower-cased, no trailing dot; unique across every org. */
		hostname: PG.text,
		status: PG.brand(PG.text, StatusPageCustomDomainStatus),
		/** The Cloudflare for SaaS custom hostname; null until it is created. */
		cloudflareHostnameId: PG.column(PG.nullable(PG.text), { name: "cloudflare_hostname_id" }),
		/** The Worker route sending the hostname's traffic to the status Worker; null until created. */
		cloudflareRouteId: PG.column(PG.nullable(PG.text), { name: "cloudflare_route_id" }),
		/** What the customer adds at their DNS provider, as of the last check. */
		dnsRecords: PG.column(PG.jsonb(Schema.Array(StatusPageCustomDomainDnsRecord)), {
			name: "dns_records",
			default: [],
		}),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		lastCheckedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_checked_at" }),
		activatedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "activated_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["pageId"],
	indexes: [
		PG.uniqueIndex("status_page_custom_domains_hostname_unq", ["hostname"]),
		PG.index("status_page_custom_domains_org_idx", ["orgId"]),
		PG.index("status_page_custom_domains_checked_idx", ["lastCheckedAt"]),
	],
	foreignKeys: [
		PG.foreignKey({
			columns: ["pageId"],
			references: StatusPages,
			foreignColumns: ["id"],
			onDelete: "cascade",
		}),
	],
	tenantColumn: "orgId",
})

export type StatusPageCustomDomainRow = PG.SelectRowOf<typeof StatusPageCustomDomains>

/**
 * Edge data to remove: a deleted page's snapshot and routes, a renamed page's old slug, or a
 * removed custom domain (its `host:` route, Cloudflare hostname and Worker route). Written in the
 * same transaction as the delete, rename or removal (rows outlive the page and the org), drained
 * by the publisher sweep.
 */
export const StatusPageCleanups = PG.table("status_page_cleanups", {
	columns: {
		id: PG.column(PG.text),
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		pageId: PG.column(PG.brand(PG.text, StatusPageId), { name: "page_id" }),
		/** The slug route to drop; null for a custom domain removal alone. */
		slug: PG.column(PG.nullable(PG.text)),
		/** True when the page is gone: drop its snapshot and break-glass entries too. */
		deleteSnapshot: PG.column(PG.bool, { name: "delete_snapshot" }),
		/** A custom domain to take down: its `host:` route and, when created, its Cloudflare pieces. */
		hostname: PG.column(PG.nullable(PG.text)),
		cloudflareHostnameId: PG.column(PG.nullable(PG.text), { name: "cloudflare_hostname_id" }),
		cloudflareRouteId: PG.column(PG.nullable(PG.text), { name: "cloudflare_route_id" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("status_page_cleanups_created_idx", ["createdAt"])],
	tenantColumn: "orgId",
})

export type StatusPageCleanupRow = PG.SelectRowOf<typeof StatusPageCleanups>
