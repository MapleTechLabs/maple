/**
 * The image for a chart an agent drew inside a reply, served by the SPA's own
 * Worker.
 *
 * Same shape as `renderAlertChartImage`, and for the same reasons: the API owns
 * every judgement (does this id verify, which conversation and which chart in
 * it may be read), and this module only draws what it is handed. It exists on
 * the web origin rather than the API's because that is where the takumi wasm
 * and the Geist fonts already are — one renderer, now three images.
 *
 * The fetcher of this URL is a chat platform's own servers, relaying a reply
 * into a channel. None of them holds a Maple credential, which is why the
 * endpoint behind it is unauthenticated and the id is signed instead.
 */
import { chatRankedCard, chatTimeseriesCard, type ChartCard } from "./chat-chart-card"
import { renderNode, type AssetFetcher } from "./render"
import type { ChartPoint, ChartUnit } from "@maple/widgets/chart/static-chart"
import type { ApiTarget } from "../worker-env"

/** The API has to answer before an image request is worth abandoning. */
const API_TIMEOUT_MS = 4000

type ChatChartResponse =
	| {
			readonly kind: "line" | "area" | "bar"
			readonly title: string
			readonly unit: ChartUnit
			readonly series: ReadonlyArray<{
				readonly name: string
				readonly points: ReadonlyArray<ChartPoint>
			}>
	  }
	| {
			readonly kind: "ranked"
			readonly title: string
			readonly unit: ChartUnit
			readonly points: ReadonlyArray<{ readonly name: string; readonly value: number }>
	  }

/** The card to draw, or `undefined` for a chart with nothing in it. */
const chatChartCard = (chart: ChatChartResponse): ChartCard | undefined => {
	if (chart.kind === "ranked") {
		return chart.points.length === 0 ? undefined : chatRankedCard(chart)
	}
	return chart.series.some((series) => series.points.length > 0) ? chatTimeseriesCard(chart) : undefined
}

/**
 * 404 with no body for everything that is not a renderable chart — a tampered
 * id, a conversation that no longer holds that reply, an API that did not
 * answer. Uniform for the same reason the alert chart's is: the status must not
 * tell whoever kept a copy of the URL which of those it was.
 */
export const renderChatChartImage = async (
	api: ApiTarget,
	chartId: string,
	assets: AssetFetcher,
): Promise<Response> => {
	const notFound = new Response(null, { status: 404 })

	let chart: ChatChartResponse
	try {
		const response = await api.fetch(
			new Request(new URL("/v2/share/chat-chart", api.baseUrl), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chartId }),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			}),
		)
		if (!response.ok) return notFound
		chart = (await response.json()) as ChatChartResponse
	} catch {
		return notFound
	}

	let png: Uint8Array
	try {
		// Laying the card out is inside the try, not before it: `chart` is a cast
		// over `response.json()`, so a body missing `series` throws on the first
		// property read — and a throw here must not become a 500 in a chat client's
		// image slot, where it shows as a broken-image glyph next to a real reply.
		const card = chatChartCard(chart)
		if (card === undefined) return notFound
		png = await renderNode(card.node, assets, { width: card.width, height: card.height })
	} catch {
		return notFound
	}

	return new Response(png as BodyInit, {
		headers: {
			"content-type": "image/png",
			// Shorter than the alert chart's, and not `immutable`: the fence is
			// final once its turn ends, but the id can be minted while the reply is
			// still streaming, and a week-long TTL on a half-drawn chart is the one
			// failure a reader cannot recover from by looking again.
			"cache-control": "public, max-age=300, s-maxage=3600",
		},
	})
}
