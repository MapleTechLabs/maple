import type {
	ActorDocument,
	ErrorIssueEventDocument,
	IssueEscalationAttemptDocument,
} from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { AGENT_ACCENT, TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { badge, kbd, kbdGroup } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { panel } from "../../../ui/panel"
import { textarea } from "../../../ui/textarea"
import { messageResponse } from "../../code-review/kit/markdown"
import { relativeTime } from "../../kit/relative-time"
import { type ActorIdentity, identityAvatar, resolveActorIdentity } from "../kit/actor"
import {
	DOT_CLASS,
	EVENT_LABEL,
	isContinuation,
	isoMs,
	MESSAGE_TYPES,
	MESSAGE_VERB,
	renderPayload,
} from "./activity-format"
import { Message } from "./message"

// The issue timeline and the comment composer.

/** Rows mounted before "Show earlier" (`RECENT_ITEMS`). */
const RECENT_ITEMS = 50

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>
type Item =
	| Readonly<{ kind: "event"; createdAt: string; event: ErrorIssueEventDocument }>
	| Readonly<{ kind: "escalation"; createdAt: string; escalation: IssueEscalationAttemptDocument }>

const ITEM = "group/row grid grid-cols-[4.25rem_1.75rem_minmax(0,1fr)] gap-x-3"
const MESSAGE_ITEM = `${ITEM} first:pt-0`
const STAMP =
	"py-3 text-right text-2xs leading-5 whitespace-nowrap tabular-nums text-muted-foreground transition-opacity"

const rail = (h: H, marker: Html): Html =>
	h.span(
		[h.Class("relative flex h-full justify-center")],
		[
			h.span([h.AriaHidden(true), h.Class("h-full w-px bg-border-subtle group-last/row:h-5")]),
			h.span([h.Class("absolute top-2.5 flex justify-center")], [marker]),
		],
	)

const dot = (h: H, className: string): Html =>
	h.span([h.AriaHidden(true), h.Class(cn("mt-1 size-2.5 rounded-full ring-2 ring-background", className))])

const stamp = (h: H, value: string, clock: Clock, className = STAMP): Html =>
	relativeTime(h, { value, ...clock, tooltip: "title", className })

const ledgerRow = (
	h: H,
	clock: Clock,
	createdAt: string,
	dotClass: string,
	head: ReadonlyArray<Html>,
	body: string | null,
) =>
	h.li(
		[h.Class(ITEM)],
		[
			stamp(h, createdAt, clock),
			rail(h, dot(h, dotClass)),
			h.div(
				[h.Class("min-w-0 py-2.5")],
				[
					h.div([h.Class("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm")], head),
					...(body
						? [
								h.div(
									[
										h.Class(
											"mt-1 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]",
										),
									],
									[body],
								),
							]
						: []),
				],
			),
		],
	)

const escalationRow = (h: H, escalation: IssueEscalationAttemptDocument, clock: Clock): Html => {
	const destinations = escalation.deliveries
		.map((delivery) => `${delivery.destinationName ?? delivery.destinationId}: ${delivery.status}`)
		.join(", ")
	const body =
		destinations ||
		escalation.skipReason?.replaceAll("_", " ") ||
		countLabel(escalation.attempts, "delivery attempt")
	return ledgerRow(
		h,
		clock,
		escalation.createdAt,
		TONE_FILL.warn,
		[
			h.span([h.Class("font-medium text-foreground")], ["Escalation"]),
			h.span(
				[h.Class("font-mono text-2xs capitalize text-muted-foreground")],
				[escalation.severity, " · ", escalation.status],
			),
		],
		body,
	)
}

const authorLabel = (h: H, actor: ActorDocument | null): ReadonlyArray<Html> => {
	if (actor === null) return []
	const identity = resolveActorIdentity(actor)
	return [
		h.span(
			[
				h.Class(
					cn(
						"inline-flex items-center gap-1 text-2xs",
						identity.kind === "agent" ? AGENT_ACCENT.text : "text-muted-foreground",
					),
				),
				...(identity.detail === null ? [] : [h.Title(identity.detail)]),
			],
			[identityAvatar(h, identity), identity.name],
		),
	]
}

const messageRow = (
	h: H,
	event: ErrorIssueEventDocument,
	identity: ActorIdentity | null,
	body: string,
	isContinued: boolean,
	clock: Clock,
): Html => {
	const isAgent = identity?.kind === "agent"
	const verb = MESSAGE_VERB[event.type]
	return h.li(
		[h.Class(MESSAGE_ITEM)],
		[
			stamp(
				h,
				event.createdAt,
				clock,
				cn(STAMP, isContinued && "opacity-0 group-hover/row:opacity-100 pointer-coarse:opacity-100"),
			),
			rail(
				h,
				isContinued
					? h.span([h.AriaHidden(true)])
					: identity !== null
						? identityAvatar(h, identity, "md", "relative ring-2 ring-background")
						: dot(h, "bg-muted-foreground"),
			),
			h.div(
				[h.Class(cn("min-w-0", isContinued ? "pb-2.5" : "pt-1 pb-2.5"))],
				[
					...(isContinued
						? []
						: [
								h.div(
									[h.Class("flex flex-wrap items-baseline gap-x-2 gap-y-0.5")],
									[
										h.span(
											[h.Class("text-sm font-medium text-foreground")],
											[identity?.name ?? "Unknown"],
										),
										...(isAgent
											? [
													badge(
														h,
														{
															pill: true,
															size: "xs",
															mono: true,
															className: cn("font-normal", AGENT_ACCENT.soft),
															attributes: identity?.detail
																? [h.Title(identity.detail)]
																: [],
														},
														[identity?.detail ?? "agent"],
													),
												]
											: []),
										...(verb
											? [h.span([h.Class("text-xs text-muted-foreground")], [verb])]
											: []),
									],
								),
							]),
					h.div(
						[
							h.Class(
								cn(
									"mt-1.5 max-w-prose overflow-x-auto rounded-md border px-3 py-2 text-sm",
									isAgent ? AGENT_ACCENT.surface : "border-border-subtle bg-surface-sunken",
								),
							),
						],
						[messageResponse(h, body, "text-sm leading-relaxed")],
					),
				],
			),
		],
	)
}

const eventRow = (h: H, event: ErrorIssueEventDocument, previous: Item | undefined, clock: Clock): Html => {
	const body = renderPayload(event)
	if (MESSAGE_TYPES.has(event.type) && body) {
		const before = previous?.kind === "event" ? previous.event : null
		const identity = event.actor === null ? null : resolveActorIdentity(event.actor)
		return messageRow(h, event, identity, body, isContinuation(before, event), clock)
	}
	return ledgerRow(
		h,
		clock,
		event.createdAt,
		DOT_CLASS[event.type],
		[
			h.span([h.Class("font-medium text-foreground")], [EVENT_LABEL[event.type]]),
			...(event.fromState && event.toState
				? [
						h.span(
							[h.Class("font-mono text-2xs text-muted-foreground")],
							[event.fromState, " → ", event.toState],
						),
					]
				: []),
			...authorLabel(h, event.actor),
		],
		body,
	)
}

/** Oldest first: a conversation with the composer at its foot. */
export const issueTimeline = (
	h: H,
	events: ReadonlyArray<ErrorIssueEventDocument>,
	escalations: ReadonlyArray<IssueEscalationAttemptDocument>,
	clock: Clock,
	isShowingEarlier: boolean,
): Html => {
	const items: ReadonlyArray<Item> = [
		...events.map((event): Item => ({ kind: "event", createdAt: event.createdAt, event })),
		...escalations.map((escalation): Item => ({
			kind: "escalation",
			createdAt: escalation.createdAt,
			escalation,
		})),
	].sort((a, b) => isoMs(a.createdAt) - isoMs(b.createdAt))
	if (items.length === 0)
		return emptyMessage(h, { dashed: true, className: "py-10" }, [
			h.p([h.Class("text-sm font-medium text-foreground")], ["No activity yet"]),
			h.p(
				[h.Class("mt-1 text-xs")],
				["Comments from your team and notes from agents working this issue land here."],
			),
		])
	// A busy thread mounts its recent rows; the earlier ones wait behind one button.
	const hiddenCount = isShowingEarlier ? 0 : Math.max(0, items.length - RECENT_ITEMS)
	return h.ol(
		[h.Class("flex flex-col")],
		[
			...(hiddenCount > 0
				? [
						h.li(
							[h.Class("flex justify-center pb-2")],
							[
								button(
									h,
									{
										variant: "ghost",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedShowEarlier())],
									},
									["Show ", countLabel(hiddenCount, "earlier event")],
								),
							],
						),
					]
				: []),
			...items
				.slice(hiddenCount)
				.map((item, offset) =>
					item.kind === "escalation"
						? escalationRow(h, item.escalation, clock)
						: eventRow(h, item.event, items[hiddenCount + offset - 1], clock),
				),
		],
	)
}

