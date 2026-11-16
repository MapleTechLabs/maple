import { Option, String as Str } from "effect"

/**
 * Format a double the way Rust's `f64::to_string()` (the `Display` impl) does:
 * the shortest round-trip decimal, but NEVER in scientific notation. JS's
 * `String(num)` produces the same shortest mantissa but switches to `e`
 * notation for large/small magnitudes, so we expand any exponent into a plain
 * decimal string.
 */
export function formatDouble(num: number): string {
	if (Number.isNaN(num)) {
		return "NaN"
	}
	if (num === Infinity) {
		return "inf"
	}
	if (num === -Infinity) {
		return "-inf"
	}
	// Distinguish -0.0 (Rust prints "-0").
	if (num === 0) {
		return Object.is(num, -0) ? "-0" : "0"
	}
	const s = String(num)
	return Option.match(Str.indexOf("e")(s), {
		onNone: () => s,
		onSome: (eIndex) => expandExponential(s, eIndex),
	})
}

function expandExponential(s: string, eIndex: number): string {
	let mantissa = Str.slice(0, eIndex)(s)
	const exp = parseInt(Str.slice(eIndex + 1)(s), 10)

	let sign = ""
	if (Str.startsWith("-")(mantissa)) {
		sign = "-"
		mantissa = Str.slice(1)(mantissa)
	} else if (Str.startsWith("+")(mantissa)) {
		mantissa = Str.slice(1)(mantissa)
	}

	const dot = Str.indexOf(".")(mantissa)
	let intPart: string
	let fracPart: string
	if (Option.isNone(dot)) {
		intPart = mantissa
		fracPart = ""
	} else {
		intPart = Str.slice(0, dot.value)(mantissa)
		fracPart = Str.slice(dot.value + 1)(mantissa)
	}

	// Combine into a single digit string with a tracked decimal-point position.
	const digits = intPart + fracPart
	// Position of the decimal point measured from the start of `digits`.
	let pointPos = intPart.length + exp

	let result: string
	if (pointPos <= 0) {
		result = "0." + Str.repeat(-pointPos)("0") + digits
	} else if (pointPos >= digits.length) {
		result = digits + Str.repeat(pointPos - digits.length)("0")
	} else {
		result = Str.slice(0, pointPos)(digits) + "." + Str.slice(pointPos)(digits)
	}

	// Trim redundant trailing zeros in any fractional part and a dangling dot.
	if (Str.includes(".")(result)) {
		result = Str.replace(/\.$/, "")(Str.replace(/0+$/, "")(result))
	}
	return sign + result
}
