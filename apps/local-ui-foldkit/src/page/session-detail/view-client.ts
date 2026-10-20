import { EMPTY_VALUE, countLabel, formatDuration } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { cn } from "@maple/ui/lib/utils"
import { icon } from "@maple/web/ui/icon"
import { keyValue, keyValueList } from "@maple/web/ui/key-value"
import { spinner } from "@maple/web/ui/spinner"
import { truncatedText } from "@maple/web/ui/truncated-text"
import { serviceDot } from "@maple/web/ui/values"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { isPending } from "../../data/slot"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import type { Model, SessionDetail, SessionTrace } from "./model"
import { card } from "./view-bits"

// The Client and Correlated traces cards of `SessionDetailView`.

const text = <M>(h: HtmlBuilder<M>, value: string, shown: string): Html => truncatedText(h, { text: value }, [shown])

export const clientCard = <M>(h: HtmlBuilder<M>, session: SessionDetail, label: string): Html =>
	card(h, "Client", [
		keyValueList(h, { layout: "stacked", className: "grid-cols-2 gap-x-4 gap-y-3 text-sm [&_dt]:text-xs" }, [
			keyValue(h, { label: "User" }, [text(h, label, label || "-")]),
			keyValue(h, { label: "Browser" }, [text(h, session.browserName, session.browserName || "-")]),
			keyValue(h, { label: "OS" }, [text(h, session.osName, session.osName || "-")]),
			keyValue(h, { label: "Device" }, [text(h, session.deviceType, session.deviceType || "-")]),
			keyValue(h, { label: "Service" }, [
				session.serviceName
					? h.a(
							[
								h.Href(hrefFor(`/services/${encodeURIComponent(session.serviceName)}`)),
								h.Class("flex min-w-0 items-center gap-1.5 hover:underline"),
							],
							[serviceDot(h, { serviceName: session.serviceName, size: "sm" }), text(h, session.serviceName, session.serviceName)],
						)
					: EMPTY_VALUE,
			]),
			keyValue(h, { label: "Entry URL", className: "col-span-2" }, [text(h, session.urlInitial, hostFromUrl(session.urlInitial) || "-")]),
			keyValue(h, { label: "User agent", className: "col-span-2" }, [text(h, session.userAgent, session.userAgent || "-")]),
		]),
	])

const traceItem = <M>(h: HtmlBuilder<M>, trace: SessionTrace): Html =>
	h.li(
		[h.Key(trace.traceId)],
		[
			h.a(
				[
					h.Href(hrefFor(`/traces/${encodeURIComponent(trace.traceId)}`)),
					h.Class("group flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"),
				],
				[
					h.span([h.Class(cn("size-1.5 shrink-0 rounded-full", trace.hasError ? "bg-severity-error" : "bg-muted-foreground/40"))], []),
					h.span(
						[h.Class("min-w-0 flex-1")],
						[
							h.span([h.Class("block truncate text-sm")], [trace.rootSpanName || shortId(trace.traceId, "trace", { length: 12 })]),
							h.span(
								[h.Class("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground")],
								[
									...(trace.rootServiceName ? [serviceDot(h, { serviceName: trace.rootServiceName, size: "sm" })] : []),
									h.span([h.Class("truncate")], [trace.rootServiceName || "unknown", " ·", " ", countLabel(trace.spanCount, "span")]),
								],
							),
						],
					),
					h.span([h.Class("shrink-0 font-mono text-xs tabular-nums text-muted-foreground")], [formatDuration(trace.durationMs)]),
					icon(h, "ArrowRightIcon", {
						size: 14,
						className: "shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
					}),
				],
			),
		],
	)

export const tracesCard = <M>(h: HtmlBuilder<M>, model: Model, traceIds: ReadonlyArray<string>): Html =>
	card(h, `Correlated traces · ${traceIds.length}`, [
		traceIds.length === 0
			? h.p([h.Class("text-sm text-muted-foreground")], ["No backend traces correlated."])
			: isPending(model.traces)
				? spinner(h, "size-4")
				: h.ul(
						[h.Class("space-y-1.5")],
						Option.getOrElse(AsyncData.getData(model.traces.data), () => []).map((trace) => traceItem(h, trace)),
					),
	])
