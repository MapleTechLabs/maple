import { createHash } from "node:crypto"
import { Effect, Option, String as Str } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { ShareRateLimiter } from "@maple/backend/services/auth/ShareRateLimiter"

/**
 * `GET /calendar/oncall/{token}.ics`: a schedule's shifts as an iCalendar feed, for a calendar app
 * to subscribe to. No session and no API key: the link is the credential, so the response says
 * nothing a caller without it could use, and an unknown link is the same bare 404 as a wrong path.
 */

export const ONCALL_CALENDAR_PATH = "/calendar/oncall"
const ICS_SUFFIX = ".ics"

/** The link a schedule's feed is fetched by. */
export const onCallCalendarFeedUrl = (apiOrigin: string, token: string): string =>
	`${apiOrigin}${ONCALL_CALENDAR_PATH}/${token}${ICS_SUFFIX}`

// Private: the body names people. A calendar app refetches on its own clock, so a short
// lifetime only spares a burst of repeat requests.
const FEED_HEADERS = {
	"cache-control": "private, max-age=300",
	"x-robots-tag": "noindex",
	"content-disposition": 'inline; filename="on-call.ics"',
}

const notFound = HttpServerResponse.text("Not found", {
	status: 404,
	headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
})

const comeBackLater = (seconds: number) =>
	HttpServerResponse.text("Temporarily unavailable", {
		status: 503,
		headers: { "cache-control": "no-store", "retry-after": String(seconds) },
	})

const tooManyRequests = HttpServerResponse.text("Too many requests", {
	status: 429,
	headers: { "cache-control": "no-store", "retry-after": "60" },
})

export const OnCallCalendarRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService
		const rateLimiter = yield* ShareRateLimiter
		yield* router.add(
			"GET",
			`${ONCALL_CALENDAR_PATH}/:file`,
			Effect.gen(function* () {
				const params = yield* HttpRouter.params
				const file = params.file ?? ""
				if (!Str.endsWith(ICS_SUFFIX)(file)) return notFound
				const token = Str.slice(0, -ICS_SUFFIX.length)(file)
				// The same two buckets as a shared dashboard link: per caller, and per link, so a
				// leaked link cannot be polled without bound. Keyed by a hash, never the token.
				const request = yield* HttpServerRequest.HttpServerRequest
				const outcome = yield* rateLimiter.check({
					tokenHashPrefix: Str.slice(
						0,
						24,
					)(createHash("sha256").update(token, "utf8").digest("hex")),
					ip: request.headers["cf-connecting-ip"],
				})
				if (outcome === "limited") return tooManyRequests
				const body = yield* schedules.calendarFeed(token)
				return Option.match(body, {
					onNone: () => notFound,
					onSome: (calendar) =>
						HttpServerResponse.text(calendar, {
							status: 200,
							contentType: "text/calendar; charset=utf-8",
							headers: FEED_HEADERS,
						}),
				})
			}).pipe(
				// The token must not reach a trace: the span carries the route, not the path.
				Effect.withSpan("OnCallCalendar.feed", {
					attributes: { "http.route": `${ONCALL_CALENDAR_PATH}/:file` },
				}),
				// A calendar app keeps its last good copy on a 503, which beats a feed without names.
				Effect.catchTags({
					"@maple/http/errors/AlertPersistenceError": () => Effect.succeed(comeBackLater(60)),
					"@maple/http/errors/AlertMemberDirectoryUnavailableError": () =>
						Effect.succeed(comeBackLater(300)),
				}),
			),
			// The server span is suppressed for this prefix; this covers a span recorded anyway.
			{ redactedParams: ["file"] },
		)
	}),
)