const participantStrip = (h: H, participants: ReadonlyArray<ActorDocument>): ReadonlyArray<Html> => {
	const seen = new Set<string>()
	const identities = participants.flatMap((actor) => {
		if (seen.has(actor.id)) return []
		seen.add(actor.id)
		return [resolveActorIdentity(actor)]
	})
	if (identities.length === 0) return []
	const shown = identities.slice(0, 5)
	const overflow = identities.length - shown.length
	const agentCount = identities.filter((identity) => identity.kind === "agent").length
	return [
		h.div(
			[h.Class("flex items-center gap-2 px-1 text-xs text-muted-foreground")],
			[
				h.span(
					[h.Class("flex -space-x-1.5")],
					shown.map((identity) => identityAvatar(h, identity, "sm", "ring-2 ring-background")),
				),
				...(overflow > 0 ? [h.span([h.Class("tabular-nums")], [`+${overflow}`])] : []),
				h.span(
					[],
					[
						countLabel(identities.length, "participant"),
						...(agentCount > 0 ? [` · ${countLabel(agentCount, "agent")}`] : []),
					],
				),
			],
		),
	]
}

/** The composer; self-hosted has no directory, so no "me" avatar. */
export const commentComposer = (
	h: H,
	options: Readonly<{ draft: string; isPosting: boolean; participants: ReadonlyArray<ActorDocument> }>,
): Html => {
	const canSubmit = !options.isPosting && options.draft.trim().length > 0
	return h.div(
		[h.Class(cn("space-y-2", "mt-6"))],
		[
			...participantStrip(h, options.participants),
			panel(
				h,
				{
					padded: "sm",
					className: cn(
						"flex-row gap-3 overflow-visible transition-colors",
						"focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/20",
						options.isPosting && "opacity-60",
					),
				},
				[
					h.div(
						[h.Class("min-w-0 flex-1 space-y-2")],
						[
							textarea(h, {
								id: "comment-input",
								isUnstyled: true,
								isDisabled: options.isPosting,
								controlClassName:
									"max-h-80 min-h-11 resize-none px-0 py-0 text-sm leading-relaxed placeholder:text-muted-foreground",
								attributes: [
									h.Value(options.draft),
									h.Placeholder("Context, findings, links… markdown supported"),
									h.OnInput((value) => Message.ChangedCommentDraft({ value })),
									// Mod+Enter submits (`ClickedComment` guards empty and double sends).
									h.OnKeyDownPreventDefault((key, modifiers) =>
										key === "Enter" && (modifiers.metaKey || modifiers.ctrlKey)
											? Option.some(Message.ClickedComment())
											: Option.none(),
									),
								],
							}),
							h.div(
								[
									h.Class(
										"flex items-center justify-between gap-3 text-xs text-muted-foreground",
									),
								],
								[
									kbdGroup(h, undefined, [
										kbd(h, undefined, ["⌘"]),
										kbd(h, undefined, ["↵"]),
										h.span([h.Class("ml-1")], ["to comment"]),
									]),
									button(
										h,
										{
											size: "sm",
											isDisabled: !canSubmit,
											isLoading: options.isPosting,
											attributes: [h.OnClick(Message.ClickedComment())],
										},
										["Comment"],
									),
								],
							),
						],
					),
				],
			),
		],
	)
}
