import { randomUUID } from "node:crypto"
import type { SourceInsert } from "@maple/db/tables"
import { type OrgId, type PullSourcePlatform, SourceId } from "@maple/domain/primitives"
import { Schema } from "effect"

const decodeSourceIdSync = Schema.decodeUnknownSync(SourceId)

export const newSourceId = () => decodeSourceIdSync(randomUUID())

/** A source Maple creates itself: no token, no rules, no author. */
const systemSourceRow = (
	fields: Pick<SourceInsert, "orgId" | "name" | "platform" | "kind" | "isDefault">,
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
	systemSourceRow(
		{ orgId, name: "Default", platform: "opentelemetry", kind: "default", isDefault: true },
		now,
	)

export interface PullSourceRef {
	readonly platform: PullSourcePlatform
	/** Id of the integration row the source stands for (scrape target, GCP connector, ...). */
	readonly integrationId: string
	readonly name: string
}

/** An integration's source, keyed by its platform and integration row. */
export const pullSourceRow = (orgId: OrgId, ref: PullSourceRef, now: number): SourceInsert => ({
	...systemSourceRow(
		{ orgId, name: ref.name, platform: ref.platform, kind: "integration", isDefault: false },
		now,
	),
	integrationId: ref.integrationId,
})

/** Identity of a pull source within an org. */
export const pullSourceKey = (platform: string, integrationId: string | null) =>
	`${platform}:${integrationId}`
