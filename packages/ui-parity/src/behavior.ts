import type { CallLogEntry } from "./contract.ts"

/**
 * Behavioral parity (call logs) and accessibility parity (ARIA snapshots) between two captures.
 * Both are compared as multisets: legacy and Foldkit fire concurrent queries in different orders,
 * and ARIA trees nest through different wrappers, so only what was sent or exposed counts.
 */

/**
 * Background traffic whose count and timing depend on how long a capture ran, not on what the user
 * did. Entries are prefixes of `CallLogEntry.tag`.
 * - IGNORED_CALLS are never compared.
 * - PRESENCE_ONLY_CALLS only have to be sent at least once by both apps (or by neither).
 * Both start empty: add an entry only with a reason next to it.
 */
export const IGNORED_CALLS: ReadonlyArray<string> = []
export const PRESENCE_ONLY_CALLS: ReadonlyArray<string> = []

const matches = (list: ReadonlyArray<string>, key: string) => list.some((prefix) => key.startsWith(prefix))

// Version-4 ids are minted by the app (`crypto.randomUUID`); fixture ids are deterministic.
const RANDOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Sorted keys, app-minted ids replaced by a placeholder, so equal payloads serialize equally. */
const normalize = (value: unknown): unknown => {
	if (typeof value === "string") return RANDOM_UUID.test(value) ? "<random-uuid>" : value
	if (Array.isArray(value)) return value.map(normalize)
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, normalize(Reflect.get(value, key))]),
		)
	return value
}

/** First path where two normalized values differ: `.content`, `.attachmentIds[1]`, `` for the root. */
const firstDifference = (a: unknown, b: unknown, path = ""): string | undefined => {
	if (JSON.stringify(a) === JSON.stringify(b)) return undefined
	if (Array.isArray(a) && Array.isArray(b)) {
		for (let index = 0; index < Math.max(a.length, b.length); index++) {
			const found = firstDifference(a[index], b[index], `${path}[${index}]`)
			if (found !== undefined) return found
		}
		return path
	}
	if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
		for (const key of keys) {
			const found = firstDifference(
				Reflect.get(a, key),
				Reflect.get(b, key),
				`${path}.${key}`,
			)
			if (found !== undefined) return found
		}
	}
	return path
}

const SENT = "(sent)"

const groupCalls = (calls: ReadonlyArray<CallLogEntry>, ignoreBackground: boolean) => {
	const groups = new Map<string, string[]>()
	for (const call of calls) {
		const key = call.tag
		if (matches(IGNORED_CALLS, key)) continue
		if (matches(PRESENCE_ONLY_CALLS, key)) {
			if (!ignoreBackground) groups.set(key, [SENT])
		} else groups.set(key, [...(groups.get(key) ?? []), JSON.stringify(normalize(call.payload))])
	}
	for (const payloads of groups.values()) payloads.sort()
	return groups
}

/** Removes the payloads both sides share, leaving what only each side sent. */
const unmatched = (baseline: ReadonlyArray<string>, candidate: ReadonlyArray<string>) => {
	const counts = new Map<string, number>()
	for (const item of candidate) counts.set(item, (counts.get(item) ?? 0) + 1)
	const onlyBaseline: string[] = []
	for (const item of baseline) {
		const left = counts.get(item) ?? 0
		if (left) counts.set(item, left - 1)
		else onlyBaseline.push(item)
	}
	const onlyCandidate = candidate.filter((item) => {
		const left = counts.get(item) ?? 0
		if (left) counts.set(item, left - 1)
		return left > 0
	})
	return { onlyBaseline, onlyCandidate }
}

/**
 * One readable line per difference, e.g. `alerts.listRules payload differs at .limit`.
 * `ignoreBackground` drops PRESENCE_ONLY_CALLS too: lab pages may boot without the app root, so
 * their background traffic legitimately differs there.
 */
export const diffCallLogs = (
	baseline: ReadonlyArray<CallLogEntry>,
	candidate: ReadonlyArray<CallLogEntry>,
	options: { readonly ignoreBackground?: boolean; readonly ignore?: ReadonlyArray<string> } = {},
): string[] => {
	const ignore = options.ignore ?? []
	const kept = (calls: ReadonlyArray<CallLogEntry>) => calls.filter((call) => !matches(ignore, call.tag))
	const base = groupCalls(kept(baseline), options.ignoreBackground ?? false)
	const cand = groupCalls(kept(candidate), options.ignoreBackground ?? false)
	const lines: string[] = []
	for (const key of [...new Set([...base.keys(), ...cand.keys()])].sort()) {
		const a = base.get(key) ?? []
		const b = cand.get(key) ?? []
		if (!b.length)
			lines.push(
				`${key} not sent (${a[0] === SENT ? "baseline sends it" : `${a.length}× in baseline`})`,
			)
		else if (!a.length)
			lines.push(`${key} sent${b[0] === SENT ? "" : ` ${b.length}×`}, never in baseline`)
		else {
			const { onlyBaseline, onlyCandidate } = unmatched(a, b)
			if (a.length !== b.length) lines.push(`${key} sent ${b.length}×, ${a.length}× in baseline`)
			for (let index = 0; index < Math.min(onlyBaseline.length, onlyCandidate.length); index++) {
				const path = firstDifference(
					JSON.parse(onlyBaseline[index]!),
					JSON.parse(onlyCandidate[index]!),
				)
				lines.push(`${key} payload differs at ${path || "(root)"}`)
			}
		}
	}
	return lines
}

export interface AriaDelta {
	/** ARIA snapshot lines (indentation stripped) present only in the baseline. */
	readonly missing: ReadonlyArray<string>
	/** Lines present only in the candidate. */
	readonly extra: ReadonlyArray<string>
}

const ariaLines = (snapshot: string) =>
	snapshot
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)

export const diffAria = (baseline: string, candidate: string): AriaDelta => {
	const { onlyBaseline, onlyCandidate } = unmatched(ariaLines(baseline), ariaLines(candidate))
	return { missing: onlyBaseline, extra: onlyCandidate }
}

/** The role an ARIA snapshot line describes (`- button "Send"` → `button`, `- /url: /x` → `/url`). */
export const ariaRole = (line: string) => line.replace(/^- /, "").match(/^\/?[\w-]+/)?.[0] ?? line
