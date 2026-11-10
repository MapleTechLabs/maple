import type { StatusPageSnapshot } from "@maple/domain/status-page"
import {
	renderSubscriptionPage,
	SUBSCRIBE_FIELDS,
	SUBSCRIBE_PATHS,
	SUBSCRIBE_SCOPE_SOME,
	type SubscriptionView,
} from "@maple/status-page"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { readFormData } from "./break-glass"
import type { StatusEnv, StatusSubscriptions, SubscriptionOutcome } from "./ports"
import { html, notFound, plain, redirect } from "./responses"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeMessage = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
)

/** The service binding call threw: Maple is down or the binding is broken. */
class SubscriptionCallError extends Schema.TaggedError<SubscriptionCallError>()(
	"@maple/status/SubscriptionCallError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

const OK: SubscriptionOutcome = { _tag: "ok" }
const NOT_FOUND: SubscriptionOutcome = { _tag: "not-found" }
const UNAVAILABLE: SubscriptionOutcome = { _tag: "unavailable" }

// The binding routes by name; the origin is the formality `Request` insists on.
const API_ORIGIN = "https://maple-api.internal"

/** Maple's public subscription endpoints over the `API` service binding; none bound is `unavailable`. */
export const apiSubscriptions = (api: Option.Option<Pick<Fetcher, "fetch">>): StatusSubscriptions => {
	const call = (pageId: string, action: string, body: unknown): Effect.Effect<SubscriptionOutcome> =>
		Option.match(api, {
			onNone: () => Effect.succeed(UNAVAILABLE),
			onSome: (binding) =>
				Effect.tryPromise({
					try: async () => {
						const response = await binding.fetch(
							`${API_ORIGIN}/api/status-pages/public/${encodeURIComponent(pageId)}/${action}`,
							{
								method: "POST",
								headers: { "content-type": "application/json" },
								body: encodeJson(body),
							},
						)
						return { status: response.status, text: await response.text() }
					},
					catch: (cause) => new SubscriptionCallError({ message: "Maple did not answer", cause }),
				}).pipe(
					Effect.map(({ status, text }): SubscriptionOutcome => {
						if (status >= 200 && status < 300) return OK
						if (status === 404) return NOT_FOUND
						if (status !== 400) return UNAVAILABLE
						return {
							_tag: "rejected",
							message: Option.match(decodeMessage(text), {
								onNone: () => "That request could not be accepted.",
								onSome: (decoded) => decoded.message,
							}),
						}
					}),
					Effect.orElseSucceed(() => UNAVAILABLE),
				),
		})
	return {
		subscribe: (pageId, input) =>
			call(pageId, "subscribe", {
				email: input.email,
				...(input.componentIds === null ? undefined : { componentIds: input.componentIds }),
			}),
		confirm: (pageId, token) => call(pageId, "confirm", { token }),
		unsubscribe: (pageId, token) => call(pageId, "unsubscribe", { token }),
	}
}

export const isSubscriptionPath = (path: string): boolean =>
	path === SUBSCRIBE_PATHS.subscribe ||
	path === SUBSCRIBE_PATHS.confirm ||
	path === SUBSCRIBE_PATHS.unsubscribe

interface At {
	readonly pageId: string
	readonly basePath: string
	readonly path: string
}

const UNAVAILABLE_VIEW: SubscriptionView = {
	title: "Try again later",
	text: "Subscriptions are unavailable right now. Try again in a few minutes.",
	tone: "error",
}

const page = (
	env: StatusEnv,
	snapshot: StatusPageSnapshot,
	at: At,
	status: number,
	view: SubscriptionView,
) => {
	const nonce = env.randomId()
	return html(renderSubscriptionPage(snapshot, view, { nonce, basePath: at.basePath }), {
		status,
		cacheControl: "no-store",
		nonce,
	})
}

/** The visitor's answer to what Maple said; `done` is the success view. */
const answer = (
	env: StatusEnv,
	snapshot: StatusPageSnapshot,
	at: At,
	outcome: SubscriptionOutcome,
	done: SubscriptionView,
): Response => {
	switch (outcome._tag) {
		case "ok":
			return page(env, snapshot, at, 200, done)
		case "rejected":
			return page(env, snapshot, at, 400, {
				title: "Something is not right",
				text: outcome.message,
				tone: "error",
			})
		case "not-found":
			return notFound()
		case "unavailable":
			return page(env, snapshot, at, 503, UNAVAILABLE_VIEW)
	}
}

const field = (form: FormData, name: string): string => {
	const value = form.get(name)
	return typeof value === "string" ? Str.trim(value) : ""
}

const SUBSCRIBED: SubscriptionView = {
	title: "Check your inbox",
	text: "If that address is not subscribed yet, we have sent it a link to confirm. The link works for 48 hours.",
	tone: "ok",
}

const postSubscribe = (env: StatusEnv, request: Request, snapshot: StatusPageSnapshot, at: At) =>
	Effect.gen(function* () {
		const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
		// Fails open: Maple caps confirmation emails per address and per page as well.
		const allowed = yield* env.storage
			.rateLimit(`subscribe:${ip}:${at.pageId}`)
			.pipe(Effect.orElseSucceed(() => true))
		if (!allowed) {
			return page(env, snapshot, at, 429, {
				title: "Too many attempts",
				text: "Wait a minute and try again.",
				tone: "error",
			})
		}
		const form = yield* readFormData(request)
		const componentIds =
			field(form, SUBSCRIBE_FIELDS.scope) === SUBSCRIBE_SCOPE_SOME
				? Arr.filter(form.getAll(SUBSCRIBE_FIELDS.componentIds), (value) => typeof value === "string")
				: null
		const outcome = yield* env.subscriptions.subscribe(at.pageId, {
			email: field(form, SUBSCRIBE_FIELDS.email),
			componentIds,
		})
		return answer(env, snapshot, at, outcome, SUBSCRIBED)
	}).pipe(
		Effect.catchTag("@maple/status/BreakGlassRejected", (error) =>
			Effect.succeed(
				page(env, snapshot, at, error.status, {
					title: "Something is not right",
					text: error.message,
					tone: "error",
				}),
			),
		),
	)

const INVALID_LINK: SubscriptionView = {
	title: "This link is not valid",
	text: "The link is incomplete. Open it again from the email, or subscribe again from the status page.",
	tone: "error",
}

/**
 * A link from an email: GET only shows a button, since mail scanners fetch every link; the POST
 * acts. Mail clients' one-click unsubscribe POSTs straight to the link, token in the query.
 */
const tokenRoute = (
	env: StatusEnv,
	request: Request,
	url: URL,
	snapshot: StatusPageSnapshot,
	at: At,
	route: {
		readonly prompt: SubscriptionView
		readonly label: string
		readonly act: (token: string) => Effect.Effect<SubscriptionOutcome>
		readonly done: SubscriptionView
	},
) =>
	Effect.gen(function* () {
		const queryToken = Str.trim(url.searchParams.get(SUBSCRIBE_FIELDS.token) ?? "")
		if (request.method === "GET" || request.method === "HEAD") {
			if (queryToken === "") return page(env, snapshot, at, 400, INVALID_LINK)
			return page(env, snapshot, at, 200, {
				...route.prompt,
				action: { path: at.path, token: queryToken, label: route.label },
			})
		}
		if (request.method !== "POST") return plain("Method not allowed", 405)
		const form = yield* readFormData(request).pipe(Effect.orElseSucceed(() => new FormData()))
		const token = field(form, SUBSCRIBE_FIELDS.token) || queryToken
		if (token === "") return page(env, snapshot, at, 400, INVALID_LINK)
		const outcome = yield* route.act(token)
		return answer(env, snapshot, at, outcome, route.done)
	})

/** `/subscribe`, `/subscribe/confirm` and `/unsubscribe` under the page's base. */
export const serveSubscription = (
	env: StatusEnv,
	request: Request,
	url: URL,
	snapshot: StatusPageSnapshot,
	at: At,
): Effect.Effect<Response> => {
	if (at.path === SUBSCRIBE_PATHS.subscribe) {
		if (request.method === "POST") return postSubscribe(env, request, snapshot, at)
		return Effect.succeed(redirect(`${at.basePath}/#subscribe`))
	}
	if (at.path === SUBSCRIBE_PATHS.confirm) {
		return tokenRoute(env, request, url, snapshot, at, {
			prompt: {
				title: "Confirm your subscription",
				text: `Get an email when ${snapshot.page.name} posts an incident or maintenance update.`,
				tone: "ok",
			},
			label: "Confirm subscription",
			act: (token) => env.subscriptions.confirm(at.pageId, token),
			done: {
				title: "You are subscribed",
				text: `You will get an email when ${snapshot.page.name} posts an update. Every email has an unsubscribe link.`,
				tone: "ok",
			},
		})
	}
	return tokenRoute(env, request, url, snapshot, at, {
		prompt: {
			title: "Unsubscribe",
			text: `Stop emails about ${snapshot.page.name} status updates.`,
			tone: "ok",
		},
		label: "Unsubscribe",
		act: (token) => env.subscriptions.unsubscribe(at.pageId, token),
		done: {
			title: "You are unsubscribed",
			text: `This address no longer gets ${snapshot.page.name} status updates.`,
			tone: "ok",
		},
	})
}
