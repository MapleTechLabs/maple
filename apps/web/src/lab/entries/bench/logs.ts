import { LOGS_TABLE_BENCH_ROWS } from "../../bench/logs-table-bench-fixture"
import { Effect, Option, Schema, Stream } from "effect"
import { Mount, Subscription, Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { logTimeFormat, toLogRowView } from "../../../ui/logs/log-row-view"
import * as LogsStream from "../../../ui/logs/logs-stream"
import * as LogsStreamView from "../../../ui/logs/logs-stream-view"
import { listFooterText, ViewerFlags, viewerFlags } from "../../../ui/logs/viewer"
import { defineLabWithFlags } from "../../define"
import { foldLabToasts, initLabToasts, labRoot } from "../../toasts"
import * as Toast from "../../../ui/toast"
import { installLogsBench } from "../../bench/logs-harness"

/**
 * `/lab/bench/logs`: the logs stream over 2,000 wide synthetic rows,
 * with the `window.__logsBench` harness for `perf/logs.perf.spec.ts`.
 */
const PINNED_COLUMNS = ["deployment.environment.name", "cloud.region"]

// MODEL

const Model = Schema.Struct({
	stream: LogsStream.Model,
	timeZone: Schema.String,
	footerText: Schema.String,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	GotStreamMessage: { message: LogsStream.Message },
	CompletedBenchInstall: {},
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

// MOUNT

const InstallLogsBench = Mount.define("InstallLogsBench", {
	messages: [Message.CompletedBenchInstall],
	execute: ({ element }) =>
		Effect.acquireRelease(
			Effect.sync(() => (element instanceof HTMLElement ? installLogsBench(element) : () => undefined)),
			(uninstall) => Effect.sync(uninstall),
		).pipe(Effect.as(Message.CompletedBenchInstall())),
})

// INIT

const init = (flags: ViewerFlags): Update.Return<Model, Message> => {
	const time = logTimeFormat(flags.timeZone)
	return {
		model: {
			stream: LogsStream.init(
				"logs-bench",
				LOGS_TABLE_BENCH_ROWS.map((log) => toLogRowView(log, PINNED_COLUMNS, time)),
			),
			timeZone: flags.timeZone,
			toasts: initLabToasts(),
			footerText: listFooterText(flags.locale, {
				shown: LOGS_TABLE_BENCH_ROWS.length,
				noun: "logs",
				capped: true,
				hasMore: false,
			}),
		},
	}
}

// UPDATE

const unchanged: Update.Step<Model, Message> = (model) => ({ model })

// The bench passes `onLogClick={() => {}}` and no live tail: nothing the stream reports goes anywhere.
const foldStream = Update.foldChild({
	update: LogsStream.update,
	read: (model: Model) => Option.some(model.stream),
	write: (model, stream) => modifyFields(model, { stream: () => stream }),
	toParentMessage: (message: LogsStream.Message) => Message.GotStreamMessage({ message }),
	foldOutMessage: LogsStream.OutMessage.match<Update.Step<Model, Message>>({
		OpenedLog: () => unchanged,
		ChangedInspecting: () => unchanged,
		ChoseAttributeFilter: () => unchanged,
	}),
})

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotStreamMessage: ({ message: streamMessage }) => foldStream(model, streamMessage),
		CompletedBenchInstall: () => ({ model }),
		GotToastMessage: ({ message }) => foldToasts(model, message),
	})

// VIEW

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.DataAttribute("logs-bench", "true"),
			h.Class("flex h-screen flex-col bg-background p-4 text-foreground"),
			h.OnMount(InstallLogsBench()),
		],
		[
			h.submodel({
				slotId: "logs-stream",
				model: model.stream,
				view: LogsStreamView.view,
				toParentMessage: (message) => Message.GotStreamMessage({ message }),
				viewInputs: {
					wrap: false,
					density: "compact",
					pinnedColumns: PINNED_COLUMNS,
					searchText: undefined,
					timeZone: model.timeZone,
					isWaiting: false,
					footerText: model.footerText,
					canFilter: false,
				},
			}),
		],
	)

// SUBSCRIPTION

const subscriptions = Subscription.make<Model, Message>()((entry) => ({
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
}))

export const lab = defineLabWithFlags("Logs table", {
	Model,
	Flags: ViewerFlags,
	flags: viewerFlags,
	init,
	update,
	view,
	subscriptions,
})
