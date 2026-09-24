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
 *
 * What the two surfaces DO disagree about is how much of a turn to show. Web draws the whole
 * interleaving — every tool call, and the prose the model wrote between them. A channel gets one
 * line while the turn runs and the answer once it has finished; see {@link ChatRenderOptions}.
 */
import { parseAnnotations, type AnnotationSegment } from "@maple/domain/chat-annotations"
import {
	chartFences,
	hasOpenFence,
	normalizeUnit,
	parseChartSpec,
	splitChartFences,
	type ChartSpec,
} from "@maple/domain/chat-chart-spec"
import { delegatedAgentOf, type ChatMessage, type ChatToolCall } from "@maple/domain/chat-session"
import { formatDuration, formatNumber } from "@maple/domain/format"
import { encodeChatActionToken } from "../action-token"
import {
	MAX_APPROVAL_OUTCOME_CHARS,
	type ChatBlock,
	type ChatEntityBlock,
	type ChatRenderContext,
	type ChatToolActivity,
} from "./blocks"

/**
 * @param running The turn is still going, so a status line stands in for the answer it has not
 * reached. Default false renders the finished message, which is what every cold re-render — a
 * settling edit, a `history()` replay — wants without having to say so.
 */
export const renderChatMessage = (
	message: ChatMessage,
	context: ChatRenderContext,
	running = false,
): ReadonlyArray<ChatBlock> => {
	const blocks: Array<ChatBlock> = []

	// The calls that ran. A proposed one has not, so it neither reports progress nor cuts the prose
	// that explains it — it has a block of its own further down.
	const calls = message.toolCalls.filter((call) => call.proposed !== true)

	// The latest one only, and only while the turn runs. A reader in a channel wants to know the
	// bot is still working, not to keep a list of everything it touched on the way to an answer
	// that is now sitting right under it.
	const latest = running ? calls[calls.length - 1] : undefined
	if (latest !== undefined) blocks.push({ kind: "activity", tools: [toolActivity(latest)] })

	const start = answerOffset(message.text, calls, running)
	// Whatever renders a chart's image numbers every fence in the WHOLE message, so prose dropped
	// ahead of the answer still counts towards the index of a chart inside it. A fence left open
	// across the cut is counted by this scan too, exactly as the whole-message scan counts it.
	let chartIndex = chartFences(message.text.slice(0, start)).length

	for (const part of splitChartFences(visibleText(message.text, calls, start))) {
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

	for (const call of message.toolCalls) {
		if (call.proposed !== true) continue
		blocks.push({
			kind: "approval",
			toolName: call.name,
			summary: summarizeToolInput(call.input),
			token: encodeChatActionToken(call.id),
			// `output` is optional on the wire, so its PRESENCE is what settles a proposal: a decision
			// that produced no text is still a decision, and reading the value would call it open.
			outcome: !("output" in call)
				? null
				: { approved: call.isError !== true, text: outcomeText(call.output) },
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

/**
 * The text from the cut on, with a blank line wherever a tool call interrupted the model.
 *
 * Usually one segment, because the cut lands on the last call. Two paths can leave a boundary
 * inside the range anyway: {@link answerOffset}'s fallback, when the final segment is empty, and a
 * retry's stale offset, which can sit after a later call's. Model text carries no separator of its
 * own, so concatenating across a boundary runs two sentences together — "…at 40%.Two signatures."
 *
 * A boundary inside an unclosed fence is not a place to break: splitting one would stop it parsing
 * and put a chart's payload in the channel as prose, under an index that no longer matches the
 * whole-message numbering the image endpoint uses.
 */
const visibleText = (text: string, calls: ReadonlyArray<ChatToolCall>, start: number): string => {
	const bounds = [...new Set(calls.map((call) => call.textOffset ?? text.length))]
		.filter((at) => at > start && at < text.length)
		.sort((left, right) => left - right)
	const segments: Array<string> = []
	let segment = ""
	let from = start
	for (const at of [...bounds, text.length]) {
		segment += text.slice(from, at)
		from = at
		if (hasOpenFence(segment)) continue
		segments.push(segment.trim())
		segment = ""
	}
	segments.push(segment.trim())
	return segments.filter((piece) => piece.length > 0).join("\n\n")
}

/**
 * Where the prose worth showing starts.
 *
 * A turn's text is cut into segments by its tool calls' `textOffset`s, and every segment before
 * the last call is the model talking its way towards an answer. Web re-interleaves all of it,
 * which is what a transcript is for; a channel shows one segment, because the rest reads as a
 * colleague thinking out loud between other people's messages.
 *
 * Calls are read in the order they were made, never sorted by offset: a `turn-retry` can leave a
 * retracted attempt's call holding an offset past the end of the text it took back, and the answer
 * belongs after the call the model actually made last rather than after that stale one. `slice`
 * clamps, so such an offset simply cuts nothing. A call recorded before offsets existed defaults
 * to the end of the text, as web does, so an old prose-then-calls turn still renders whole.
 */
const answerOffset = (text: string, calls: ReadonlyArray<ChatToolCall>, running: boolean): number => {
	const offsets = calls.map((call) => call.textOffset ?? text.length)
	// Still running: the segment after the last call so far, which may yet be the answer. The next
	// call is what turns it into narration, and re-rendering is what retracts it.
	if (running) return offsets[offsets.length - 1] ?? 0
	// Finished: the last segment that says anything. Normally that is the one after the final call,
	// but a turn that stopped without answering has nothing there, and the closest it came to an
	// answer is the segment before.
	for (let index = offsets.length - 1; index >= 0; index--) {
		if (text.slice(offsets[index]).trim().length > 0) return offsets[index]
	}
	return 0
}

/** The phrase the session recorded, or the tool's name in words for a call that has none. */
const toolLabel = (call: ChatToolCall): string => call.label ?? `Using ${call.name.replaceAll("_", " ")}`

const toolActivity = (call: ChatToolCall): ChatToolActivity => {
	const agent = delegatedAgentOf(call.name)
	if (call.task !== undefined) {
		return {
			label: agent === undefined ? toolLabel(call) : `Delegating to ${agent}`,
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
		label: toolLabel(call),
		status: !("output" in call) ? "running" : call.isError === true ? "failed" : "done",
		detail: null,
	}
}

/** What a settled proposal says happened. A tool's output is text, but the wire type is not. */
const outcomeText = (output: unknown): string => {
	const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "")
	return truncate(text, MAX_APPROVAL_OUTCOME_CHARS)
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
