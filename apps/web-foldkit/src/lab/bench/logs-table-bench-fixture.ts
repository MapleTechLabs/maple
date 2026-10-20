import type { LogRow } from "@maple/query-engine"

/** `/lab/bench/logs`: 2,000 wide synthetic rows. */
const ROW_COUNT = 2_000
const ATTRIBUTE_VALUE = "wide-value-".repeat(12)

export const LOGS_TABLE_BENCH_ROWS: LogRow[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
	timestamp: new Date(Date.UTC(2026, 6, 17, 18, 30) - index * 1_000).toISOString(),
	exactTimestamp: new Date(Date.UTC(2026, 6, 17, 18, 30) - index * 1_000)
		.toISOString()
		.replace("T", " ")
		.replace("Z", ""),
	severityText: index % 17 === 0 ? "ERROR" : index % 5 === 0 ? "WARN" : "INFO",
	severityNumber: index % 17 === 0 ? 17 : index % 5 === 0 ? 13 : 9,
	serviceName: `checkout-worker-${index % 24}`,
	body: `Synthetic wide log row ${index}: ${"request processing details ".repeat(10)}`,
	traceId: index.toString(16).padStart(32, "0") as LogRow["traceId"],
	spanId: index.toString(16).padStart(16, "0") as LogRow["spanId"],
	logAttributes: Object.fromEntries(
		Array.from({ length: 10 }, (_, attributeIndex) => [
			`attribute.${attributeIndex}`,
			`${ATTRIBUTE_VALUE}${index}-${attributeIndex}`,
		]),
	),
	resourceAttributes: {
		"deployment.environment.name": "production",
		"cloud.region": "eu-central-1",
	},
}))
