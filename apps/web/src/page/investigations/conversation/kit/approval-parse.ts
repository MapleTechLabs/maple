import { Option, Schema, Array as Arr } from "effect"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
export type ParseResult = { ok: true; value: unknown } | { ok: false }

export function safeParseJson(value: unknown): ParseResult {
	if (typeof value !== "string" || value.length === 0) return { ok: false }
	return Option.match(decodeJson(value), {
		onNone: (): ParseResult => ({ ok: false }),
		onSome: (parsed): ParseResult => ({ ok: true, value: parsed }),
	})
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value && typeof value === "object" && !Arr.isArray(value)) {
		return value as Record<string, unknown>
	}
	return undefined
}

export function asArray(value: unknown): unknown[] | undefined {
	return Arr.isArray(value) ? value : undefined
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}
