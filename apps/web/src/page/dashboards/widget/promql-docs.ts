import { Array as Arr, Record as Rec } from "effect"

// What the PromQL editor's suggestions say about each function, aggregation and keyword.

/**
 * Every function the engine evaluates (`FUNCTIONS` in `@maple/promql`), with its signature. Written
 * out rather than read from there: that barrel would put the engine's regex library in the bundle.
 */
const FUNCTION_DOCS = {
	abs: ["abs(instant-vector) → instant-vector", "Absolute value of each sample."],
	absent: ["absent(instant-vector) → instant-vector", "1 when the vector has no elements, else empty."],
	absent_over_time: [
		"absent_over_time(range-vector) → instant-vector",
		"1 when the range has no samples, else empty.",
	],
	acos: ["acos(instant-vector) → instant-vector", "Arccosine of each sample."],
	acosh: ["acosh(instant-vector) → instant-vector", "Inverse hyperbolic cosine of each sample."],
	asin: ["asin(instant-vector) → instant-vector", "Arcsine of each sample."],
	asinh: ["asinh(instant-vector) → instant-vector", "Inverse hyperbolic sine of each sample."],
	atan: ["atan(instant-vector) → instant-vector", "Arctangent of each sample."],
	atanh: ["atanh(instant-vector) → instant-vector", "Inverse hyperbolic tangent of each sample."],
	avg_over_time: ["avg_over_time(range-vector) → instant-vector", "Average of each series over the range."],
	ceil: ["ceil(instant-vector) → instant-vector", "Rounds each sample up to the nearest integer."],
	changes: [
		"changes(range-vector) → instant-vector",
		"How many times each series changed value in the range.",
	],
	clamp: [
		"clamp(instant-vector, scalar, scalar) → instant-vector",
		"Clamps each sample between a minimum and a maximum.",
	],
	clamp_max: [
		"clamp_max(instant-vector, scalar) → instant-vector",
		"Clamps each sample to at most the given value.",
	],
	clamp_min: [
		"clamp_min(instant-vector, scalar) → instant-vector",
		"Clamps each sample to at least the given value.",
	],
	cos: ["cos(instant-vector) → instant-vector", "Cosine of each sample."],
	cosh: ["cosh(instant-vector) → instant-vector", "Hyperbolic cosine of each sample."],
	count_over_time: [
		"count_over_time(range-vector) → instant-vector",
		"Number of samples of each series in the range.",
	],
	day_of_month: [
		"day_of_month(instant-vector?) → instant-vector",
		"Day of the month (1-31) of each timestamp, in UTC.",
	],
	day_of_week: [
		"day_of_week(instant-vector?) → instant-vector",
		"Day of the week (0-6, Sunday first) of each timestamp, in UTC.",
	],
	day_of_year: [
		"day_of_year(instant-vector?) → instant-vector",
		"Day of the year (1-366) of each timestamp, in UTC.",
	],
	days_in_month: [
		"days_in_month(instant-vector?) → instant-vector",
		"Number of days in the month of each timestamp, in UTC.",
	],
	deg: ["deg(instant-vector) → instant-vector", "Converts radians to degrees."],
	delta: [
		"delta(range-vector) → instant-vector",
		"Difference between the first and last value of each gauge in the range.",
	],
	deriv: [
		"deriv(range-vector) → instant-vector",
		"Per-second derivative of each gauge, by linear regression.",
	],
	exp: ["exp(instant-vector) → instant-vector", "Exponential of each sample."],
	floor: ["floor(instant-vector) → instant-vector", "Rounds each sample down to the nearest integer."],
	histogram_avg: [
		"histogram_avg(instant-vector) → instant-vector",
		"Average of the observations in each native histogram.",
	],
	histogram_count: [
		"histogram_count(instant-vector) → instant-vector",
		"Observation count of each native histogram.",
	],
	histogram_fraction: [
		"histogram_fraction(scalar, scalar, instant-vector) → instant-vector",
		"Fraction of observations between two values.",
	],
	histogram_quantile: [
		"histogram_quantile(scalar, instant-vector) → instant-vector",
		"φ-quantile (0 to 1) from histogram buckets.",
	],
	histogram_stddev: [
		"histogram_stddev(instant-vector) → instant-vector",
		"Standard deviation of each native histogram.",
	],
	histogram_stdvar: [
		"histogram_stdvar(instant-vector) → instant-vector",
		"Standard variance of each native histogram.",
	],
	histogram_sum: [
		"histogram_sum(instant-vector) → instant-vector",
		"Sum of the observations in each native histogram.",
	],
	holt_winters: [
		"holt_winters(range-vector, scalar, scalar) → instant-vector",
		"Smoothed value by double exponential smoothing (older name).",
	],
	double_exponential_smoothing: [
		"double_exponential_smoothing(range-vector, scalar, scalar) → instant-vector",
		"Smoothed value by double exponential smoothing.",
	],
	hour: ["hour(instant-vector?) → instant-vector", "Hour of the day (0-23) of each timestamp, in UTC."],
	idelta: [
		"idelta(range-vector) → instant-vector",
		"Difference between the last two samples of each gauge.",
	],
	increase: ["increase(range-vector) → instant-vector", "Increase of each counter over the range."],
	irate: [
		"irate(range-vector) → instant-vector",
		"Per-second rate from the last two samples of each counter.",
	],
	label_join: [
		"label_join(instant-vector, string, string, string...) → instant-vector",
		"Joins the values of source labels into a new label.",
	],
	label_replace: [
		"label_replace(instant-vector, string, string, string, string) → instant-vector",
		"Writes a label from a regex match on another label.",
	],
	last_over_time: [
		"last_over_time(range-vector) → instant-vector",
		"Most recent sample of each series in the range.",
	],
	ln: ["ln(instant-vector) → instant-vector", "Natural logarithm of each sample."],
	log10: ["log10(instant-vector) → instant-vector", "Decimal logarithm of each sample."],
	log2: ["log2(instant-vector) → instant-vector", "Binary logarithm of each sample."],
	max_over_time: ["max_over_time(range-vector) → instant-vector", "Maximum of each series over the range."],
	mad_over_time: [
		"mad_over_time(range-vector) → instant-vector",
		"Median absolute deviation of each series over the range.",
	],
	min_over_time: ["min_over_time(range-vector) → instant-vector", "Minimum of each series over the range."],
	minute: [
		"minute(instant-vector?) → instant-vector",
		"Minute of the hour (0-59) of each timestamp, in UTC.",
	],
	month: ["month(instant-vector?) → instant-vector", "Month of the year (1-12) of each timestamp, in UTC."],
	pi: ["pi() → scalar", "The number π."],
	predict_linear: [
		"predict_linear(range-vector, scalar) → instant-vector",
		"Predicted value t seconds ahead, by linear regression.",
	],
	present_over_time: [
		"present_over_time(range-vector) → instant-vector",
		"1 for each series with any sample in the range.",
	],
	quantile_over_time: [
		"quantile_over_time(scalar, range-vector) → instant-vector",
		"φ-quantile of each series over the range.",
	],
	rad: ["rad(instant-vector) → instant-vector", "Converts degrees to radians."],
	rate: ["rate(range-vector) → instant-vector", "Per-second average rate of increase of each counter."],
	resets: [
		"resets(range-vector) → instant-vector",
		"Number of counter resets of each series in the range.",
	],
	round: [
		"round(instant-vector, scalar?) → instant-vector",
		"Rounds each sample to the nearest integer, or multiple.",
	],
	scalar: ["scalar(instant-vector) → scalar", "The single sample of a one-element vector as a scalar."],
	sgn: ["sgn(instant-vector) → instant-vector", "Sign of each sample: 1, -1 or 0."],
	sin: ["sin(instant-vector) → instant-vector", "Sine of each sample."],
	sinh: ["sinh(instant-vector) → instant-vector", "Hyperbolic sine of each sample."],
	sort: ["sort(instant-vector) → instant-vector", "Sorts samples ascending by value."],
	sort_desc: ["sort_desc(instant-vector) → instant-vector", "Sorts samples descending by value."],
	sort_by_label: [
		"sort_by_label(instant-vector, string...) → instant-vector",
		"Sorts series ascending by the given labels.",
	],
	sort_by_label_desc: [
		"sort_by_label_desc(instant-vector, string...) → instant-vector",
		"Sorts series descending by the given labels.",
	],
	sqrt: ["sqrt(instant-vector) → instant-vector", "Square root of each sample."],
	stddev_over_time: [
		"stddev_over_time(range-vector) → instant-vector",
		"Standard deviation of each series over the range.",
	],
	stdvar_over_time: [
		"stdvar_over_time(range-vector) → instant-vector",
		"Standard variance of each series over the range.",
	],
	sum_over_time: ["sum_over_time(range-vector) → instant-vector", "Sum of each series over the range."],
	tan: ["tan(instant-vector) → instant-vector", "Tangent of each sample."],
	tanh: ["tanh(instant-vector) → instant-vector", "Hyperbolic tangent of each sample."],
	time: ["time() → scalar", "Seconds since the epoch at evaluation time."],
	timestamp: ["timestamp(instant-vector) → instant-vector", "Timestamp of each sample, in seconds."],
	vector: ["vector(scalar) → instant-vector", "A scalar as a vector with no labels."],
	year: ["year(instant-vector?) → instant-vector", "Year of each timestamp, in UTC."],
} satisfies Record<string, readonly [signature: string, doc: string]>

