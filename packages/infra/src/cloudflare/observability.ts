import * as Cloudflare from "alchemy/Cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import { plainWithDefault, requiredPlain } from "../env.ts"
import { MapleStack } from "./stack.ts"

/** prd destination slugs (derived from their names), referenced by non-owning stages. */
const PRD_LOGS_DESTINATION = "maple-workers-logs"
const PRD_TRACES_DESTINATION = "maple-workers-traces"

/**
 * Account-wide Workers Observability destinations for the asset Workers, owned only by the `us`
 * prd; every other stage references the slugs (the deploy token cannot list them to adopt).
 */
export const WorkersObservabilityDestinations = Effect.gen(function* () {
	const { stage, profile } = yield* MapleStack
	if (stage.kind !== "prd" || !profile.deploys.sharedApps) {
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

/** Asset Workers' observability: traces off, since Cloudflare marks every non-2xx span `Error` (bot 404s). */
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
