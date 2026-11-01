import type { AdvisorySeverity } from "@maple/domain/runtime-advisories"

// CVSS 3.0 / 3.1 base score from a vector string (FIRST's specification, section 7). Advisories
// without a curated severity (most Go ones) only carry the vector.

const WEIGHTS = {
	AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
	AC: { L: 0.77, H: 0.44 },
	UI: { N: 0.85, R: 0.62 },
	CIA: { H: 0.56, L: 0.22, N: 0 },
} as const

/** Privileges Required weighs more when the scope changes. */
const PR_WEIGHTS = {
	U: { N: 0.85, L: 0.62, H: 0.27 },
	C: { N: 0.85, L: 0.68, H: 0.5 },
} as const

const pick = <T extends Record<string, number>>(table: T, key: string | undefined): number | undefined =>
	key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined

/** CVSS 3.1 Roundup: the smallest one-decimal number at or above the input, free of float noise. */
const roundUp = (value: number): number => {
	const scaled = Math.round(value * 100000)
	return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10
}

/** The base score of a `CVSS:3.x/...` vector, undefined for any other or malformed vector. */
export function cvss3BaseScore(vector: string): number | undefined {
	const [prefix, ...parts] = vector.trim().split("/")
	if (prefix !== "CVSS:3.0" && prefix !== "CVSS:3.1") return undefined
	const metrics = new Map(
		parts.flatMap((part) => {
			const [key, value] = part.split(":")
			return key === undefined || value === undefined ? [] : [[key, value] as const]
		}),
	)
	const scope = metrics.get("S")
	if (scope !== "U" && scope !== "C") return undefined
	const av = pick(WEIGHTS.AV, metrics.get("AV"))
	const ac = pick(WEIGHTS.AC, metrics.get("AC"))
	const pr = pick(PR_WEIGHTS[scope], metrics.get("PR"))
	const ui = pick(WEIGHTS.UI, metrics.get("UI"))
	const c = pick(WEIGHTS.CIA, metrics.get("C"))
	const i = pick(WEIGHTS.CIA, metrics.get("I"))
	const a = pick(WEIGHTS.CIA, metrics.get("A"))
	if (
		av === undefined ||
		ac === undefined ||
		pr === undefined ||
		ui === undefined ||
		c === undefined ||
		i === undefined ||
		a === undefined
	)
		return undefined
	const iss = 1 - (1 - c) * (1 - i) * (1 - a)
	const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
	if (impact <= 0) return 0
	const exploitability = 8.22 * av * ac * pr * ui
	return scope === "U"
		? roundUp(Math.min(impact + exploitability, 10))
		: roundUp(Math.min(1.08 * (impact + exploitability), 10))
}

/** The qualitative rating of a base score (CVSS 3.1 table 14); a score of 0 rates low. */
export function severityOfScore(score: number): AdvisorySeverity {
	if (score >= 9) return "critical"
	if (score >= 7) return "high"
	if (score >= 4) return "medium"
	return "low"
}
