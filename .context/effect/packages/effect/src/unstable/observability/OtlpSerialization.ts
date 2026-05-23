/**
 * Defines the serialization boundary used by the OTLP observability layers.
 *
 * `OtlpSerialization` converts Effect's in-memory OTLP trace, metric, and log
 * data into `HttpBody` values so exporters can send them to collectors over
 * OTLP/HTTP. Use this module to choose between the JSON encoding that is useful
 * for debugging and collector endpoints that explicitly accept OTLP/HTTP JSON,
 * and the protobuf encoding commonly expected by production OpenTelemetry
 * collectors.
 *
 * The JSON layer writes the telemetry structures directly with
 * `HttpBody.jsonUnsafe`; the protobuf layer encodes the same structures with
 * the internal OTLP protobuf encoder and sets the `application/x-protobuf`
 * content type. Endpoint paths, authentication headers, batching, retries, and
 * shutdown flushing are handled by the OTLP exporter layers that consume this
 * service, while this module focuses only on preserving the wire format chosen
 * for traces, metrics, and logs.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Layer from "../../Layer.ts"
import * as HttpBody from "../http/HttpBody.ts"
import * as otlpProtobuf from "./internal/otlpProtobuf.ts"
import type { LogsData } from "./OtlpLogger.ts"
import type { MetricsData } from "./OtlpMetrics.ts"
import type { TraceData } from "./OtlpTracer.ts"

/**
 * Service for serializing OTLP traces, metrics, and logs into HTTP request
 * bodies.
 *
 * @category services
 * @since 4.0.0
 */
export class OtlpSerialization extends Context.Service<OtlpSerialization, {
  readonly traces: (data: TraceData) => HttpBody.HttpBody
  readonly metrics: (data: MetricsData) => HttpBody.HttpBody
  readonly logs: (data: LogsData) => HttpBody.HttpBody
}>()("effect/observability/OtlpSerialization") {}

/**
 * Provides `OtlpSerialization` using OTLP/HTTP JSON bodies.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerJson = Layer.succeed(OtlpSerialization, {
  traces: (spans) => HttpBody.jsonUnsafe(spans),
  metrics: (metrics) => HttpBody.jsonUnsafe(metrics),
  logs: (logs) => HttpBody.jsonUnsafe(logs)
})

/**
 * Provides `OtlpSerialization` using protobuf-encoded OTLP bodies with the
 * `application/x-protobuf` content type.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerProtobuf = Layer.succeed(OtlpSerialization, {
  traces: (spans) =>
    HttpBody.uint8Array(
      otlpProtobuf.encodeTracesData(spans as any),
      "application/x-protobuf"
    ),
  metrics: (metrics) =>
    HttpBody.uint8Array(
      otlpProtobuf.encodeMetricsData(metrics as any),
      "application/x-protobuf"
    ),
  logs: (logs) =>
    HttpBody.uint8Array(
      otlpProtobuf.encodeLogsData(logs as any),
      "application/x-protobuf"
    )
})
