import { getAutoPlatformAttributes } from "@maple-dev/effect-sdk/server"
import { Layer } from "effect"
import { FetchHttpClient, HttpBody } from "effect/unstable/http"
import { OtlpMetrics, OtlpResource, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { MAPLE_VERSION } from "../version"

// Publishable ("pk") ingest token, baked into the distributed binary so CLI
// telemetry works on a fresh install with zero config. The `maple_pk_` class is
// the public-key tier meant to be embedded in clients — ingest-only, scoped to
// Maple's internal workspace, never a privileged key. Rotation means shipping a
// new CLI release. An explicit `MAPLE_INGEST_KEY` still wins (see below).
const DEFAULT_INGEST_KEY = "maple_pk_bwGJomBwDO4B15sopcuinQVqNFCDjhE2"

/**
 * Where this invocation is running.
 *
 * Without this the SDK falls back to `Config.withDefault("development")` — none
 * of `MAPLE_ENVIRONMENT` / `RAILWAY_ENVIRONMENT_NAME` / `DEPLOYMENT_ENV` exist
 * on a laptop — so *every* CLI install reported `development`, indistinguishable
 * from a Maple worker running locally and, worse, from our own CI. Triaging the
 * CLI's error stream meant reading paths out of error strings to guess whether a
 * failure came from a user or a GitHub Actions runner.
 *
 * `CI` is the de-facto standard variable, set by GitHub Actions, GitLab, CircleCI
 * and Buildkite alike. An explicit `MAPLE_ENVIRONMENT` still wins.
 */
const resolveEnvironment = (): string => {
	if (process.env.MAPLE_ENVIRONMENT) return process.env.MAPLE_ENVIRONMENT
	return process.env.CI ? "ci" : "cli"
}

/** Same precedence as the SDK: an explicit endpoint, then the region's ingest. */
const resolveEndpoint = (): string => {
	const explicit = process.env.MAPLE_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
	if (explicit) return explicit.replace(/\/+$/, "")
	return process.env.MAPLE_REGION?.trim().toLowerCase() === "eu"
		? "https://ingest.eu.maple.dev"
		: "https://ingest.maple.dev"
}

// Scrubbing. The CLI exports to Maple's cloud, so nothing a user typed or
// stored may leave: SQL text, filter values, error messages (chDB quotes rows
// and literals), log bodies. Error identity survives as `exception.type`.

type TraceData = OtlpTracer.TraceData
type OtlpSpan = TraceData["resourceSpans"][number]["scopeSpans"][number]["spans"][number]
type SpanEvent = OtlpSpan["events"][number]

const DROPPED_KEYS = new Set([
	"db.query.text",
	"db.statement",
	"exception.message",
	"error.message",
	"effect.cause",
	"url.query",
	"http.request.body",
	"http.response.body",
	// User-typed filter values from query-engine operations.
	"service",
	"spanName",
	"sessionId",
])
const DROPPED_KEY_PATTERN = /sql|^query\.filter\./i

const attributeString = (attribute: OtlpResource.KeyValue): string | undefined =>
	typeof attribute.value.stringValue === "string" ? attribute.value.stringValue : undefined

const withString = (key: string, value: string): OtlpResource.KeyValue => ({
	key,
	value: { stringValue: value },
})

/** Command words and flag names only; positional arguments and flag values
 *  (SQL, trace ids, filter values) are dropped. */
export const sanitizeArgv = (argv: string): string => {
	const kept: string[] = []
	let commandWords = 0
	let leading = true
	for (const token of argv.split(/\s+/)) {
		if (token === "") continue
		if (token.startsWith("-")) {
			kept.push(token.split("=")[0] ?? token)
			leading = false
		} else if (leading && commandWords < 2 && /^[a-z][a-z-]*$/.test(token)) {
			kept.push(token)
			commandWords++
		} else leading = false
	}
	return kept.join(" ")
}

/** Stack frames without the message lines or directory prefixes. */
export const sanitizeStack = (stack: string): string =>
	stack
		.split("\n")
		.filter((line) => /^\s+at\s/.test(line))
		.map((line) => line.replace(/(?:[A-Za-z]:)?[\\/][^\s():]*[\\/]([^\\/\s():]+)/g, "$1"))
		.join("\n")

export const scrubAttributes = (
	attributes: ReadonlyArray<OtlpResource.KeyValue>,
): Array<OtlpResource.KeyValue> =>
	attributes.flatMap((attribute): Array<OtlpResource.KeyValue> => {
		const { key } = attribute
		if (DROPPED_KEYS.has(key) || DROPPED_KEY_PATTERN.test(key)) return []
		const value = attributeString(attribute)
		if (key === "cli.argv" && value !== undefined) return [withString(key, sanitizeArgv(value))]
		if (key === "exception.stacktrace" && value !== undefined)
			return [withString(key, sanitizeStack(value))]
		if (key === "url.full" && value !== undefined) return [withString(key, value.replace(/[?#].*$/, ""))]
		return [attribute]
	})

const scrubEvent = (event: SpanEvent): SpanEvent => {
	// `Effect.log` inside a span becomes an event named after the message.
	const level = event.attributes.find((attribute) => attribute.key === "effect.logLevel")
	if (level !== undefined) return { ...event, name: "log", attributes: [level] }
	return { ...event, attributes: scrubAttributes(event.attributes) }
}

export const scrubSpan = (span: OtlpSpan): OtlpSpan => ({
	...span,
	attributes: scrubAttributes(span.attributes),
	events: span.events.map(scrubEvent),
	links: span.links.map((link) => ({ ...link, attributes: scrubAttributes(link.attributes) })),
	// The status message is the first error's message; the type is on the event.
	status: { code: span.status.code },
})

export const scrubTraceData = (data: TraceData): TraceData => ({
	resourceSpans: data.resourceSpans.map((resourceSpan) => ({
		...resourceSpan,
		scopeSpans: resourceSpan.scopeSpans.map((scopeSpan) => ({
			...scopeSpan,
			spans: scopeSpan.spans.map(scrubSpan),
		})),
	})),
})

/** JSON serialization with the scrubber applied at the export boundary. */
const ScrubbedSerialization = Layer.succeed(OtlpSerialization.OtlpSerialization, {
	traces: (data) => HttpBody.jsonUnsafe(scrubTraceData(data)),
	metrics: (data) => HttpBody.jsonUnsafe(data),
	// No log exporter is installed; a log record's body is free text.
	logs: () => HttpBody.jsonUnsafe({ resourceLogs: [] }),
})

/**
 * `MAPLE_TELEMETRY=off` mutes the CLI's own telemetry entirely. CI's native
 * probes set it: they induce failures on purpose — digest mismatches, crashed
 * retirements, adversarial registries — and every one landed in the production
 * errors hub as a `maple-cli` issue (hundreds of `deployment.environment=ci`
 * events a week nobody could act on). Ordinary CI use of the CLI stays on.
 */
const telemetryOff = process.env.MAPLE_TELEMETRY === "off"

const makeTelemetryLayer = (): Layer.Layer<never> => {
	const endpoint = resolveEndpoint()
	const environment = resolveEnvironment()
	const resource = {
		serviceName: "maple-cli",
		serviceVersion: MAPLE_VERSION,
		attributes: {
			...getAutoPlatformAttributes(),
			"maple.sdk.type": "server",
			"service.instance.id": crypto.randomUUID(),
			"service.namespace": "core",
			"deployment.environment": environment,
			"deployment.environment.name": environment,
			"vcs.repository.url.full": "https://github.com/MapleTechLabs/maple",
		},
	}
	const headers = { Authorization: `Bearer ${process.env.MAPLE_INGEST_KEY ?? DEFAULT_INGEST_KEY}` }
	return Layer.mergeAll(
		OtlpTracer.layer({ url: `${endpoint}/v1/traces`, resource, headers, shutdownTimeout: "3 seconds" }),
		OtlpMetrics.layer({ url: `${endpoint}/v1/metrics`, resource, headers, shutdownTimeout: "3 seconds" }),
	).pipe(Layer.provide(ScrubbedSerialization), Layer.provide(FetchHttpClient.layer))
}

/**
 * OpenTelemetry layer for the CLI: traces and metrics about the CLI itself and,
 * under `maple start`, the server's request handling. Exported to
 * `https://ingest.maple.dev` by default (`MAPLE_ENDPOINT` /
 * `OTEL_EXPORTER_OTLP_ENDPOINT` redirect it, `MAPLE_INGEST_KEY` replaces the
 * key). Spans pass through the scrubber above; logs are not exported.
 */
export const TelemetryLayer: Layer.Layer<never> = telemetryOff ? Layer.empty : makeTelemetryLayer()
