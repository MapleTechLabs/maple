import { getHttpInfo } from "@maple/ui/lib/http"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { linkButton } from "../../../ui/button"
import { httpSpanLabel } from "../../../ui/http-span-label"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { correlationWindow } from "./command"
import type { Message } from "./message"
import type { Model } from "./model"
import type { LoadedTrace } from "./select"

// The trace page's header: `titleContent` (the root span) and `headerActions` (logs, replay).

export const titleContent = (h: HtmlBuilder<Message>, trace: LoadedTrace): Html | undefined => {
	const root = trace.rootSpan
	if (root === undefined) return undefined
	return getHttpInfo({
		spanName: root.spanName,
		spanAttributes: { ...root.spanAttributes },
		spanKind: root.spanKind,
	}) !== null
		? pageTitle(h, { className: "min-w-0" }, [
				httpSpanLabel(h, {
					spanName: root.spanName,
					spanAttributes: root.spanAttributes,
					spanKind: root.spanKind,
					className: "gap-3",
				}),
			])
		: pageTitle(h, { title: root.spanName }, [root.spanName])
}

/** `TraceLogsLink`: "View Logs (N)" when any log carries the trace id; silent otherwise. */
export const logsLink = (h: HtmlBuilder<Message>, model: Model, trace: LoadedTrace): Html | null =>
	Option.match(correlationWindow(trace.traceStartTime, trace.data.totalDurationMs), {
		onNone: () => null,
		onSome: ({ startTime, endTime }) => {
			const total = Option.getOrElse(AsyncData.getData(model.logsCount.data), () => 0)
			return total === 0 || !AsyncData.isSuccess(model.logsCount.data)
				? null
				: linkButton(
						h,
						{
							variant: "outline",
							size: "xs",
							href: hrefOf(
								AppRoute.Logs({ search: { traceId: model.traceId, startTime, endTime } }),
							),
						},
						[icon(h, "FileIcon"), " View Logs (", String(total), ")"],
					)
		},
	})

/** `TraceReplayLink`: "View Session Replay" when a browser session observed the trace. */
export const replayLink = (h: HtmlBuilder<Message>, model: Model): Html | null =>
	Option.match(
		Option.flatMapNullishOr(AsyncData.getData(model.replaySessionId.data), (id) => id),
		{
			onNone: () => null,
			onSome: (sessionId) =>
				linkButton(
					h,
					{
						variant: "outline",
						size: "xs",
						href: hrefOf(AppRoute.Replay({ sessionId, search: {} })),
					},
					[icon(h, "EyeIcon"), " View Session Replay"],
				),
		},
	)

export const headerActions = (h: HtmlBuilder<Message>, model: Model, trace: LoadedTrace): Html | undefined =>
	trace.rootSpan === undefined
		? undefined
		: h.div([h.Class(cn("flex items-center gap-2"))], [logsLink(h, model, trace), replayLink(h, model)])
