import * as Orm from "@maple-dev/effect-orm/database"
import type { MapleDb } from "@maple/db/client"
import type { OrgId, StatusPageId, UptimeMonitorId } from "@maple/primitives"
import { Effect, Array as Arr } from "effect"

// The status-page outbox: a write a visitor could see bumps `status_pages.revision` in its own
// transaction, and the publisher republishes every page whose `published_revision` lags.

/** Marks one page as needing a publish. */
export const bumpPage = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
	db.execute(
		Orm.sql`UPDATE status_pages SET revision = revision + 1 WHERE org_id = ${orgId}::text AND id = ${pageId}::text`,
	)

/** Marks every page showing one of these monitors (a status flip, a pause, a delete). */
export const bumpPagesForMonitors = (
	db: MapleDb,
	orgId: OrgId,
	monitorIds: ReadonlyArray<UptimeMonitorId>,
) => {
	if (monitorIds.length === 0) return Effect.void
	return db.execute(Orm.sql`
		UPDATE status_pages SET revision = revision + 1
		WHERE org_id = ${orgId}::text AND id IN (
			SELECT page_id FROM status_page_components
			WHERE org_id = ${orgId}::text AND monitor_id IN (${Orm.sql.join(
				Arr.map(monitorIds, (id) => Orm.sql`${id}::text`),
				Orm.sql`, `,
			)})
		)`)
}

/**
 * Queues removal of a page's edge data, its custom domain included; call in the delete's
 * transaction, before the delete (the domain row goes with the page by foreign key).
 */
export const queuePageRemoval = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (
			id, org_id, page_id, slug, delete_snapshot,
			hostname, cloudflare_hostname_id, cloudflare_route_id, created_at
		)
		SELECT gen_random_uuid()::text, p.org_id, p.id, p.slug, true,
			d.hostname, d.cloudflare_hostname_id, d.cloudflare_route_id, now()
		FROM status_pages p
		LEFT JOIN status_page_custom_domains d ON d.page_id = p.id
		WHERE p.org_id = ${orgId}::text AND p.id = ${pageId}::text`)

/** Queues removal of every page of an org, for org deletion. */
export const queueOrgPageRemovals = (db: MapleDb, orgId: OrgId) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (
			id, org_id, page_id, slug, delete_snapshot,
			hostname, cloudflare_hostname_id, cloudflare_route_id, created_at
		)
		SELECT gen_random_uuid()::text, p.org_id, p.id, p.slug, true,
			d.hostname, d.cloudflare_hostname_id, d.cloudflare_route_id, now()
		FROM status_pages p
		LEFT JOIN status_page_custom_domains d ON d.page_id = p.id
		WHERE p.org_id = ${orgId}::text`)

/** Queues removal of a renamed page's old slug route. */
export const queueSlugRemoval = (db: MapleDb, orgId: OrgId, pageId: StatusPageId, slug: string) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (id, org_id, page_id, slug, delete_snapshot, created_at)
		VALUES (gen_random_uuid()::text, ${orgId}::text, ${pageId}::text, ${slug}::text, false, now())`)

/** A custom domain being taken down: its edge route, and its Cloudflare pieces once created. */
export interface CustomDomainRemoval {
	readonly hostname: string
	readonly cloudflareHostnameId: string | null
	readonly cloudflareRouteId: string | null
}

/** Queues removal of a replaced or removed custom domain; call in the same transaction. */
export const queueCustomDomainRemoval = (
	db: MapleDb,
	orgId: OrgId,
	pageId: StatusPageId,
	domain: CustomDomainRemoval,
) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (
			id, org_id, page_id, slug, delete_snapshot,
			hostname, cloudflare_hostname_id, cloudflare_route_id, created_at
		)
		VALUES (
			gen_random_uuid()::text, ${orgId}::text, ${pageId}::text, NULL, false,
			${domain.hostname}::text, ${domain.cloudflareHostnameId}::text, ${domain.cloudflareRouteId}::text, now()
		)`)
