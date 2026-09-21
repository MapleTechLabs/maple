/**
 * `ChatMessage` → blocks.
 *
 * Everything the agent writes into its prose that is not prose comes back out here: a ```chart
 * fence becomes a chart, a `<<maple:…>>` annotation becomes an entity reference, and both keep the
 * position the model wrote them in. Leaving either in the text would put raw JSON in a channel,
 * which is what a reader of an unparsed reply actually sees.
 *
 * The parsers are `@maple/domain`'s, shared with the web transcript, so the two surfaces cannot
 * disagree about what counts as a chart or a card.
 */
import { parseAnnotations, type AnnotationSegment } from "@maple/domain/chat-annotations"
import {
	normalizeUnit,
	parseChartSpec,
	splitChartFences,
	type ChartSpec,
} from "@maple/domain/chat-chart-spec"
import { delegatedAgentOf, type ChatMessage, type ChatToolCall } from "@maple/domain/chat-session"
import { formatDuration, formatNumber } from "@maple/domain/format"
import { encodeChatActionToken } from "../action-token"
import type { ChatBlock, ChatEntityBlock, ChatRenderContext, ChatToolActivity } from "./blocks"

export const renderChatMessage = (
	message: ChatMessage,
	context: ChatRenderContext,
): ReadonlyArray<ChatBlock> => {
	const blocks: Array<ChatBlock> = []
	let chartIndex = 0

	for (const part of splitChartFences(message.text)) {
		if (part.kind === "chart") {
			// Counted before it is judged. The image endpoint numbers the fences it
			// finds, not the ones that turned out to be charts, so skipping the index
			// of a malformed one here would put every later chart under the wrong plot.
			const index = chartIndex++
			// A fence still arriving is held back entirely, so a half-written chart shows
			// as nothing until the next edit rather than as JSON.
			if (!part.closed) continue
			const spec = parseChartSpec(part.value)
			// Model output that is not a chart after all stays visible as the fence it was, so a bad
			// payload is debuggable rather than silently missing — the same call web makes.
			if (spec === null) {
				pushProse(blocks, `${CHART_FENCE}\n${part.value}\n${FENCE}`)
				continue
			}
			blocks.push({
				kind: "chart",
				spec,
				unit: normalizeUnit(spec.unit),
				title: spec.title ?? null,
				summary: chartSummary(spec),
				imageUrl: context.chartImageUrl({
					sessionId: context.sessionId,
					messageId: message.id,
					chartIndex: index,
					spec,
				}),
			})
			continue
		}
		for (const segment of parseAnnotations(part.value)) {
			if (segment.type === "text") pushProse(blocks, segment.content)
			else blocks.push(entityBlock(segment, context))
		}
	}

	const activity = message.toolCalls.filter((call) => call.proposed !== true).map(toolActivity)
	if (activity.length > 0) blocks.push({ kind: "activity", tools: activity })

	for (const call of message.toolCalls) {
		if (call.proposed !== true) continue
		blocks.push({
			kind: "approval",
			toolName: call.name,
			summary: summarizeToolInput(call.input),
			token: encodeChatActionToken(context.sessionId, call.id),
		})
	}

	return blocks
}

const CHART_FENCE = "```chart"
const FENCE = "```"

const pushProse = (blocks: Array<ChatBlock>, markdown: string): void => {
	const trimmed = markdown.trim()
	if (trimmed.length > 0) blocks.push({ kind: "prose", markdown: trimmed })
}

/** What the plot would have shown, for a platform that has no image of it. */
const chartSummary = (spec: ChartSpec): string => {
	if (spec.type === "ranked") {
		const highest = spec.data.reduce((top, point) => (point.value > top.value ? point : top))
		return `${plural(spec.data.length, "item")}, highest ${highest.name} (${formatNumber(highest.value)})`
	}
	const series = new Set<string>()
	for (const point of spec.data) for (const name of Object.keys(point.series)) series.add(name)
	return `${[...series].join(", ")} across ${plural(spec.data.length, "point")}`
}

