import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { OrgCollections } from "../../../data/collections/org-collections"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"

/** `useAlertDestinationsList()`: the names the escalation confirmation would list. */
const destinations = (orgId: string): Stream.Stream<Message, never, OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const collections = yield* OrgCollections
			const set = yield* collections.forOrg(orgId)
			return liveQueryStream(
				(q) => q.from({ d: set.alertDestinations }),
				(rows) =>
					Message.UpdatedDestinations({
						orgId,
						destinations: rows.map((row) => ({ id: row.id, name: row.name })),
					}),
			)
		}),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		destinations: entry(
			{ orgId: Schema.String },
			{
				modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
				dependenciesToStream: ({ orgId }) => destinations(orgId),
			},
		),
	}),
)
