import { Duration, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import * as LogsStream from "../../ui/logs/logs-stream"
import { ViewerFlags, viewerFlags } from "../../ui/logs/viewer"
import * as Shell from "../../shell"
import { LabShellFlags, labShellFlags, labShellSubscriptions } from "../app-shell"
import { defineLabWithFlags } from "../define"
import type { Resources } from "../../platform/resources"
import { Message, Model } from "../logs-lab/model"
import { init, update } from "../logs-lab/update"
import { view } from "../logs-lab/view"
import { pollTicks } from "../../data/poll"

/**
 * `/lab/logs`: the logs stream over a production-like fixture, with the lab's toggles for
 * wrap, density, search and pinned columns, and a live tail that reveals held-back rows on reload.
 */
const toShell = (message: Shell.Message) => Message.GotShellMessage({ message })

const own = Subscription.make<Model, Message, Resources>()((entry) => ({
	navigationKeys: entry(
		{ hasRows: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ hasRows: model.stream.rows.length > 0 }),
			dependenciesToStream: ({ hasRows }) =>
				hasRows
					? Stream.map(LogsStream.navigationKeys, (message) =>
							Message.GotStreamMessage({ message }),
						)
					: Stream.empty,
		},
	),
	/** `useIntervalRefresh`, held while the reader inspects the stream. */
	autoRefresh: entry(
		{ intervalSeconds: Schema.Number },
		{
			modelToDependencies: (model) => ({
				intervalSeconds: model.isInspecting ? 0 : model.refreshInterval,
			}),
			dependenciesToStream: ({ intervalSeconds }) =>
				intervalSeconds > 0
					? pollTicks(Duration.seconds(intervalSeconds)).pipe(
							Stream.map(() => Message.TickedAutoRefresh()),
						)
					: Stream.empty,
		},
	),
}))

const subscriptions = Subscription.aggregate<Model, Message, Resources>()(
	labShellSubscriptions<Model, Message>(toShell),
	own,
)

export const lab = defineLabWithFlags("Logs stream", {
	Model,
	Flags: Schema.Struct({ ...ViewerFlags.fields, ...LabShellFlags.fields }),
	flags: Effect.map(Effect.all([viewerFlags, labShellFlags]), ([viewer, shell]) => ({
		...viewer,
		...shell,
	})),
	init,
	update,
	view,
	subscriptions,
})
