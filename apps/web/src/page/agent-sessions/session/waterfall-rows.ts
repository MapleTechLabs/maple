import type { AiSessionSpan } from "@maple/domain/http"
import {
	type AiSpanCategory,
	GEN_AI_OPERATIONS,
	type IdleGap,
	type SessionTurn,
	spanModel,
	spanStartMs,
	toolSpanIssuers,
} from "@maple/agent-sessions"
import { filterSpans } from "../../../lib/agent-sessions/span-filters"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import type { SessionData } from "./derive"
import type { Model } from "./model"

// The session waterfall's row model (`buildRows`, `orderByTree`, `spanHeading`, `toolTarget`).

export const TURN_ROW_HEIGHT = 30
export const ROW_HEIGHT = 28

export type WaterfallRow =
	| Readonly<{ kind: "turn"; key: string; turn: SessionTurn; visibleCount: number }>
	| Readonly<{ kind: "span"; key: string; span: AiSessionSpan; depth: number }>
	| Readonly<{ kind: "gap"; key: string; gap: IdleGap }>

export const rowHeight = (row: WaterfallRow): number => (row.kind === "turn" ? TURN_ROW_HEIGHT : ROW_HEIGHT)

/** The rows the open waterfall draws, for the view and for the keyboard cursor in `update`. */
export const waterfallRowsOf = (model: Model, data: SessionData): ReadonlyArray<WaterfallRow> => {
	const spans = Arr.flatMap(data.turns, (turn) => turn.spans)
	return buildRows({
		turns: data.turns,
		gaps: model.options.collapseIdle ? data.summary.idleGaps : [],
		collapsedTurns: model.collapsedTurns,
		query: model.query,
		agentSpansOnly: model.options.agentSpansOnly,
		issuers: toolSpanIssuers(spans),
	})
}

/** Depth-first over the parent chain; a tool span sits under the model call that issued it when on the page. */
const orderByTree = (
	spans: ReadonlyArray<AiSessionSpan>,
	issuers: ReadonlyMap<string, string>,
): ReadonlyArray<Readonly<{ span: AiSessionSpan; depth: number }>> => {
	const present = new Set(Arr.map(spans, (span) => span.spanId))
	const parentOf = (span: AiSessionSpan): string | undefined => {
		const issuer = issuers.get(span.spanId)
		const parentId = issuer !== undefined && present.has(issuer) ? issuer : span.parentSpanId
		return parentId !== "" && present.has(parentId) ? parentId : undefined
	}
	const children = new Map<string, Array<AiSessionSpan>>()
	Arr.forEach(spans, (span) => {
		const parentId = parentOf(span)
		if (parentId !== undefined) children.set(parentId, [...(children.get(parentId) ?? []), span])
	})
	const childrenOf = (spanId: string) => children.get(spanId) ?? []
	const walk = (
		span: AiSessionSpan,
		depth: number,
	): ReadonlyArray<Readonly<{ span: AiSessionSpan; depth: number }>> => [
		{ span, depth },
		...Arr.flatMap(childrenOf(span.spanId), (child) => walk(child, depth + 1)),
	]
	return Arr.filter(spans, (span) => parentOf(span) === undefined).flatMap((root) => walk(root, 0))
}

