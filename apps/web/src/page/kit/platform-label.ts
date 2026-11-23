import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "@maple/views/ui/icon"
import { hstackClass } from "@maple/views/ui/stack"
import { String as Str } from "effect"

export type PlatformKind = "os" | "arch" | "cloud"

type Known = Readonly<{ icon?: IconName; label: string; color?: string }>

// Keys as OpenTelemetry's `os.type` and device management tools spell them.
const OS = new Map<string, Known>([
	["linux", { icon: "LinuxIcon", label: "Linux" }],
	["darwin", { icon: "AppleIcon", label: "macOS" }],
	["windows", { icon: "MicrosoftIcon", label: "Windows", color: "var(--color-brand-microsoft)" }],
	["ios", { icon: "AppleIcon", label: "iOS" }],
	["ipados", { icon: "AppleIcon", label: "iPadOS" }],
	["android", { icon: "AndroidIcon", label: "Android" }],
	["chrome", { icon: "ChromeIcon", label: "ChromeOS" }],
])

const CLOUD = new Map<string, Known>([
	["aws", { icon: "AwsIcon", label: "AWS" }],
	["gcp", { icon: "GoogleCloudIcon", label: "GCP" }],
	["azure", { icon: "AzureIcon", label: "Azure" }],
])

const resolve = (kind: PlatformKind, value: string): Known => {
	const key = Str.toLowerCase(value)
	if (kind === "arch") return { icon: "MicrochipIcon", label: key }
	return (kind === "os" ? OS : CLOUD).get(key) ?? { label: value }
}

/** An operating system's name ("macOS" for `darwin`), or undefined for one with no mark. */
export const osName = (value: string): string | undefined => OS.get(Str.toLowerCase(value))?.label

/** An operating system, CPU architecture or cloud as its mark beside its name; just the value when it has no mark. */
export const platformLabel = <M>(h: HtmlBuilder<M>, kind: PlatformKind, value: string): Html => {
	const known = resolve(kind, value)
	return h.span(
		[h.Class(cn(hstackClass({ gap: "1", inline: true })))],
		[
			...(known.icon === undefined
				? []
				: [
						known.color === undefined
							? icon(h, known.icon, {
									size: 12,
									className: cn("shrink-0", "text-foreground-soft"),
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
