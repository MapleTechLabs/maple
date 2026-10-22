import { parseClickHouseDateTime, type WarehouseTime } from "../../lib/time"
import { cn } from "@maple/ui/lib/utils"
import { icon, type IconName } from "@maple/web/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { TranscriptEvent } from "./model"

// The session transcript and its body.

const offsetLabel = (startTime: WarehouseTime, ts: WarehouseTime): string => {
	const start = parseClickHouseDateTime(startTime)
	const at = parseClickHouseDateTime(ts)
	if (start === null || at === null) return ""
	const deltaMs = Math.max(0, at - start)
	if (deltaMs < 1000) return `+${deltaMs}ms`
	return `+${(deltaMs / 1000).toFixed(1)}s`
}

const EVENT_ICONS: ReadonlyMap<string, IconName> = new Map([
	["navigation", "GlobeIcon"],
	["click", "PulseIcon"],
	["input", "PulseIcon"],
	["console", "CodeIcon"],
	["network", "NetworkNodesIcon"],
	["error", "CircleWarningIcon"],
] as const)

const isErrorEvent = (event: TranscriptEvent): boolean =>
	event.type === "error" ||
	(event.type === "console" && event.level === "error") ||
	(event.type === "network" && event.netStatus >= 400)

const line = <M>(h: HtmlBuilder<M>, className: string, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class(className)], children)

const body = <M>(h: HtmlBuilder<M>, event: TranscriptEvent): Html => {
	const muted = "truncate text-xs text-muted-foreground"
	if (event.type === "navigation") return line(h, muted, [event.url || "-"])
	if (event.type === "click") return line(h, muted, [event.targetText || event.targetSelector || "element"])
	if (event.type === "input")
		return line(h, "truncate font-mono text-xs text-muted-foreground", [event.targetSelector || "input"])
	if (event.type === "console") return line(h, "break-words text-xs text-muted-foreground", [event.message])
	if (event.type === "network")
		return line(h, muted, [
			h.span([h.Class("font-medium text-foreground")], [event.netMethod]),
			" ",
			event.netUrl,
			h.span(
				[h.Class(cn("ml-1.5 tabular-nums", event.netStatus >= 400 && "text-severity-error"))],
				[
					event.netStatus ? String(event.netStatus) : "-",
					" · ",
					String(Math.round(event.netDurationMs)),
					"ms",
				],
			),
		])
	if (event.type === "error")
		return h.div(
			[],
			[
				line(h, "break-words text-xs text-severity-error", [event.message]),
				...(event.errorStack
					? [
							h.pre(
								[
									h.Class(
										"mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-1.5 font-mono text-[10px] text-muted-foreground",
									),
								],
								[event.errorStack],
							),
						]
					: []),
			],
		)
	return line(h, muted, [event.message])
}

export const transcript = <M>(
	h: HtmlBuilder<M>,
	events: ReadonlyArray<TranscriptEvent>,
	startTime: WarehouseTime,
): Html =>
	h.ol(
		[h.Class("space-y-3")],
		events.map((event) =>
			h.li(
				[h.Key(`${event.seq}-${String(event.timestamp)}`), h.Class("flex gap-3")],
				[
					h.span(
						[
							h.Class(
								cn(
									"mt-0.5 grid size-6 shrink-0 place-items-center rounded-full",
									isErrorEvent(event)
										? "bg-severity-error/10 text-severity-error"
										: "bg-muted text-muted-foreground",
								),
							),
						],
						[icon(h, EVENT_ICONS.get(event.type) ?? "CodeIcon", { className: "size-3.5" })],
					),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							h.div(
								[h.Class("flex items-baseline justify-between gap-2")],
								[
									h.span([h.Class("text-xs font-medium capitalize")], [event.type]),
									h.span(
										[
											h.Class(
												"shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground",
											),
										],
										[offsetLabel(startTime, event.timestamp)],
									),
								],
							),
							body(h, event),
						],
					),
				],
			),
		),
	)
