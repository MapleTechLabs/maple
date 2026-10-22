import { Clock, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { MapleApiV2Client } from "../../platform/api-clients"
import { dataSourceTransform, toReadyData } from "../dashboards/kit/widget-data"
import { Message } from "./message"
import { DashboardSectionSchema } from "@maple/widgets/dashboard"
import { type Resolve, type ShareError, SharedDashboard, type WidgetState } from "./model"

// The share's reads: resolve the token, then widget data in batches of four (`useShareWidgetData`).

const SHARE_UNAVAILABLE_MESSAGE = "This dashboard could not be loaded. Try again later."
export const DATA_UNAVAILABLE_MESSAGE = "This data could not be loaded."

export const ResolveClock = Command.define("ResolveShareClock", {
	messages: [Message.CompletedResolveClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedResolveClock({ nowMs })),
})

/** A Reload re-resolves a relative window at the current time. */
export const ResolveReloadClock = Command.define("ResolveShareReloadClock", {
	messages: [Message.CompletedResolveReloadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedResolveReloadClock({ nowMs })),
})

/** `isFramed`: reading a cross-origin `top` throws, and that means framed by someone unseen. */
export const ReadFrame = Command.define("ReadShareFrame", {
	messages: [Message.CompletedReadFrame],
	execute: Effect.try(() => window.self !== window.top).pipe(
		Effect.orElseSucceed(() => true),
		Effect.map((isFramed) => Message.CompletedReadFrame({ isFramed })),
	),
})

const decodeDashboard = Schema.decodeUnknownEffect(SharedDashboard)
const decodeSections = Schema.decodeUnknownOption(Schema.Array(DashboardSectionSchema))
const decodeSectionsField = Schema.decodeUnknownOption(Schema.Struct({ sections: Schema.Unknown }))

/** `decodeShare`: sections that fail to decode render an ungrouped board, never a dead page. */
export const sectionsOf = (dashboard: unknown) =>
	Option.getOrElse(
		Option.flatMap(decodeSectionsField(dashboard), ({ sections }) => decodeSections(sections)),
		() => [],
	)

const decodeObject = (value: unknown): Readonly<Record<string, unknown>> =>
	Option.getOrElse(
		Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(value),
		() => ({}),
	)

const decodeEnvelope = Schema.decodeUnknownOption(
	Schema.Struct({ error: Schema.Struct({ _tag: Schema.String }) }),
)
const decodeMessage = Schema.decodeUnknownOption(
	Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
)
const decodeTagged = Schema.decodeUnknownOption(Schema.Struct({ _tag: Schema.String }))

/** The error's tag: the v2 envelope's (`{ error: { _tag } }`), or the error's own. */
const tagOf = (error: unknown): string =>
	Option.getOrElse(
		Option.orElse(
			Option.map(decodeEnvelope(error), (envelope) => envelope.error._tag),
			() => Option.map(decodeTagged(error), (tagged) => tagged._tag),
		),
		() => "",
	)

/** `toResolveError`: the typed share errors by tag, everything else unavailable. */
const toShareError = (error: unknown): ShareError => {
	switch (tagOf(error)) {
		case "@maple/http/errors/ShareSignInRequiredError":
			return { _tag: "SignInRequired" }
		case "@maple/http/errors/ShareWrongOrgError":
			return { _tag: "WrongOrg" }
		case "@maple/http/errors/ShareRateLimitedError":
			return { _tag: "RateLimited" }
		case "@maple/http/errors/ShareNotFoundError":
			return { _tag: "NotFound" }
		default:
			return { _tag: "Unavailable", message: SHARE_UNAVAILABLE_MESSAGE }
	}
}

export const ResolveShare = Command.define("ResolveShare", {
	args: { token: Schema.String },
	messages: [Message.CompletedResolveShare],
	execute: ({ token }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.sharePublic.resolve({ payload: { token } })
			return yield* decodeDashboard({
				mode: response.mode,
				scope: response.scope,
				embeddable: response.embeddable,
				dashboard: { ...decodeObject(response.dashboard), sections: sectionsOf(response.dashboard) },
			})
		}).pipe(
			Effect.map((share): Resolve => ({ _tag: "Ready", share })),
			Effect.catch((error) => Effect.succeed<Resolve>({ _tag: "Failed", error: toShareError(error) })),
			Effect.map((resolve) => Message.CompletedResolveShare({ token, resolve })),
		),
})

/** One frame after the tiles reported, so their batched options flush together. */
export const WaitFlushFrame = Command.define("WaitShareFlushFrame", {
	messages: [Message.CompletedFlushFrame],
	execute: Effect.callback<typeof Message.CompletedFlushFrame.Type>((resume) => {
		const handle = requestAnimationFrame(() => resume(Effect.succeed(Message.CompletedFlushFrame())))
		return Effect.sync(() => cancelAnimationFrame(handle))
	}),
})

const BatchRequest = Schema.Struct({
	widgetId: Schema.String,
	key: Schema.String,
	maxDataPoints: Schema.optional(Schema.Number),
	transform: Schema.optional(Schema.Unknown),
})

