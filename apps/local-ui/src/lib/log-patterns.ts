// Display helpers for Drain log templates (`clusterLogPatterns` in
// `@maple/query-engine/observability`). Variables are `<*>` or a named mask
// such as `<uuid>`, `<ip>`, `<hex>` or `<email>`.

import { compareSeverity } from "./log-shape"

export interface TemplateSegment {
	readonly text: string
	readonly variable: boolean
}

const VARIABLE = /<\*>|<(?:uuid|ip|hex|email)>/g

/** Splits a template into literal and variable runs, in order, dropping empty literals. */
export function splitTemplate(template: string): ReadonlyArray<TemplateSegment> {
	const segments: TemplateSegment[] = []
	let last = 0
	for (const match of template.matchAll(VARIABLE)) {
		const index = match.index ?? 0
		if (index > last) segments.push({ text: template.slice(last, index), variable: false })
		segments.push({ text: match[0], variable: true })
		last = index + match[0].length
	}
	if (last < template.length) segments.push({ text: template.slice(last), variable: false })
	return segments
}

/**
 * The longest whitespace-free literal token of a template. Drain rejoins tokens with
 * single spaces, so only one token is a substring of every matching body.
 */
export function patternSearchTerm(template: string): string {
	return splitTemplate(template)
		.filter((segment) => !segment.variable)
		.flatMap((segment) => segment.text.split(/\s+/))
		.reduce((best, token) => (token.length > best.length ? token : best), "")
}

export interface CountEntry {
	readonly name: string
	readonly count: number
}

/** Count map entries, largest first, ties by name. */
export function rankCounts(counts: Readonly<Record<string, number>>): ReadonlyArray<CountEntry> {
	return Object.entries(counts)
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Severity entries ordered by level (most severe first), not by count. */
export function severityBreakdown(counts: Readonly<Record<string, number>>): ReadonlyArray<CountEntry> {
	return Object.entries(counts)
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => compareSeverity(a.name, b.name))
}
