/**
 * Maple's own Workers' telemetry defaults. Ingest key, endpoint and environment come from the
 * Worker env (`selfObservabilityEnv(stage)`), not from here.
 */
import { Telemetry, type TelemetrySdkOptions } from "@maple-dev/alchemy/telemetry"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerEnvironment } from "alchemy/Cloudflare"
import * as Layer from "effect/Layer"

export const MAPLE_REPOSITORY_URL = "https://github.com/MapleTechLabs/maple"

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
	Telemetry(workerTelemetryConfig(options))

/**
 * The SDK under another service name, for background work (queue, cron) whose spans must not
 * skew the request service's percentiles. Call once at module scope: buffers are per isolate.
 */
export const eventTelemetry = (
	options: WorkerTelemetryOptions,
): Layer.Layer<never, never, WorkerEnvironment> =>
	MapleCloudflareSDK.make(workerTelemetryConfig(options)).requestLayer.pipe(
		// Same key as alchemy's tag; a type bridge only.
		Layer.provide(Layer.effect(MapleCloudflareSDK.WorkerEnvironment, WorkerEnvironment)),
	)
