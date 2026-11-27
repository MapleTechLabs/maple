import { Clock, Effect, Option, String as Str } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/http"
import type { AuditedReadSubject } from "@maple/backend/services/audit/audit-access"
import { httpRequestForensics, type AuditLogServiceApi } from "@maple/backend/services/audit/AuditLogService"
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

const requestPath = (url: string): string => {
	return Option.match(Str.indexOf("?")(url), {
		onNone: () => url,
		onSome: (queryStart) => Str.slice(0, queryStart)(url),
	})
}

// A refused key is always a row. A person refused Read telemetry is not: a role without it opens
// pages that ask for telemetry as they load, and those refusals stay on the span.
const isAuditedDenial = (caller: AuditedReadSubject, denial: AccessDenial): boolean =>
	caller.actor.type === "api_key" || denial.permission !== "telemetry:read"

/**
 * Records a refused request with its forensics, at most once per window for the same caller,
 * route and message. The window is keyed on the matched route, not the URL: every id or spelling
 * of a path would otherwise be a row of its own. A person's row names the route, since a path
 * can hold a push token; a key's keeps the path it asked for. Never fails, like `record`.
 */
export const recordAccessDenial =
	(audit: AuditLogServiceApi, request: HttpServerRequest.HttpServerRequest, caller: AuditedReadSubject) =>
	(denial: AccessDenial): Effect.Effect<void> =>
		Effect.gen(function* () {
			if (!isAuditedDenial(caller, denial)) return
			const now = yield* Clock.currentTimeMillis
			const matched = yield* Effect.serviceOption(HttpRouter.RouteContext)
			const route = Option.map(matched, (context) => context.route.path)
			const path = requestPath(request.url)
			const isKey = caller.actor.type === "api_key"
			const who = caller.actor.apiKeyId ?? caller.actor.userId ?? caller.actor.type
			const signature = `${caller.orgId}|${who}|${request.method} ${Option.getOrElse(route, () => path)}|${denial.message}`
			if (!shouldRecordDenial(signature, now)) return
			yield* audit.record({
				orgId: caller.orgId,
				actor: caller.actor,
				source: caller.source,
				action: "api.request",
				outcome: "denied",
				denialReason: denial.message,
				metadata: {
					method: request.method,
					...(isKey
						? { path }
						: Option.match(route, {
								onNone: () => undefined,
								onSome: (template) => ({ path: template }),
							})),
					...(denial.permission === undefined ? undefined : { permission: denial.permission }),
				},
				...httpRequestForensics(request),
			})
		})
