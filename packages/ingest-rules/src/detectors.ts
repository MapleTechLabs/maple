import type { IngestRuleDetector } from "@maple/domain/ingest-rules"

// Detector regexes and post-checks, character for character the table in docs/ingest-rules.md.
// ASCII classes and bounded quantifiers only, so the Rust engine matches the same text.

interface Detector {
	readonly regex: RegExp
	readonly accept: (text: string, start: number, end: number) => boolean
}

const isAsciiAlnum = (char: string | undefined) => char !== undefined && /^[A-Za-z0-9]$/.test(char)
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9"
const bounded = (text: string, start: number, end: number) =>
	!isAsciiAlnum(text[start - 1]) && !isAsciiAlnum(text[end])
const digitsOf = (match: string) => match.replace(/[^0-9]/g, "")

const luhn = (digits: string): boolean => {
	const sum = Array.from(digits)
		.reverse()
		.reduce((total, char, index) => {
			const doubled = index % 2 === 1 ? Number(char) * 2 : Number(char)
			return total + (doubled > 9 ? doubled - 9 : doubled)
		}, 0)
	return sum % 10 === 0
}

const ibanValid = (raw: string): boolean => {
	const compact = raw.replace(/ /g, "")
	const rotated = compact.slice(4) + compact.slice(0, 4)
	const remainder = Array.from(rotated).reduce((acc, char) => {
		const code = isDigit(char) ? char : String(char.charCodeAt(0) - 55)
		return Array.from(code).reduce((inner, digit) => (inner * 10 + Number(digit)) % 97, acc)
	}, 0)
	return remainder === 1
}

const isIpv6Address = (match: string): boolean => {
	const colons = match.split(":").length - 1
	const doubles = match.split("::").length - 1
	const hasHex = /[0-9A-Fa-f]/.test(match)
	if (!hasHex) return false
	if (doubles === 1) return colons <= 7
	return doubles === 0 && colons === 7
}

const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])"

export const DETECTORS = {
	email: {
		regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/gu,
		accept: () => true,
	},
	credit_card: {
		regex: /[0-9](?:[ -]?[0-9]){12,18}/gu,
		accept: (text, start, end) => {
			const digits = digitsOf(text.slice(start, end))
			return bounded(text, start, end) && digits.length >= 13 && digits.length <= 19 && luhn(digits)
		},
	},
	jwt: {
		regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu,
		accept: () => true,
	},
	api_token: {
		regex: /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|[Bb]earer [A-Za-z0-9._~+/=-]{8,}/gu,
		accept: bounded,
	},
	ipv4: {
		regex: new RegExp(`(?:${OCTET}\\.){3}${OCTET}`, "gu"),
		accept: (text, start, end) =>
			bounded(text, start, end) &&
			text[start - 1] !== "." &&
			!(text[end] === "." && isDigit(text[end + 1])),
	},
	ipv6: {
		regex: /[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}/gu,
		accept: (text, start, end) =>
			bounded(text, start, end) &&
			text[start - 1] !== ":" &&
			text[end] !== ":" &&
			isIpv6Address(text.slice(start, end)),
	},
	phone: {
		regex: /\+[0-9][0-9 ().-]{6,18}[0-9]|\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}/gu,
		accept: (text, start, end) => {
			const digits = digitsOf(text.slice(start, end)).length
			return bounded(text, start, end) && digits >= 10 && digits <= 15
		},
	},
	iban: {
		regex: /[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?/gu,
		accept: (text, start, end) => bounded(text, start, end) && ibanValid(text.slice(start, end)),
	},
} satisfies Record<IngestRuleDetector, Detector>

export interface Span {
	readonly start: number
	readonly end: number
}

/** Accepted, non-overlapping matches. A rejected candidate resumes the search one character on. */
export const findAll = (regex: RegExp, text: string, accept: Detector["accept"]): ReadonlyArray<Span> => {
	const spans: Array<Span> = []
	regex.lastIndex = 0
	let match = regex.exec(text)
	while (match !== null) {
		const start = match.index
		const end = start + match[0].length
		if (end === start) {
			regex.lastIndex = start + 1
		} else if (accept(text, start, end)) {
			spans.push({ start, end })
			regex.lastIndex = end
		} else {
			regex.lastIndex = start + 1
		}
		match = regex.exec(text)
	}
	return spans
}