/** The aggregation operators the engine runs (it refuses the experimental `limitk` and `limit_ratio`). */
export const AGGREGATIONS: ReadonlyArray<readonly [name: string, signature: string, doc: string]> = [
	["sum", "sum(instant-vector)", "Sum over dimensions."],
	["avg", "avg(instant-vector)", "Average over dimensions."],
	["min", "min(instant-vector)", "Minimum over dimensions."],
	["max", "max(instant-vector)", "Maximum over dimensions."],
	["count", "count(instant-vector)", "Number of elements in the vector."],
	["group", "group(instant-vector)", "1 for every group."],
	["stddev", "stddev(instant-vector)", "Population standard deviation over dimensions."],
	["stdvar", "stdvar(instant-vector)", "Population standard variance over dimensions."],
	["topk", "topk(k, instant-vector)", "Largest k elements by value."],
	["bottomk", "bottomk(k, instant-vector)", "Smallest k elements by value."],
	["quantile", "quantile(φ, instant-vector)", "φ-quantile (0 to 1) over dimensions."],
	["count_values", "count_values(label, instant-vector)", "Number of elements with the same value."],
]

/** Keywords that follow a complete expression: set operators, modifiers and vector matching. */
export const KEYWORDS: ReadonlyArray<readonly [name: string, doc: string]> = [
	["by", "Keeps only these labels in the aggregation."],
	["without", "Drops these labels in the aggregation."],
	["and", "Intersection: left elements with a match on the right."],
	["or", "Union: left elements plus unmatched right elements."],
	["unless", "Left elements with no match on the right."],
	["offset", "Shifts the selector back in time."],
	["bool", "Comparison returns 0 or 1 instead of filtering."],
	["on", "Matches the two sides only on these labels."],
	["ignoring", "Matches the two sides ignoring these labels."],
	["group_left", "Many-to-one matching, the left side has more series."],
	["group_right", "One-to-many matching, the right side has more series."],
]

/** Every function as `[name, signature, doc]`. */
export const FUNCTION_ENTRIES: ReadonlyArray<readonly [name: string, signature: string, doc: string]> =
	Arr.map(Rec.toEntries(FUNCTION_DOCS), ([name, [signature, doc]]) => [name, signature, doc] as const)
