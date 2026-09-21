/**
 * The chart-image contract, shared by every chart Maple renders to a PNG.
 *
 * There are two sources — an alert rule's observed values, and a ```chart fence
 * an agent wrote into a reply — and for a while there were two of everything
 * else as well: two id schemas, two request bodies, two unit unions, two point
 * tuples. None of that was a difference; an alert chart is a chart with one
 * series and a threshold, and the threshold was always optional.
 *
 * What genuinely differs is where the numbers come from and what the URL is.
 * Those live at the endpoints. This is the vocabulary they share.
 */
import { Schema } from "effect"

/**
 * The opaque, signed id of a chart image (`alertChartId` / `chatChartId` in
 * `@maple/db`).
 *
 * Loosely checked: its structure is the signer's business, and a malformed id
 * fails verification into the same uniform "no such chart" as a tampered one.
 */
export const ShareChartId = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(1024)).annotate({
	identifier: "ShareChartId",
})

export const ShareChartRequest = Schema.Struct({
	chartId: ShareChartId,
}).annotate({ identifier: "ShareChartRequest" })

/**
 * The units the static renderer knows.
 *
 * The single authority for this list: it types the HTTP responses *and* the
 * signed alert-chart id's payload in `@maple/db`, so the wire and the signature
 * cannot disagree about what units exist. The renderer in `@maple/widgets`
 * declares a structurally identical union — it sits below this package and
 * cannot import it — and the two meet in `apps/web`, where a divergence is a
 * type error rather than a runtime surprise.
 *
 * **Append only.** `AlertChartPayload` decodes a signed id's `unit` through
 * this schema, and those ids are live in notifications already delivered.
 * Removing or renaming a member makes every id carrying it fail to decode,
 * which is a 404 on a chart someone can still see in their channel. Adding one
 * is free. The list is now shared with charts an agent draws, so it is under
 * more pressure to change than when it belonged to alerts alone.
 */
export const ChartUnit = Schema.Literals([
	"number",
	"percent",
	"duration_ms",
	"bytes",
	"requests_per_sec",
]).annotate({ identifier: "ChartUnit" })
export type ChartUnit = Schema.Schema.Type<typeof ChartUnit>

/** Which side of the threshold the renderer shades; `none` for range comparators. */
export const ChartBreachSide = Schema.Literals(["above", "below", "none"]).annotate({
	identifier: "ChartBreachSide",
})
export type ChartBreachSide = Schema.Schema.Type<typeof ChartBreachSide>

/**
 * `[epochMillis, value]`, oldest first.
 *
 * Finite on both axes. A fence's numbers are checked finite before they are
 * scaled into the renderer's unit and can leave the number line on the way; a
 * non-finite value serializes as a JSON `null` and plots as a NaN coordinate,
 * which is a failure moved to the far side of the wire.
 */
export const ChartPoint = Schema.Tuple([Schema.Finite, Schema.Finite]).annotate({
	identifier: "ChartPoint",
})

/** One named line/area/bar. An alert chart has exactly one. */
export const ChartSeries = Schema.Struct({
	name: Schema.String,
	points: Schema.Array(ChartPoint),
}).annotate({ identifier: "ChartSeries" })

/** One category and its value, for a ranking. */
export const ChartRankedPoint = Schema.Struct({
	name: Schema.String,
	value: Schema.Finite,
}).annotate({ identifier: "ChartRankedPoint" })

export class ChartTimeseries extends Schema.Class<ChartTimeseries>("ChartTimeseries")({
	kind: Schema.Literals(["line", "area", "bar"]),
	title: Schema.String,
	unit: ChartUnit,
	series: Schema.Array(ChartSeries),
	/** Drawn as a dashed rule. `null` on a chart that is not about a limit. */
	threshold: Schema.NullOr(Schema.Finite),
	breachSide: ChartBreachSide,
	/**
	 * The single series again, flat — **for one release, and only on
	 * `/v2/share/alert-chart`.**
	 *
	 * api and web are separate Workers that can serve different commits at
	 * once: alchemy isolates per-resource failures, and on 2026-09-07 prod ran
	 * a six-hour-old api behind a current web because one upload was rejected
	 * and its siblings shipped. Alert chart images are live in notifications
	 * already delivered, so a window where they 500 is a window a customer
	 * sees. Emitting the old field alongside the new one is what makes the
	 * change safe in *both* deploy orders rather than one.
	 *
	 * Delete once a deploy has put both Workers past this commit: nothing in
	 * this repo reads it, and `renderChartImage` only falls back to it.
	 */
	points: Schema.optionalKey(Schema.Array(ChartPoint)),
}) {}

/** A ranking: categories, not a time axis, and no alert counterpart. */
export class ChartRanked extends Schema.Class<ChartRanked>("ChartRanked")({
	kind: Schema.Literal("ranked"),
	title: Schema.String,
	unit: ChartUnit,
	points: Schema.Array(ChartRankedPoint),
}) {}

/**
 * Everything the image needs, and nothing else.
 *
 * Deliberately not the alert, the incident, the rule or the reply: this is
 * fetched by whatever draws the picture, so it carries the chart's own numbers
 * and the words printed on the card. No prose, no conversation, no org name.
 *
 * A union on `kind` rather than one class with both payloads, because a ranking
 * has categories where a timeseries has a time axis, and a renderer that has to
 * check which array is empty is a renderer that will one day draw neither.
 */
export const ShareChartResponse = Schema.Union([ChartTimeseries, ChartRanked]).annotate({
	identifier: "ShareChartResponse",
})
export type ShareChartResponse = Schema.Schema.Type<typeof ShareChartResponse>
