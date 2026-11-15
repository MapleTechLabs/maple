import { lookup } from "./lookup"

const UNIT_MS = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
	y: 31_536_000_000,
} satisfies Record<string, number>

const UNIT_ORDER = ["y", "w", "d", "h", "m", "s", "ms"]

const DURATION_PART = /(\d+)(ms|y|w|d|h|m|s)/g

/** A Prometheus duration (`1h30m`, `5m`, `250ms`) or a plain number of seconds, in ms. Undefined when invalid. */
export const parseDurationMs = (text: string): number | undefined => {
	if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
	if (!/^(\d+(ms|y|w|d|h|m|s))+$/.test(text)) return undefined
	let total = 0
	let lastUnit = -1
	for (const match of text.matchAll(DURATION_PART)) {
		const unit = match[2] ?? ""
		const order = UNIT_ORDER.indexOf(unit)
		// Units must appear largest first, each at most once.
		if (order <= lastUnit) return undefined
		lastUnit = order
		total += Number(match[1]) * (lookup(UNIT_MS, unit) ?? 0)
	}
	return total
}

/** Prometheus' canonical spelling of a duration, the inverse of `parseDurationMs`. */
export const formatDuration = (ms: number): string => {
	if (ms === 0) return "0s"
	let rest = ms
	let out = ""
	for (const unit of UNIT_ORDER) {
		const size = lookup(UNIT_MS, unit) ?? 1
		const count = Math.floor(rest / size)
		if (count > 0) {
			out += `${count}${unit}`
			rest -= count * size
		}
	}
	return out
}

/** A number literal: decimal, hex, Inf/NaN, or a duration read as seconds. */
export const parseNumber = (text: string): number | undefined => {
	const lower = text.toLowerCase()
	if (lower === "inf" || lower === "+inf") return Number.POSITIVE_INFINITY
	if (lower === "-inf") return Number.NEGATIVE_INFINITY
	if (lower === "nan") return Number.NaN
	if (/^0x[0-9a-f]+$/.test(lower)) return Number.parseInt(lower.slice(2), 16)
	if (/^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?$/.test(lower) || /^[0-9]+\.$/.test(lower)) return Number(lower)
	const duration = parseDurationMs(text)
	return duration === undefined ? undefined : duration / 1000
}

const SIMPLE_ESCAPES = {
	a: "\x07",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	'"': '"',
	"'": "'",
} satisfies Record<string, string>

/** Unquote a PromQL string literal (Go rules: `"..."`, `'...'`, or raw backticks). */
export const unquote = (text: string): string | undefined => {
	const quote = text[0]
	if (text.length < 2 || text[text.length - 1] !== quote) return undefined
	const body = text.slice(1, -1)
	if (quote === "`") return body
	if (quote !== '"' && quote !== "'") return undefined
	let out = ""
	// `\x` and octal escapes are bytes, as in Go: runs of them decode together as UTF-8.
	let bytes: number[] = []
	const flush = () => {
		if (bytes.length > 0) out += new TextDecoder().decode(new Uint8Array(bytes))
		bytes = []
	}
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] ?? ""
		const next = body[i + 1] ?? ""
		if (ch === "\\" && next === "x") {
			const hex = body.slice(i + 2, i + 4)
			if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined
			bytes.push(Number.parseInt(hex, 16))
			i += 3
			continue
		}
		const octal = body.slice(i + 1, i + 4)
		if (ch === "\\" && /^[0-7]{3}$/.test(octal)) {
			const byte = Number.parseInt(octal, 8)
			if (byte > 255) return undefined
			bytes.push(byte)
			i += 3
			continue
		}
		flush()
		if (ch !== "\\") {
			out += ch
			continue
		}
		const simple = lookup(SIMPLE_ESCAPES, next)
		if (simple !== undefined) {
			out += simple
			i += 1
			continue
		}
		const hexLength = next === "u" ? 4 : next === "U" ? 8 : 0
		if (hexLength === 0) return undefined
		const hex = body.slice(i + 2, i + 2 + hexLength)
		if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== hexLength) return undefined
		const codePoint = Number.parseInt(hex, 16)
		// Above U+10FFFF, or a surrogate, is not a character.
		if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined
		out += String.fromCodePoint(codePoint)
		i += 1 + hexLength
	}
	flush()
	return out
}
