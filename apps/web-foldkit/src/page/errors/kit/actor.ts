import type { ActorDocument } from "@maple/domain/http"
import { internalAgentLabel } from "@maple/domain/system-agents"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { initialsFrom } from "@maple/ui/lib/initials"
import { gradientFor } from "@maple/ui/lib/replay"
import { AGENT_ACCENT } from "@maple/ui/lib/tone"
import { shortId as truncateId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"

// `ActorAvatar` / `ActorChip` (apps/web/src/components/errors/actor-chip.tsx).
// TODO(actor-directory): people resolve through the Clerk member directory in legacy; here every
// person renders as their short id, which is legacy's fallback for an unknown member.

export interface ActorIdentity {
	readonly kind: "user" | "agent"
	readonly internal: boolean
	readonly name: string
	readonly initials: string
	readonly seed: string
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
			initials: initialsFrom(name),
			seed: actor.agentName ?? actor.id,
		}
	}
	const raw = actor.userId ?? actor.id
	return {
		kind: "user",
		internal: false,
		name: shortId(raw),
		initials: raw
			.replace(/^user_/, "")
			.slice(0, 2)
			.toUpperCase(),
		seed: raw,
	}
}

const SIZE_CLASS = { sm: "size-5 text-4xs", md: "size-7 text-2xs" } as const

export const identityAvatar = <M>(
	h: HtmlBuilder<M>,
	identity: ActorIdentity,
	size: keyof typeof SIZE_CLASS = "sm",
): Html => {
	const base = cn(
		"inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
		SIZE_CLASS[size],
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
	return h.span(
		[h.AriaHidden(true), h.Class(cn(base, "bg-gradient-to-br text-white", gradientFor(identity.seed)))],
		[identity.initials],
	)
}

export const actorAvatar = <M>(
	h: HtmlBuilder<M>,
	actor: ActorDocument,
	size: keyof typeof SIZE_CLASS = "sm",
): Html => identityAvatar(h, resolveActorIdentity(actor), size)

/** `ActorChip`'s empty form. */
export const noActor = <M>(h: HtmlBuilder<M>): Html =>
	h.span([h.Class("text-xs text-muted-foreground")], [EMPTY_VALUE])
