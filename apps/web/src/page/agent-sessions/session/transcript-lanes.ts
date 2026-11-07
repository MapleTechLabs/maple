import type { CaptureCoverage, TranscriptRow } from "@maple/agent-sessions"
import { countLabel, formatDuration } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { separator } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { spinner } from "@maple/views/ui/spinner"
import { timestamp } from "@maple/views/ui/timestamp"
import { truncatedText } from "@maple/views/ui/truncated-text"
import type { LoadProgress } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { payloadSection } from "./transcript-blocks"
import { avatar, clock, clockOf, LABEL, META, row, SPEAKER } from "./transcript-shell"
import { REST_LOAD_FAILURE } from "./view-load"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { fillRule } from "@maple/views/ui/rule"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
			avatar: vstack(h, { align: "center", as: "span" }, [
				h.span([h.AriaHidden(true), h.Class("h-4")], []),
				avatar(h, "FaceRobotIcon", "bg-chart-1/15 text-chart-1"),
				separator(h, "vertical", "mx-auto grow"),
			]),
		},
		[
			hstack(h, { gap: "2", align: "center", className: "mt-4 h-6" }, [
				truncatedText(h, { text: lane.agentName, className: cn(SPEAKER, "max-w-56 shrink") }),
				clock(h, lane.startMs, timeZone, model.nowMs),
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
			]),
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
					h.Class("ml-2.75 h-4 w-3 rounded-bl-md border-border border-b border-l"),
				],
				[],
			),
		},
		[
			hstack(h, { gap: "2", align: "center", className: "pt-2 pb-0.5" }, [
				typography(h, { size: "xs", tone: "muted", truncate: true, className: "min-w-0" }, [
					lane.agentName,
					lane.parentAgentName === undefined ? " finished" : ` returned to ${lane.parentAgentName}`,
					" ",
					"· ",
					formatDuration(lane.durationMs),
					" · ",
					countLabel(lane.llmCalls, "LLM call"),
					" ·",
					" ",
					countLabel(lane.toolCalls, "tool call"),
				]),
			]),
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

const parallelRule = (h: H, label: string, range: ReadonlyArray<Html | string>): Html =>
	hstack(h, { gap: "2", align: "center", className: "py-1.5 text-muted-foreground" }, [
		icon(h, "BranchForkIcon", { size: 12, className: "shrink-0" }),
		truncatedText(h, { text: label, className: typographyClass({ size: "xs", weight: "medium" }) }),
		h.span([h.Class(cn(META, "shrink-0"))], range),
		separator(h, "horizontal", "min-w-6 flex-1 bg-border-subtle"),
	])

type Cluster = Readonly<{
	startMs: number
	endMs: number
	overlapStartMs: number | undefined
	overlapEndMs: number | undefined
}>

const overlapWindow = (h: H, cluster: Cluster, timeZone: string): ReadonlyArray<Html | string> => {
	const at = (epochMs: number): Html =>
		timestamp(h, { value: epochMs, timeZone, label: clockOf(epochMs, timeZone) })
	return cluster.overlapStartMs !== undefined && cluster.overlapEndMs !== undefined
		? ["overlap ", at(cluster.overlapStartMs), " → ", at(cluster.overlapEndMs)]
		: ["interleaved ", at(cluster.startMs), " → ", at(cluster.endMs)]
}

export const parallelMarker = (
	h: H,
	marker: Extract<TranscriptRow, { kind: "parallel" }>,
	timeZone: string,
): Html =>
	row(h, { depth: marker.depth, className: "pt-4", isFlush: true }, [
		parallelRule(
			h,
			`${Arr.join(
				Arr.map(marker.lanes, (lane) => lane.agentName),
				" and ",
			)} ran in parallel`,
			overlapWindow(h, marker, timeZone),
		),
	])

export const parallelTurnsMarker = (
	h: H,
	marker: Extract<TranscriptRow, { kind: "parallel-turns" }>,
	timeZone: string,
): Html =>
	row(h, { depth: marker.depth, className: "pt-4", isFlush: true }, [
		parallelRule(h, `${marker.turns.length} turns in parallel`, overlapWindow(h, marker, timeZone)),
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
			hstack(h, { gap: "2.5" }, [
				icon(h, "CircleInfoIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
				h.span([h.Class(cn(LABEL, "text-muted-foreground"))], ["Capture changes here"]),
				typography(h, { size: "xs", tone: "muted", className: "min-w-0" }, [
					"spans below come from ",
					note.serviceName ?? "",
					", which records ",
					CAPTURES_LABEL[note.captures],
				]),
				fillRule(h),
			]),
		])
	const scope = note.scope === "session" ? `${note.anyCaptured ? "most of " : ""}this session` : "this turn"
	return hstack(
		h,
		{
			gap: "3",
			align: "start",
			className: "mx-2 mt-2 max-w-[924px] rounded-lg bg-surface-sunken px-4 py-3",
		},
		[
			icon(h, "CircleInfoIcon", {
				size: 16,
				className: typographyClass({ tone: "muted", className: "mt-0.5 shrink-0" }),
			}),
			vstack(h, { gap: "1", shrink: true, className: "grow" }, [
				h.p(
					[h.Class("font-medium text-ui text-foreground")],
					["Message content isn't captured for ", scope],
				),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "leading-relaxed" }, [
					"Prompts, replies and tool payloads are opt-in. The spans carry timing, models, tokens and tool names, but no text. The structure below is complete; only the words are missing.",
				]),
			]),
		],
	)
}

export const dividerBlock = (
	h: H,
	divider: Extract<TranscriptRow, { kind: "divider" }>,
	progress: LoadProgress | undefined,
	timeZone: string,
	nowMs: number,
): Html => {
	if (divider.dividerKind === "compaction")
		return row(h, { depth: divider.depth, className: "py-4", isFlush: true }, [
			hstack(h, { gap: "2.5" }, [
				icon(h, "CompactLinesIcon", { size: 14, className: "shrink-0 text-chart-4" }),
				h.span([h.Class(cn(LABEL, "text-chart-4"))], ["Context compacted"]),
				...(divider.startMs === undefined ? [] : [clock(h, divider.startMs, timeZone, nowMs)]),
				typography(h, { size: "xs", tone: "muted", truncate: true, className: "min-w-0" }, [
					"history replaced with a summary: the model no longer has the messages above",
				]),
				h.span([h.AriaHidden(true), h.Class("h-px grow bg-chart-4/30")], []),
			]),
		])
	return vstack(
		h,
		{
			gap: "2",
			align: "center",
			className: "mt-8 border-input border-t border-dashed pt-6 pb-2",
			attributes: [h.DataAttribute("testid", "transcript-more")],
		},
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
					hstack(h, { gap: "2" }, [
						spinner(h, "text-muted-foreground", 13),
						h.span(
							[h.Class(cn(LABEL, "text-muted-foreground"))],
							["Loading the rest of this session"],
						),
					]),
					h.p(
						[h.Class("text-center text-ui text-muted-foreground")],
						["The agent's later turns are still arriving. This is not where the session ended."],
					),
				],
	)
}
