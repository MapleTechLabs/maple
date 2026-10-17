import { resolveRefreshIntervalSeconds } from "@maple/web/lib/dashboard-controls/search-params"
import { Duration, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as LogsStream from "../../../ui/logs/logs-stream"
import type { PageSubscriptionInput } from "../../contract"
import { searchPreset } from "../../kit/time-controls"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"

type Input = PageSubscriptionInput<Model>

export const subscriptions = Subscription.make<Input, Message>()((entry) => ({
	/** `useListNavigation` and the →/← expand hotkeys, while the stream has rows. */
	navigationKeys: entry(
		{ hasRows: Schema.Boolean },
		{
			modelToDependencies: ({ model }) => ({ hasRows: model.stream.rows.length > 0 }),
			dependenciesToStream: ({ hasRows }) =>
				hasRows
					? Stream.map(LogsStream.navigationKeys, (message) =>
							Message.GotStreamMessage({ message }),
						)
					: Stream.empty,
		},
	),
	/**
	 * `PageRefreshProvider`'s `useIntervalRefresh`: the `?refresh=` cadence, held while the reader
	 * inspects and off for a custom range (a fixed window has nothing new to tail).
	 */
	autoRefresh: entry(
		{ intervalSeconds: Schema.Number },
		{
			modelToDependencies: ({ model }) => ({
				intervalSeconds:
					model.isInspecting ||
					model.selectedIndex !== null ||
					searchPreset(model.search, DEFAULT_PRESET) === undefined
						? 0
						: resolveRefreshIntervalSeconds(model.search.refresh, undefined),
			}),
			dependenciesToStream: ({ intervalSeconds }) =>
				intervalSeconds > 0
					? Stream.tick(Duration.seconds(intervalSeconds)).pipe(
							Stream.drop(1),
							Stream.map(() => Message.TickedAutoRefresh()),
						)
					: Stream.empty,
		},
	),
}))
