import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"

// `MetaLine` and `PlatformLabel`.

/** An item: plain text (capped and titled) or a node. Absent items are dropped. */
export type MetaItem = Html | string | null | undefined | false

export const metaLine = <M>(
	h: HtmlBuilder<M>,
	items: ReadonlyArray<MetaItem>,
	options: Readonly<{ title?: string; className?: string }> = {},
): Html => {
	const present = items.filter(
		(item): item is Html | string => item !== null && item !== undefined && item !== false && item !== "",
	)
	if (present.length === 0) return null
	const texts = present.filter((item): item is string => typeof item === "string")
	const derivedTitle = texts.length === present.length ? texts.join(" · ") : undefined
	const title = options.title ?? derivedTitle
	return h.div(
		[
			h.Class(
				cn(
					"mt-1 flex min-w-0 items-center gap-x-2 truncate font-mono text-xs text-muted-foreground/80",
					options.className,
				),
			),
			...(title === undefined ? [] : [h.Title(title)]),
		],
		present.map((item, index) =>
			h.span(
				[h.Class("flex shrink-0 items-center gap-x-2")],
				[
					...(index > 0 ? [h.span([h.Class("text-foreground/20")], ["·"])] : []),
					typeof item === "string" ? h.span([h.Class("max-w-[28ch] truncate")], [item]) : item,
				],
			),
		),
	)
}

export type PlatformKind = "os" | "arch" | "cloud"

type Known = Readonly<{ icon?: IconName; label: string; color?: string }>

const OS = new Map<string, Known>([
	["linux", { icon: "LinuxIcon", label: "Linux" }],
	["darwin", { icon: "AppleIcon", label: "macOS" }],
	["windows", { icon: "MicrosoftIcon", label: "Windows", color: "#0078D4" }],
])

const CLOUD = new Map<string, Known>([
	["aws", { icon: "AwsIcon", label: "AWS" }],
	["gcp", { icon: "GoogleCloudIcon", label: "GCP" }],
	["azure", { icon: "AzureIcon", label: "Azure" }],
])

const resolve = (kind: PlatformKind, value: string): Known => {
	const key = value.toLowerCase()
	if (kind === "arch") return { icon: "MicrochipIcon", label: key }
	return (kind === "os" ? OS : CLOUD).get(key) ?? { label: value }
}

export const platformLabel = <M>(h: HtmlBuilder<M>, kind: PlatformKind, value: string): Html => {
	const known = resolve(kind, value)
	return h.span(
		[h.Class(cn("inline-flex items-center gap-1"))],
		[
			...(known.icon === undefined
				? []
				: [
						known.color === undefined
							? icon(h, known.icon, {
									size: 12,
									className: cn("shrink-0", "text-foreground/70"),
								})
							: icon(h, known.icon, {
									size: 12,
									className: cn("shrink-0"),
									style: { color: known.color },
								}),
					]),
			known.label,
		],
	)
}
