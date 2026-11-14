import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { plainFrom } from "../env.ts"
import { resolveAs } from "../secret-guard.ts"
import * as Secrets from "../secrets.ts"
import { DEFAULT_MAPLE_REGION } from "../region.ts"
import { MapleStack } from "./stack.ts"
import { prdOrigin } from "./stage.ts"
import { String as Str } from "effect"

/** prd destination slugs (derived from their names), referenced by non-owning stages. */
const PRD_LOGS_DESTINATION = "maple-workers-logs"
const PRD_TRACES_DESTINATION = "maple-workers-traces"

/** What the account's Workers Observability destinations read from the deploy's environment. */
export const workersObservabilitySecrets = Secrets.OtelIngestKey.value

/**
 * Account-wide Workers Observability destinations for the asset Workers, owned only by the `us`
 * prd; every other stage references the slugs (the deploy token cannot list them to adopt).
 */
export const WorkersObservabilityDestinations = Effect.gen(function* () {
	const { stage, region } = yield* MapleStack
	if (stage.kind !== "prd" || region !== DEFAULT_MAPLE_REGION) {
		return { logsDestination: undefined, tracesDestination: undefined }
	}

	const endpoint = yield* plainFrom(["MAPLE_ENDPOINT"], prdOrigin("ingest"))
	const ingestEndpoint = Str.replace(/\/+$/, "")(endpoint)
	// As the account's observability destinations, which the catalog grants this one key.
	const ingestKey = yield* resolveAs("workers-observability", workersObservabilitySecrets)
	const headers = { authorization: `Bearer ${Redacted.value(ingestKey)}` }
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
