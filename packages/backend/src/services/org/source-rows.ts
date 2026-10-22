import { randomUUID } from "node:crypto"
import type { SourceInsert, SourceRow } from "@maple/db/tables"
import type { SourceTokenStatus } from "@maple/domain/http"
import { type SourceHealthInput, sourceHealth } from "@maple/domain/source-health"
import { type OrgId, type PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import { Schema } from "effect"

const decodeSourceIdSync = Schema.decodeUnknownSync(SourceId)

export const newSourceId = () => decodeSourceIdSync(randomUUID())

/** A source Maple creates itself: no token, no rules, no author. */
const systemSourceRow = (
	fields: Pick<SourceInsert, "orgId" | "name" | "platform" | "kind">,
	now: number,
): SourceInsert => ({
	...fields,
	id: newSourceId(),
	description: null,
	keyHash: null,
	keyPrefix: null,
	allowedSignals: null,
	rateLimitRps: null,
	resourceAttributes: [],
	expiresAt: null,
	rolledAt: null,
	createdAt: now,
	updatedAt: now,
	createdBy: null,
	updatedBy: null,
})

/** The org's default source, standing for its public/private ingest key pair. */
export const defaultSourceRow = (orgId: OrgId, now: number) =>
	systemSourceRow({ orgId, name: "Default", platform: "opentelemetry", kind: "default" }, now)

export interface PullSourceRef {
	readonly platform: PullSourcePlatform
	readonly name: string
}

/** An integration's source; the integration row points at it through `source_id`. */
export const pullSourceRow = (orgId: OrgId, ref: PullSourceRef, now: number): SourceInsert =>
	systemSourceRow({ orgId, name: ref.name, platform: ref.platform, kind: "integration" }, now)

/** A pause with no end, or one that has not ended yet. Mirrors the gateway's pause window. */
export const isPausedAt = (
	source: { readonly pausedAt: number | null; readonly pausedUntil: number | null },
	now: number,
) => source.pausedAt !== null && (source.pausedUntil === null || source.pausedUntil > now)

/** As the gateway applies it: an expired token is rejected even while paused. */
export const statusOf = (
	row: Pick<SourceRow, "expiresAt" | "pausedAt" | "pausedUntil">,
	now: number,
): SourceTokenStatus => {
	if (row.expiresAt !== null && row.expiresAt <= now) return "expired"
	if (isPausedAt(row, now)) return "paused"
	return "active"
}

/** What a source's integration says about its health beyond the row (a scrape target's cadence). */
export type SourceHealthOverrides = Pick<SourceHealthInput, "turnedOff" | "staleAfterMs">

/** The `sources` columns health reads: no token or secret column. */
export const SOURCE_HEALTH_COLUMNS = [
	"id",
	"platform",
	"expiresAt",
	"pausedAt",
	"pausedUntil",
	"lastUsedAt",
	"lastRejectedAt",
	"lastRejection",
	"lastPollOkAt",
	"lastPollError",
	"disconnectedAt",
	"pollResources",
] as const

/** A source's health from its row and what its integration adds. */
export const sourceRowHealth = (
	row: Pick<SourceRow, (typeof SOURCE_HEALTH_COLUMNS)[number]>,
	now: number,
	overrides: SourceHealthOverrides = {},
) => sourceHealth({ ...row, status: statusOf(row, now), ...overrides }, now)
