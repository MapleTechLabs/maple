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

/** Marks every page showing one of these monitors (a status flip, a rename, a delete). */
export const bumpPagesForMonitors = (db: MapleDb, monitorIds: ReadonlyArray<UptimeMonitorId>) => {
	if (monitorIds.length === 0) return Effect.void
	return db.execute(Orm.sql`
		UPDATE status_pages SET revision = revision + 1
		WHERE id IN (
			SELECT page_id FROM status_page_components
			WHERE monitor_id IN (${Orm.sql.join(
				monitorIds.map((id) => Orm.sql`${id}::text`),
				Orm.sql`, `,
			)})
		)`)
}
