/** Output schemas for the list_security_findings and inspect_security_finding MCP tools. */
import { Schema } from "effect"

/** The Security Center's four sources of findings. */
export const SECURITY_AREAS = ["code", "dependencies", "exposure", "runtimes"] as const
export const SecurityAreaLiteral = Schema.Literals(SECURITY_AREAS)
export type SecurityArea = typeof SecurityAreaLiteral.Type

/** One scale across areas; `unknown` is an advisory without a score. */
export const SECURITY_SEVERITIES = ["critical", "high", "medium", "low", "informational", "unknown"] as const
export const SecuritySeverityLiteral = Schema.Literals(SECURITY_SEVERITIES)
export type SecuritySeverity = typeof SecuritySeverityLiteral.Type

/**
 * How an area stands: `findings` and `clear` were read; the rest say why there is nothing to read
 * (`not_enabled`, `not_connected`, `no_data`), may not be read by this caller (`forbidden`) or
 * failed (`unavailable`).
 */
export const SECURITY_AREA_STATES = [
	"findings",
	"clear",
	"not_enabled",
	"not_connected",
	"no_data",
	"forbidden",
	"unavailable",
] as const
export const SecurityAreaStateLiteral = Schema.Literals(SECURITY_AREA_STATES)

export const SecuritySeverityCounts = Schema.Struct({
	critical: Schema.Number,
	high: Schema.Number,
	medium: Schema.Number,
	low: Schema.Number,
	/** Informational and unscored. */
	other: Schema.Number,
})

export const SecurityAreaSummary = Schema.Struct({
	area: SecurityAreaLiteral,
	state: SecurityAreaStateLiteral,
	/** One line: what was read and what it found, or why nothing was. */
	summary: Schema.String,
	/** Open findings per severity in this area; triaged and fixed ones are not counted. */
	counts: SecuritySeverityCounts,
	/** Findings in this area that matched the call's filters, of which `findings` lists the worst. */
	matched: Schema.Number,
})

/** A service a finding reaches in production: it runs the vulnerable code, or was probed. */
export const SecurityServiceRef = Schema.Struct({
	service: Schema.String,
	environment: Schema.String,
})

export const SecurityFindingRow = Schema.Struct({
	area: SecurityAreaLiteral,
	/** What `inspect_security_finding` takes: a code fingerprint, a dependency finding id, or an advisory id. */
	id: Schema.String,
	severity: SecuritySeverityLiteral,
	title: Schema.String,
	/** Repository and file, lockfile, service and path, or service and environment. */
	location: Schema.String,
	/** Triage state (`open`, `fixed`, `dismissed`, `accepted_risk`) or, for telemetry, what was observed. */
	status: Schema.String,
	/** The one thing to do or know next: the fix version, the verdict, the HTTP answer. */
	detail: Schema.String,
	/** Services the finding reaches in production, busiest first; empty when none is known to. */
	services: Schema.Array(SecurityServiceRef),
	/** ISO time last seen: the run, scan or request that last reported it. */
	lastSeen: Schema.NullOr(Schema.String),
})
export type SecurityFindingRow = typeof SecurityFindingRow.Type

export const ListSecurityFindingsOutput = Schema.Struct({
	generatedAt: Schema.String,
	/** The telemetry window exposure and runtimes were read over. */
	window: Schema.Struct({ startTime: Schema.String, endTime: Schema.String }),
	areaFilter: Schema.optionalKey(SecurityAreaLiteral),
	/** The filters the counts and findings follow. */
	filters: Schema.Struct({
		status: Schema.String,
		severity: Schema.optionalKey(Schema.String),
		service: Schema.optionalKey(Schema.String),
		repository: Schema.optionalKey(Schema.String),
	}),
	areas: Schema.Array(SecurityAreaSummary),
	/** Worst first across the areas read; capped, so `matched` on each area can be larger. */
	findings: Schema.Array(SecurityFindingRow),
	/** Area-specific facts worth one line each: a catch-all service, a scan that failed, a target never run. */
	notes: Schema.Array(Schema.String),
	/** With `area=exposure`: probe traffic per category and the busiest scanning sources. */
	exposure: Schema.optionalKey(
		Schema.Struct({
			categories: Schema.Array(
				Schema.Struct({
					label: Schema.String,
					requests: Schema.Number,
					/** Answered with a 2xx, catch-all services left out; null for named scanners on ordinary pages. */
					answered: Schema.NullOr(Schema.Number),
					services: Schema.Number,
					topPaths: Schema.Array(Schema.String),
				}),
			),
			sources: Schema.Array(
				Schema.Struct({
					address: Schema.String,
					requests: Schema.Number,
					/** Distinct probe paths the source asked for. */
					signatures: Schema.Number,
					/** The named scanning tool, empty when its user agent named none. */
					scanner: Schema.String,
					userAgent: Schema.String,
					lastSeen: Schema.String,
				}),
			),
		}),
	),
	/** With `area=runtimes`: every service's runtime, fine ones included. */
	runtimes: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				service: Schema.String,
				environment: Schema.String,
				runtime: Schema.String,
				/** end_of_life, behind, supported, no_version, emulated, unknown_cycle, catalog_unavailable, untracked. */
				posture: Schema.String,
				note: Schema.String,
				/** Known advisories for the version; null when it was not checked. */
				advisories: Schema.NullOr(Schema.Number),
				sdk: Schema.String,
			}),
		),
	),
})

// ---------------------------------------------------------------------------------------------
// inspect_security_finding

const Location = Schema.Struct({ file: Schema.String, line: Schema.Number, description: Schema.String })

