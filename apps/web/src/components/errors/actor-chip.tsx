import type { ActorDocument } from "@maple/domain/http"
import { internalAgentLabel } from "@maple/domain/system-agents"
import { MapleMark } from "@maple/ui/components/icons/maple-mark"
import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { initialsFrom } from "@maple/ui/lib/initials"
import { gradientFor } from "@maple/ui/lib/replay"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { AGENT_ACCENT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { FaceRobotIcon } from "@/components/icons"
import { shortId, useActorDirectory, type ActorDirectory } from "@/hooks/use-actor-directory"

/**
 * What an actor looks like once the raw event row has been joined against the
 * workspace directory: a name a human recognises, plus the one detail worth
 * carrying next to it (the model for an agent, the email for a person).
 */
export interface ActorIdentity {
	readonly kind: "user" | "agent"
	/** One of Maple's own subsystems (triage, alerts, …) — rendered with the Maple mark. */
	readonly internal: boolean
	readonly name: string
	readonly detail: string | null
	readonly imageUrl: string | null
	readonly initials: string
	/** Stable seed for the fallback avatar gradient. */
	readonly seed: string
}

export function resolveActorIdentity(actor: ActorDocument, directory: ActorDirectory): ActorIdentity {
	if (actor.type === "agent") {
		const label = actor.agentName ? internalAgentLabel(actor.agentName) : null
		const name = label ?? actor.agentName ?? "Agent"
		return {
			kind: "agent",
			internal: label !== null,
			name,
			// First-party agents show a friendly label, so surface the raw actor
			// name where the model would otherwise go — the audit trail stays legible.
			detail: actor.model ?? (label ? actor.agentName : null),
			imageUrl: null,
			initials: initialsFrom(name),
			seed: actor.agentName ?? actor.id,
		}
	}
	const person = actor.userId ? directory.lookup(actor.userId) : null
	if (person) {
		return {
			kind: "user",
			internal: false,
			name: person.name,
			// Don't repeat the email as the detail when it IS the display name.
			detail: person.email === person.name ? null : person.email,
			imageUrl: person.imageUrl,
			initials: initialsFrom(person.name),
			seed: person.userId,
		}
	}
	// Not in the directory: a removed member, a self-hosted deployment with no
	// member API, or the page rendering before Clerk answers. Six characters of
	// id beats thirty-two, and the tooltip still carries the whole thing.
	const raw = actor.userId ?? actor.id
	return {
		kind: "user",
		internal: false,
		name: shortId(raw),
		detail: null,
		imageUrl: null,
		initials: raw
			.replace(/^user_/, "")
			.slice(0, 2)
			.toUpperCase(),
		seed: raw,
	}
}

export function useActorIdentity(actor: ActorDocument | null): ActorIdentity | null {
	const directory = useActorDirectory()
	return actor ? resolveActorIdentity(actor, directory) : null
}

const SIZE_CLASS = {
	sm: "size-5 text-4xs",
	md: "size-7 text-2xs",
} as const

/**
 * Round avatar for an actor. People get their Clerk photo, or a per-user
 * gradient with initials — the same identity treatment the Sessions list uses,
 * so the same person looks the same across the product. Agents render in the
 * agent accent that already means "not a human" everywhere in this timeline: Maple's
 * own subsystems carry the Maple mark, third-party agents the robot.
 */
export function ActorAvatar({
	actor,
	size = "sm",
	className,
}: {
	actor: ActorDocument | null
	size?: keyof typeof SIZE_CLASS
	className?: string
}) {
	const identity = useActorIdentity(actor)
	if (!identity) return null
	return <IdentityAvatar className={className} identity={identity} size={size} />
}

export function IdentityAvatar({
	identity,
	size = "sm",
	className,
}: {
	identity: ActorIdentity
	size?: keyof typeof SIZE_CLASS
	className?: string
}) {
	const base = cn(
		"inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
		SIZE_CLASS[size],
		className,
	)

	if (identity.kind === "agent") {
		return (
			<span aria-hidden className={cn(base, AGENT_ACCENT.soft, AGENT_ACCENT.ring)}>
				{identity.internal ? (
					// The mark's trunk runs to the viewBox edge, so nudge it up a
					// touch to sit optically centred in the circle.
					<MapleMark className="size-[54%] -translate-y-[4%]" />
				) : (
					<FaceRobotIcon className="size-[62%]" strokeWidth={2} />
				)}
			</span>
		)
	}

	if (identity.imageUrl) {
		// Avatar falls back to the initials when the photo 404s.
		return (
			<Avatar aria-hidden className={cn(base, "ring-1 ring-border/60")}>
				<AvatarImage alt="" src={identity.imageUrl} />
				<AvatarFallback
					className={cn(
						"bg-gradient-to-br text-white",
						SIZE_CLASS[size],
						gradientFor(identity.seed),
					)}
				>
					{identity.initials}
				</AvatarFallback>
			</Avatar>
		)
	}

	return (
		<span aria-hidden className={cn(base, "bg-gradient-to-br text-white", gradientFor(identity.seed))}>
			{identity.initials}
		</span>
	)
}

/**
 * Inline "who did this" label. Avatar plus name, with the model or email in a
 * tooltip rather than crowding the row — every timeline row has one of these, so
 * the chip has to be quiet enough to read past.
 */
export function ActorChip({
	actor,
	className,
	showAvatar = true,
}: {
	actor: ActorDocument | null
	className?: string
	showAvatar?: boolean
}) {
	const identity = useActorIdentity(actor)
	if (!identity) {
		return <span className="text-xs text-muted-foreground">{EMPTY_VALUE}</span>
	}

	const chipClass = cn(
		"inline-flex max-w-full items-center gap-1.5 align-middle text-xs",
		identity.kind === "agent" ? AGENT_ACCENT.text : "text-muted-foreground",
		className,
	)
	const body = (
		<>
			{showAvatar ? <IdentityAvatar identity={identity} /> : null}
			<span className="truncate font-medium">{identity.name}</span>
		</>
	)

	if (!identity.detail) return <span className={chipClass}>{body}</span>

	return (
		<Tooltip>
			<TooltipTrigger render={<span className={cn(chipClass, "cursor-default")} />}>
				{body}
			</TooltipTrigger>
			<TooltipPopup>{identity.detail}</TooltipPopup>
		</Tooltip>
	)
}
