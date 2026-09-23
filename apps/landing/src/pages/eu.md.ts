/**
 * `/eu.md`: the agent-readable twin of `/eu`.
 *
 * Leads with the city and the price so an answer engine that reads one line
 * still gets both right.
 */
import type { APIRoute } from "astro"
import { EU_APP_URL, EU_INGEST_URL, euFaqs } from "../lib/eu-region"
import { blocks, docHeader, markdown, table } from "../lib/page-markdown"

export const GET: APIRoute = async ({ site }) => {
	const url = (path: string) => new URL(path, site ?? "https://maple.dev").toString()

	const regions = table(
		["", "United States", "European Union"],
		[
			["Location", "United States", "Frankfurt, Germany"],
			["Dashboard", "https://app.maple.dev", EU_APP_URL],
			["OTLP ingest", "https://ingest.maple.dev", EU_INGEST_URL],
			["Price", "Same plan and rates", "Same plan and rates"],
		],
	)

	return markdown(
		blocks(
			docHeader(
				"Maple Cloud EU hosting",
				"Maple Cloud runs in two regions: the United States and the European Union (Frankfurt, Germany). An organization chooses its region when it is created, and all of its telemetry (traces, logs, metrics and session replays) is stored and processed in that region. Pricing is the same in both.",
			),

			"## Regions",
			regions,

			"## Getting started in the EU",
			[
				"1. Sign up. The first onboarding step asks where your data should live.",
				"2. Choose European Union. Onboarding continues in the EU dashboard.",
				"3. Point your OpenTelemetry exporters at the EU ingest endpoint with an ingest key from the EU dashboard.",
			].join("\n"),
			[
				"```bash",
				`export OTEL_EXPORTER_OTLP_ENDPOINT="${EU_INGEST_URL}"`,
				'export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"',
				"```",
			].join("\n"),

			"## Shared between regions",
			"Your Maple login, billing (plan and usage totals, no telemetry) and the maple.dev website are run once for both regions. None of them hold the telemetry you send.",

			"## FAQ",
			...euFaqs().flatMap((item) => [`### ${item.question}`, item.answer]),

			"## Links",
			[
				`- [EU hosting (HTML)](${url("/eu")})`,
				`- [Pricing](${url("/pricing.md")})`,
				`- [Instrumentation docs](${url("/docs/instrumentation.md")})`,
			].join("\n"),
		),
	)
}
