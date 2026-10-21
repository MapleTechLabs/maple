import type { Html, HtmlBuilder } from "foldkit/html"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { presenceOf } from "../kit/signal-presence"
import { docsLink, signalEmptyState } from "../kit/signal-empty-state"
import type { Message } from "./message"
import type { Model } from "./model"

// The service map's empty state: the dotted
// grid and a faint ghost graph over the presence-aware empty copy.

/** The keyframes' CSS text, whitespace included (it is part of the page's text). */
const FLOW_CSS = [
	"",
	"\t\t\t\t\t\t@keyframes sm-empty-flow { to { stroke-dashoffset: -16; } }",
	"\t\t\t\t\t\t.sm-empty-flow { animation: sm-empty-flow 1.8s linear infinite; }",
	"\t\t\t\t\t\t@media (prefers-reduced-motion: reduce) { .sm-empty-flow { animation: none; } }",
	"\t\t\t\t\t",
].join("\n")

const attrs = <M>(h: HtmlBuilder<M>, values: Readonly<Record<string, string>>) =>
	Object.entries(values).map(([name, value]) => h.Attribute(name, value))

const ghostNode = <M>(h: HtmlBuilder<M>, x: number, y: number, color: string): Html =>
	h.g(
		[],
		[
			h.rect(
				attrs(h, {
					x: String(x),
					y: String(y),
					width: "72",
					height: "30",
					rx: "7",
					fill: color,
					"fill-opacity": "0.16",
					stroke: color,
					"stroke-opacity": "0.5",
					"stroke-width": "1.25",
				}),
			),
			h.circle(
				attrs(h, {
					cx: String(x + 13),
					cy: String(y + 15),
					r: "3",
					fill: color,
					"fill-opacity": "0.9",
				}),
			),
			h.rect(
				attrs(h, {
					x: String(x + 22),
					y: String(y + 10),
					width: "36",
					height: "3",
					rx: "1.5",
					fill: color,
					"fill-opacity": "0.34",
				}),
			),
			h.rect(
				attrs(h, {
					x: String(x + 22),
					y: String(y + 17),
					width: "22",
					height: "3",
					rx: "1.5",
					fill: color,
					"fill-opacity": "0.2",
				}),
			),
		],
	)

const MASK_GRID = "radial-gradient(ellipse 75% 72% at 50% 50%, transparent 26%, black 82%)"
const MASK_GRAPH = "radial-gradient(ellipse 62% 78% at 50% 50%, black 52%, transparent 100%)"

const ghostGraph = <M>(h: HtmlBuilder<M>): Html =>
	h.svg(
		[
			h.AriaHidden(true),
			h.Attribute("viewBox", "0 0 460 178"),
			h.Class("pointer-events-none mb-1 w-[min(440px,76vw)] text-muted-foreground"),
			h.Attribute("fill", "none"),
			h.Style({ "mask-image": MASK_GRAPH, "-webkit-mask-image": MASK_GRAPH }),
		],
		[
			h.style([], [FLOW_CSS]),
			h.g(
				attrs(h, {
					stroke: "currentColor",
					"stroke-width": "1.25",
					"stroke-opacity": "0.3",
					"stroke-dasharray": "4 4",
				}),
				[
					h.path(attrs(h, { d: "M108 49 C 150 40, 162 30, 194 27" })),
					h.path([
						h.Class("sm-empty-flow"),
						...attrs(h, { d: "M108 49 C 150 66, 162 122, 194 131" }),
					]),
					h.path(attrs(h, { d: "M266 27 C 312 34, 322 72, 352 79" })),
					h.path(attrs(h, { d: "M266 131 C 312 122, 322 86, 352 79" })),
				],
			),
			ghostNode(h, 36, 34, "var(--service-1)"),
			ghostNode(h, 194, 12, "var(--service-2)"),
			ghostNode(h, 194, 116, "var(--service-3)"),
			ghostNode(h, 352, 64, "var(--service-5)"),
		],
	)

/** Traces arriving with no edges means context is not propagated; no traces means setup. */
const message = <M>(h: HtmlBuilder<M>, model: Model): Html => {
	const presence = presenceOf(model.presence, "traces")
	if (presence.status === "present")
		return empty(
			h,
			[
				emptyHeader(h, [
					emptyMedia(h, { variant: "icon" }, [icon(h, "NetworkNodesIcon", { size: 18 })]),
					emptyTitle(h, ["No service calls in this window"]),
					emptyDescription(h, [
						"Traces are arriving, but no service calls another one yet. Propagate trace context on outgoing HTTP calls so both sides share a trace.",
					]),
				]),
				emptyContent(h, [docsLink(h, "serviceMap")]),
			],
			"flex-none bg-transparent py-0",
		)
	return signalEmptyState(h, {
		signal: "traces",
		presence,
		nowMs: model.nowMs,
		noun: "service calls",
		purpose: "See which services call each other, drawn from the spans they send.",
		guideDocs: "serviceMap",
		className: "flex-none bg-transparent py-0",
	})
}

/** The empty canvas: a skeleton until the page-init presence read settles. */
export const serviceMapEmptyState = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.Class("relative flex h-full items-center justify-center overflow-hidden")],
		[
			h.div([
				h.AriaHidden(true),
				h.Class("pointer-events-none absolute inset-0 opacity-70"),
				h.Style({
					"background-image": "radial-gradient(circle, var(--border) 1px, transparent 1px)",
					"background-size": "16px 16px",
					"mask-image": MASK_GRID,
					"-webkit-mask-image": MASK_GRID,
				}),
			]),
			h.div(
				[
					h.Class(
						"relative z-10 flex flex-col items-center motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:[animation-duration:300ms]",
					),
				],
				[ghostGraph(h), message(h, model)],
			),
		],
	)
