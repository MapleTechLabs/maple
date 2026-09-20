/**
 * The chart an agent drew inside a reply, as an image a chat platform can embed.
 *
 * Two halves of one feature. {@link chatChartImageUrl} mints the signed URL a
 * relayed reply points at; {@link chatChartResponse} turns the fence that URL
 * names back into the numbers the renderer draws. They live together because
 * the thing they have to agree on — that a chart is identified by *where it is*
 * rather than by what it holds — is not visible from either one alone.
 *
 * Nothing here stores a chart. The conversation's own event log already holds
 * the reply, and a signed id naming a position in it is a fixed 200 bytes
 * whatever the chart plots. The alternative was putting the series in the URL,
 * which a chat platform's link length caps make unworkable for anything past a
 * toy.
 */
import {
	chartFences,
	parseChartSpec,
	staticChartUnit,
	type ChartSpec,
	type TimeseriesSpec,
} from "@maple/domain/chat-chart-spec"
import { chatChartId, type VerifiedChatChartClaims } from "@maple/db"
import { orgIdFromChatSessionId, type ChatMessage } from "@maple/domain/chat-session"
import type { ChatChartResponse, OrgId } from "@maple/domain/http"
import { ChatChartRanked, ChatChartTimeseries } from "@maple/domain/http"
import { downsample, type ChartPoint } from "@maple/widgets/chart/static-chart"

/**
 * Points kept per series. The alert card draws 60 across the same 720px and a
 * chat chart splits that width between series, so more would be sub-pixel.
 */
const MAX_POINTS_PER_SERIES = 60

/**
 * Bars a ranking draws. A model writes a ranking in rank order, so the ones
 * past this are the tail it already decided mattered least.
 */
const MAX_RANKED_BARS = 12

/**
 * The public URL of one chart inside one reply, or `null` when this deployment
 * cannot sign one.
 *
 * `null` — rather than an unsigned URL — for the same reason `chartImageUrl`
 * returns one for an alert: sharing is optional infrastructure, and an
 * unsigned chart URL is not a thing this repo will mint. A caller that gets
 * `null` relays the reply without its picture.
 *
 * This is the port a renderer relaying replies into a chat platform injects:
 * it holds the fence index it is rendering and asks for that chart's image.
 */
export const chatChartImageUrl = (options: {
	readonly appBaseUrl: string
	readonly hmacKey: string | null
	readonly orgId: OrgId
	readonly sessionId: string
	readonly messageId: string
	readonly chartIndex: number
}): string | null => {
	if (options.hmacKey === null) return null
	const id = chatChartId(
		{
			orgId: options.orgId,
			sessionId: options.sessionId,
			messageId: options.messageId,
			chartIndex: options.chartIndex,
		},
		options.hmacKey,
	)
	return new URL(`/chat/chart/${encodeURIComponent(id)}.png`, options.appBaseUrl).toString()
}

/**
 * The conversation a verified id may be read from, or `null` when the id's two
 * halves disagree about who owns it.
 *
 * A session id carries its own org and the signed id carries one too. This
 * returns the session id only once they match, so a caller cannot address a
 * conversation without having passed the check — which is the property, rather
 * than the comparison itself.
 */
export const chatChartSession = (claims: VerifiedChatChartClaims): string | null =>
	orgIdFromChatSessionId(claims.rawSessionId) === claims.rawOrgId ? claims.rawSessionId : null

/**
 * The chart a verified id names inside a transcript, or `null` when the reply,
 * the fence or its contents are not there.
 *
 * Assistant replies only: the charts are the agent's, and a user message whose
 * id collided would otherwise be readable through the same URL.
 */
export const chatChartFrom = (
	messages: ReadonlyArray<ChatMessage>,
	claims: VerifiedChatChartClaims,
): ChatChartResponse | null => {
	const message = messages.find(
		(candidate) => candidate.id === claims.rawMessageId && candidate.role === "assistant",
	)
	if (message === undefined) return null

	// Position in the reply is the chart's identity — see `chartFences`.
	const fence = chartFences(message.text)[claims.chartIndex]
	const spec = fence === undefined ? null : parseChartSpec(fence)
	return spec === null ? null : chatChartResponse(spec)
}

/**
 * `{ bucket, series: { … } }` rows turned inside out: one entry per series
 * name, in the order the rows first name them, so a legend reads the way the
 * model wrote it.
 */
const seriesOf = (
	spec: TimeseriesSpec,
	scale: number,
): ReadonlyArray<ChatChartTimeseries["series"][number]> => {
	const byName = new Map<string, Array<ChartPoint>>()
	for (const row of spec.data) {
		// `parseChartSpec` has already dropped the rows whose bucket is not a time.
		const at = Date.parse(row.bucket)
		for (const [name, value] of Object.entries(row.series)) {
			const points = byName.get(name) ?? []
			points.push([at, value * scale])
			byName.set(name, points)
		}
	}
	return [...byName].map(([name, points]) => ({
		name,
		// The renderer sorts, but downsampling picks extremes per stride and needs
		// the strides to be time-ordered to mean anything.
		points: downsample(
			[...points].sort((a, b) => a[0] - b[0]),
			MAX_POINTS_PER_SERIES,
		),
	}))
}

/**
 * A parsed fence as the wire payload the image is drawn from.
 *
 * Units are resolved to the five the static renderer knows, and the values
 * scaled into them — see `staticChartUnit`. The rows are bounded here rather
 * than at the renderer because the fence is model output: nothing upstream caps
 * how many points it may hold, and an unbounded one is a response body and a
 * raster the Worker has to pay for.
 */
export const chatChartResponse = (spec: ChartSpec): ChatChartResponse => {
	const { unit, scale } = staticChartUnit(spec.unit)
	const title = spec.title ?? ""

	if (spec.type === "ranked") {
		return new ChatChartRanked({
			kind: "ranked",
			title,
			unit,
			points: spec.data
				.slice(0, MAX_RANKED_BARS)
				.map((point) => ({ name: point.name, value: point.value * scale })),
		})
	}

	return new ChatChartTimeseries({
		kind: spec.type,
		title,
		unit,
		series: seriesOf(spec, scale),
	})
}
