import * as Orm from "@maple-dev/effect-orm/database"
import type { MapleDb } from "@maple/db/client"
import type { OrgId, StatusPageId, UptimeMonitorId } from "@maple/domain/primitives"
import { Effect } from "effect"

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
				monitorIds.map((id) => Orm.sql`${id}::text`),
				Orm.sql`, `,
			)})
		)`)
}

/** Queues removal of a page's edge data; call in the delete's transaction, before the delete. */
export const queuePageRemoval = (db: MapleDb, orgId: OrgId, pageId: StatusPageId) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (id, org_id, page_id, slug, delete_snapshot, created_at)
		SELECT gen_random_uuid()::text, org_id, id, slug, true, now()
		FROM status_pages WHERE org_id = ${orgId}::text AND id = ${pageId}::text`)

/** Queues removal of every page of an org, for org deletion. */
export const queueOrgPageRemovals = (db: MapleDb, orgId: OrgId) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (id, org_id, page_id, slug, delete_snapshot, created_at)
		SELECT gen_random_uuid()::text, org_id, id, slug, true, now()
		FROM status_pages WHERE org_id = ${orgId}::text`)

/** Queues removal of a renamed page's old slug route. */
export const queueSlugRemoval = (db: MapleDb, orgId: OrgId, pageId: StatusPageId, slug: string) =>
	db.execute(Orm.sql`
		INSERT INTO status_page_cleanups (id, org_id, page_id, slug, delete_snapshot, created_at)
		VALUES (gen_random_uuid()::text, ${orgId}::text, ${pageId}::text, ${slug}::text, false, now())`)
