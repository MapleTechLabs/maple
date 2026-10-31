// The investigation conversation's starter suggestions and the noun for its subject's kind.

import { Schema } from "effect"

const signalLabel = (signalType: string): string => {
	switch (signalType) {
		case "error_rate":
			return "error rate"
		case "p95_latency":
			return "p95 latency"
		case "p99_latency":
			return "p99 latency"
		case "apdex":
			return "Apdex"
		case "throughput":
			return "throughput"
		case "builder_query":
			return "query result"
		case "raw_query":
			return "SQL query result"
		default:
			// Never leak a raw enum into prose: these read mid-sentence.
			return signalType.replace(/[_-]+/g, " ")
	}
}

/** What Maple can investigate, read off the investigation's subject. */
const InvestigationKindSchema = Schema.Literals(["alert", "anomaly", "error", "freeform"])
export type InvestigationKind = typeof InvestigationKindSchema.Type

/** The subject as the starter suggestions read it, whatever its kind. */
export interface InvestigationContext {
	kind: InvestigationKind
	/** Rule name, "p95 latency · svc", or the exception message. */
	title: string
	/** The alert or anomaly's signal (the snapshot's `Signal` fact). */
	signalType?: string
	/** The group key or service name the suggestions name. */
	scope?: string
	/** The report's suspected cause, once a diagnosis is on screen. */
	aiSuspectedCause?: string
}

/** The time window the suggestions name, in minutes. */
const WINDOW_MINUTES = 15

const KIND_NOUN = {
	alert: "alert",
	anomaly: "anomaly",
	error: "error",
	freeform: "question",
} satisfies Record<InvestigationKind, string>

export const investigationNoun = (kind: InvestigationKind): string => KIND_NOUN[kind]

/**
 * A scope short enough for a suggestion button. `scope` is free text: a system-seeded
 * investigation can carry a whole sentence, so cut at the first clause boundary (its head is
 * the subject, "subscriptions-api public endpoints (GET …)" to "subscriptions-api"), then cap it.
 */
const CHIP_SCOPE_MAX = 32

export const chipScope = (raw: string): string => {
	const head = raw.split(/[(\n,;—]/)[0]!.trim()
	const text = head.length > 0 ? head : raw.trim()
	if (text.length <= CHIP_SCOPE_MAX) return text
	// A clause this long is a sentence, whose subject is its first word: prefer that
	// whole word over a mid-word ellipsis.
	const first = text.split(/\s+/)[0]!
	return first.length > CHIP_SCOPE_MAX ? `${first.slice(0, CHIP_SCOPE_MAX - 1).trimEnd()}…` : first
}

const CHIP_PHRASE_MAX = 36

/**
 * {@link chipScope} for an error's title, the exception message (a sentence, sometimes JSON).
 * Its front is the identifying part, so this truncates instead of lifting a subject word.
 */
export const chipPhrase = (raw: string): string => {
	const text = raw.split("\n")[0]!.trim()
	return text.length > CHIP_PHRASE_MAX ? `${text.slice(0, CHIP_PHRASE_MAX - 1).trimEnd()}…` : text
}

/** Starter prompts tuned to the kind + signal + scope of the investigation. */
export const investigationSuggestions = (ctx: InvestigationContext): string[] => {
	const scope = ctx.scope ? chipScope(ctx.scope) : "the affected service"
	const windowM = WINDOW_MINUTES

	// A diagnosis is already on screen: push on the report, corroborating or breaking it,
	// instead of asking for one.
	if (ctx.aiSuspectedCause) {
		return [
			"What would confirm this?",
			"What else could explain it?",
			"Show the supporting traces",
			"What should we do first?",
		]
	}

	if (ctx.kind === "freeform") {
		return [
			"Summarize the strongest evidence",
			"What data is still missing?",
			"Show the most relevant traces",
			"What should we do next?",
		]
	}

	if (ctx.kind === "error") {
		const error = chipPhrase(ctx.title)
		return [
			`Sample stack traces for ${error}`,
			`When did ${error} start?`,
			`Which release introduced this?`,
			`Group these errors by endpoint`,
		]
	}

	if (ctx.kind === "anomaly") {
		const sig = ctx.signalType ?? ""
		if (sig.includes("latency")) {
			return [
				`Slowest operations in ${scope} right now`,
				`Top 10 slowest traces in ${scope}`,
				`Compare ${scope} latency to the past week`,
				`Recent deploys or config changes in ${scope}`,
			]
		}
		if (sig.includes("error")) {
			return [
				`Top exceptions in ${scope} in the last ${windowM}m`,
				`Which errors drove the spike?`,
				`Group errors in ${scope} by endpoint`,
				`Sample stack traces per error class`,
			]
		}
		return [
			`What changed in ${scope}?`,
			`Compare ${scope} to the past week`,
			`Upstream callers of ${scope} — any drops?`,
			`Recent deploys in ${scope}`,
		]
	}

	// alert
	const sig = ctx.signalType ?? ""
	if (sig === "p95_latency" || sig === "p99_latency") {
		return [
			`Slowest operations in ${scope} right now`,
			`Top 10 slowest traces in ${scope}`,
			`Compare ${scope} ${signalLabel(sig)} to the past week`,
			`Recent deploys or config changes in ${scope}`,
		]
	}
	if (sig === "error_rate") {
		return [
			`Top exceptions in ${scope} in the last ${windowM}m`,
			`New error types since ${Math.max(windowM * 12, 60)}m ago`,
			`Group errors in ${scope} by endpoint`,
			`Sample stack traces per error class`,
		]
	}
	if (sig === "throughput") {
		return [
			`Plot ${scope} throughput vs yesterday`,
			`Upstream callers of ${scope} — any drops?`,
			`Operations in ${scope} with biggest volume delta`,
		]
	}
	return [`Diagnose ${scope}`, `Recent errors in ${scope}`, `Slowest traces in ${scope}`]
}
