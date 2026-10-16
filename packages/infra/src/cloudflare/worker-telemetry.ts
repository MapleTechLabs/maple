/**
 * Maple's own Workers' telemetry defaults. Ingest key, endpoint and environment come from the
 * Worker env (`selfObservabilityEnv(stage)`), not from here.
 */
import { Telemetry, type TelemetrySdkOptions } from "@maple-dev/alchemy/telemetry"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerEnvironment } from "alchemy/Cloudflare"
import * as AlchemyTelemetry from "alchemy/Telemetry"
import { HttpClient, HttpMiddleware } from "effect/http"
import * as Layer from "effect/Layer"

export const MAPLE_REPOSITORY_URL = "https://github.com/MapleTechLabs/maple"

/**
 * The headers worth recording on HTTP spans, by phase. effect 4.0.4 records none by default; an
 * allowlist rather than "all but redacted" because outgoing requests carry credentials no
 * redaction list knows about (a customer's ClickHouse password goes out as `x-clickhouse-key`).
 */
const RECORDED_HEADERS = {
	// Which host and client a request came through: OAuth redirect URIs are built from these. No
	// client IP: country is enough, and an address on every span is personal data.
	request: new Set([
		"host",
		"x-forwarded-host",
		"x-forwarded-proto",
		"origin",
		"accept",
		"content-type",
		"content-length",
		"cf-ray",
		"cf-ipcountry",
		"mcp-protocol-version",
	]),
	// Vendor request ids, rate-limit state and auth challenges: what a 429, a 401 or a support
	// ticket needs. ClickHouse's query id is the key into the customer's `system.query_log`.
	response: new Set([
		"content-type",
		"content-length",
		"cf-ray",
		"cf-placement",
		"cf-cache-status",
		"www-authenticate",
		"retry-after",
		"request-id",
		"x-request-id",
		"x-github-request-id",
		"x-slack-req-id",
		"x-clickhouse-query-id",
		"x-clickhouse-exception-code",
		"x-clickhouse-summary",
		"ratelimit",
		"ratelimit-policy",
		"ratelimit-limit",
		"ratelimit-remaining",
		"ratelimit-reset",
		"x-ratelimit-limit",
		"x-ratelimit-remaining",
		"x-ratelimit-reset",
	]),
} as const

// Effect lowercases header names before the filter sees them.
const isRecordedHeader = (name: string, phase: "request" | "response"): boolean =>
	RECORDED_HEADERS[phase].has(name)

/** Header capture for every HTTP span a Maple Worker records, server and client. */
export const MapleHttpTracingLive = Layer.mergeAll(
	Layer.succeed(HttpMiddleware.TracerHeaderFilter, isRecordedHeader),
	Layer.succeed(HttpClient.TracerHeaderFilter, isRecordedHeader),
)

export interface WorkerTelemetryOptions {
	readonly serviceName: string
	/** Added to the domain's `ANTICIPATED_ERROR_IDENTIFIERS` (e.g. the MCP set). */
	readonly anticipatedErrorIdentifiers?: ReadonlyArray<string> | undefined
	/** Span-name prefixes never exported. */
	readonly dropSpanNames?: ReadonlyArray<string> | undefined
}

/** The SDK options every Maple Worker uses: `core` namespace, repo URL, anticipated 4xx. */
export const workerTelemetryConfig = (options: WorkerTelemetryOptions): TelemetrySdkOptions => ({
	serviceName: options.serviceName,
	serviceNamespace: "core",
	repositoryUrl: MAPLE_REPOSITORY_URL,
	dropSpanNames: options.dropSpanNames,
	anticipatedErrorIdentifiers: [
		...ANTICIPATED_ERROR_IDENTIFIERS,
		...(options.anticipatedErrorIdentifiers ?? []),
	],
})

export const WorkerTelemetry = (options: WorkerTelemetryOptions): Layer.Layer<never> =>
	Layer.mergeAll(
		Telemetry(workerTelemetryConfig(options)),
		// Read by the bridge's HTTP tracer, so it is built into every event with the exporters.
		AlchemyTelemetry.layer(MapleHttpTracingLive),
	)

/**
 * The SDK under another service name, for background work (queue, cron) whose spans must not
 * skew the request service's percentiles. Call once at module scope: buffers are per isolate.
 */
export const eventTelemetry = (
	options: WorkerTelemetryOptions,
): Layer.Layer<never, never, WorkerEnvironment> =>
	Layer.mergeAll(
		MapleCloudflareSDK.make(workerTelemetryConfig(options)).requestLayer.pipe(
			// Same key as alchemy's tag; a type bridge only.
			Layer.provide(Layer.effect(MapleCloudflareSDK.WorkerEnvironment, WorkerEnvironment)),
		),
		MapleHttpTracingLive,
	)

/**
 * The SDK for a runtime the Worker bridge does not wrap (a Durable Object's own
 * `ManagedRuntime`), its `layer` already carrying {@link MapleHttpTracingLive}. Call once at
 * module scope: buffers are per isolate.
 */
export const runtimeTelemetry = (options: WorkerTelemetryOptions): MapleCloudflareSDK.Telemetry => {
	const telemetry = MapleCloudflareSDK.make(workerTelemetryConfig(options))
	return { ...telemetry, layer: Layer.merge(telemetry.layer, MapleHttpTracingLive) }
}
