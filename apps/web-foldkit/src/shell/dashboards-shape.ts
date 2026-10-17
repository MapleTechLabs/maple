import { Array as Arr, Effect, Order, Schema, Stream } from "effect"
import { OrgCollections } from "../data/collections/org-collections"
import { liveQueryStream } from "../data/live-query"

/** What the Pinned group reads from a `dashboards` row (`DashboardRowSchema` in apps/web). */
export const PinnedDashboardRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	updated_at: Schema.String,
})
export type PinnedDashboardRow = typeof PinnedDashboardRow.Type

const byUpdatedDesc = Order.flip(Order.mapInput(Order.String, (row: PinnedDashboardRow) => row.updated_at))

/**
 * `useDashboardsRead` for the Pinned group: a live query over the org's `dashboards` collection,
 * newest first. The collection is the one the dashboards pages read, so the shape is requested once.
 */
export const pinnedDashboardRows = <Message>(
	orgId: string,
	toMessage: (rows: ReadonlyArray<PinnedDashboardRow>) => Message,
): Stream.Stream<Message, never, OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const collections = yield* OrgCollections
			const set = yield* collections.forOrg(orgId)
			return liveQueryStream(
				(q) => q.from({ d: set.dashboards }),
				(rows) =>
					toMessage(
						Arr.sort(
							rows.map((row) => ({ id: row.id, name: row.name, updated_at: row.updated_at })),
							byUpdatedDesc,
						),
					),
			)
		}),
	)
