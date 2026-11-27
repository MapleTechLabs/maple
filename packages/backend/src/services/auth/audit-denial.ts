import { Clock, Effect, Option, String as Str } from "effect"
import type { HttpServerRequest } from "effect/http"
import type { AuditLogSource } from "@maple/domain/http"
import type { OrgId } from "@maple/primitives"
import {
	httpRequestForensics,
	type AuditActorRef,
	type AuditLogServiceApi,
} from "@maple/backend/services/audit/AuditLogService"
import type { AccessDenial } from "./access-span"

/** Suppress duplicate denial rows for the same key/reason within this window. */
export const AUDIT_DENIAL_COALESCE_WINDOW_MS = 60_000

/** Bound on distinct in-flight denial signatures kept per isolate. */
const MAX_TRACKED_DENIALS = 10_000

/**
 * Isolate-local coalescing cache: last-recorded time per denial signature.
 * Tradeoff: Workers isolates multiply and recycle, so suppression is
 * best-effort: each isolate still records the first denial it sees, which is
 * the forensic signal; only the repeat volume is shed, with no network hop.
 */
const recentDenials = new Map<string, number>()

/**
 * True when this signature has not been recorded within the window; marks it
 * recorded. The timestamp is not refreshed on suppression, so a sustained loop
 * still lands one row per window rather than going silent forever.
 */
const shouldRecordDenial = (signature: string, now: number): boolean => {
	const last = recentDenials.get(signature)
	if (last !== undefined && now - last < AUDIT_DENIAL_COALESCE_WINDOW_MS) return false
	// Delete-then-set keeps insertion order ≈ recency, so the bound evicts the stalest signature.
	recentDenials.delete(signature)
	if (recentDenials.size >= MAX_TRACKED_DENIALS) {
		const oldest = recentDenials.keys().next()
		if (!oldest.done) recentDenials.delete(oldest.value)
	}
	recentDenials.set(signature, now)
	return true
}

/** Who was refused: an API key, or a person on a session or device credential. */
export interface DeniedCaller {
	readonly orgId: OrgId
	readonly actor: AuditActorRef
	readonly source: AuditLogSource
}

const requestPath = (url: string): string => {
	return Option.match(Str.indexOf("?")(url), {
		onNone: () => url,
		onSome: (queryStart) => Str.slice(0, queryStart)(url),
	})
}

// A refused key is always a row. A person refused Read telemetry is not: a role without it opens
// pages that ask for telemetry as they load, and those refusals stay on the span.
const isRecorded = (caller: DeniedCaller, denial: AccessDenial): boolean =>
	caller.actor.type === "api_key" || denial.permission !== "telemetry:read"

/**
 * Record a refused request with full forensics (method+path plus the
 * `cf-ray`/`cf-connecting-ip`/`cf-ipcountry` headers), coalescing duplicates:
 * the same (org, caller, method+path, reason) is written at most once per window
 * so a client looping refused requests cannot amplify into unbounded queue
 * messages, rows, and warn logs. Never fails, same contract as `record`.
 */
export const recordAccessDenial = (
	audit: AuditLogServiceApi,
	request: HttpServerRequest.HttpServerRequest,
	caller: DeniedCaller,
	denial: AccessDenial,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		if (!isRecorded(caller, denial)) return
		const now = yield* Clock.currentTimeMillis
		const path = requestPath(request.url)
		const who = caller.actor.apiKeyId ?? caller.actor.userId ?? caller.actor.type
		const signature = `${caller.orgId}|${who}|${request.method} ${path}|${denial.reason}`
		if (!shouldRecordDenial(signature, now)) return
		yield* audit.record({
			orgId: caller.orgId,
			actor: caller.actor,
			source: caller.source,
			action: "api.request",
			outcome: "denied",
			denialReason: denial.reason,
			metadata: {
				method: request.method,
				path,
				...(denial.permission === undefined ? undefined : { permission: denial.permission }),
			},
			...httpRequestForensics(request),
		})
	})
