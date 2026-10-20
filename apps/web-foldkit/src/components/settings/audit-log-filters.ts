import type { AuditActorType, AuditOutcome } from "@maple/domain/http"

export interface AuditLogSearch {
	readonly range?: string
	readonly since?: string
	readonly until?: string
	readonly actor?: string
	readonly actor_type?: string
	readonly outcome?: string
}

/** Every key present, unset ones `undefined`, so spreading it over the search clears them. */
export interface AuditLogSearchUpdate {
	readonly range: string | undefined
	readonly since: string | undefined
	readonly until: string | undefined
	readonly actor: string | undefined
	readonly actor_type: string | undefined
	readonly outcome: string | undefined
}

export const AUDIT_RANGE_PRESETS = [
	{ value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
	{ value: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
	{ value: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
	{ value: "90d", label: "Last 90 days", ms: 90 * 24 * 60 * 60 * 1000 },
] as const

export type AuditRangePreset = (typeof AUDIT_RANGE_PRESETS)[number]["value"]

const ACTOR_TYPES: ReadonlyArray<AuditActorType> = ["user", "api_key", "agent", "system"]
const OUTCOMES: ReadonlyArray<AuditOutcome> = ["allowed", "denied"]

/** The window: a rolling preset, a fixed `since`/`until` pair, or everything. */
export type AuditDateRange =
	| { readonly kind: "all" }
	| { readonly kind: "preset"; readonly preset: AuditRangePreset }
	| { readonly kind: "custom"; readonly since?: string | undefined; readonly until?: string | undefined }

export interface AuditLogFilters {
	readonly range: AuditDateRange
	readonly actorId?: string | undefined
	readonly actorType?: AuditActorType | undefined
	readonly outcome?: AuditOutcome | undefined
}

// The API takes explicit-UTC ISO timestamps only; anything else would be a 400.
const isIsoTimestamp = (value: string | undefined): value is string =>
	value !== undefined && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(value) && !Number.isNaN(Date.parse(value))

// Actor ids the app writes: Clerk `user_…`, public `key_…` and `actor_…` ids (base58 bodies).
const isActorId = (value: string | undefined): value is string =>
	value !== undefined && /^(?:user|key|actor)_[A-Za-z0-9]+$/.test(value)

/** Narrow the raw search params to filters the API accepts, dropping anything malformed. */
export function parseAuditLogSearch(search: AuditLogSearch): AuditLogFilters {
	const preset = AUDIT_RANGE_PRESETS.find((option) => option.value === search.range)
	const since = isIsoTimestamp(search.since) ? search.since : undefined
	const until = isIsoTimestamp(search.until) ? search.until : undefined
	const range: AuditDateRange =
		preset !== undefined
			? { kind: "preset", preset: preset.value }
			: since !== undefined || until !== undefined
				? { kind: "custom", since, until }
				: { kind: "all" }
	return {
		range,
		actorId: isActorId(search.actor) ? search.actor : undefined,
		actorType: ACTOR_TYPES.find((type) => type === search.actor_type),
		outcome: OUTCOMES.find((value) => value === search.outcome),
	}
}

/** Write filters back as search params; unset ones are `undefined` so the URL drops them. */
export function auditLogSearchFrom(filters: AuditLogFilters): AuditLogSearchUpdate {
	const { range } = filters
	return {
		range: range.kind === "preset" ? range.preset : undefined,
		since: range.kind === "custom" ? range.since : undefined,
		until: range.kind === "custom" ? range.until : undefined,
		actor: filters.actorId,
		actor_type: filters.actorType,
		outcome: filters.outcome,
	}
}

/** Just the audit filters out of a search object, for links that should keep them. */
export function pickAuditLogSearch(search: AuditLogSearch): AuditLogSearchUpdate {
	return auditLogSearchFrom(parseAuditLogSearch(search))
}

/** The `since`/`until` bounds a range resolves to at `now`. */
export function resolveAuditDateRange(
	range: AuditDateRange,
	now: number,
): { readonly since: string | undefined; readonly until: string | undefined } {
	if (range.kind === "custom") return { since: range.since, until: range.until }
	const preset =
		range.kind === "preset"
			? AUDIT_RANGE_PRESETS.find((option) => option.value === range.preset)
			: undefined
	return {
		since: preset === undefined ? undefined : new Date(now - preset.ms).toISOString(),
		until: undefined,
	}
}

export function hasAuditLogFilters(filters: AuditLogFilters): boolean {
	return (
		filters.range.kind !== "all" ||
		filters.actorId !== undefined ||
		filters.actorType !== undefined ||
		filters.outcome !== undefined
	)
}
