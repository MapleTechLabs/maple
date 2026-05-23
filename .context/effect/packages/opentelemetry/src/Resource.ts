/**
 * Provides the OpenTelemetry resource used by the Effect OpenTelemetry layers.
 *
 * A resource describes the entity that produces telemetry, such as a service,
 * process, deployment, or browser application. The tracing, metrics, logging,
 * and SDK layers use this module's `Resource` service to configure providers
 * and identify emitted telemetry with service-level metadata.
 *
 * Use `layer` when service metadata is known in code, `layerFromEnv` when
 * deploying with `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`, and
 * `layerEmpty` when no resource attributes should be provided. Resource
 * attributes are for stable process or service metadata, not per-span or
 * per-log data. The explicit `layer` helper sets `service.name` and the
 * `telemetry.sdk.*` attributes after merging custom attributes, so those keys
 * are controlled by this integration. With `layerFromEnv`, `OTEL_SERVICE_NAME`
 * overrides `service.name` from `OTEL_RESOURCE_ATTRIBUTES`, and additional
 * attributes passed to the layer are merged last.
 *
 * @since 4.0.0
 */
import type * as OtelApi from "@opentelemetry/api"
import * as Resources from "@opentelemetry/resources"
import * as OtelSemConv from "@opentelemetry/semantic-conventions"
import * as Arr from "effect/Array"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/**
 * Context service containing the OpenTelemetry `Resource` associated with emitted telemetry.
 *
 * @category services
 * @since 4.0.0
 */
export class Resource extends Context.Service<
  Resource,
  Resources.Resource
>()("@effect/opentelemetry/Resource") {}

/**
 * Creates a `Resource` layer from service metadata and additional OpenTelemetry attributes.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (config: {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: OtelApi.Attributes
}) =>
  Layer.succeed(
    Resource,
    Resources.resourceFromAttributes(configToAttributes(config))
  )

/**
 * Converts resource configuration into OpenTelemetry attributes, adding service name, optional service version, and telemetry SDK metadata.
 *
 * @category configuration
 * @since 4.0.0
 */
export const configToAttributes = (options: {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: OtelApi.Attributes
}): Record<string, string> => {
  const attributes: Record<string, string> = {
    ...(options.attributes ?? undefined),
    [OtelSemConv.ATTR_SERVICE_NAME]: options.serviceName,
    [OtelSemConv.ATTR_TELEMETRY_SDK_NAME]: "@effect/opentelemetry",
    [OtelSemConv.ATTR_TELEMETRY_SDK_LANGUAGE]: typeof (globalThis as any).document === "undefined"
      ? OtelSemConv.TELEMETRY_SDK_LANGUAGE_VALUE_NODEJS
      : OtelSemConv.TELEMETRY_SDK_LANGUAGE_VALUE_WEBJS
  }
  if (options.serviceVersion) {
    attributes[OtelSemConv.ATTR_SERVICE_VERSION] = options.serviceVersion
  }
  return attributes
}

/**
 * Creates a `Resource` layer from OpenTelemetry environment variables, optionally merging additional attributes.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerFromEnv = (
  additionalAttributes?:
    | OtelApi.Attributes
    | undefined
): Layer.Layer<Resource> =>
  Layer.effect(
    Resource,
    Effect.gen(function*() {
      const serviceName = yield* Config.option(Config.string("OTEL_SERVICE_NAME"))
      const attributes = yield* Config.string("OTEL_RESOURCE_ATTRIBUTES").pipe(
        Config.withDefault(""),
        Config.map((s) => {
          const attrs = s.split(",")
          return Arr.reduce(attrs, {} as OtelApi.Attributes, (acc, attr) => {
            const parts = attr.split("=")
            if (parts.length !== 2) {
              return acc
            }
            acc[parts[0].trim()] = parts[1].trim()
            return acc
          })
        })
      )
      if (serviceName._tag === "Some") {
        attributes[OtelSemConv.ATTR_SERVICE_NAME] = serviceName.value
      }
      if (additionalAttributes) {
        Object.assign(attributes, additionalAttributes)
      }
      return Resources.resourceFromAttributes(attributes)
    }).pipe(Effect.orDie)
  )

/**
 * Layer that provides an empty OpenTelemetry resource.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerEmpty = Layer.succeed(
  Resource,
  Resources.emptyResource()
)
