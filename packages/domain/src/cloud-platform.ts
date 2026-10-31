// The platform a span ran on, read from its attributes.
//
// Cloudflare Workers Observability spans carry a `cloudflare.*` / `faas.*` / `geo.*` set no
// other emitter sends, so they get their own summary. Any other span with a real `cloud.*` or
// `faas.*` value gets the generic OpenTelemetry cloud/FaaS summary. The trace views and the
// MCP `inspect_span` tool both read this one detector.
//
// Warehouse attributes are `Map(String, String)` and the trimmed tree projection returns every
// requested key with an empty value, so a key only counts when its value is non-blank.

import { Record, Schema } from "effect"

export const CloudflareWorkerSummary = Schema.TaggedStruct("cloudflare", {
	scriptName: Schema.optionalKey(Schema.String),
	scriptVersion: Schema.optionalKey(Schema.String),
	/** `fetch`, `scheduled`, `queue`, ... */
	handler: Schema.optionalKey(Schema.String),
	/** `stateless`, `durableObject`, ... */
	executionModel: Schema.optionalKey(Schema.String),
	/** Cloudflare data centre, e.g. `ORD`. */
	colo: Schema.optionalKey(Schema.String),
	region: Schema.optionalKey(Schema.String),
	city: Schema.optionalKey(Schema.String),
	countryCode: Schema.optionalKey(Schema.String),
	cpuTimeMs: Schema.optionalKey(Schema.Number),
	wallTimeMs: Schema.optionalKey(Schema.Number),
	ttfbMs: Schema.optionalKey(Schema.Number),
	/** Provider-native outcome (`ok`, `exceededCpu`, `exception`), not the span status. */
	outcome: Schema.optionalKey(Schema.String),
	rayId: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CloudflareWorkerSummary" })
export type CloudflareWorkerSummary = typeof CloudflareWorkerSummary.Type

/** OpenTelemetry `cloud.*` / `faas.*` resource semantics, for any other provider. */
export const CloudPlatformSummary = Schema.TaggedStruct("cloud", {
	provider: Schema.optionalKey(Schema.String),
	platform: Schema.optionalKey(Schema.String),
	region: Schema.optionalKey(Schema.String),
	availabilityZone: Schema.optionalKey(Schema.String),
	accountId: Schema.optionalKey(Schema.String),
	resourceId: Schema.optionalKey(Schema.String),
	functionName: Schema.optionalKey(Schema.String),
	functionVersion: Schema.optionalKey(Schema.String),
	instance: Schema.optionalKey(Schema.String),
	trigger: Schema.optionalKey(Schema.String),
	coldStart: Schema.optionalKey(Schema.Boolean),
	invocationId: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CloudPlatformSummary" })
export type CloudPlatformSummary = typeof CloudPlatformSummary.Type

export const PlatformSummary = Schema.Union([CloudflareWorkerSummary, CloudPlatformSummary])
export type PlatformSummary = typeof PlatformSummary.Type

type Attrs = Readonly<Record<string, string>>

const EMPTY: Attrs = {}

const isPresent = (value: string | undefined): value is string => value !== undefined && value.trim() !== ""

/** One key only when its value is defined, so an absent field stays absent. */
const field = <K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } =>
	value === undefined ? {} : Record.singleton(key, value)

/** Reads span attributes first, then resource attributes, skipping blank values. */
const reader = (span: Attrs, resource: Attrs) => {
	const get = (key: string): string | undefined =>
		isPresent(span[key]) ? span[key] : isPresent(resource[key]) ? resource[key] : undefined
	const pick = (...keys: ReadonlyArray<string>): string | undefined => keys.map(get).find(isPresent)
	// Zero is a real timing (the Workers clock only advances on I/O); unparsable is absent.
	const millis = (key: string): number | undefined => {
		const raw = get(key)
		const value = raw === undefined ? Number.NaN : Number(raw)
		return Number.isFinite(value) ? value : undefined
	}
	const hasPrefix = (prefix: string): boolean =>
		[span, resource].some((attrs) =>
			Object.entries(attrs).some(([key, value]) => key.startsWith(prefix) && isPresent(value)),
		)
	return { get, pick, millis, hasPrefix }
}

const cloudflare = (read: ReturnType<typeof reader>): CloudflareWorkerSummary | undefined => {
	const isWorker = read.get("cloud.platform") === "cloudflare.workers" || read.hasPrefix("cloudflare.")
	if (!isWorker) return undefined
	return {
		_tag: "cloudflare",
		...field("scriptName", read.pick("cloudflare.script_name", "faas.name")),
		...field("scriptVersion", read.pick("cloudflare.script_version.id", "faas.version")),
		...field("handler", read.pick("cloudflare.handler_type", "faas.trigger")),
		...field("executionModel", read.get("cloudflare.execution_model")),
		...field("colo", read.get("cloudflare.colo")),
		...field("region", read.get("faas.invoked_region")),
		...field("city", read.get("geo.locality.name")),
		...field("countryCode", read.get("geo.country.code")),
		...field("cpuTimeMs", read.millis("cpu_time_ms")),
		...field("wallTimeMs", read.millis("wall_time_ms")),
		...field("ttfbMs", read.millis("cloudflare.response.time_to_first_byte_ms")),
		...field("outcome", read.get("cloudflare.outcome")),
		...field("rayId", read.get("cloudflare.ray_id")),
	}
}

const coldStart = (raw: string | undefined): boolean | undefined =>
	raw === "true" ? true : raw === "false" ? false : undefined

const cloud = (read: ReturnType<typeof reader>): CloudPlatformSummary | undefined => {
	const isCloud =
		read.get("cloud.provider") !== undefined ||
		read.get("cloud.platform") !== undefined ||
		read.hasPrefix("faas.")
	if (!isCloud) return undefined
	return {
		_tag: "cloud",
		...field("provider", read.get("cloud.provider")),
		...field("platform", read.get("cloud.platform")),
		...field("region", read.pick("cloud.region", "faas.invoked_region")),
		...field("availabilityZone", read.get("cloud.availability_zone")),
		...field("accountId", read.get("cloud.account.id")),
		...field("resourceId", read.get("cloud.resource_id")),
		...field("functionName", read.get("faas.name")),
		...field("functionVersion", read.get("faas.version")),
		...field("instance", read.get("faas.instance")),
		...field("trigger", read.get("faas.trigger")),
		...field("coldStart", coldStart(read.get("faas.coldstart"))),
		...field("invocationId", read.get("faas.invocation_id")),
	}
}

/**
 * The platform a span ran on, or `undefined` when its attributes name none. Span attributes
 * win over resource attributes for the same key.
 */
export const detectPlatform = (
	spanAttributes: Attrs,
	resourceAttributes: Attrs = EMPTY,
): PlatformSummary | undefined => {
	const read = reader(spanAttributes, resourceAttributes)
	return cloudflare(read) ?? cloud(read)
}

/** The Cloudflare summary alone, for views that only badge Workers. */
export const detectCloudflareWorker = (
	spanAttributes: Attrs,
	resourceAttributes: Attrs = EMPTY,
): CloudflareWorkerSummary | undefined => cloudflare(reader(spanAttributes, resourceAttributes))
