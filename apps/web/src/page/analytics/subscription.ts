import { Duration, Option, Schema, Stream } from "effect"
import { AsyncData } from "foldkit"
import { Subscription } from "foldkit"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { filtersOf, searchSiteOf, tabOf } from "./requests"
import { pollTicks } from "../../data/poll"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** `AnalyticsLiveBadge`'s poll: twice inside the server's 15s cache TTL. */
const POLL_SECONDS = 15
/** The Search tab's status re-read while the first import runs (it lands within minutes). */
const SEARCH_IMPORT_POLL_SECONDS = 60

const isFirstImportRunning = (model: Model): boolean => {
	if (tabOf(model.search) !== "search") return false
	const site = searchSiteOf(model.search, Option.getOrUndefined(AsyncData.getData(model.searchStatus.data)))
	return site !== undefined && site.watermarkDate === null && site.lastError === null
}

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		/** `useIntervalRefresh`: restarts when the filters (the badge's atom) change; paused while hidden or offline. */
		livePoll: entry(
			{ filters: Schema.String },
			{
				modelToDependencies: ({ model }) => ({ filters: encodeJson(filtersOf(model.search)) }),
				dependenciesToStream: () =>
					pollTicks(Duration.seconds(POLL_SECONDS)).pipe(
						Stream.map(() => Message.TickedLivePoll()),
					),
			},
		),
		searchImportPoll: entry(
			{ isImporting: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isImporting: isFirstImportRunning(model) }),
				dependenciesToStream: ({ isImporting }) =>
					isImporting
						? pollTicks(Duration.seconds(SEARCH_IMPORT_POLL_SECONDS)).pipe(
								Stream.map(() => Message.TickedSearchImportPoll()),
							)
						: Stream.empty,
			},
		),
	}),
)
