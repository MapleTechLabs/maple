// Columns whose numeric cells are identifiers, not quantities: grouping them
// ("2,026", "1,234") or rounding them (UInt64 ids past 2^53) corrupts them.
const IDENTIFIER_WORDS = new Set([
	"id",
	"ids",
	"uuid",
	"sha",
	"hash",
	"number",
	"num",
	"no",
	"year",
	"pr",
	"trace",
	"span",
	"code",
	"port",
	"version",
])

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/

export function isIdentifierHeader(header: string | undefined): boolean {
	if (header === undefined) return false
	if (header.includes("#")) return true
	const words = header
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
	return words.some((word) => IDENTIFIER_WORDS.has(word))
}

/** Group digits only for plain decimal quantities that survive a round-trip through `Number`. */
export function formatCell(value: string, header?: string): string {
	const trimmed = value.trim()
	if (!DECIMAL.test(trimmed) || isIdentifierHeader(header)) return value
	const num = Number(trimmed)
	if (Number.isInteger(num)) return Number.isSafeInteger(num) ? num.toLocaleString() : value
	return num.toLocaleString(undefined, { maximumFractionDigits: 4 })
}
