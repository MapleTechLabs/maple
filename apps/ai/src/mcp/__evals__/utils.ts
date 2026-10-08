import { Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"

/** Stable identifiers used across eval prompts + fixtures. */
export const FIXTURES = {
	orgId: "org_eval",
	service: "api",
	traceId: "0af7651916cd43dd8448eb211c80319c",
	spanId: "b7ad6b7169203331",
	/**
	 * A FingerprintHash is a UInt64 rendered as a DECIMAL string
	 * (`CH.toString_($.FingerprintHash)`), not hex — hex was what this fixture
	 * used, and it is the same wrong mental model that makes agents feed
	 * `error_detail` a truncated issue id in production.
	 */
	fingerprint: "11640295108927840024",
	/** A Postgres error-issue id. A DIFFERENT identity space to `fingerprint`. */
	issueId: "2b11d788-6f3a-4c21-9f0e-51c4a8d7e930",
} as const

export const EVAL_TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)(FIXTURES.orgId),
	userId: Schema.decodeSync(UserId)("internal-service"),
	roles: [],
	authMode: "self_hosted",
}
