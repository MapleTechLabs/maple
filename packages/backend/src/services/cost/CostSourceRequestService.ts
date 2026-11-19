// Cost providers people asked Maple to support, kept so the team can see which source to build next.
import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSourceRequests } from "@maple/db/tables"
import { CostSourceRequestPersistenceError } from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

export interface CostSourceRequestInput {
	readonly provider: string
	readonly note?: string | undefined
}

export interface CostSourceRequestServiceApi {
	/** Records the request and answers its id. */
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		input: CostSourceRequestInput,
	) => Effect.Effect<{ readonly id: string }, CostSourceRequestPersistenceError>
}

export class CostSourceRequestService extends Context.Service<
	CostSourceRequestService,
	CostSourceRequestServiceApi
>()("@maple/backend/services/cost/CostSourceRequestService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(
			database,
			"CostSourceRequestService",
			(error) => new CostSourceRequestPersistenceError({ message: error.message }),
		)

		const create = Effect.fn("CostSourceRequestService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			input: CostSourceRequestInput,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const id = randomUUID()
			const now = yield* Clock.currentTimeMillis
			const note = Str.trim(input.note ?? "")
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(CostSourceRequests).values({
						id,
						orgId,
						userId,
						provider: input.provider,
						note: note === "" ? null : note,
						createdAt: now,
					}),
				),
			)
			return { id }
		})

		return { create }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
