import { Array as Arr, String as Str } from "effect"
import { SEMCONV_RENAME_ROWS } from "@maple/domain/semconv"
// Detects "messed up" span attribute keys in an org's telemetry and turns them into
// recommended ingest attribute mappings. Pure and dependency-free so it runs identically in the
// API reconcile loop (RecommendationIssueService) and in unit tests.
//
// The renames come from the shared semconv table (`./semconv`), span-scoped only: the ingest
// mapping engine writes span target keys and cannot rename resource attributes.

export type RecommendationKind = "rename" | "double-emission" | "naming"

export interface AttributeRecommendation {
	/** Stable dedupe id (e.g. `rename:http.status_code`). */
	id: string
	kind: RecommendationKind
	/** The offending span attribute key. */
	key: string
	/** Present for `rename` and `double-emission` rows. */
	canonical?: string
	reason: string
	/** Usage count of `key` on spans over the scanned window. */
	usageCount: number
	/** Only `rename` rows can be fixed by creating a mapping. */
	applyable: boolean
}

/** The span renames a mapping can apply. */
const ATTRIBUTE_RENAMES = Arr.filter(SEMCONV_RENAME_ROWS, (rename) => rename.scope === "span")

/** How many generic camelCase advisories to surface, to bound noise. */
const NAMING_ADVISORY_LIMIT = 10

const KIND_RANK: Record<RecommendationKind, number> = {
	rename: 0,
	"double-emission": 1,
	naming: 2,
} satisfies Record<RecommendationKind, number>

/** camelCase, non-namespaced key (has an uppercase letter, no dot) — the clear naming violation. */
function isCamelCaseNoDot(key: string): boolean {
	return !Str.includes(".")(key) && /[A-Z]/.test(key)
}

/** Keys Maple reads by exact spelling. `SampleRate` is the span's sampling weight; renaming breaks it. */
const MAPLE_READ_KEYS: ReadonlySet<string> = new Set(["SampleRate"])

/**
 * Canonical keys of the rename rules that fire for `spanKeys` but are missing from it. The caller
 * checks these directly in the warehouse, since a top-N key list can miss a rare canonical key.
 */
export function canonicalKeysToProbe(
	spanKeys: ReadonlyArray<{ attributeKey: string }>,
	existingMappingSourceKeys: ReadonlyArray<string>,
): string[] {
	const present = new Set(Arr.map(spanKeys, (row) => row.attributeKey))
	const suppressed = new Set(existingMappingSourceKeys)
	const keys = Arr.map(
		Arr.filter(
			ATTRIBUTE_RENAMES,
			(rule) =>
				present.has(rule.deprecated) &&
				!suppressed.has(rule.deprecated) &&
				!present.has(rule.canonical),
		),
		(rule) => rule.canonical,
	)
	return [...new Set(keys)].sort()
}

/**
 * Detect recommended attribute mappings from the org's live span attribute keys.
 *
 * @param spanKeys                  Span attribute keys with usage counts (from the warehouse).
 * @param existingMappingSourceKeys Span-scoped `sourceKey`s already covered by a mapping — suppressed.
 * @param dismissedIds              Recommendation ids to suppress (unused server-side; kept for callers
 *                                  that want to filter client-side).
 */
