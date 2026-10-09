import * as PG from "@maple-dev/effect-orm/postgres"
import { DashboardShareMode as DashboardShareModeSchema } from "@maple/domain/http"
import { DashboardId, DashboardShareId, OrgId, UserId } from "@maple/domain/primitives"
import { Dashboards } from "./dashboards"

/**
 * Share links for a dashboard, or for a single widget on one.
 *
 * `widget_id` is the scope: null means the whole board, set means exactly that
 * one chart. A widget share is a first-class link with its own token, mode and
 * revocation (not a view of the dashboard's share), so a public embed of one
 * chart survives its dashboard being flipped to org-only or unshared entirely.
 *
 * At most one live row per (dashboard, widget) scope, enforced by the partial
 * unique index below. A dashboard may therefore have its own link plus one per
 * widget, all live at once, which is the point.
 *
 * `mode` rather than one row per mode: toggling public <-> org-only has to keep
 * the same URL working, or a link already pasted into a chat silently changes
 * meaning. Two rows would also mean two live URLs for one scope and no answer
 * to "which one did I share".
 *
 * Revoke and rotate are the same operation: stamp `revoked_at` on the current
 * row, and (for rotate) insert a fresh one in the same transaction. Revoked
 * rows are kept for audit and can never resurrect, because every resolution
 * filters `revoked_at is null`.
 */
export const DashboardShares = PG.table("dashboard_shares", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		id: PG.brand(PG.text, DashboardShareId),
		dashboardId: PG.column(PG.brand(PG.text, DashboardId), { name: "dashboard_id" }),
		// Null = the whole dashboard. Set = this one widget, and only this one:
		// the resolver refuses any other widget id presented against the token.
		widgetId: PG.column(PG.nullable(PG.text), { name: "widget_id" }),
		// "public" = anyone with the link. "org" = any signed-in member of orgId.
		mode: PG.brand(PG.text, DashboardShareModeSchema),
		// HMAC-SHA256 of the raw token (see share-token-hash.ts). This is what
		// resolution looks up; deterministic, so it stays one indexed equality.
		tokenHash: PG.column(PG.text, { name: "token_hash" }),
		// The raw token, AES-256-GCM encrypted under MAPLE_INGEST_KEY_ENCRYPTION_KEY
		// with an AAD binding it to this row (see SharedDashboardService).
		//
		// Stored recoverably on purpose: a share link nobody can read back is a
		// link you have to destroy in order to see, and rotating just to re-copy
		// breaks every URL already pasted somewhere. The key lives in the Worker's
		// secrets and never in Postgres, so the original property holds: a
		// database dump on its own is still not a set of working links.
		tokenCiphertext: PG.column(PG.text, { name: "token_ciphertext" }),
		tokenIv: PG.column(PG.text, { name: "token_iv" }),
		tokenTag: PG.column(PG.text, { name: "token_tag" }),
		// Last few characters in plaintext, so a link can be named in a list or an
		// audit trail without decrypting anything.
		tokenSuffix: PG.column(PG.text, { name: "token_suffix" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
		updatedBy: PG.column(PG.brand(PG.text, UserId), { name: "updated_by" }),
		// Null = live. Set = this token no longer resolves, for any reason.
		revokedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "revoked_at" }),
	},
	primaryKey: { columns: ["orgId", "id"], name: "dashboard_shares_org_id_id_pk" },
	indexes: [
		// The resolution path: one indexed equality, no scan.
		PG.uniqueIndex("dashboard_shares_token_hash_unq", ["tokenHash"]),
		// At most one live share per (dashboard, widget) scope. Two concurrent
		// rotates collide here rather than leaving two working links behind.
		//
		// `coalesce` rather than indexing `widget_id` directly: in Postgres NULLs
		// are distinct in a unique index, so a bare three-column index would let a
		// dashboard accumulate unlimited whole-board shares while still constraining
		// the per-widget ones. Folding null to '' makes "the whole board" a single
		// value that collides with itself.
		PG.uniqueIndex("dashboard_shares_live_unq", ($) => [$.orgId, $.dashboardId, "coalesce(widget_id, '')"], {
			where: "revoked_at is null",
		}),
		PG.index("dashboard_shares_org_dashboard_idx", ["orgId", "dashboardId"]),
		// The OG-card path resolves a signed share id with no org in hand: the
		// image URL is fetched by a crawler that has no session and, by design,
		// carries nothing but the id. The primary key leads with `org_id`, so it
		// cannot serve that lookup.
		PG.index("dashboard_shares_id_idx", ["id"]),
	],
	foreignKeys: [
		// Deliberate exception to this repo's no-foreign-key convention (see
		// dashboard_versions, which has none). Everywhere else a dangling row is a
		// cosmetic problem; here it is a security one: a deleted dashboard whose
		// share row survives is a link that still resolves. The resolver also loads
		// the dashboard through DashboardPersistenceService and 404s when it is
		// gone, so this is the second of two locks, not the only one.
		PG.foreignKey({
			columns: ["orgId", "dashboardId"],
			references: Dashboards,
			foreignColumns: ["orgId", "id"],
			onDelete: "cascade",
			name: "dashboard_shares_dashboard_fk",
		}),
	],
	tenantColumn: "orgId",
})

export type DashboardShareRow = PG.SelectRowOf<typeof DashboardShares>
export type DashboardShareInsert = PG.InsertRowOf<typeof DashboardShares>
export type DashboardShareMode = DashboardShareRow["mode"]
