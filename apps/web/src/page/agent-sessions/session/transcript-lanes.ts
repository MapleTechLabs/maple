import type { CaptureCoverage, TranscriptRow } from "@maple/agent-sessions"
import { countLabel, formatDuration } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { spinner } from "../../../ui/spinner"
import { truncatedText } from "../../../ui/truncated-text"
import type { LoadProgress } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { payloadSection } from "./transcript-blocks"
import { avatar, CLOCK, clockOf, LABEL, META, row, SPEAKER } from "./transcript-shell"
import { REST_LOAD_FAILURE } from "./view-load"

// The transcript's structure: agent lanes, parallel markers, capture notes and dividers.

type H = HtmlBuilder<Message>

export const laneOpen = (
	h: H,
	model: Model,
	lane: Extract<TranscriptRow, { kind: "lane-open" }>,
	timeZone: string,
): Html => {
	const kind =
		lane.laneKind === "subagent"
			? lane.parentAgentName === undefined
				? "subagent"
				: `subagent of ${lane.parentAgentName}`
			: `agent · trace ${shortId(lane.span.traceId, "trace")}`
	return row(
		h,
		{
			depth: lane.depth,
			isHang: true,
			avatar: h.span(
				[h.Class("flex flex-col items-center")],
				[
					h.span([h.AriaHidden(true), h.Class("h-4")], []),
					avatar(h, "FaceRobotIcon", "bg-chart-1/15 text-chart-1"),
					h.span([h.AriaHidden(true), h.Class("w-px grow bg-border")], []),
				],
			),
		},
		[
			h.div(
				[h.Class("mt-4 flex h-6 items-center gap-2")],
				[
					truncatedText(h, { text: lane.agentName, className: cn(SPEAKER, "max-w-56 shrink") }),
					h.span([h.Class(CLOCK)], [clockOf(lane.startMs, timeZone)]),
					h.span(
						[h.Class(META)],
						[
							kind,
							" ",
							"· ",
							String(lane.spanCount),
							" spans · ",
							formatDuration(lane.span.durationMs),
						],
					),
				],
			),
			...(model.options.showPayloads && lane.args !== undefined
				? [
						panel(h, {}, [
							payloadSection(h, model, {
								label: "Task prompt",
								payload: lane.args,
								textKey: `${lane.key}:args-text`,
							}),
						]),
					]
				: []),
		],
	)
}

export const laneClose = (h: H, model: Model, lane: Extract<TranscriptRow, { kind: "lane-close" }>): Html =>
	row(
		h,
		{
			depth: lane.depth,
			isHang: true,
			avatar: h.span(
				[
					h.AriaHidden(true),
					h.Class("ml-[11px] h-4 w-3 rounded-bl-md border-border border-b border-l"),
				],
				[],
			),
		},
		[
			h.div(
				[h.Class("flex items-center gap-2 pt-2 pb-0.5")],
				[
					h.span(
						[h.Class("min-w-0 truncate text-muted-foreground text-xs")],
						[
							lane.agentName,
							lane.parentAgentName === undefined
								? " finished"
								: ` returned to ${lane.parentAgentName}`,
							" ",
							"· ",
							formatDuration(lane.durationMs),
							" · ",
							countLabel(lane.llmCalls, "LLM call"),
							" ·",
							" ",
							countLabel(lane.toolCalls, "tool call"),
						],
					),
				],
			),
			...(model.options.showPayloads && lane.result !== undefined
				? [
						panel(h, {}, [
							payloadSection(h, model, {
								label: "Returned",
								payload: lane.result,
								textKey: `${lane.key}:result-text`,
							}),
						]),
					]
				: []),
		],
	)

const parallelRule = (h: H, label: string, range: string): Html =>
	h.div(
		[h.Class("flex items-center gap-2 py-1.5 text-muted-foreground")],
		[
			icon(h, "BranchForkIcon", { size: 12, className: "shrink-0" }),
			truncatedText(h, { text: label, className: "font-medium text-xs" }),
			h.span([h.Class(cn(META, "shrink-0"))], [range]),
			h.span([h.AriaHidden(true), h.Class("h-px min-w-6 grow bg-border-subtle")], []),
		],
	)

type Cluster = Readonly<{
	startMs: number
	endMs: number
	overlapStartMs: number | undefined
	overlapEndMs: number | undefined
}>

const overlapWindow = (cluster: Cluster, timeZone: string): string =>
	cluster.overlapStartMs !== undefined && cluster.overlapEndMs !== undefined
		? `overlap ${clockOf(cluster.overlapStartMs, timeZone)} → ${clockOf(cluster.overlapEndMs, timeZone)}`
		: `interleaved ${clockOf(cluster.startMs, timeZone)} → ${clockOf(cluster.endMs, timeZone)}`

