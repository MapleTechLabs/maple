/**
 * Chart images, served by the SPA's own Worker.
 *
 * Same shape as `renderShareOgImage`, and for the same reasons: the API owns
 * every judgement (does this id verify, what may it read), and this module only
 * draws what it is handed. It lives on the web origin rather than the API's
 * because that is where the takumi wasm and the Geist fonts already are — one
 * renderer, every image.
 *
 * The fetchers of these URLs are a chat platform's servers and whatever mail
 * client opens the email. None of them holds a Maple credential, which is why
 * the endpoints behind them are unauthenticated and the ids are signed instead.
 *
 * Two kinds of chart reach this, and they differ in three facts and nothing
 * else: the path they are requested at, the operation that resolves them, and
 * how long the answer may be cached. {@link CHART_KINDS} is those three facts.
 */
import { chartCard, rankedCard, type ChartCard } from "./chart-card"
import { renderNode, type AssetFetcher } from "./render"
import type { ShareChartResponse } from "@maple/domain/http"
import type { ApiTarget } from "../worker-env"

/** The API has to answer before an image request is worth abandoning. */
const API_TIMEOUT_MS = 4000

const CHART_SUFFIX = ".png"

interface ChartKind {
	readonly pathPrefix: string
	readonly apiPath: string
	readonly cacheControl: string
}

/**
 * Everything that distinguishes one chart image from another.
 *
 * The alert window is pinned by its signature and `alert_checks` is
 * append-only, so those bytes are immutable — the long edge TTL is what keeps a
 * link doing the rounds in a channel to one warehouse read. A reply's chart is
 * final once its turn ends, but its id can be minted while the reply is still
 * streaming, and a week-long TTL on a half-drawn chart is the one failure a
 * reader cannot recover from by looking again.
 */
export const CHART_KINDS: ReadonlyArray<ChartKind> = [
	{
		pathPrefix: "/alerts/chart/",
		apiPath: "/v2/share/alert-chart",
		cacheControl: "public, max-age=3600, s-maxage=604800, immutable",
	},
	{
		pathPrefix: "/chat/chart/",
		apiPath: "/v2/share/chat-chart",
		cacheControl: "public, max-age=300, s-maxage=3600",
	},
]

/**
 * The kind and signed id a request path names, or `undefined` for a path that
 * is not a chart image.
 *
 * A signed id is base64url plus a `.` plus a signature, so unlike a share OG id
 * it legitimately contains a dot — only the `.png` at the very end is the
 * extension. A `/` anywhere is rejected: the id is one path segment, and
 * anything with structure in it is not one this repo minted.
 */
export const chartRequestFromPath = (
	pathname: string,
): { readonly kind: ChartKind; readonly chartId: string } | undefined => {
	if (!pathname.endsWith(CHART_SUFFIX)) return undefined
	const kind = CHART_KINDS.find((candidate) => pathname.startsWith(candidate.pathPrefix))
	if (kind === undefined) return undefined
	const chartId = decodeURIComponent(
		pathname.slice(kind.pathPrefix.length, pathname.length - CHART_SUFFIX.length),
	)
	return chartId.length === 0 || chartId.includes("/") ? undefined : { kind, chartId }
}

/** The card to draw, or `undefined` for a chart with nothing in it. */
const cardFor = (chart: ShareChartResponse): ChartCard | undefined => {
	if (chart.kind === "ranked") {
		return chart.points.length === 0 ? undefined : rankedCard(chart)
	}
	return chart.series.some((series) => series.points.length > 0)
		? chartCard(chart.title, {
				kind: chart.kind,
				unit: chart.unit,
				series: chart.series,
				threshold: chart.threshold,
				breachSide: chart.breachSide,
			})
		: undefined
}

/**
 * 404 with no body for everything that is not a renderable chart — a tampered
 * id, a window whose checks have aged out, a reply the conversation no longer
 * holds, an API that did not answer. Uniform for the same reason the share
 * image is: the status must not tell whoever kept a copy of the URL which of
 * those it was.
 */
export const renderChartImage = async (
	api: ApiTarget,
	request: { readonly kind: ChartKind; readonly chartId: string },
	assets: AssetFetcher,
): Promise<Response> => {
	const notFound = new Response(null, { status: 404 })

	let chart: ShareChartResponse
	try {
		const response = await api.fetch(
			new Request(new URL(request.kind.apiPath, api.baseUrl), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ chartId: request.chartId }),
				signal: AbortSignal.timeout(API_TIMEOUT_MS),
			}),
		)
		if (!response.ok) return notFound
		chart = (await response.json()) as ShareChartResponse
	} catch {
		return notFound
	}

	let png: Uint8Array
	try {
		// Laying the card out is inside the try, not before it: `chart` is a cast
		// over `response.json()`, so a body missing `series` throws on the first
		// property read — and a throw here must not become a 500 in a chat client's
		// image slot, where it shows as a broken-image glyph next to a real message.
		const card = cardFor(chart)
		if (card === undefined) return notFound
		png = await renderNode(card.node, assets, { width: card.width, height: card.height })
	} catch {
		return notFound
	}

	return new Response(png as BodyInit, {
		headers: { "content-type": "image/png", "cache-control": request.kind.cacheControl },
	})
}
