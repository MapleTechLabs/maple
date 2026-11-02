import type { ActorDocument } from "@maple/domain/http"
import { internalAgentLabel } from "@maple/domain/system-agents"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { initialsFrom } from "@maple/ui/lib/initials"
import { AGENT_ACCENT } from "@maple/ui/lib/tone"
import { shortId as truncateId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { avatarFallback } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { warmAvatarTone } from "../../../ui/avatar-tone"

// Actor avatars and chips.
// TODO(actor-directory): people should resolve through the Clerk member directory; here every
// person renders as their short id, the fallback for an unknown member.

export interface ActorIdentity {
	readonly kind: "user" | "agent"
	readonly internal: boolean
	readonly name: string
	/** The model for an agent (or its raw name behind a friendly label); people have none here. */
	readonly detail: string | null
	readonly initials: string
	readonly seed: string
	/** A directory member's photo. */
	readonly imageUrl?: string | null
}

/** `shortId` (hooks/use-actor-directory.ts). */
const shortId = (id: string): string => {
	const withoutPrefix = id.includes("_") ? (id.split("_").at(-1) ?? id) : id
	return truncateId(withoutPrefix, "generic", { length: 6 })
}

export const resolveActorIdentity = (actor: ActorDocument): ActorIdentity => {
	if (actor.type === "agent") {
		const label = actor.agentName ? internalAgentLabel(actor.agentName) : null
		const name = label ?? actor.agentName ?? "Agent"
		return {
			kind: "agent",
			internal: label !== null,
			name,
			detail: actor.model ?? (label ? actor.agentName : null),
			initials: initialsFrom(name),
			seed: actor.agentName ?? actor.id,
		}
	}
	const raw = actor.userId ?? actor.id
	return {
		kind: "user",
		internal: false,
		name: shortId(raw),
		detail: null,
		// No directory name yet: the raw id's leading characters ("00", "2A") are not initials.
		initials: "",
		seed: raw,
	}
}

const SIZE_CLASS = { sm: "size-5 text-4xs", md: "size-7 text-2xs" } as const

export const identityAvatar = <M>(
	h: HtmlBuilder<M>,
	identity: ActorIdentity,
	size: keyof typeof SIZE_CLASS = "sm",
	className?: string,
): Html => {
	const base = cn(
		"inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
		SIZE_CLASS[size],
		className,
	)
	if (identity.kind === "agent") {
		return h.span(
			[h.AriaHidden(true), h.Class(cn(base, AGENT_ACCENT.soft, AGENT_ACCENT.ring))],
			[
				identity.internal
					? icon(h, "MapleMark", { className: "size-[54%] -translate-y-[4%]" })
					: icon(h, "FaceRobotIcon", {
							className: "size-[62%]",
							attributes: [h.Attribute("stroke-width", "2")],
						}),
			],
		)
	}
	const gradient = warmAvatarTone(identity.seed)
	const mark =
		identity.initials === "" ? icon(h, "UserIcon", { className: "size-[60%]" }) : identity.initials
	// The initials show until the photo loads; photos are not loaded here yet.
	if (identity.imageUrl !== undefined && identity.imageUrl !== null && identity.imageUrl !== "")
		return avatarFallback(
			h,
			{
				className: cn(base, "ring-1 ring-border-subtle"),
				fallbackClassName: cn(gradient, SIZE_CLASS[size]),
				attributes: [h.AriaHidden(true)],
			},
			mark,
		)
	return h.span([h.AriaHidden(true), h.Class(cn(base, gradient))], [mark])
}

export const actorAvatar = <M>(
	h: HtmlBuilder<M>,
	actor: ActorDocument,
	size: keyof typeof SIZE_CLASS = "sm",
): Html => identityAvatar(h, resolveActorIdentity(actor), size)

/** `ActorChip`'s empty form. */
export const noActor = <M>(h: HtmlBuilder<M>): Html =>
	h.span([h.Class("text-xs text-muted-foreground")], [EMPTY_VALUE])

/** `ActorChip`: avatar and name; a person outside the directory has no detail, so no tooltip. */
export const actorChip = <M>(h: HtmlBuilder<M>, actor: ActorDocument | null, className?: string): Html => {
	if (actor === null) return noActor(h)
	const identity = resolveActorIdentity(actor)
	return h.span(
		[
			h.Class(
				cn(
					"inline-flex max-w-full items-center gap-1.5 align-middle text-xs",
					identity.kind === "agent" ? AGENT_ACCENT.text : "text-muted-foreground",
					className,
				),
			),
		],
		[identityAvatar(h, identity), h.span([h.Class("truncate font-medium")], [identity.name])],
	)
}
