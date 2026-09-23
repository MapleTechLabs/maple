import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import { plainWithDefault, requiredPlain } from "../env.ts"
import { MapleStack } from "./stack.ts"
import { regionHostsSharedApps } from "./stage.ts"

/**
 * The production destinations' slugs, which Cloudflare derives from their
 * names. A stage that does not own the destinations references these.
 */
const PRD_LOGS_DESTINATION = "maple-workers-logs"
const PRD_TRACES_DESTINATION = "maple-workers-traces"

/**
 * Workers Observability destinations for the asset Workers' platform logs and
 * traces (`landing`, `local-ui`, the sandbox): OTLP into Maple's own ingest.
 * Account-wide, so exactly one deploy owns them: the `us` prd, like the other
 * shared apps (`regionHostsSharedApps`), `retain`ed. Every other stage, the
 * EU prd included, references the slugs above instead — owning them twice
 * would have two stacks reconciling one destination, and the deploy token
 * cannot even list destinations to adopt them (Cloudflare answers
 * "Authentication error" to that call, which is what failed the first
 * `prd-eu` deploy). Yielded from each Worker module that references them;
 * alchemy registers a resource by id, so the second yield returns the first's.
 */
export const WorkersObservabilityDestinations = Effect.gen(function* () {
	const { stage, region } = yield* MapleStack
	if (stage.kind !== "prd" || !regionHostsSharedApps(region)) {
		return { logsDestination: undefined, tracesDestination: undefined }
	}

	const { MAPLE_ENDPOINT } = yield* plainWithDefault("MAPLE_ENDPOINT", "https://ingest.maple.dev")
	const ingestEndpoint = MAPLE_ENDPOINT.replace(/\/+$/, "")
	const headers = { authorization: `Bearer ${yield* requiredPlain("MAPLE_OTEL_INGEST_KEY")}` }
	const tracesDestination = yield* Cloudflare.Workers.ObservabilityDestination(
		"workers-observability-traces",
		{
			name: "maple-workers-traces",
			url: `${ingestEndpoint}/v1/traces`,
			headers,
			logpushDataset: "opentelemetry-traces",
			enabled: true,
		},
	).pipe(RemovalPolicy.retain())
	const logsDestination = yield* Cloudflare.Workers.ObservabilityDestination("workers-observability-logs", {
		name: "maple-workers-logs",
		url: `${ingestEndpoint}/v1/logs`,
		headers,
		logpushDataset: "opentelemetry-logs",
		enabled: true,
	}).pipe(RemovalPolicy.retain())

	return { logsDestination, tracesDestination }
})

/**
 * The `observability` block the asset Workers share: invocation logs on,
 * traces off — Cloudflare marks every non-2xx `fetch` span `Error`, so bot
 * 404s (`/wp-admin`, `/.git/config`) flooded error issues with "Unknown Error".
 */
export const assetWorkerObservability = ({
	logsDestination,
	tracesDestination,
}: Effect.Success<typeof WorkersObservabilityDestinations>) => ({
	enabled: true,
	logs: {
		enabled: true,
		invocationLogs: true,
		destinations: [logsDestination?.slug ?? PRD_LOGS_DESTINATION],
	},
	traces: {
		enabled: false,
		destinations: [tracesDestination?.slug ?? PRD_TRACES_DESTINATION],
	},
})