const entityBlock = (
	segment: Exclude<AnnotationSegment, { type: "text" }>,
	context: ChatRenderContext,
): ChatEntityBlock => {
	const app = context.appBaseUrl
	switch (segment.type) {
		case "trace": {
			const { id, name, durationMs, spanCount, services, hasError } = segment.data
			return {
				kind: "entity",
				entity: "trace",
				label: name,
				detail: joinDetail([
					formatDuration(durationMs),
					spanCount === undefined ? null : plural(spanCount, "span"),
					services === undefined ? null : services.join(", "),
					hasError === true ? "has errors" : null,
				]),
				url: `${app}/traces/${encodeURIComponent(id)}`,
			}
		}
		case "service": {
			const { name, throughputRpm, errorRate, p95Ms, p99Ms } = segment.data
			return {
				kind: "entity",
				entity: "service",
				label: name,
				detail: joinDetail([
					throughputRpm === undefined ? null : `${formatNumber(throughputRpm)} rpm`,
					errorRate === undefined ? null : `${formatNumber(errorRate)}% errors`,
					p95Ms === undefined ? null : `p95 ${formatDuration(p95Ms)}`,
					p99Ms === undefined ? null : `p99 ${formatDuration(p99Ms)}`,
				]),
				url: `${app}/services/${encodeURIComponent(name)}`,
			}
		}
		case "error": {
			const { errorType, count, affectedServices } = segment.data
			return {
				kind: "entity",
				entity: "error",
				label: errorType,
				detail: joinDetail([
					count === undefined ? null : `${formatNumber(count)} ${count === 1 ? "event" : "events"}`,
					affectedServices === undefined ? null : affectedServices.join(", "),
				]),
				// The app lists issues rather than error types, so there is no page to open for one.
				url: null,
			}
		}
		case "log": {
			const { severity, body, serviceName, timestamp, traceId } = segment.data
			return {
				kind: "entity",
				entity: "log",
				label: truncate(body, 160),
				detail: joinDetail([severity.toUpperCase(), serviceName ?? null, timestamp ?? null]),
				// A log record is addressed by a composite key the annotation does not carry; its
				// trace is the page that holds it.
				url: traceId === undefined ? null : `${app}/traces/${encodeURIComponent(traceId)}`,
			}
		}
	}
}

const joinDetail = (parts: ReadonlyArray<string | null>): string | null => {
	const present = parts.filter((part): part is string => part !== null && part.length > 0)
	return present.length === 0 ? null : present.join(" · ")
}

const toolActivity = (call: ChatToolCall): ChatToolActivity => {
	const agent = delegatedAgentOf(call.name)
	if (call.task !== undefined) {
		return {
			name: agent ?? call.name,
			status:
				call.task.status === "running"
					? "running"
					: call.task.status === "completed"
						? "done"
						: "failed",
			detail: plural(call.task.messages.length, "step"),
		}
	}
	return {
		// `output` is optional on the wire, so its PRESENCE is what settles a call — a tool that
		// answered with nothing has an output, and reading the value would call it still running.
		name: call.name,
		status: !("output" in call) ? "running" : call.isError === true ? "failed" : "done",
		detail: null,
	}
}

/** How many arguments an approval line shows before it stops being readable. */
const MAX_SUMMARY_ARGS = 6
const MAX_SUMMARY_VALUE = 80

/** A proposed call's arguments as a line someone can approve or refuse without reading JSON. */
export const summarizeToolInput = (input: unknown): string => {
	if (input === null || typeof input !== "object") return truncate(String(input), MAX_SUMMARY_VALUE)
	const parts: Array<string> = []
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null) continue
		if (parts.length === MAX_SUMMARY_ARGS) {
			parts.push("…")
			break
		}
		const text = typeof value === "object" ? JSON.stringify(value) : String(value)
		parts.push(`${key}: ${truncate(text, MAX_SUMMARY_VALUE)}`)
	}
	return parts.join(" · ")
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`
