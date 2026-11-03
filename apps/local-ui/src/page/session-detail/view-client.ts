import { EMPTY_VALUE, countLabel, formatDuration } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { cn } from "@maple/ui/lib/utils"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { spinner } from "@maple/views/ui/spinner"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { serviceDot } from "@maple/views/ui/values"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { isAwaitingFirstData } from "@maple/views/data/keyed"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import type { Model, SessionDetail, SessionTrace } from "./model"
import { card } from "./view-bits"

// The Client and Correlated traces cards of `SessionDetailView`.

const text = <M>(h: HtmlBuilder<M>, value: string, shown: string): Html =>
	truncatedText(h, { text: value }, [shown])

export const clientCard = <M>(h: HtmlBuilder<M>, session: SessionDetail, label: string): Html =>
	card(h, "Client", [
		keyValueList(
			h,
			{ layout: "stacked", className: "grid-cols-2 gap-x-4 gap-y-3 text-sm [&_dt]:text-xs" },
			[
				keyValue(h, { label: "User" }, [text(h, label, label || "-")]),
				keyValue(h, { label: "Browser" }, [text(h, session.browserName, session.browserName || "-")]),
				keyValue(h, { label: "OS" }, [text(h, session.osName, session.osName || "-")]),
				keyValue(h, { label: "Device" }, [text(h, session.deviceType, session.deviceType || "-")]),
				keyValue(h, { label: "Service" }, [
					session.serviceName
						? h.a(
								[
									h.Href(hrefFor(`/services/${encodeURIComponent(session.serviceName)}`)),
									h.Class(
										hstackClass({
											gap: "1.5",
											shrink: true,
											className: "hover:underline active:underline",
										}),
									),
								],
								[
									serviceDot(h, { serviceName: session.serviceName, size: "sm" }),
									text(h, session.serviceName, session.serviceName),
								],
							)
						: EMPTY_VALUE,
				]),
				keyValue(h, { label: "Entry URL", className: "col-span-2" }, [
					text(h, session.urlInitial, hostFromUrl(session.urlInitial) || "-"),
				]),
				keyValue(h, { label: "User agent", className: "col-span-2" }, [
					text(h, session.userAgent, session.userAgent || "-"),
				]),
			],
		),
	])

const traceItem = <M>(h: HtmlBuilder<M>, trace: SessionTrace): Html =>
	h.li(
		[h.Key(trace.traceId)],
		[
			h.a(
				[
					h.Href(hrefFor(`/traces/${encodeURIComponent(trace.traceId)}`)),
					h.Class(
						hstackClass({
							gap: "2",
							className:
								"group w-full rounded-lg border px-2.5 py-2 text-left hover:border-primary-a4 active:border-primary-a4 hover:bg-accent/40 active:bg-accent/40",
						}),
					),
				],
				[
					h.span(
						[
							h.Class(
								cn(
									"size-1.5 shrink-0 rounded-full",
									trace.hasError ? "bg-severity-error" : "bg-muted-foreground/40",
								),
							),
						],
						[],
					),
					h.span(
						[h.Class("min-w-0 flex-1")],
						[
							typography(h, { size: "sm", truncate: true, className: "block" }, [
								trace.rootSpanName || shortId(trace.traceId, "trace", { length: 12 }),
							]),
							hstack(
								h,
								{
									as: "span",
									gap: "1.5",
									shrink: true,
									className: typographyClass({ size: "xs", tone: "muted" }),
								},
								[
									...(trace.rootServiceName
										? [serviceDot(h, { serviceName: trace.rootServiceName, size: "sm" })]
										: []),
									typography(h, { truncate: true }, [
										trace.rootServiceName || "unknown",
										" ·",
										" ",
										countLabel(trace.spanCount, "span"),
									]),
								],
							),
						],
					),
					typography(
						h,
						{ size: "xs", tone: "muted", mono: true, numeric: true, className: "shrink-0" },
						[formatDuration(trace.durationMs)],
					),
					revealIcon(h, "ArrowRightIcon"),
				],
			),
		],
	)

export const tracesCard = <M>(h: HtmlBuilder<M>, model: Model, traceIds: ReadonlyArray<string>): Html =>
	card(h, `Correlated traces · ${traceIds.length}`, [
		traceIds.length === 0
			? typography(h, { as: "p", size: "sm", tone: "muted" }, ["No backend traces correlated."])
			: isAwaitingFirstData(model.traces)
				? spinner(h, "size-4")
				: h.ul(
						[h.Class("space-y-1.5")],
						Arr.map(
							Option.getOrElse(AsyncData.getData(model.traces.data), () => []),
							(trace) => traceItem(h, trace),
						),
					),
	])
