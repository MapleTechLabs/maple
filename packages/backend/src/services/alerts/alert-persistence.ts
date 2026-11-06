import * as Orm from "@maple-dev/effect-orm/database"
import type { MapleDb } from "@maple/db/client"
import { AlertPersistenceError, type OrgId } from "@maple/domain/http"
import { makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

/** Shared `unknown -> AlertPersistenceError` mapper for every alerts service. */
export const makePersistenceError = makePersistenceErrorMapper(
	AlertPersistenceError,
	"Alert persistence failed",
)

/**
 * The per-org lock every alert rule write takes inside its transaction, so a name check or a
 * destination check and the write that follows are atomic.
 */
export const lockOrgAlertRules = (db: MapleDb, orgId: OrgId) =>
	db.execute(Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}))`)
