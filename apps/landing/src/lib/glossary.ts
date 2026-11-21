/**
 * The observability glossary. `/glossary` lists every term from here, each term
 * page reads its own entry for the definition and JSON-LD, and llms.txt lists
 * them. A new term needs an entry here and a page in pages/glossary/.
 */

export type GlossaryTerm = {
	slug: string
	/** The term as a heading: "Trace", "OTLP". */
	term: string
	/** One or two sentences that define the term on their own. */
	definition: string
}

const terms = {
	trace: {
		term: "Trace",
		definition:
			"A trace is the record of one request or operation as it moves through a system, made of spans that share one trace ID and form a tree of parent and child operations.",
	},
	span: {
		term: "Span",
		definition:
			"A span is one timed operation inside a trace, such as an HTTP request, a database query or a function call, with a name, a start and end time, attributes, events and a status.",
	},
	otlp: {
		term: "OTLP",
		definition:
			"OTLP, the OpenTelemetry Protocol, is the vendor-neutral format for sending traces, metrics and logs from OpenTelemetry SDKs and Collectors to a backend, over gRPC on port 4317 or HTTP on port 4318.",
	},
	percentiles: {
		term: "Percentiles (p50, p95, p99)",
		definition:
			"A percentile is the value below which a given share of measurements fall: p99 latency is the response time that 99% of requests beat and the slowest 1% exceed.",
	},
	slo: {
		term: "SLO and error budget",
		definition:
			"A service level objective (SLO) is a target for how often a service must behave well over a time window, such as 99.9% of requests succeeding over 30 days. The error budget is the failure that target allows: 0.1% of requests.",
	},
	cardinality: {
		term: "Cardinality",
		definition:
			"In observability, cardinality is the number of distinct values an attribute takes, and for a metric the number of distinct time series its attribute combinations produce.",
	},
	instrumentation: {
		term: "Instrumentation and auto-instrumentation",
		definition:
			"Instrumentation is the code that produces telemetry from an application. Auto-instrumentation adds it without changes to your code, by patching common libraries at startup; manual instrumentation is spans and metrics you write yourself.",
	},
	"semantic-conventions": {
		term: "Semantic conventions",
		definition:
			"OpenTelemetry semantic conventions are the standard names and values for telemetry attributes, metrics and spans, such as http.request.method or service.name, so data from any library or language means the same thing.",
	},
} satisfies Record<string, Omit<GlossaryTerm, "slug">>

export type GlossarySlug = keyof typeof terms

/** Every term, in the order the index lists them. */
export const glossaryTerms: readonly GlossaryTerm[] = Object.entries(terms).map(([slug, entry]) => ({
	slug,
	...entry,
}))

export const glossaryTerm = (slug: GlossarySlug): GlossaryTerm => ({ slug, ...terms[slug] })
