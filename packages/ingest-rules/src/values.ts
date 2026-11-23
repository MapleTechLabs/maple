import { Option, String as Str } from "effect"
import type { AttrValue } from "./engine"

/** A double as Rust's `{}` prints it: never exponent form, `-0` kept, `inf`/`NaN` spelled out. */
export const formatDouble = (value: number): string => {
	if (Number.isNaN(value)) return "NaN"
	if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf"
	if (Object.is(value, -0)) return "-0"
	const text = String(Math.abs(value))
	if (!Str.includes("e")(text)) return String(value)
	// Shortest round-trip digits, then shifted: `1e+21` is "1000000000000000000000", `1.5e-7` "0.00000015".
	const [mantissa, exponentText = "0"] = Str.split("e")(text)
	const digits = Str.replace(".", "")(mantissa)
	const point = Option.getOrElse(Str.indexOf(".")(mantissa), () => mantissa.length) + Number(exponentText)
	const unsigned =
		point >= digits.length
			? digits + Str.repeat(point - digits.length)("0")
			: point <= 0
				? `0.${Str.repeat(-point)("0")}${digits}`
				: `${Str.slice(0, point)(digits)}.${Str.slice(point)(digits)}`
	return value < 0 ? `-${unsigned}` : unsigned
}

/** The string a value compares as; null for bytes, arrays and kvlists. */
export const comparable = (value: AttrValue): string | null => {
	if (typeof value === "string") return value
	if (typeof value === "number") return formatDouble(value)
	if (typeof value === "bigint") return String(value)
	if (typeof value === "boolean") return value ? "true" : "false"
	return null
}