export const parallelMarker = (
	h: H,
	marker: Extract<TranscriptRow, { kind: "parallel" }>,
	timeZone: string,
): Html =>
	row(h, { depth: marker.depth, className: "pt-4", isFlush: true }, [
		parallelRule(
			h,
			`${marker.lanes.map((lane) => lane.agentName).join(" and ")} ran in parallel`,
			overlapWindow(marker, timeZone),
		),
	])

export const parallelTurnsMarker = (
	h: H,
	marker: Extract<TranscriptRow, { kind: "parallel-turns" }>,
	timeZone: string,
): Html =>
	row(h, { depth: marker.depth, className: "pt-4", isFlush: true }, [
		parallelRule(h, `${marker.turns.length} turns in parallel`, overlapWindow(marker, timeZone)),
	])

const CAPTURES_LABEL = {
	both: "prompts and replies",
	input: "prompts but not replies",
	output: "replies but not prompts",
	none: "no message content",
} satisfies Record<CaptureCoverage, string>

export const noteBlock = (h: H, note: Extract<TranscriptRow, { kind: "note" }>): Html => {
	if (note.noteKind === "capture-boundary")
		return row(h, { depth: note.depth, className: "pt-5", isFlush: true }, [
			h.div(
				[h.Class("flex items-center gap-2.5")],
				[
					icon(h, "CircleInfoIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
					h.span([h.Class(cn(LABEL, "text-muted-foreground"))], ["Capture changes here"]),
					h.span(
						[h.Class("min-w-0 text-muted-foreground text-xs")],
						[
							"spans below come from ",
							note.serviceName ?? "",
							", which records ",
							CAPTURES_LABEL[note.captures],
						],
					),
					h.span([h.AriaHidden(true), h.Class("h-px grow bg-border")], []),
				],
			),
		])
	const scope = note.scope === "session" ? `${note.anyCaptured ? "most of " : ""}this session` : "this turn"
	return h.div(
		[h.Class("mx-2 mt-2 flex max-w-[924px] items-start gap-3 rounded-lg bg-surface-sunken px-4 py-3")],
		[
			icon(h, "CircleInfoIcon", { size: 16, className: "mt-0.5 shrink-0 text-muted-foreground" }),
			h.div(
				[h.Class("flex min-w-0 grow flex-col gap-1")],
				[
					h.p(
						[h.Class("font-medium text-ui text-foreground")],
						["Message content isn't captured for ", scope],
					),
					h.p(
						[h.Class("text-muted-foreground text-xs leading-relaxed")],
						[
							"Prompts, replies and tool payloads are opt-in. The spans carry timing, models, tokens and tool names, but no text. The structure below is complete; only the words are missing.",
						],
					),
				],
			),
		],
	)
}

export const dividerBlock = (
	h: H,
	divider: Extract<TranscriptRow, { kind: "divider" }>,
	progress: LoadProgress | undefined,
	timeZone: string,
): Html => {
	if (divider.dividerKind === "compaction")
		return row(h, { depth: divider.depth, className: "py-4", isFlush: true }, [
			h.div(
				[h.Class("flex items-center gap-2.5")],
				[
					icon(h, "CompactLinesIcon", { size: 14, className: "shrink-0 text-chart-4" }),
					h.span([h.Class(cn(LABEL, "text-chart-4"))], ["Context compacted"]),
					...(divider.startMs === undefined
						? []
						: [h.span([h.Class(CLOCK)], [clockOf(divider.startMs, timeZone)])]),
					h.span(
						[h.Class("min-w-0 truncate text-muted-foreground text-xs")],
						["history replaced with a summary: the model no longer has the messages above"],
					),
					h.span([h.AriaHidden(true), h.Class("h-px grow bg-chart-4/30")], []),
				],
			),
		])
	return h.div(
		[
			h.DataAttribute("testid", "transcript-more"),
			h.Class("mt-8 flex flex-col items-center gap-2 border-input border-t border-dashed pt-6 pb-2"),
		],
		progress?.phase === "failed"
			? [
					errorState(h, {
						failure: REST_LOAD_FAILURE,
						variant: "row",
						onRetry: Message.ClickedRetryLoad(),
						className: "w-full max-w-xl",
					}),
				]
			: [
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							spinner(h, "text-muted-foreground", 13),
							h.span(
								[h.Class(cn(LABEL, "text-muted-foreground"))],
								["Loading the rest of this session"],
							),
						],
					),
					h.p(
						[h.Class("text-center text-ui text-muted-foreground")],
						["The agent's later turns are still arriving. This is not where the session ended."],
					),
				],
	)
}
