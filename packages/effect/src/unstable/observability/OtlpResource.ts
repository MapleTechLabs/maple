/**
 * Helpers and data types for describing the OTLP resource attached to exported
 * logs, metrics, and traces.
 *
 * A resource identifies the service that produced telemetry and carries
 * process- or deployment-level attributes that should be shared across every
 * signal sent by the Effect OTLP logger, metrics exporter, and tracer. Use this
 * module when building explicit resource metadata, reading the standard OTEL
 * resource environment variables, or converting application metadata into OTLP
 * `KeyValue` / `AnyValue` shapes before serialization.
 *
 * `service.name` is required because the signal exporters also use it as the
 * instrumentation scope name. Explicit resource options take precedence over
 * `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, and
 * `OTEL_SERVICE_VERSION`; `service.name` and `service.version` are normalized
 * through the service metadata inputs and re-added as canonical OTLP
 * attributes rather than left in the custom attribute map. Attribute values are
 * converted to OTLP scalar or array values where possible, with unsupported
 * runtime values formatted as strings.
 *
 * @since 4.0.0
 */
import * as Config from "../../Config.ts"
import * as Effect from "../../Effect.ts"
import { format } from "../../Formatter.ts"
import * as Schema from "../../Schema.ts"

/**
 * OTLP resource metadata attached to exported logs, metrics, and traces.
 *
 * @category models
 * @since 4.0.0
 */
export interface Resource {
  /** Resource attributes */
  attributes: Array<KeyValue>
  /** Resource droppedAttributesCount */
  droppedAttributesCount: number
}

/**
 * Creates an OTLP resource from service metadata and additional attributes.
 *
 * **Details**
 *
 * The resource always includes `service.name`, includes `service.version` when
 * provided, and converts custom attributes into OTLP attribute values.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: {
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  readonly attributes?: Record<string, unknown> | undefined
}): Resource => {
  const resourceAttributes = options.attributes
    ? entriesToAttributes(Object.entries(options.attributes))
    : []
  resourceAttributes.push({
    key: "service.name",
    value: {
      stringValue: options.serviceName
    }
  })
  if (options.serviceVersion) {
    resourceAttributes.push({
      key: "service.version",
      value: {
        stringValue: options.serviceVersion
      }
    })
  }

  return {
    attributes: resourceAttributes,
    droppedAttributesCount: 0
  }
}

/**
 * Creates an OTLP resource from explicit options and OpenTelemetry
 * configuration.
 *
 * **Details**
 *
 * Explicit options override `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`,
 * and `OTEL_SERVICE_VERSION`; missing required configuration is converted to a
 * defect.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromConfig: (
  options?: {
    readonly serviceName?: string | undefined
    readonly serviceVersion?: string | undefined
    readonly attributes?: Record<string, unknown> | undefined
  } | undefined
) => Effect.Effect<Resource> = Effect.fnUntraced(function*(options?: {
  readonly serviceName?: string | undefined
  readonly serviceVersion?: string | undefined
  readonly attributes?: Record<string, unknown> | undefined
}) {
  const attributes = {
    ...(yield* Config.schema(
      Schema.UndefinedOr(Config.Record(Schema.String, Schema.String)),
      "OTEL_RESOURCE_ATTRIBUTES"
    )),
    ...options?.attributes
  }
  const serviceName = options?.serviceName ?? attributes["service.name"] as string ??
    (yield* Config.schema(Schema.String, "OTEL_SERVICE_NAME"))
  delete attributes["service.name"]
  const serviceVersion = options?.serviceVersion ?? attributes["service.version"] as string ??
    (yield* Config.schema(Schema.UndefinedOr(Schema.String), "OTEL_SERVICE_VERSION"))
  delete attributes["service.version"]
  return make({
    serviceName,
    serviceVersion,
    attributes
  })
}, Effect.orDie)

/**
 * Returns the `service.name` attribute from an OTLP resource.
 *
 * **Gotchas**
 *
 * Throws if the resource does not contain a string `service.name` attribute.
 *
 * @category Attributes
 * @since 4.0.0
 */
export const serviceNameUnsafe = (resource: Resource): string => {
  const serviceNameAttribute = resource.attributes.find(
    (attr) => attr.key === "service.name"
  )
  if (!serviceNameAttribute || !serviceNameAttribute.value.stringValue) {
    throw new Error("Resource does not contain a service name")
  }
  return serviceNameAttribute.value.stringValue
}

/**
 * Converts key/value entries into OTLP `KeyValue` attributes.
 *
 * @category Attributes
 * @since 4.0.0
 */
export const entriesToAttributes = (entries: Iterable<[string, unknown]>): Array<KeyValue> => {
  const attributes: Array<KeyValue> = []
  for (const [key, value] of entries) {
    attributes.push({
      key,
      value: unknownToAttributeValue(value)
    })
  }
  return attributes
}

/**
 * Converts an arbitrary JavaScript value into an OTLP `AnyValue`.
 *
 * **Details**
 *
 * Arrays are converted recursively, primitive values use their matching OTLP
 * fields, and unsupported values are formatted as strings.
 *
 * @category Attributes
 * @since 4.0.0
 */
export const unknownToAttributeValue = (value: unknown): AnyValue => {
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(unknownToAttributeValue)
      }
    }
  }
  switch (typeof value) {
    case "string":
      return {
        stringValue: value
      }
    case "bigint":
      return {
        intValue: Number(value)
      }
    case "number":
      return Number.isInteger(value)
        ? {
          intValue: value
        }
        : {
          doubleValue: value
        }
    case "boolean":
      return {
        boolValue: value
      }
    default:
      return {
        stringValue: format(value)
      }
  }
}

/**
 * An OTLP attribute represented as a string key and typed value.
 *
 * @category models
 * @since 4.0.0
 */
export interface KeyValue {
  /** KeyValue key */
  key: string
  /** KeyValue value */
  value: AnyValue
}

/**
 * OTLP `AnyValue` payload for scalar, array, key/value-list, or byte values.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyValue {
  /** AnyValue stringValue */
  stringValue?: string | null
  /** AnyValue boolValue */
  boolValue?: boolean | null
  /** AnyValue intValue */
  intValue?: number | null
  /** AnyValue doubleValue */
  doubleValue?: number | null
  /** AnyValue arrayValue */
  arrayValue?: ArrayValue
  /** AnyValue kvlistValue */
  kvlistValue?: KeyValueList
  /** AnyValue bytesValue */
  bytesValue?: Uint8Array
}

/**
 * OTLP array value containing nested `AnyValue` entries.
 *
 * @category models
 * @since 4.0.0
 */
export interface ArrayValue {
  /** ArrayValue values */
  values: Array<AnyValue>
}

/**
 * OTLP key/value-list value containing nested attributes.
 *
 * @category models
 * @since 4.0.0
 */
export interface KeyValueList {
  /** KeyValueList values */
  values: Array<KeyValue>
}

/**
 * Low and high 32-bit parts of a 64-bit integer value.
 *
 * @category models
 * @since 4.0.0
 */
export interface LongBits {
  low: number
  high: number
}

/**
 * Accepted runtime representations for an OTLP/protobuf fixed 64-bit value.
 *
 * @category models
 * @since 4.0.0
 */
export type Fixed64 = LongBits | string | number
