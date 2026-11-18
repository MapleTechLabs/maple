/** The PromQL corpus compared against a real Prometheus. Grafana-style queries first. */
export const QUERIES: ReadonlyArray<string> = [
	// selectors
	"http_requests_total",
	'http_requests_total{code="500"}',
	'http_requests_total{instance=~"a.*|c.*", code!="500"}',
	'{__name__=~"node_.*"}',
	"http_requests_total offset 10m",
	"http_requests_total @ 1700005400",
	"timestamp(http_requests_total)",
	// counters
	"rate(http_requests_total[5m])",
	"rate(http_requests_total[1m])",
	"rate(http_requests_total[3m])",
	"irate(http_requests_total[5m])",
	"increase(http_requests_total[1h])",
	"increase(http_requests_total[10m] offset 5m)",
	"resets(http_requests_total[30m])",
	"changes(node_memory_free_bytes[15m])",
	"sum by (job) (rate(http_requests_total[5m]))",
	"sum without (instance) (rate(http_requests_total[5m]))",
	'sum(rate(http_requests_total{code="500"}[5m])) / sum(rate(http_requests_total[5m]))',
	"rate(http_requests_total[5m]) / ignoring(code) group_left sum without (code) (rate(http_requests_total[5m]))",
	"topk(2, rate(http_requests_total[5m]))",
	"bottomk(1, sum by (instance) (rate(http_requests_total[5m])))",
	// gauges
	"delta(room_temperature_celsius[10m])",
	"idelta(room_temperature_celsius[5m])",
	"deriv(node_memory_free_bytes[10m])",
	"predict_linear(node_memory_free_bytes[30m], 3600)",
	"avg_over_time(node_memory_free_bytes[5m])",
	"min_over_time(room_temperature_celsius[10m])",
	"max_over_time(room_temperature_celsius[10m])",
	"sum_over_time(room_temperature_celsius[2m])",
	"count_over_time(http_requests_total[5m])",
	"last_over_time(node_memory_free_bytes[5m])",
	"stddev_over_time(room_temperature_celsius[10m])",
	"stdvar_over_time(room_temperature_celsius[10m])",
	"quantile_over_time(0.9, room_temperature_celsius[10m])",
	"mad_over_time(room_temperature_celsius[10m])",
	"histogram_count(http_request_duration_seconds_bucket)",
	"histogram_fraction(0, 0.2, http_request_duration_seconds_bucket)",
	'sort_by_label(http_requests_total, "toString")',
	'label_join(http_requests_total, "joined", "-", "constructor", "code")',
	"present_over_time(http_requests_total[1m])",
	"absent_over_time(nope_total[5m])",
	"double_exponential_smoothing(room_temperature_celsius[10m], 0.5, 0.5)",
	// aggregations
	"avg(node_memory_free_bytes)",
	"max by (job) (node_memory_free_bytes)",
	"count(http_requests_total)",
	"count by (code) (http_requests_total)",
	"stddev(node_memory_free_bytes)",
	"quantile(0.5, node_memory_free_bytes)",
	'count_values("value", http_requests_total > 0)',
	"group by (job) (http_requests_total)",
	"sum by (__name__) (rate(http_requests_total[5m]))",
	"sum by (__name__, job) (last_over_time(node_memory_free_bytes[5m]))",
	// histograms
	"histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))",
	"histogram_quantile(0.5, sum by (le, service) (rate(http_request_duration_seconds_bucket[5m])))",
	"histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[10m]))",
	"rate(http_request_duration_seconds_sum[5m]) / rate(http_request_duration_seconds_count[5m])",
	// operators and functions
	"node_memory_free_bytes / 1024 / 1024",
	"node_memory_free_bytes > 1.4e9",
	"node_memory_free_bytes > bool 1.4e9",
	"-room_temperature_celsius",
	"abs(room_temperature_celsius)",
	"clamp(room_temperature_celsius, -1, 1)",
	"round(room_temperature_celsius, 0.5)",
	'http_requests_total and http_requests_total{code="200"}',
	'http_requests_total unless http_requests_total{code="200"}',
	'http_requests_total{code="200"} or http_requests_total{code="500"}',
	'label_replace(http_requests_total, "host", "$1", "instance", "(.*):.*")',
	'label_join(http_requests_total, "id", "-", "instance", "code")',
	"vector(1) + time()",
	"scalar(sum(rate(http_requests_total[5m])))",
	'absent(nope_total{job="x"})',
	"hour(timestamp(node_memory_free_bytes))",
	"sum(rate(http_requests_total[5m])) * on() group_left vector(2)",
	// subqueries
	"max_over_time(rate(http_requests_total[5m])[30m:1m])",
	"avg_over_time(sum(node_memory_free_bytes)[10m:30s])",
	"max_over_time(rate(http_requests_total[5m])[30m:])",
]

/** Queries both engines must reject; any other Prometheus error is a failed case. */
export const EXPECTED_ERRORS: ReadonlySet<string> = new Set([
	'label_replace(http_requests_total, "host", "$1", "instance", "(")',
	"http_requests_total + on(job) group_left(job) http_requests_total",
])

/**
 * Queries where the engine follows a later Prometheus fix instead of 3.5. Reported, not failed.
 * histogram_fraction: 3.5 answers NaN for a range inside the first bucket; upstream since starts
 * positive buckets at 0, as histogram_quantile does.
 */
export const LATER_UPSTREAM_FIXES: ReadonlySet<string> = new Set([
	"histogram_fraction(0, 0.2, http_request_duration_seconds_bucket)",
])

/** Every query the runner sends, expected errors included. */
export const ALL_QUERIES: ReadonlyArray<string> = [...QUERIES, ...EXPECTED_ERRORS]
