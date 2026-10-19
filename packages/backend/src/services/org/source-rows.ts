import { randomUUID } from "node:crypto"
import type { SourceInsert } from "@maple/db/tables"
import { type OrgId, SourceId } from "@maple/domain/primitives"
import { Schema } from "effect"

const decodeSourceIdSync = Schema.decodeUnknownSync(SourceId)

export const newSourceId = () => decodeSourceIdSync(randomUUID())

/** A source Maple creates itself: no token, no rules, no author. */
const systemSourceRow = (
	fields: Pick<SourceInsert, "orgId" | "name" | "platform" | "isDefault">,
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
	systemSourceRow({ orgId, name: "Default", platform: "opentelemetry", isDefault: true }, now)
