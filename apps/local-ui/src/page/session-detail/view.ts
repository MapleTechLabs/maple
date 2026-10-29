import { button } from "@maple/web/ui/button"
import { icon } from "@maple/web/ui/icon"
import { spinner } from "@maple/web/ui/spinner"
import { truncatedText } from "@maple/web/ui/truncated-text"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import type { PageContext } from "../contract"
import type { TimeFormat } from "../kit/local-time"
import { refreshButton } from "../kit/toolbar"
import { errorState } from "../kit/view-states"
import { SessionDetailComposition, type SessionDetailViewBuilder } from "./composition"
import { Message } from "./message"
import type { Model, SessionDetail } from "./model"
import { card } from "./view-bits"
import { clientCard, tracesCard } from "./view-client"
import { hero, statTiles } from "./view-hero"
import { transcript } from "./view-transcript"

// The session detail page.

/** What the view reads from the root: data only, as Block view inputs carry no callbacks. */
export type SessionDetailViewInputs = Readonly<{
	context: PageContext
	/** The root's latest clock read (each server probe): legacy's per-render `Date.now()` for relative times. */
	clockMs: number
	/** The server's last ingest, for `useNewDataSince`'s "New data" pill. */
	lastIngestAtMs: Option.Option<number>
}>

/** `useNewDataSince(sinceMs)`: telemetry arrived after the detail loaded. */
const hasNewDataSince = (inputs: SessionDetailViewInputs, sinceMs: number): boolean =>
	sinceMs > 0 && Option.exists(inputs.lastIngestAtMs, (last) => last > sinceMs)

const transcriptBody = (h: SessionDetailViewBuilder, model: Model, session: SessionDetail): Html => {
	if (isPending(model.transcript)) return spinner(h, "size-4")
	const failure = failureWithoutData(model.transcript)
	if (Option.isSome(failure)) return errorState(h, { label: "transcript", failure: failure.value })
	const events = Option.getOrElse(AsyncData.getData(model.transcript.data), () => [])
	if (events.length === 0)
		return h.p([h.Class("text-sm text-muted-foreground")], ["No distilled events for this session."])
	return transcript(h, events, session.startTime)
}

const sessionBody = (
	h: SessionDetailViewBuilder,
	model: Model,
	session: SessionDetail,
	timeFormat: TimeFormat,
): Html => {
	const label = session.userName || session.userEmail || session.userId || "Anonymous"
	return h.div(
		[h.Class("mx-auto max-w-5xl px-4 py-5")],
		[
			hero(h, model, session, label, timeFormat),
			statTiles(h, session),
			h.div(
				[h.Class("mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]")],
				[
					h.div(
						[h.Class("flex flex-col gap-5")],
						[clientCard(h, session, label), tracesCard(h, model, session.traceIds)],
					),
					card(h, "Event transcript", [transcriptBody(h, model, session)]),
				],
			),
		],
	)
}

const content = (h: SessionDetailViewBuilder, model: Model, timeFormat: TimeFormat): Html => {
	if (isPending(model.detail))
		return h.div([h.Class("flex h-full items-center justify-center")], [spinner(h)])
	const failure = failureWithoutData(model.detail)
	if (Option.isSome(failure))
		return errorState(h, {
			label: "session",
			failure: failure.value,
			onRetry: Message.ClickedRetryDetail(),
		})
	const session = Option.getOrNull(AsyncData.getData(model.detail.data))
	if (session === null)
		return h.div(
			[h.Class("flex h-full items-center justify-center text-sm text-muted-foreground")],
			["Session not found."],
		)
	return sessionBody(h, model, session, timeFormat)
}

export const view = SessionDetailComposition.makeView.withInputs<SessionDetailViewInputs>(
	(opened, inputs, h) => {
		// "Live" and "started 3m ago" follow the root's clock.
		const model = { ...opened, nowMs: Math.max(opened.nowMs, inputs.clockMs) }
		return h.div(
			[h.Class("flex h-full flex-col")],
			[
				h.div(
					[h.Class("flex shrink-0 items-center gap-3 border-b px-4 py-2")],
					[
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								className: "gap-1.5",
								attributes: [h.OnClick(Message.ClickedBack())],
							},
							[icon(h, "ArrowLeftIcon"), inputs.context.canGoBack ? "Back" : "Sessions"],
						),
						truncatedText(
							h,
							{ text: model.sessionId, mono: true, className: "text-xs text-muted-foreground" },
							[model.sessionId],
						),
						refreshButton(h, {
							isSpinning: model.isRefreshing,
							hasNewData: hasNewDataSince(inputs, model.detailUpdatedAtMs),
							onRefresh: Message.ClickedRefresh(),
							className: "ml-auto",
						}),
					],
				),
				h.div(
					[h.Class("min-h-0 flex-1 overflow-auto")],
					[content(h, model, inputs.context.timeFormat)],
				),
			],
		)
	},
)
