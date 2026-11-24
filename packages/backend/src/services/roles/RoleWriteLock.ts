import * as Orm from "@maple-dev/effect-orm/database"
import { RolesUnavailableError, type OrgId } from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { Database, DatabaseError } from "@maple/backend/platform/DatabaseLive"

export interface RoleWriteLockApi {
	/** Runs `effect` while no other role write for `orgId` runs. */
	readonly withLock: <A, E, R>(
		orgId: OrgId,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | RolesUnavailableError, R>
}

/**
 * Serializes an organization's role writes. Clerk, which stores the definitions and memberships, has
 * no conditional write, so two saves could each pass a version or admin-count check and the later
 * one drop the earlier. Every write instead holds a Postgres advisory lock for the org while it reads
 * and writes Clerk. Role writes are rare, so the transaction holding the lock stays cheap.
 */
export class RoleWriteLock extends Context.Service<RoleWriteLock, RoleWriteLockApi>()(
	"@maple/backend/services/roles/RoleWriteLock",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const withLock: RoleWriteLockApi["withLock"] = (orgId, effect) =>
				database
					.execute((db) =>
						db.transaction(
							Effect.andThen(
								db.execute(
									Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext('roles'))`,
								),
								effect,
							),
						),
					)
					.pipe(
						Effect.catchIf(Schema.is(DatabaseError), (error) =>
							Effect.fail(
								new RolesUnavailableError({
									message: "Could not lock the organization's roles for this change",
									cause: error,
								}),
							),
						),
					)
			return { withLock }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
