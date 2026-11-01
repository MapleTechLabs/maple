import { shortId } from "@maple/ui/lib/ids"
import { initialsFrom } from "@maple/ui/lib/initials"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { parseChTimestampMs } from "../../../components/replays/replay-timeline"
import { Struct } from "effect"
import { AsyncData, Submodel } from "foldkit"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { inlineCode, inlineCodeClassName } from "../../../ui/inline-code"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { relativeTime } from "../../kit/relative-time"
import { stableSlice } from "../../kit/stable-slice"
import { errorCountPill, livePill } from "../kit/sessions-parts"
import { WatchPlayerKeys } from "./command"
import { detailOf, durationOf, isActive, labelOf, playerStatus } from "./derive"
import { Message } from "./message"
import type { Model, ReplayDetail } from "./model"
import { replaySurface, replayTransport } from "./view-player"
import { sessionRail } from "./view-rail"
import { copy } from "./view-session"
import { replayTimeline } from "./view-timeline"
import { warmAvatarTone } from "../../../ui/avatar-tone"

// The replay detail page on `ResultPage`, with the replay studio.

type H = HtmlBuilder<Message>

/** `ResultPage`'s crumb: the short id once loaded, else the state it is in. */
export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Replays", href: "/replays" },
	{
		label: AsyncData.matchData(model.detail.data, {
			onEmpty: () => "Loading…",
			onFailure: () => "Error",
			onData: (session) =>
				session === null ? "Not found" : shortId(model.sessionId, "session", { length: 8 }),
		}),
	},
]

/** `Reveal`: the one-shot entrance (frozen at its end state when motion is reduced). */
const reveal = (h: H, delay: number, child: Html): Html =>
	h.div(
		[
			h.Class(
				"animate-in fade-in slide-in-from-bottom-2 [animation-duration:300ms] [animation-timing-function:ease-out] motion-reduce:animate-none",
			),
			h.Style({ "animation-delay": `${delay}s`, "animation-fill-mode": "backwards" }),
		],
		[child],
	)

/** What the identity bar reads off the Model; none of it moves with the playhead. */
type IdentityView = Pick<Model, "sessionId" | "nowMs" | "copies">
const identityOf = stableSlice((model: Model): IdentityView =>
	Struct.pick(model, ["sessionId", "nowMs", "copies"]),
)
const identitySlot = createLazy()

const identityBar = (h: H, model: IdentityView, session: ReplayDetail, timeZone: string): Html => {
	const label = labelOf(session)
	const startedEpoch = parseChTimestampMs(session.startTime)
	const sessionActive = isActive(model, session)
	return h.div(
		[h.Class("flex flex-wrap items-center gap-x-4 gap-y-2")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 items-center gap-2.5")],
				[
					h.div(
						[
							h.Class(
								`grid size-8 shrink-0 place-items-center rounded-full ${warmAvatarTone(model.sessionId)} text-xs font-semibold`,
							),
						],
						[initialsFrom(label)],
					),
					h.h2(
						[h.Class("min-w-0 truncate text-sm font-medium leading-tight"), h.Title(label)],
						[label],
					),
					sessionActive
						? livePill(h, false)
						: badge(h, { variant: "muted", pill: true, className: "gap-1.5" }, [
								statusDot(h),
								"Ended",
							]),
					h.a(
						[
							h.Href(session.urlInitial),
							h.Target("_blank"),
							h.Rel("noreferrer"),
							h.Class(
								"hidden min-w-0 max-w-64 items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground active:text-foreground sm:inline-flex",
							),
						],
						[
							icon(h, "GlobeIcon", { className: "size-3 shrink-0" }),
							h.span([h.Class("truncate")], [hostFromUrl(session.urlInitial)]),
						],
					),
					...(Number.isFinite(startedEpoch)
						? [
								h.span(
									[
										h.Class(
											"hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:inline-flex",
										),
									],
									[
										icon(h, "ClockIcon", { className: "size-3 shrink-0" }),
										relativeTime(h, {
											value: startedEpoch,
											nowMs: model.nowMs,
											timeZone,
											prefix: "started",
											tooltip: "title",
										}),
									],
								),
							]
						: []),
					h.span(
						[
							// The id chip holds its copy button, so it borrows the chip's look on a span.
							h.Class(
								inlineCodeClassName(
									"chip",
									"hidden shrink-0 items-center gap-1 text-2xs text-muted-foreground xl:inline-flex",
								),
							),
						],
						[
							shortId(model.sessionId, "session", { length: 8 }),
							copy(h, model, "identity", model.sessionId, "Session ID", "size-5"),
						],
					),
				],
			),
			h.div(
				[h.Class("flex shrink-0 items-center gap-3")],
				[
					h.span(
						[h.Class("flex items-baseline gap-1.5")],
						[
							h.span(
								[h.Class("font-mono text-sm font-semibold tabular-nums")],
								[formatSessionDuration(durationOf(session))],
							),
							eyebrow(h, {}, ["duration"]),
						],
					),
					...(session.errorCount > 0 ? [errorCountPill(h, session.errorCount)] : []),
				],
			),
		],
	)
}

/** `ReplayStudio`: the stage column (identity, player, timeline) and the rail. */
const studio = (h: H, model: Model, session: ReplayDetail, timeZone: string): Html => {
	const { status, failure } = playerStatus(model, session)
	const transport = replayTransport(h, model, status)
	return h.div(
		[h.Class("flex min-h-0 flex-1 flex-col lg:flex-row"), h.OnMount(WatchPlayerKeys())],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4")],
				[
					reveal(h, 0, identitySlot(identityBar, [h, identityOf(model), session, timeZone])),
					h.div(
						[h.Class("flex flex-col")],
						[
							replaySurface(h, model, session, {
								status,
								failure,
								sessionActive: isActive(model, session),
							}),
							...(transport === null ? [] : [transport]),
						],
					),
					reveal(h, 0.08, replayTimeline(h, model, session.traceIds)),
				],
			),
			sessionRail(h, model, session),
		],
	)
}

/** `ReplayDetailSkeleton`. */
const detailSkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-3.5 lg:flex-row")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-3.5")],
				[
					h.div(
						[h.Class("flex items-center gap-3")],
						[
							skeleton(h, "size-8 shrink-0 rounded-full"),
							skeleton(h, "h-4 w-44"),
							skeleton(h, "h-4 w-64"),
							skeleton(h, "ml-auto h-4 w-24"),
						],
					),
					skeleton(h, "aspect-video w-full rounded-t-md"),
					skeleton(h, "-mt-3.5 h-14 w-full rounded-b-md"),
					skeleton(h, "h-48 w-full rounded-md"),
				],
			),
			skeleton(h, "h-72 w-full rounded-md lg:h-auto lg:w-84 lg:shrink-0"),
		],
	)

const notFound = (h: H, sessionId: string): Html =>
	resourceNotFound(h, {
		title: "Session not found",
		description: [
			"No metadata for session ",
			inlineCode(h, {}, [sessionId]),
			". It may have expired or not been ingested yet.",
		],
		back: { href: "/replays", label: "Back to replays" },
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const session = detailOf(model)
	const isLoaded = session !== undefined
	return dashboardPage(h, { fill: isLoaded }, [
		AsyncData.matchData(model.detail.data, {
			onEmpty: () => detailSkeleton(h),
			onFailure: (failure) => errorState(h, { failure, title: "Couldn't load session replay" }),
			onData: (row) =>
				row === null ? notFound(h, model.sessionId) : studio(h, model, row, inputs.context.timeZone),
		}),
	])
})
