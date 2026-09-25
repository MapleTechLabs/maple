/**
 * Shared types + content helpers for the docs ⌘K search.
 *
 * Pure string utilities only (no browser/node globals at module scope), so this
 * file is safe to import from both the build-time index endpoint
 * (`pages/docs/search-index.json.ts`) and the client island (`DocsSearch.tsx`).
 */

export interface SearchSection {
	heading: string
	/** Heading id Astro rendered, so `url#anchor` lands on the section. */
	anchor: string
	text: string
}

export interface SearchDoc {
	/** Collection entry id, e.g. `guides/instrumentation-node`. */
	id: string
	/** Destination route, e.g. `/docs/guides/instrumentation-node`. */
	url: string
	title: string
	description: string
	group: string
	sdk?: string
	/** Plain text before the first H2. */
	intro: string
	/** One entry per H2/H3; deeper headings fold into their parent section. */
	sections: SearchSection[]
}

/** One searchable row: a whole page (intro) or one of its sections. */
export interface SearchRecord {
	doc: SearchDoc
	section?: SearchSection
	url: string
	heading: string
	text: string
}

export interface SearchHit {
	record: SearchRecord
	/** Excerpt around the first match; empty when the match was in a title. */
	snippet: string
}

const SECTION_CHAR_CAP = 1500

/**
 * Strip markdown/MDX syntax down to searchable plain text while KEEPING code
 * identifiers (env vars, function names, error strings) that users search for.
 */
export function stripMarkdown(md: string): string {
	return (
		md
			.replace(/^\s*(?:import|export)\s.*$/gm, " ") // MDX import/export lines
			.replace(/```[^\n]*\n?/g, " ") // fenced code markers (keep inner code text)
			.replace(/`+/g, " ") // inline code backticks
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
			.replace(/<[^>]+>/g, " ") // html / jsx tags
			// Remaining markdown punctuation. `_` stays: it is in env vars and
			// identifiers (OTEL_EXPORTER_OTLP_HEADERS) far more than in emphasis.
			.replace(/[#>*~|]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	)
}

const cleanHeading = (raw: string) =>
	raw
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_]/g, "")
		.trim()

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "")

/** Fallback when Astro's heading list has no match; mirrors github-slugger for plain text. */
const slugify = (text: string) =>
	text
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.replace(/\s/g, "-")

/**
 * Split a markdown body into its intro and H2/H3 sections. `rendered` is the
 * heading list from Astro's `render()`, used for the real anchor ids.
 */
export function splitSections(
	md: string,
	rendered: ReadonlyArray<{ depth: number; slug: string; text: string }>,
): { intro: string; sections: SearchSection[] } {
	const sections: SearchSection[] = []
	const introLines: string[] = []
	let current: { heading: string; anchor: string; lines: string[] } | null = null
	// Opening fence marker; only a same-character marker at least as long closes it.
	let fence: string | null = null
	let cursor = 0

	const flush = () => {
		if (!current) return
		sections.push({
			heading: current.heading,
			anchor: current.anchor,
			text: stripMarkdown(current.lines.join("\n")).slice(0, SECTION_CHAR_CAP),
		})
	}

	for (const line of md.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
		if (marker) {
			if (!fence) fence = marker
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
		}
		const match = fence || marker ? null : /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
		if (!match) {
			;(current ? current.lines : introLines).push(line)
			continue
		}
		const heading = cleanHeading(match[2])
		const key = normalize(heading)
		const found = rendered.findIndex((h, i) => i >= cursor && normalize(h.text) === key)
		let anchor = slugify(heading)
		if (found !== -1) {
			anchor = rendered[found].slug
			cursor = found + 1
		}
		flush()
		current = { heading, anchor, lines: [] }
	}
	flush()

	return { intro: stripMarkdown(introLines.join("\n")).slice(0, SECTION_CHAR_CAP), sections }
}

/** Flatten docs into page + section rows for matching. */
export function toRecords(docs: ReadonlyArray<SearchDoc>): SearchRecord[] {
	return docs.flatMap((doc) => [
		{ doc, url: doc.url, heading: doc.title, text: `${doc.description} ${doc.intro}` },
		...doc.sections.map((section) => ({
			doc,
			section,
			url: `${doc.url}#${section.anchor}`,
			heading: section.heading,
			text: section.text,
		})),
	])
}

const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"to",
	"how",
	"do",
	"i",
	"in",
	"of",
	"for",
	"is",
	"my",
	"and",
	"or",
	"on",
])

export function queryTerms(query: string): string[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)
	const meaningful = terms.filter((t) => !STOPWORDS.has(t))
	return meaningful.length > 0 ? meaningful : terms
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Matches the term at the start of a word, so "log" hits "logs" but not "catalog". */
export const termPattern = (term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, "iu")

const globalPattern = (pattern: RegExp) => new RegExp(pattern.source, "giu")

function snippetAround(text: string, pattern: RegExp): string {
	const match = pattern.exec(text)
	if (!match) return ""
	const at = match.index + match[1].length
	const start = Math.max(0, at - 40)
	const end = Math.min(text.length, at + 110)
	return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
}

/**
 * Exact word-prefix search: every term must appear in the row's page title,
 * heading or text. Heading hits outrank body hits, and a page never takes
 * more than `perPage` rows, so one long page cannot crowd out the rest.
 */
export function searchRecords(
	records: ReadonlyArray<SearchRecord>,
	query: string,
	limit = 10,
	perPage = 3,
): SearchHit[] {
	const terms = queryTerms(query)
	if (terms.length === 0) return []
	const patterns = terms.map(termPattern)
	const phrase = terms.length > 1 ? termPattern(terms.join(" ")) : null

	const scored: { hit: SearchHit; score: number }[] = []
	for (const record of records) {
		let score = 0
		let matchedAll = true
		for (const pattern of patterns) {
			const inHeading = pattern.test(record.heading)
			const inTitle = pattern.test(record.doc.title)
			const inText = pattern.test(record.text)
			if (!inHeading && !inTitle && !inText) {
				matchedAll = false
				break
			}
			// Repeat mentions (capped) separate the section about a term from one that names it once.
			const mentions = inText ? Math.min(record.text.match(globalPattern(pattern))?.length ?? 0, 4) : 0
			score += (inHeading ? 6 : 0) + (inTitle ? 3 : 0) + mentions * 0.75
		}
		if (!matchedAll) continue
		if (phrase?.test(record.heading)) score += 8
		else if (phrase?.test(record.text)) score += 3
		// A page row whose title matches is the best landing spot for that page.
		if (!record.section && patterns.every((p) => p.test(record.doc.title))) score += 4
		const bodyPattern =
			phrase && phrase.test(record.text) ? phrase : patterns.find((p) => p.test(record.text))
		const headingOnly = patterns.every((p) => p.test(record.heading))
		scored.push({
			hit: {
				record,
				snippet: headingOnly || !bodyPattern ? "" : snippetAround(record.text, bodyPattern),
			},
			score,
		})
	}

	scored.sort((a, b) => b.score - a.score || a.hit.record.heading.length - b.hit.record.heading.length)
	const perDoc = new Map<string, number>()
	const hits: SearchHit[] = []
	for (const { hit } of scored) {
		const count = perDoc.get(hit.record.doc.id) ?? 0
		if (count >= perPage) continue
		perDoc.set(hit.record.doc.id, count + 1)
		hits.push(hit)
		if (hits.length >= limit) break
	}
	return hits
}
