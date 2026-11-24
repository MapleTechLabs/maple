// W3C `tracestate`, with the OTel JS SDK's parsing, limits and member order
// (newest first). Immutable: `set` and `unset` return a new state.
import type { TraceState as ApiTraceState } from "@opentelemetry/api"

const MAX_ITEMS = 32
const MAX_LENGTH = 512
const KEY_CHAR = "[_0-9a-z-*/]"
const VALID_KEY = new RegExp(
	`^(?:[a-z]${KEY_CHAR}{0,255}|[a-z0-9]${KEY_CHAR}{0,240}@[a-z]${KEY_CHAR}{0,13})$`,
)
const VALID_VALUE = /^[ -~]{0,255}[!-~]$/
const COMMA_OR_EQUALS = /,|=/

const validKey = (key: string): boolean => VALID_KEY.test(key)
const validValue = (value: string): boolean => VALID_VALUE.test(value) && !COMMA_OR_EQUALS.test(value)

/** Members in header order, oldest last; stored reversed so the newest `set` sorts first. */
function parse(raw: string): { state: Map<string, string>; length: number } {
	const entries = new Map<string, string>()
	let length = 0
	for (const member of raw.split(",")) {
		const trimmed = member.trim()
		const split = trimmed.indexOf("=")
		if (split === -1) continue
		const key = trimmed.slice(0, split)
		const value = trimmed.slice(split + 1)
		if (!validKey(key) || !validValue(value)) continue
		const next = length + trimmed.length + (entries.size > 0 ? 1 : 0)
		if (next > MAX_LENGTH) continue
		entries.set(key, value)
		length = next
		if (entries.size >= MAX_ITEMS) break
	}
	return { state: new Map([...entries].reverse()), length }
}

export class TraceState implements ApiTraceState {
	private readonly state: Map<string, string>
	private readonly length: number

	constructor(raw?: string, parsed?: { state: Map<string, string>; length: number }) {
		const { state, length } = parsed ?? parse(typeof raw === "string" ? raw : "")
		this.state = state
		this.length = length
	}

	set(key: string, value: string): TraceState {
		if (!validKey(key) || !validValue(value)) return this
		const current = this.state.get(key)
		let length = this.length
		if (current !== undefined) length += value.length - current.length
		else {
			if (this.state.size >= MAX_ITEMS) return this
			length += key.length + value.length + (this.state.size > 0 ? 2 : 1)
		}
		if (length > MAX_LENGTH) return this
		const state = new Map(this.state)
		state.delete(key)
		state.set(key, value)
		return new TraceState(undefined, { state, length })
	}

	unset(key: string): TraceState {
		const current = this.state.get(key)
		if (current === undefined) return this
		const length = this.length - (key.length + current.length + 1) - (this.state.size > 1 ? 1 : 0)
		const state = new Map(this.state)
		state.delete(key)
		return new TraceState(undefined, { state, length })
	}

	get(key: string): string | undefined {
		return this.state.get(key)
	}

	serialize(): string {
		return [...this.state]
			.reverse()
			.map(([key, value]) => `${key}=${value}`)
			.join(",")
	}
}
