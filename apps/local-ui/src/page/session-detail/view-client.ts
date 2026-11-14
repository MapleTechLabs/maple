import { EMPTY_VALUE, countLabel, formatDuration } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { spinner } from "@maple/views/ui/spinner"
import { statusDot } from "@maple/views/ui/status-dot"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { serviceLabel } from "@maple/views/ui/service-label"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { isAwaitingFirstData } from "@maple/views/data/keyed"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import type { Model, SessionDetail, SessionTrace } from "./model"
import { card } from "./view-bits"

// The session detail page's Client and Correlated traces cards.

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
								[serviceLabel(h, { serviceName: session.serviceName, dot: "sm" })],
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
								"group w-full rounded-md border px-2.5 py-2 text-left hover:border-primary-a4 active:border-primary-a4 hover:bg-surface-sunken active:bg-surface-sunken",
						}),
					),
				],
				[
					statusDot(h, { tone: trace.hasError !== 0 ? "crit" : "neutral" }),
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
									trace.rootServiceName
										? serviceLabel(h, { serviceName: trace.rootServiceName, dot: "sm" }, [
												typography(h, { className: "shrink-0 whitespace-nowrap" }, [
													"· ",
													countLabel(trace.spanCount, "span"),
												]),
											])
										: typography(h, { truncate: true }, [
												"unknown · ",
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
			? typography(h, { as: "p", size: "sm", tone: "muted" }, ["No backend traces correlated"])
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
