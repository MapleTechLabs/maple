import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "./avatar-tone"
import { avatarFallback } from "./display"
import { hstack, vstack } from "./stack"
import { typography } from "./typography"

// `PersonAvatar` and `PersonLabel`: a member of the org as a warm initials tile (or their own
// image), alone or beside their name.

const SIZE = { xs: "size-5", sm: "size-6", md: "size-8" } as const

/** A member's avatar: their uploaded image, else the warm initials tile seeded by their name. */
export const personAvatar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ name: string; imageUrl?: string; size?: keyof typeof SIZE; className?: string }>,
): Html =>
	avatarFallback(
		h,
		{
			className: cn(SIZE[options.size ?? "sm"], "shrink-0", options.className),
			fallbackClassName: `font-medium ${warmAvatarTone(options.name)}`,
			imageUrl: options.imageUrl ?? "",
		},
		initialsFrom(options.name),
	)

/** Avatar, name and an optional muted line under it ("until Mon 09:00"), truncating in a row. */
export const personLabel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ name: string; imageUrl?: string; detail?: string; size?: keyof typeof SIZE }>,
): Html =>
	hstack(h, { gap: "2", shrink: true }, [
		personAvatar(h, { name: options.name, imageUrl: options.imageUrl, size: options.size }),
		options.detail === undefined
			? typography(h, { size: "sm", truncate: true }, [options.name])
			: vstack(h, { gap: "0", shrink: true }, [
					typography(h, { size: "sm", truncate: true }, [options.name]),
					typography(h, { size: "xs", tone: "muted", truncate: true, numeric: true }, [
						options.detail,
					]),
				]),
	])

/** Who a person card shows: name, their image and a muted line under it (email or username). */
export type PersonCardPerson = Readonly<{ name: string; imageUrl?: string; detail?: string }>

/** The app tooltip's person card: a larger avatar beside the name and detail. */
export const personCard = <M>(h: HtmlBuilder<M>, person: PersonCardPerson): Html =>
	h.div(
		[h.Class("flex items-center gap-2.5 py-1 pe-1"), h.DataAttribute("slot", "person-card")],
		[
			personAvatar(h, { name: person.name, imageUrl: person.imageUrl, size: "md" }),
			vstack(h, { gap: "0", shrink: true }, [
				typography(h, { size: "sm", weight: "medium", truncate: true }, [person.name]),
				...(person.detail === undefined
					? []
					: [typography(h, { size: "xs", tone: "muted", truncate: true }, [person.detail])]),
			]),
		],
	)

/**
 * A trigger for the app tooltip (`tooltip-host`) that opens the person card. `data-tooltip` keeps
 * the name as the host's text fallback.
 */
export const personTrigger = <M>(
	h: HtmlBuilder<M>,
	person: PersonCardPerson,
): ReadonlyArray<Attribute<M>> => [
	h.DataAttribute("tooltip", person.name),
	h.DataAttribute("tooltip-person", person.name),
	...(person.imageUrl === undefined ? [] : [h.DataAttribute("tooltip-person-image", person.imageUrl)]),
	...(person.detail === undefined ? [] : [h.DataAttribute("tooltip-person-detail", person.detail)]),
]

/**
 * `PersonAvatarStack`: overlapping avatars of the first few people, each opening their person card
 * on hover or focus, then "+N" for the rest of `total`.
 */
export const personAvatarStack = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		people: ReadonlyArray<PersonCardPerson>
		total: number
		max?: number
		label: string
	}>,
): Html => {
	const shown = Arr.take(options.people, options.max ?? 4)
	const rest = Math.max(0, options.total - shown.length)
	return h.div(
		[
			h.Class("flex items-center -space-x-1"),
			h.Role("group"),
			h.AriaLabel(options.label),
			h.DataAttribute("slot", "person-avatar-stack"),
		],
		[
			...Arr.map(shown, (person) =>
				h.span(
					[
						h.Class(
							"relative inline-flex rounded-full ring-2 ring-background outline-none transition-transform hover:z-10 active:z-10 hover:-translate-y-px active:-translate-y-px focus-visible:z-10 focus-visible:ring-ring",
						),
						h.Tabindex(0),
						h.AriaLabel(person.name),
						...personTrigger(h, person),
					],
					[personAvatar(h, { name: person.name, imageUrl: person.imageUrl })],
				),
			),
			...(rest === 0
				? []
				: [
						h.span(
							[
								h.Class(
									"relative flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium tabular-nums text-muted-foreground ring-2 ring-background",
								),
							],
							[`+${rest}`],
						),
					]),
		],
	)
}
