/** Decimal strings bounded without rounding through a JavaScript number. */
const magnitudePattern = (maximum: bigint): string => {
	const digits = maximum.toString()
	const alternatives = ["0", `[1-9][0-9]{0,${digits.length - 2}}`]
	// For equal-length strings, the first differing digit must be smaller.
	for (let index = 0; index < digits.length; index++) {
		const minimumDigit = index === 0 ? 1 : 0
		const lastDigit = Number(digits[index]) - 1
		if (lastDigit < minimumDigit) continue
		const digit = lastDigit === minimumDigit ? String(lastDigit) : `[${minimumDigit}-${lastDigit}]`
		const remaining = digits.length - index - 1
		alternatives.push(`${digits.slice(0, index)}${digit}${remaining === 0 ? "" : `[0-9]{${remaining}}`}`)
	}
	alternatives.push(digits)
	return `(?:${alternatives.join("|")})`
}

export const INT64_MIN = -(1n << 63n)
export const INT64_MAX = (1n << 63n) - 1n
// Preserve the existing spelling of zero, including -0; reject leading zeroes.
export const DECIMAL_INT64_PATTERN = new RegExp(
	`^(?:${magnitudePattern(INT64_MAX)}|-${magnitudePattern(-INT64_MIN)})$`,
)

// Gregorian leap years: divisible by four, except centuries not divisible by 400.
const leapYear = "(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)"
const ordinaryDate =
	"[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))"
const hour = "(?:[01][0-9]|2[0-3])"
const minuteOrSecond = "[0-5][0-9]"
/** The v1 RFC 3339 subset, enforced even by validators that ignore format annotations. */
export const RFC3339_TIMESTAMP_PATTERN = new RegExp(
	`^(?:${ordinaryDate}|${leapYear}-02-29)T${hour}:${minuteOrSecond}:${minuteOrSecond}(?:\\.[0-9]{1,9})?(?:Z|[+-]${hour}:${minuteOrSecond})$`,
)
