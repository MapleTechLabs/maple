import type { Schema } from "effect"
import type { CallLogEntry } from "../contract.ts"

/**
 * Behavioral parity: every call the fixture backend answers, keyed by the `x-parity-capture` id.
 * Payloads are normalized so two apps that make the same call produce the same entry.
 */

const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const V4_UUID_INSIDE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi

/**
 * Sorted keys, `undefined` fields dropped, v4 UUIDs replaced by `<random-uuid>`, other non-JSON
 * values as `null` (what JSON.stringify writes). Timestamps are left alone: the browser clock is
 * frozen, so a timestamp that differs is a real difference.
 */
export const normalizePayload = (value: unknown): Schema.Json => {
	if (typeof value === "string")
		return V4_UUID.test(value) ? "<random-uuid>" : value.replace(V4_UUID_INSIDE, "<random-uuid>")
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value
	if (Array.isArray(value)) return value.map(normalizePayload)
	if (typeof value === "object") {
		const entries = Object.entries(value)
			.filter(([, field]) => field !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, field]) => [key, normalizePayload(field)] as const)
		return Object.fromEntries(entries)
	}
	return null
}

export interface CallLog {
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- any decoded request part; normalizePayload parses it
	readonly record: (captureId: string | null, tag: string, payload: unknown) => void
	/**
	 * Records `tag` only if this capture has no entry with it yet: for timer-driven polls, whose
	 * count depends on how long a capture takes, not on what the app does.
	 */
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- any decoded request part; normalizePayload parses it
	readonly recordOnce: (captureId: string | null, tag: string, payload: unknown) => void
	readonly recordUnmocked: (captureId: string | null, description: string) => void
	readonly take: (captureId: string) => {
		readonly calls: ReadonlyArray<CallLogEntry>
		readonly unmocked: ReadonlyArray<string>
	}
}

/** Requests without a capture id (a developer browsing the fixture) are answered but not logged. */
export const makeCallLog = (): CallLog => {
	const calls = new Map<string, Array<CallLogEntry>>()
	const unmocked = new Map<string, Array<string>>()
	const push = <A>(map: Map<string, Array<A>>, captureId: string, item: A) => {
		const list = map.get(captureId)
		if (list === undefined) map.set(captureId, [item])
		else list.push(item)
	}
	return {
		record: (captureId, tag, payload) => {
			if (captureId !== null) push(calls, captureId, { tag, payload: normalizePayload(payload) })
		},
		recordOnce: (captureId, tag, payload) => {
			if (captureId === null || calls.get(captureId)?.some((entry) => entry.tag === tag)) return
			push(calls, captureId, { tag, payload: normalizePayload(payload) })
		},
		recordUnmocked: (captureId, description) => {
			if (captureId !== null) push(unmocked, captureId, description)
		},
		take: (captureId) => {
			const taken = { calls: calls.get(captureId) ?? [], unmocked: unmocked.get(captureId) ?? [] }
			calls.delete(captureId)
			unmocked.delete(captureId)
			return taken
		},
	}
}
