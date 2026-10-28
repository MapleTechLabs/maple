import {
	type ManageMessage,
	renderAtomFeed,
	renderBadgeSvg,
	renderManagePage,
	renderPage,
	renderStatusJson,
} from "@maple/status-page"
import { Effect, Option } from "effect"
import { parseForm, postBreakGlassUpdate } from "./break-glass"
import type { StatusEnv } from "./ports"
import { asset, html, notFound, PUBLIC_CACHE_CONTROL, plain, redirect } from "./responses"
import { loadView, type PageView, pageIdForHost, pageIdForSlug } from "./snapshot"

/** `/s/<slug>` and `/s/<slug>/<rest>`: path addressing for hosts without a page of their own. */
const SLUG_PATH = /^\/s\/([a-z0-9][a-z0-9-]{1,46}[a-z0-9])(\/.*)?$/u

interface Target {
	readonly pageId: string
	/** Prefix for the page's own links. */
	readonly basePath: string
	/** Path within the page, always starting with `/`. */
	readonly path: string
	/** The slug the request named, when it came in by `/s/<slug>`. */
	readonly slug: string | null
}

/** The page a request is for: its hostname first, then the `/s/<slug>` path form. */
const resolveTarget = (env: StatusEnv, url: URL): Effect.Effect<Option.Option<Target>> =>
	Effect.gen(function* () {
		const byHost = yield* pageIdForHost(env, url.hostname)
		if (Option.isSome(byHost))
			return Option.some({ pageId: byHost.value, basePath: "", path: url.pathname, slug: null })
		const match = SLUG_PATH.exec(url.pathname)
		const slug = match?.[1]
		if (slug === undefined) return Option.none()
		const bySlug = yield* pageIdForSlug(env, slug)
		return Option.map(bySlug, (pageId) => ({
			pageId,
			basePath: `/s/${slug}`,
			path: match?.[2] ?? "/",
			slug,
		}))
	})

const managePage = (
	env: StatusEnv,
	view: PageView,
	target: Target,
	status: number,
	message?: ManageMessage,
): Response => {
	const nonce = env.randomId()
	return html(renderManagePage(view.snapshot, message, { nonce, basePath: target.basePath }), {
		status,
		cacheControl: "no-store",
		nonce,
	})
}

const NOT_SAVED =
	"The update was not saved: the status store did not answer. Try again in a minute; nothing was published."

const postManage = (env: StatusEnv, request: Request, view: PageView, target: Target) =>
	Effect.gen(function* () {
		const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
		// Fails open: the token carries 256 bits, and this form exists for when things are broken.
		const allowed = yield* env.storage
			.rateLimit(`${ip}:${target.pageId}`)
			.pipe(Effect.orElseSucceed(() => true))
		if (!allowed) {
			return managePage(env, view, target, 429, {
				tone: "error",
				text: "Too many attempts. Wait a minute and try again.",
			})
		}
		return yield* parseForm(request).pipe(
			Effect.flatMap((form) => postBreakGlassUpdate(env, view.snapshot, form)),
			Effect.as(redirect(`${target.basePath}/`)),
			Effect.catchTags({
				"@maple/status/BreakGlassRejected": (error) =>
					Effect.succeed(
						managePage(env, view, target, error.status, { tone: "error", text: error.message }),
					),
				"@maple/status/BreakGlassNotSaved": () =>
					Effect.succeed(managePage(env, view, target, 503, { tone: "error", text: NOT_SAVED })),
			}),
		)
	})

const servePage = (env: StatusEnv, request: Request, url: URL, view: PageView, target: Target) => {
	const isRead = request.method === "GET" || request.method === "HEAD"
	if (target.path === "/_manage") {
		if (isRead) return Effect.succeed(managePage(env, view, target, 200))
		if (request.method === "POST") return postManage(env, request, view, target)
		return Effect.succeed(plain("Method not allowed", 405))
	}
	if (!isRead) return Effect.succeed(plain("Method not allowed", 405))
	switch (target.path) {
		case "/": {
			const nonce = env.randomId()
			const body = renderPage(view.snapshot, view.freshness, env.nowMs, {
				nonce,
				basePath: target.basePath,
			})
			return Effect.succeed(html(body, { cacheControl: PUBLIC_CACHE_CONTROL, nonce }))
		}
		case "/api/v1/status.json":
			return Effect.succeed(
				asset(
					JSON.stringify(renderStatusJson(view.snapshot, view.freshness)),
					"application/json; charset=utf-8",
					{
						"access-control-allow-origin": "*",
					},
				),
			)
		case "/badge.svg":
			return Effect.succeed(
				asset(renderBadgeSvg(view.snapshot, view.freshness), "image/svg+xml; charset=utf-8"),
			)
		case "/feed.atom":
			return Effect.succeed(
				asset(
					renderAtomFeed(view.snapshot, `${url.origin}${target.basePath}`),
					"application/atom+xml; charset=utf-8",
				),
			)
		default:
			return Effect.succeed(notFound())
	}
}

/** One request: resolve the page, load what is still reachable, render. Never fails. */
export const handleRequest = (request: Request, env: StatusEnv): Effect.Effect<Response> =>
	Effect.gen(function* () {
		const url = new URL(request.url)
		// Liveness only: says the Worker runs, not that any page can be served.
		if (url.pathname === "/_health") return plain("ok", 200)
		const target = yield* resolveTarget(env, url)
		if (Option.isNone(target)) return notFound()
		const view = yield* loadView(env, target.value.pageId)
		if (Option.isNone(view)) return plain("This status page is temporarily unavailable.", 503)
		// A renamed page keeps its old `slug:` key until cleanup; only the current slug serves it.
		if (target.value.slug !== null && view.value.snapshot.page.slug !== target.value.slug)
			return notFound()
		return yield* servePage(env, request, url, view.value, target.value)
	})