/** Turns, their spans and the idle gaps between, in time order; a turn the filter empties drops out. */
export const buildRows = (input: {
	turns: ReadonlyArray<SessionTurn>
	gaps: ReadonlyArray<IdleGap>
	collapsedTurns: ReadonlyArray<string>
	query: string
	agentSpansOnly: boolean
	issuers: ReadonlyMap<string, string>
}): ReadonlyArray<WaterfallRow> => {
	const surviving = Arr.flatMap(input.turns, (turn) => {
		const spans = filterSpans(turn.spans, input.query, input.agentSpansOnly)
		return spans.length === 0 ? [] : [{ turn, spans }]
	})
	if (surviving.length === 0) return []
	const gapRow = (gap: IdleGap): WaterfallRow => ({ kind: "gap", key: gap.id, gap })
	// Every gap is placed once: before the first row that starts at or after it.
	const placed = new Set<string>()
	const gapsBefore = (limitMs: number): ReadonlyArray<WaterfallRow> =>
		Arr.map(
			Arr.filter(input.gaps, (gap) => !placed.has(gap.id) && gap.startMs < limitMs),
			(gap) => {
				placed.add(gap.id)
				return gapRow(gap)
			},
		)
	const rows = Arr.flatMap(surviving, ({ turn, spans }): ReadonlyArray<WaterfallRow> => {
		const head: ReadonlyArray<WaterfallRow> = [
			...gapsBefore(turn.startMs),
			{ kind: "turn", key: turn.id, turn, visibleCount: spans.length },
		]
		if (input.collapsedTurns.includes(turn.id)) return [...head, ...gapsBefore(turn.endMs)]
		const body = Arr.flatMap(
			orderByTree(spans, input.issuers),
			({ span, depth }): ReadonlyArray<WaterfallRow> => [
				...gapsBefore(spanStartMs(span)),
				{ kind: "span", key: `${turn.id}:${span.spanId}`, span, depth },
			],
		)
		return [...head, ...body, ...gapsBefore(turn.endMs)]
	})
	return [...rows, ...gapsBefore(Number.POSITIVE_INFINITY)]
}

const leadingOperation = (span: AiSessionSpan, name: string): string | undefined => {
	const reported = span.genAi.operationName
	if (reported !== undefined && (name === reported || Str.startsWith(`${reported} `)(name))) return reported
	const head = Str.split(" ")(name)[0] ?? ""
	return GEN_AI_OPERATIONS.has(head) ? head : undefined
}

const namesTheModel = (span: AiSessionSpan, subject: string): boolean => {
	const lower = Str.toLowerCase(subject)
	return (
		span.genAi.responseModel?.toLowerCase() === lower || span.genAi.requestModel?.toLowerCase() === lower
	)
}

/** The SPAN cell: the operation as chrome, and the one thing the row is about as its label. */
export const spanHeading = (
	span: AiSessionSpan,
	category: AiSpanCategory,
): Readonly<{ operation: string | undefined; subject: string | undefined }> => {
	const name = Str.trim(span.spanName)
	const operation = leadingOperation(span, name)
	const rest = operation === undefined ? name : Str.trim(Str.slice(operation.length)(name))
	const subject = rest === "" ? undefined : rest
	if (category === "tool") return { operation, subject: subject ?? span.genAi.toolName }
	if (category === "agent") return { operation, subject: subject ?? span.genAi.agentName }
	if (category === "inference" && subject !== undefined && namesTheModel(span, subject))
		return { operation, subject: undefined }
	return { operation, subject }
}

const TOOL_TARGET_KEYS = ["path", "file_path", "filePath", "file", "query", "pattern", "command", "url"]
const MAX_TARGET_LENGTH = 120

const clipTarget = (value: string): string | undefined => {
	const text = Str.replace(/\s+/g, " ")(Str.trim(value))
	if (text.length === 0) return undefined
	return text.length > MAX_TARGET_LENGTH ? `${Str.slice(0, MAX_TARGET_LENGTH - 1)(text)}…` : text
}

/** Vendor JSON: the arguments as one string, or an object whose string fields may name a target. */
const ToolArguments = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])
const decodeArguments = Schema.decodeUnknownOption(ToolArguments)
const decodeString = Schema.decodeUnknownOption(Schema.String)

/** What the tool was pointed at, from the argument keys that name a target. */
export const toolTarget = (span: AiSessionSpan): string | undefined =>
	Option.getOrUndefined(
		Option.flatMap(decodeArguments(span.genAi.toolCallArguments), (args) =>
			Schema.is(Schema.String)(args)
				? Option.fromUndefinedOr(clipTarget(args))
				: Option.flatMap(
						Option.firstSomeOf(Arr.map(TOOL_TARGET_KEYS, (key) => decodeString(args[key]))),
						(value) => Option.fromUndefinedOr(clipTarget(value)),
					),
		),
	)

/** The MODEL / TARGET cell: the model that ran, or what the tool acted on, or the app span's service. */
export const spanTarget = (span: AiSessionSpan, category: AiSpanCategory): string | undefined =>
	category === "tool"
		? toolTarget(span)
		: (spanModel(span) ?? (span.isAiSpan ? undefined : span.serviceName))
