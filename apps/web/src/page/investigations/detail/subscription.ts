import { rowsToInvestigation } from "@maple/web-data/collections/investigations"
import { Clock, Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { OrgCollections } from "../../../data/collections/org-collections"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { Tail, tailOf, tailsMessages } from "../../chat/conversation/subscription"
import { Message } from "./message"
import type { Model, Sync } from "./model"

/**
 * `useInvestigation`: the `investigation_v2` shape scoped to this id, as a live query. The
 * collection is minted per (org, id) and released once the Subscription's live query lets go.
 */
const investigationStream = (orgId: string, id: string, attempt: number) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const collections = yield* OrgCollections
			const collection = yield* collections.forInvestigation(orgId, id)
			return liveQueryStream(
				(q) => q.from({ i: collection }),
				(rows): ReturnType<typeof Message.SyncedInvestigation> => {
					const row = rows.find((candidate) => candidate.id === id)
					const investigation = row === undefined ? null : rowsToInvestigation(row)
					const sync: Sync =
						row === undefined
							? { _tag: "Missing" }
							: investigation === null
								? { _tag: "Failed" }
								: { _tag: "Ready", investigation }
					return Message.SyncedInvestigation({ orgId, id, attempt, sync })
				},
			).pipe(Stream.ensuring(collections.releaseInvestigation(collection)))
		}),
	).pipe((live) => withLoadWatchdog(live, Message.SyncedInvestigation({ orgId, id, attempt, sync: { _tag: "Failed" } })))

/** `COLLECTION_LOAD_TIMEOUT_MS`: how long the shape may stay loading before it counts as lost. */
export const LOAD_TIMEOUT = Duration.seconds(30)

/** `useCollectionLoadFailed`: nothing synced within the timeout means the connection is lost (with Retry). */
export const withLoadWatchdog = <A, E, R>(live: Stream.Stream<A, E, R>, failed: A, timeout: Duration.Input = LOAD_TIMEOUT) =>
	Stream.race(live, Stream.fromEffect(Effect.as(Effect.sleep(timeout), failed)))

/** `useTickingNow`: a running pass's elapsed time counts up once a second. */
const clock = Stream.tick(Duration.seconds(1)).pipe(
	Stream.drop(1),
	Stream.mapEffect(() => Clock.currentTimeMillis),
	Stream.map((nowMs) => Message.TickedClock({ nowMs })),
)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	investigation: entry(
		{ orgId: Schema.String, id: Schema.String, attempt: Schema.Number },
		{
			modelToDependencies: ({ model, context }) => ({ orgId: context.orgId, id: model.id, attempt: model.syncAttempt }),
			dependenciesToStream: ({ orgId, id, attempt }) => investigationStream(orgId, id, attempt),
		},
	),
	/** The thread's live turn, while one runs (`useMapleChat`'s tail). */
	tail: entry(
		{ tails: Schema.Array(Tail) },
		{
			modelToDependencies: ({ model }) => ({ tails: model.conversation === null ? [] : tailOf(model.conversation) }),
			dependenciesToStream: ({ tails }) =>
				tails.length === 0
					? Stream.empty
					: tailsMessages(tails, (_tabId, message) => Message.GotConversationMessage({ message })),
		},
	),
	clock: entry(
		{ isRunning: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({
				isRunning: model.sync._tag === "Ready" && model.sync.investigation.status === "investigating",
			}),
			dependenciesToStream: ({ isRunning }) => (isRunning ? clock : Stream.empty),
		},
	),
}))
