import {
	signStatusPageAccess,
	STATUS_PAGE_ACCESS_COOKIE,
	STATUS_PAGE_ACCESS_MAX_AGE_SECONDS,
	verifyStatusPageAccess,
	verifyStatusPagePassword,
} from "@maple/domain/status-page-access"
import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { ACCESS_FIELD, renderAccessPage } from "@maple/status-page"
import { Effect, Result, Array as Arr, String as Str } from "effect"
import { readFormData } from "./break-glass"
import type { StatusEnv } from "./ports"
import { html, redirect } from "./responses"

// The gate in front of a password-protected page: a form that checks the password against the
// published hash, and a signed cookie that lets the visitor back in for 30 days.

/** Every value sent for the access cookie: a browser sends one per path that matches. */
const accessCookies = (request: Request): ReadonlyArray<string> =>
	Arr.flatMap(Str.split(";")(request.headers.get("cookie") ?? ""), (part) => {
		const [name, ...value] = Str.split("=")(Str.trim(part))
		return name === STATUS_PAGE_ACCESS_COOKIE ? [Arr.join(value, "=")] : []
	})

/** Whether the request carries a cookie signed under the page's current password. */
export const hasAccess = (env: StatusEnv, request: Request, snapshot: StatusPageSnapshot) => {
	const hash = snapshot.passwordHash
	if (hash === null) return Effect.succeed(false)
	return Effect.forEach(accessCookies(request), (value) =>
		verifyStatusPageAccess(hash, snapshot.pageId, value, env.nowMs),
	).pipe(Effect.map(Arr.some((valid) => valid)))
}

export const accessPage = (
	env: StatusEnv,
	snapshot: StatusPageSnapshot,
	basePath: string,
	status: number,
	message?: string,
): Response => {
	const nonce = env.randomId()
	return html(renderAccessPage(snapshot, message, { nonce, basePath }), {
		status,
		cacheControl: "no-store",
		nonce,
	})
}

/**
 * Checks a posted password. Rate-limited per address and page, failing closed: a page password
 * is guessable where a break-glass token is not, and a visitor locked out loses nothing urgent.
 */
export const postAccess = (
	env: StatusEnv,
	request: Request,
	snapshot: StatusPageSnapshot,
	basePath: string,
): Effect.Effect<Response> =>
	Effect.gen(function* () {
		const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
		const allowed = yield* env.storage.rateLimit(`access:${ip}:${snapshot.pageId}`).pipe(
			Effect.tapError((error) =>
				Effect.logWarning("Status page access rate limit unavailable").pipe(
					Effect.annotateLogs({
						"maple.status_page.id": snapshot.pageId,
						"error.type": error._tag,
					}),
				),
			),
			Effect.orElseSucceed(() => false),
		)
		if (!allowed) {
			return accessPage(env, snapshot, basePath, 429, "Too many attempts. Wait a minute and try again.")
		}
		const form = yield* Effect.result(readFormData(request))
		if (Result.isFailure(form)) {
			return accessPage(env, snapshot, basePath, form.failure.status, "The form could not be read.")
		}
		const posted = form.success.get(ACCESS_FIELD)
		const hash = snapshot.passwordHash
		const granted =
			hash !== null && typeof posted === "string" && (yield* verifyStatusPagePassword(posted, hash))
		yield* Effect.annotateCurrentSpan("maple.status_page.access_granted", granted)
		if (!granted || hash === null) {
			return accessPage(
				env,
				snapshot,
				basePath,
				401,
				"That password is not right. Check it and try again.",
			)
		}
		const cookie = yield* signStatusPageAccess(
			hash,
			snapshot.pageId,
			env.nowMs + STATUS_PAGE_ACCESS_MAX_AGE_SECONDS * 1000,
		)
		// Host-only and scoped to the page's path, so another page on Maple's shared host never gets it.
		return redirect(`${basePath}/`, {
			"set-cookie": `${STATUS_PAGE_ACCESS_COOKIE}=${cookie}; Path=${basePath === "" ? "/" : basePath}; Max-Age=${STATUS_PAGE_ACCESS_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
		})
	})
