// What members asked Maple to support, kept so the team can see what to build next.
import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { FeatureRequests } from "@maple/db/tables"
import type { FeatureRequestArea } from "@maple/domain/feature-requests"
import { FeatureRequestPersistenceError } from "@maple/domain/http"
import type { OrgId, UserId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

export interface FeatureRequestInput {
	readonly area: FeatureRequestArea
	readonly subject: string
	readonly note?: string | undefined
}

export interface FeatureRequestServiceApi {
	/** Records the request and answers its id. */
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		input: FeatureRequestInput,
	) => Effect.Effect<{ readonly id: string }, FeatureRequestPersistenceError>
}

export class FeatureRequestService extends Context.Service<FeatureRequestService, FeatureRequestServiceApi>()(
	"@maple/backend/services/feature-requests/FeatureRequestService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(
				database,
				"FeatureRequestService",
				(error) => new FeatureRequestPersistenceError({ message: error.message }),
			)

			const create = Effect.fn("FeatureRequestService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				input: FeatureRequestInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.feature_request.area": input.area })
				const id = randomUUID()
				const now = yield* Clock.currentTimeMillis
				const note = Str.trim(input.note ?? "")
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(FeatureRequests).values({
							id,
							orgId,
							userId,
							area: input.area,
							subject: input.subject,
							note: note === "" ? null : note,
							createdAt: now,
						}),
					),
				)
				return { id }
			})

			return { create }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
