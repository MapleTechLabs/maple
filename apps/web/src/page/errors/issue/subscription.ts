import { Clock, Duration, Option, Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import { type OrgCollections, orgLive } from "../../../data/collections/org-collections"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"

/** `useAlertDestinationsList()`: the names the escalation confirmation would list. */
const destinations = (orgId: string): Stream.Stream<Message, never, OrgCollections> =>
	orgLive(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ d: set.alertDestinations }),
			(rows) =>
				Message.UpdatedDestinations({
					orgId,
					destinations: rows.map((row) => ({ id: row.id, name: row.name })),
				}),
		),
	)

/** `LeaseHud`'s `setInterval(..., 1000)`: the countdown's clock, read at once and every second. */
const leaseClock = Stream.tick(Duration.seconds(1)).pipe(
	Stream.mapEffect(() => Clock.currentTimeMillis),
	Stream.map((nowMs) => Message.TickedLeaseClock({ nowMs })),
)

const isLeaseHeld = (model: Model): boolean =>
	Option.exists(
		AsyncData.getData(model.detail.data),
		(detail) => detail.lease_holder !== null && detail.lease_expires_at !== null,
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
		leaseClock: entry(
			{ isHeld: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isHeld: isLeaseHeld(model) }),
				dependenciesToStream: ({ isHeld }) => (isHeld ? leaseClock : Stream.empty),
			},
		),
	}),
)
