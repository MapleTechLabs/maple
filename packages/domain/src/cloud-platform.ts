// The platform a span ran on, shared by the trace views and MCP `inspect_span`. The tree
// projection returns every requested key with an empty value, so only non-blank values count.

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

/** Keys of the function that ran; `faas.invoked_*` on a client span names the one it called. */
const FAAS_SELF_KEYS = [
	"faas.name",
	"faas.version",
	"faas.instance",
	"faas.trigger",
	"faas.coldstart",
	"faas.invocation_id",
]

const cloud = (span: Attrs, resource: Attrs): CloudPlatformSummary | undefined => {
	// All `cloud.*` come from one map: a client span's `cloud.region` (an AWS SDK call) must not
	// mix into the resource's own provider.
	const cloudMap =
		isPresent(resource["cloud.provider"]) || isPresent(resource["cloud.platform"]) ? resource : span
	const cloudAttr = (key: string): string | undefined =>
		isPresent(cloudMap[key]) ? cloudMap[key] : undefined
	const faas = reader(span, resource)
	const isCloud =
		cloudAttr("cloud.provider") !== undefined ||
		cloudAttr("cloud.platform") !== undefined ||
		FAAS_SELF_KEYS.some((key) => faas.get(key) !== undefined)
	if (!isCloud) return undefined
	return {
		_tag: "cloud",
		...field("provider", cloudAttr("cloud.provider")),
		...field("platform", cloudAttr("cloud.platform")),
		...field("region", cloudAttr("cloud.region")),
		...field("availabilityZone", cloudAttr("cloud.availability_zone")),
		...field("accountId", cloudAttr("cloud.account.id")),
		...field("resourceId", cloudAttr("cloud.resource_id")),
		...field("functionName", faas.get("faas.name")),
		...field("functionVersion", faas.get("faas.version")),
		...field("instance", faas.get("faas.instance")),
		...field("trigger", faas.get("faas.trigger")),
		...field("coldStart", coldStart(faas.get("faas.coldstart"))),
		...field("invocationId", faas.get("faas.invocation_id")),
	}
}

/**
 * The platform a span ran on, or `undefined` when its attributes name none. Span attributes win
 * per key, except that a generic summary takes all `cloud.*` from one map.
 */
export const detectPlatform = (
	spanAttributes: Attrs,
	resourceAttributes: Attrs = EMPTY,
): PlatformSummary | undefined =>
	cloudflare(reader(spanAttributes, resourceAttributes)) ?? cloud(spanAttributes, resourceAttributes)

/** The Cloudflare summary alone, for views that only badge Workers. */
export const detectCloudflareWorker = (
	spanAttributes: Attrs,
	resourceAttributes: Attrs = EMPTY,
): CloudflareWorkerSummary | undefined => cloudflare(reader(spanAttributes, resourceAttributes))