/** One `/v2/share/widget-data` call for up to four widgets. */
export const FetchBatch = Command.define("FetchShareWidgetBatch", {
	args: {
		token: Schema.String,
		batchId: Schema.Number,
		startTime: Schema.String,
		endTime: Schema.String,
		variableValues: Schema.Record(Schema.String, Schema.String),
		requests: Schema.Array(BatchRequest),
	},
	messages: [Message.CompletedFetchBatch],
	execute: ({ token, batchId, startTime, endTime, variableValues, requests }) => {
		const keys = Object.fromEntries(requests.map((request) => [request.widgetId, request.key]))
		const failAll = (message: string) =>
			Object.fromEntries(
				requests.map((request): [string, WidgetState] => [
					request.widgetId,
					{ _tag: "Error", message, kind: null },
				]),
			)
		return Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.sharePublic.widgetData({
				payload: {
					token,
					requests: requests.map((request) =>
						request.maxDataPoints === undefined
							? { widgetId: request.widgetId }
							: { widgetId: request.widgetId, maxDataPoints: request.maxDataPoints },
					),
					timeRange: { startTime, endTime },
					variableValues,
				},
			})
			const transforms = new Map(requests.map((request) => [request.widgetId, request.transform]))
			const states = Object.fromEntries(
				response.results.map((result): [string, WidgetState] => [
					result.widgetId,
					result.ok === true
						? {
								_tag: "Ready",
								data: toReadyData(
									result.data,
									dataSourceTransform({ transform: transforms.get(result.widgetId) }),
								),
							}
						: {
								_tag: "Error",
								message: result.message,
								kind: result.reason === "unsupported" ? "range" : "runtime",
							},
				]),
			)
			return Message.CompletedFetchBatch({ batchId, keys, states, variables: response.variables })
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.CompletedFetchBatch({
						batchId,
						keys,
						states: failAll(
							Option.getOrElse(
								Option.map(decodeMessage(error), (envelope) => envelope.error.message),
								() => DATA_UNAVAILABLE_MESSAGE,
							),
						),
					}),
				),
			),
		)
	},
})

/** `signIn`: a full navigation, carrying this share back as the redirect. */
export const GoToSignIn = Command.define("GoToShareSignIn", {
	messages: [Message.StartedSignInRedirect],
	execute: Effect.sync(() => {
		const redirect = encodeURIComponent(window.location.pathname + window.location.search)
		window.location.href = `/sign-in?redirect_url=${redirect}`
		return Message.StartedSignInRedirect()
	}),
})

/** `useContainerWidth` of the board container. */
export const MeasureGrid = Mount.defineStream("MeasureShareGrid", {
	messages: [Message.MeasuredGrid],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredGrid.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					Queue.offerUnsafe(
						queue,
						Message.MeasuredGrid({ width: Math.round(element.getBoundingClientRect().width) }),
					)
					const observer = new ResizeObserver((entries) => {
						const entry = entries.at(-1)
						if (entry !== undefined)
							Queue.offerUnsafe(
								queue,
								Message.MeasuredGrid({ width: Math.round(entry.contentRect.width) }),
							)
					})
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

const quantize = (widthPx: number): Option.Option<number> =>
	!Number.isFinite(widthPx) || widthPx <= 0
		? Option.none()
		: Option.some(Math.max(100, Math.floor(widthPx / 100) * 100))

/** `useMeasuredWidgetMaxDataPoints`: the tile's width on a 100 px grid, as data points for its panel. */
export const WatchTile = Mount.defineStream("WatchShareTile", {
	args: { widgetId: Schema.String, isBar: Schema.Boolean },
	messages: [Message.MeasuredWidget],
	execute: ({ element, widgetId, isBar }) =>
		Stream.callback<typeof Message.MeasuredWidget.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const report = (width: number) =>
						Option.map(quantize(width), (widthPx) =>
							Queue.offerUnsafe(
								queue,
								Message.MeasuredWidget({
									widgetId,
									maxDataPoints: Math.max(1, Math.floor(isBar ? widthPx / 6 : widthPx)),
								}),
							),
						)
					report(element.getBoundingClientRect().width)
					const observer = new ResizeObserver((entries) =>
						entries.forEach((entry) => report(entry.contentRect.width)),
					)
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

type Appearance = Readonly<{ theme: string | null; background: string; colorScheme: string }>

/** The page's appearance now, to put back on the way out. */
const currentAppearance = (): Appearance => {
	const root = document.documentElement
	return {
		theme: root.classList.contains("dark") ? "dark" : root.classList.contains("light") ? "light" : null,
		background: document.body.style.background,
		colorScheme: root.style.colorScheme,
	}
}

const applyThemeClass = (theme: string) => {
	const root = document.documentElement
	root.classList.remove("light", "dark")
	root.classList.add(theme)
	root.style.colorScheme = theme
}

const isThemeOverride = (theme: string | null) => theme === "light" || theme === "dark"

/**
 * `SharePage`'s layout effect: `?theme=` applies without persisting, and an embed clears the
 * backdrop (`body` and `color-scheme`) so the host page shows around the card. Restored on leave.
 */
export const ApplyShareAppearance = Mount.defineStream("ApplyShareAppearance", {
	args: { theme: Schema.NullOr(Schema.String), isEmbed: Schema.Boolean },
	messages: [Message.AppliedShareAppearance],
	execute: ({ theme, isEmbed }) =>
		Stream.callback<typeof Message.AppliedShareAppearance.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const previous = currentAppearance()
					if (theme !== null && isThemeOverride(theme)) applyThemeClass(theme)
					if (isEmbed) {
						document.body.style.background = "transparent"
						document.documentElement.style.colorScheme = "normal"
					}
					Queue.offerUnsafe(queue, Message.AppliedShareAppearance())
					return previous
				}),
				(previous) =>
					Effect.sync(() => {
						document.body.style.background = previous.background
						if (previous.theme !== null && isThemeOverride(theme)) applyThemeClass(previous.theme)
						document.documentElement.style.colorScheme = previous.colorScheme
					}),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})