export function detectAttributeRecommendations(
	spanKeys: ReadonlyArray<{ attributeKey: string; usageCount: number }>,
	existingMappingSourceKeys: ReadonlyArray<string>,
	dismissedIds: ReadonlyArray<string> = [],
): AttributeRecommendation[] {
	const present = new Set<string>()
	const usageByKey = new Map<string, number>()
	for (const { attributeKey, usageCount } of spanKeys) {
		present.add(attributeKey)
		usageByKey.set(attributeKey, usageCount)
	}

	const suppressedKeys = new Set(existingMappingSourceKeys)
	const dismissed = new Set(dismissedIds)
	const handledKeys = new Set<string>() // keys already turned into a rename/dual row

	const out: AttributeRecommendation[] = []

	for (const rule of ATTRIBUTE_RENAMES) {
		if (!present.has(rule.deprecated)) continue
		if (suppressedKeys.has(rule.deprecated)) continue
		handledKeys.add(rule.deprecated)

		const usageCount = usageByKey.get(rule.deprecated) ?? 0

		if (present.has(rule.canonical)) {
			// Canonical already exists on spans — a mapping would be a silent no-op (the Rust
			// applier never overwrites an existing target). Surface as a dismiss-only advisory.
			const id = `dual:${rule.deprecated}`
			if (dismissed.has(id)) continue
			out.push({
				id,
				kind: "double-emission",
				key: rule.deprecated,
				canonical: rule.canonical,
				reason: `Spans emit both ${rule.deprecated} and ${rule.canonical}. Standardize on ${rule.canonical} in your SDK — a mapping can't merge them, the canonical key already exists.`,
				usageCount,
				applyable: false,
			})
			continue
		}

		const id = `rename:${rule.deprecated}`
		if (dismissed.has(id)) continue
		out.push({
			id,
			kind: "rename",
			key: rule.deprecated,
			canonical: rule.canonical,
			reason: rule.reason,
			usageCount,
			applyable: true,
		})
	}

	// Generic naming advisories: camelCase, non-namespaced keys we can't confidently map.
	const namingCandidates: AttributeRecommendation[] = []
	for (const { attributeKey, usageCount } of spanKeys) {
		if (handledKeys.has(attributeKey)) continue
		if (suppressedKeys.has(attributeKey)) continue
		if (!isCamelCaseNoDot(attributeKey)) continue
		if (MAPLE_READ_KEYS.has(attributeKey)) continue
		const id = `naming:${attributeKey}`
		if (dismissed.has(id)) continue
		namingCandidates.push({
			id,
			kind: "naming",
			key: attributeKey,
			reason: "Non-conforming key name — OpenTelemetry attributes use lowercase dotted.snake_case. Consider renaming at the SDK.",
			usageCount,
			applyable: false,
		})
	}
	namingCandidates.sort((a, b) =>
		b.usageCount !== a.usageCount ? b.usageCount - a.usageCount : Str.localeCompare(b.key)(a.key),
	)
	out.push(...namingCandidates.slice(0, NAMING_ADVISORY_LIMIT))

	out.sort((a, b) => {
		const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind]
		if (byKind !== 0) return byKind
		if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount
		return Str.localeCompare(b.key)(a.key)
	})

	return out
}

// Reconcile planning — pure decision logic for persisting recommendations as durable issues.
// Kept separate from IO so it can be unit-tested without a warehouse or database.

export type RecommendationIssueStatus = "open" | "dismissed" | "applied" | "resolved"

/** Minimal shape `planReconcileIssues` needs from a stored issue row. */
export interface ExistingIssueLike {
	id: string
	number: number
	recommendationKey: string
	sourceKey: string
	status: RecommendationIssueStatus
}

export interface PlannedIssueInsert {
	number: number
	recommendationKey: string
	kind: RecommendationKind
	sourceKey: string
	canonicalKey: string | null
	usageCount: number
}

export interface PlannedIssueUpdate {
	id: string
	/** Refreshed usage; absent when the issue is no longer detected. */
	usageCount?: number
	/** Status transition; absent means keep the current status. */
	nextStatus?: "open" | "applied" | "resolved"
}

export interface ReconcilePlan {
	inserts: PlannedIssueInsert[]
	updates: PlannedIssueUpdate[]
}

/**
 * Diff freshly-detected recommendations against stored issues:
 *  - newly detected            → insert as `open` with the next per-org number
 *  - detected + already stored  → refresh usage; a `resolved` row that's back → reopen
 *  - stored + no longer detected → an `open` row becomes `applied` (a mapping now covers the key)
 *                                  or `resolved` (fixed at the SDK); other statuses are left as-is
 *                                  (a user's dismissal sticks).
 */
export function planReconcileIssues(
	detected: ReadonlyArray<AttributeRecommendation>,
	existing: ReadonlyArray<ExistingIssueLike>,
	mappingSourceKeys: ReadonlyArray<string>,
): ReconcilePlan {
	const detectedByKey = new Map(Arr.map(detected, (rec) => [rec.id, rec] as const))
	const existingByKey = new Map(Arr.map(existing, (row) => [row.recommendationKey, row] as const))
	const mappingSet = new Set(mappingSourceKeys)

	let nextNumber = Arr.reduce(existing, 0, (max, row) => Math.max(max, row.number)) + 1

	const inserts: PlannedIssueInsert[] = []
	const updates: PlannedIssueUpdate[] = []

	for (const rec of detected) {
		const row = existingByKey.get(rec.id)
		if (!row) {
			inserts.push({
				number: nextNumber++,
				recommendationKey: rec.id,
				kind: rec.kind,
				sourceKey: rec.key,
				canonicalKey: rec.canonical ?? null,
				usageCount: rec.usageCount,
			})
			continue
		}
		updates.push({
			id: row.id,
			usageCount: rec.usageCount,
			nextStatus: row.status === "resolved" ? "open" : undefined,
		})
	}

	for (const row of existing) {
		if (detectedByKey.has(row.recommendationKey)) continue
		if (row.status !== "open") continue
		updates.push({
			id: row.id,
			nextStatus: mappingSet.has(row.sourceKey) ? "applied" : "resolved",
		})
	}

	return { inserts, updates }
}
