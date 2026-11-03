import type { LogRow } from "@maple/query-engine"
import { Option, Record as Rec, String as Str } from "effect"
import type { LogRowLinks } from "../ui/logs/log-row-view"

/** `/lab/bench/logs`: 2,000 wide synthetic rows. */
const ROW_COUNT = 2_000
const ATTRIBUTE_VALUE = Str.repeat(12)("wide-value-")

export const LOGS_TABLE_BENCH_ROWS: LogRow[] = Array.from({ length: ROW_COUNT }, (_, index) => ({
	timestamp: new Date(Date.UTC(2026, 6, 17, 18, 30) - index * 1_000).toISOString(),
	exactTimestamp: Str.replace(
		"Z",
		"",
	)(Str.replace("T", " ")(new Date(Date.UTC(2026, 6, 17, 18, 30) - index * 1_000).toISOString())),
	severityText: index % 17 === 0 ? "ERROR" : index % 5 === 0 ? "WARN" : "INFO",
	severityNumber: index % 17 === 0 ? 17 : index % 5 === 0 ? 13 : 9,
	serviceName: `checkout-worker-${index % 24}`,
	body: `Synthetic wide log row ${index}: ${Str.repeat(10)("request processing details ")}`,
	traceId: Str.padStart(32, "0")(index.toString(16)) as LogRow["traceId"],
	spanId: Str.padStart(16, "0")(index.toString(16)) as LogRow["spanId"],
	logAttributes: Rec.fromEntries(
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

/** The dashboard's trace and log pages, for rows built from the fixture. */
export const FIXTURE_LOG_LINKS: LogRowLinks = {
	trace: (traceId) => `/traces/${traceId}`,
	log: Option.some((logKey: string) => `/logs/${logKey}`),
}
