import { auditActionLabel, auditResourceLabel } from "@maple/domain/audit-actions"
import type { AuditActorType, AuditOutcome } from "@maple/domain/http"
import { decodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Array as Arr, Option, String as Str } from "effect"

export interface AuditLogSearch {
	readonly range?: string
	readonly since?: string
	readonly until?: string
	readonly actor?: string
	readonly actor_type?: string
	readonly outcome?: string
	readonly kind?: string
	readonly resource_type?: string
	readonly action?: string
	readonly resource?: string
	readonly affected?: string
	readonly request?: string
}

/** Every key present, unset ones `undefined`, so spreading it over the search clears them. */
export interface AuditLogSearchUpdate {
	readonly range: string | undefined
	readonly since: string | undefined
	readonly until: string | undefined
	readonly actor: string | undefined
	readonly actor_type: string | undefined
	readonly outcome: string | undefined
	readonly kind: string | undefined
	readonly resource_type: string | undefined
	readonly action: string | undefined
	readonly resource: string | undefined
	readonly affected: string | undefined
	readonly request: string | undefined
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

/** Which part of the log the list shows. `changes` is the default and stays out of the URL. */
export type AuditLogKind = "changes" | "access" | "all"
const KINDS: ReadonlyArray<AuditLogKind> = ["changes", "access", "all"]

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
	readonly kind?: AuditLogKind | undefined
	readonly resourceType?: string | undefined
	readonly action?: string | undefined
	/** A resource's public id (`dash_…`). */
	readonly resourceId?: string | undefined
	readonly affectedUserId?: string | undefined
	readonly requestId?: string | undefined
}

/** The list's kind, `changes` when the URL names none. */
export const auditLogKindOf = (filters: AuditLogFilters): AuditLogKind => filters.kind ?? "changes"

// The API takes explicit-UTC ISO timestamps only; anything else would be a 400.
const isIsoTimestamp = (value: string | undefined): value is string =>
	value !== undefined && /^\d{4}-\d{2}-\d{2}T.+Z$/.test(value) && !Number.isNaN(Date.parse(value))

// Actor ids the app writes: Clerk `user_…`, public `key_…` and `actor_…` ids (base58 bodies).
const isActorId = (value: string | undefined): value is string =>
	value !== undefined && /^(?:user|key|actor)_[A-Za-z0-9]+$/.test(value)

const isUserId = (value: string | undefined): value is string =>
	value !== undefined && /^user_[A-Za-z0-9]+$/.test(value)

// Public resource ids: a lowercase prefix and a base58 body (`dash_…`, `alrt_…`).
const isPublicId = (value: string | undefined): value is string =>
	value !== undefined && /^[a-z]+_[A-Za-z0-9]{6,}$/.test(value)

// Request ids are Cloudflare ray ids: hex, sometimes with a `-<colo>` suffix.
const isRequestId = (value: string | undefined): value is string =>
	value !== undefined && /^[0-9a-f]{16}(?:-[A-Z]{3})?$/.test(value)

const isKnownAction = (value: string | undefined): value is string =>
	value !== undefined && auditActionLabel(value) !== null

const isKnownResourceType = (value: string | undefined): value is string =>
	value !== undefined && auditResourceLabel(value) !== null

/** Narrow the raw search params to filters the API accepts, dropping anything malformed. */
export function parseAuditLogSearch(search: AuditLogSearch): AuditLogFilters {
	const since = isIsoTimestamp(search.since) ? search.since : undefined
	const until = isIsoTimestamp(search.until) ? search.until : undefined
	const range = Option.match(
		Arr.findFirst(AUDIT_RANGE_PRESETS, (option) => option.value === search.range),
		{
			onSome: (preset): AuditDateRange => ({ kind: "preset", preset: preset.value }),
			onNone: (): AuditDateRange =>
				since !== undefined || until !== undefined
					? { kind: "custom", since, until }
					: { kind: "all" },
		},
	)
	return {
		range,
		actorId: isActorId(search.actor) ? search.actor : undefined,
		actorType: Option.getOrUndefined(Arr.findFirst(ACTOR_TYPES, (type) => type === search.actor_type)),
		outcome: Option.getOrUndefined(Arr.findFirst(OUTCOMES, (value) => value === search.outcome)),
		kind: Option.getOrUndefined(
			Arr.findFirst(KINDS, (value) => value !== "changes" && value === search.kind),
		),
		resourceType: isKnownResourceType(search.resource_type) ? search.resource_type : undefined,
		action: isKnownAction(search.action) ? search.action : undefined,
		resourceId: isPublicId(search.resource) ? search.resource : undefined,
		affectedUserId: isUserId(search.affected) ? search.affected : undefined,
		requestId: isRequestId(search.request) ? search.request : undefined,
	}
}

/** The entry a shared link points at (`?entry=alog_…`), as the internal id rows carry; none if malformed. */
export function linkedAuditEntryId(search: { readonly entry?: string | undefined }): string | null {
	return search.entry === undefined ? null : decodePublicId(PublicIdPrefixes.auditLogEntry, search.entry)
}

/** The filter one pasted value stands for: an id of a known shape, or an action name. */
export type AuditLookup =
	| { readonly key: "actorId"; readonly value: string }
	| { readonly key: "resourceId"; readonly value: string }
	| { readonly key: "requestId"; readonly value: string }
	| { readonly key: "action"; readonly value: string }

/** Read a pasted id or action as the filter it stands for; none for anything else. */
export function parseAuditLookup(raw: string): Option.Option<AuditLookup> {
	const value = Str.trim(raw)
	if (isActorId(value)) return Option.some({ key: "actorId", value })
	if (isRequestId(value)) return Option.some({ key: "requestId", value })
	if (isKnownAction(value)) return Option.some({ key: "action", value })
	if (isPublicId(value)) return Option.some({ key: "resourceId", value })
	return Option.none()
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
		kind: filters.kind === "changes" ? undefined : filters.kind,
		resource_type: filters.resourceType,
		action: filters.action,
		resource: filters.resourceId,
		affected: filters.affectedUserId,
		request: filters.requestId,
	}
}

/** Just the audit filters out of a search object, for links that should keep them. */
export function pickAuditLogSearch(search: AuditLogSearch): AuditLogSearchUpdate {
	return auditLogSearchFrom(parseAuditLogSearch(search))
}

export function hasAuditLogFilters(filters: AuditLogFilters): boolean {
	return (
		filters.range.kind !== "all" ||
		filters.actorId !== undefined ||
		filters.actorType !== undefined ||
		filters.outcome !== undefined ||
		filters.resourceType !== undefined ||
		filters.action !== undefined ||
		filters.resourceId !== undefined ||
		filters.affectedUserId !== undefined ||
		filters.requestId !== undefined
	)
}