export const CodeFindingDetail = Schema.Struct({
	area: Schema.Literal("code"),
	fingerprint: Schema.String,
	repository: Schema.String,
	branch: Schema.String,
	title: Schema.String,
	/** `confirmed` was reproduced; `needs_validation` is a lead read from source; `rejected` was disproved. */
	verdict: Schema.String,
	severity: SecuritySeverityLiteral,
	/** True when the severity is the lead's estimate, not a confirmed rating. */
	severityEstimated: Schema.Boolean,
	status: Schema.String,
	statusReason: Schema.NullOr(Schema.String),
	/** When a person last triaged it; null when nobody has. */
	statusChangedAt: Schema.NullOr(Schema.String),
	description: Schema.String,
	rootCause: Schema.String,
	/** Entry point to sink. */
	trace: Schema.Array(Schema.Struct({ kind: Schema.String, ...Location.fields })),
	evidence: Schema.Array(Location),
	/** How an attacker reaches it (confirmed findings). */
	exploit: Schema.NullOr(
		Schema.Struct({
			attackerPerspective: Schema.String,
			instructions: Schema.Array(Schema.String),
			payloads: Schema.Array(Schema.String),
			observedResult: Schema.String,
		}),
	),
	conditions: Schema.Array(Schema.String),
	remediation: Schema.NullOr(
		Schema.Struct({
			strategy: Schema.String,
			codeChanges: Schema.Array(Schema.Struct({ file: Schema.String, fixedCode: Schema.String })),
		}),
	),
	/** What stops a lead from being confirmed, and how to check it (needs_validation). */
	blockers: Schema.Array(Schema.String),
	validationPlan: Schema.Array(Schema.String),
	/** Why it was disproved (rejected). */
	rejectedBecause: Schema.NullOr(Schema.String),
	firstSeenRef: Schema.String,
	lastSeenRef: Schema.String,
	firstSeenAt: Schema.String,
	lastSeenAt: Schema.String,
	/** Production services running a commit of the repository: they run its code. */
	services: Schema.Array(SecurityServiceRef),
	/** The audit run that no longer found it, for a `fixed` finding. */
	fixedBy: Schema.NullOr(
		Schema.Struct({
			runId: Schema.String,
			ref: Schema.NullOr(Schema.String),
			at: Schema.NullOr(Schema.String),
		}),
	),
})

export const DependencyFindingDetail = Schema.Struct({
	area: Schema.Literal("dependencies"),
	id: Schema.String,
	repository: Schema.String,
	lockfilePath: Schema.String,
	ecosystem: Schema.String,
	packageName: Schema.String,
	/** The installed versions the advisory affects. */
	versions: Schema.Array(Schema.String),
	fixedIn: Schema.NullOr(Schema.String),
	/** direct, dev, transitive or unknown. */
	relation: Schema.String,
	advisoryId: Schema.String,
	aliases: Schema.Array(Schema.String),
	severity: SecuritySeverityLiteral,
	summary: Schema.NullOr(Schema.String),
	status: Schema.String,
	statusReason: Schema.NullOr(Schema.String),
	/** Services running a commit whose lockfile has the affected version, with that commit and its 24h spans. */
	services: Schema.Array(
		Schema.Struct({ ...SecurityServiceRef.fields, commitSha: Schema.String, spans: Schema.Number }),
	),
	/** What to change: the upgrade, or how to reach it for a transitive package. */
	fix: Schema.String,
	firstSeenSha: Schema.String,
	lastSeenSha: Schema.String,
	firstSeenAt: Schema.String,
	lastSeenAt: Schema.String,
})

/** A runtime version a known advisory affects, and every service on it. */
export const RuntimeAdvisoryDetail = Schema.Struct({
	area: Schema.Literal("runtimes"),
	advisoryId: Schema.String,
	url: Schema.String,
	summary: Schema.NullOr(Schema.String),
	severity: SecuritySeverityLiteral,
	runtime: Schema.String,
	version: Schema.String,
	fixedIn: Schema.NullOr(Schema.String),
	services: Schema.Array(SecurityServiceRef),
})

/** A probe a service answered with a 2xx, and everything scanners asked that service. */
export const ExposureDetail = Schema.Struct({
	area: Schema.Literal("exposure"),
	id: Schema.String,
	service: Schema.String,
	host: Schema.String,
	path: Schema.String,
	category: Schema.String,
	severity: SecuritySeverityLiteral,
	httpStatus: Schema.Number,
	requests: Schema.Number,
	lastSeen: Schema.String,
	/** One request that got the answer: `inspect_trace` shows it. */
	sampleTraceId: Schema.String,
	/** True when the service answers most probe paths: its 2xx answers are likely its index page. */
	catchAll: Schema.Boolean,
	/** Every probe path scanners sent this service in the window, busiest first. */
	probes: Schema.Array(
		Schema.Struct({
			signature: Schema.String,
			category: Schema.String,
			requests: Schema.Number,
			answered: Schema.Number,
		}),
	),
})

export const InspectSecurityFindingOutput = Schema.Struct({
	query: Schema.String,
	/** Every finding the id names: one fingerprint can sit in two targets, one CVE in many packages. */
	matches: Schema.Array(
		Schema.Union([CodeFindingDetail, DependencyFindingDetail, RuntimeAdvisoryDetail, ExposureDetail]),
	),
	/** Areas that could not be searched for this caller, with why. */
	notSearched: Schema.Array(Schema.String),
	/** For an advisory id: what was checked and found clean, and what could not be judged. */
	coverage: Schema.Array(Schema.String),
})
