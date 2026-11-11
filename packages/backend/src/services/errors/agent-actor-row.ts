import { randomUUID } from "node:crypto"
import { ActorId, type OrgId, type UserId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { Actors, type ActorRow } from "@maple/db/tables"
import { Effect, Option, Schema } from "effect"

const decodeActorId = Schema.decodeUnknownSync(ActorId)

/**
 * The org's agent actor named `agentName` on `db`, inserted when missing. `None` only when the
 * insert and the read after it disagree, which each caller reports in its own error.
 */
export const ensureAgentActorRow = (
	db: MapleDb,
	orgId: OrgId,
	agentName: string,
	fields: {
		readonly capabilities: ReadonlyArray<string>
		readonly createdBy: UserId | null
		readonly timestamp: number
	},
): Effect.Effect<Option.Option<ActorRow>, MapleDbError> =>
	Effect.gen(function* () {
		const select = db
			.run(
				PG.from(Actors)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.type.eq("agent"), $.agentName.eq(agentName)])
					.limit(1),
			)
			.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
		const existing = yield* select
		if (Option.isSome(existing)) return existing
		yield* db.run(
			PG.insertInto(Actors)
				.values({
					id: decodeActorId(randomUUID()),
					orgId,
					type: "agent",
					userId: null,
					agentName,
					model: null,
					capabilitiesJson: fields.capabilities,
					createdBy: fields.createdBy,
					createdAt: fields.timestamp,
					lastActiveAt: fields.timestamp,
				})
				.onConflictDoNothing(),
		)
		return yield* select
	})
