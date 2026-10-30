import { type ChatConnectorManifest, chatConnectorManifests } from "@maple/chat-platform/manifests"
import type { AlertDestinationType } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"
import { manifestGlyph } from "../../../ui/manifest-glyph"
import { LINEAR_ACCENT } from "../../integrations/catalog"

// `PROVIDERS` and `ProviderLogo`: the destination providers and their marks.

const BRANDFETCH_CLIENT_ID = "1id0IQ-4i8Z46-n-DfQ"
const HAZEL_ACCENT_TEXT = "light-dark(#A34209, #F46F0F)"
const INK_ON_DARK_ACCENT = "#FFFFFF"
const INK_ON_BRIGHT_ACCENT = "#1E1B17"

const brandfetchUrl = (domain: string, size = 64): string =>
	`https://cdn.brandfetch.io/${domain}/w/${size}/h/${size}/theme/dark/icon.jpeg?c=${BRANDFETCH_CLIENT_ID}`

export interface DestinationProvider {
	readonly type: AlertDestinationType
	readonly label: string
	readonly description: string
	readonly accent: string
	readonly accentBg: string
	readonly accentOn: string
	readonly accentText?: string
	readonly brandfetchDomain?: string
	readonly monogram?: Readonly<{ letter: string; gradient: readonly [string, string] }>
	readonly fallbackIcon?: IconName
	/** A chat connector's manifest mark, drawn where `fallbackIcon` would be. */
	readonly fallbackGlyph?: ChatConnectorManifest["icon"]
	readonly docsUrl?: string
	readonly docsLabel?: string
}

export const PROVIDERS = new Map<AlertDestinationType, DestinationProvider>([
	[
		"pagerduty",
		{
			type: "pagerduty",
			label: "PagerDuty",
			description: "Trigger incidents with a PagerDuty Events API v2 integration key.",
			accent: "#06AC38",
			accentBg: "rgba(6,172,56,0.16)",
			accentText: "light-dark(#056B2A, #06AC38)",
			accentOn: INK_ON_BRIGHT_ACCENT,
			brandfetchDomain: "pagerduty.com",
			docsUrl: "https://maple.dev/docs/alerting/notification-destinations#pagerduty",
			docsLabel: "PagerDuty setup guide",
		},
	],
	[
		"webhook",
		{
			type: "webhook",
			label: "Webhook",
			description: "POST a signed JSON payload to any HTTP endpoint you control.",
			accent: "#F59E0B",
			accentBg: "rgba(245,158,11,0.16)",
			accentText: "light-dark(#8F5A00, #F59E0B)",
			accentOn: INK_ON_BRIGHT_ACCENT,
			fallbackIcon: "CodeIcon",
		},
	],
	[
		"hazel-oauth",
		{
			type: "hazel-oauth",
			label: "Hazel",
			description: "Connect Hazel via OAuth and pick a workspace to route alerts into.",
			accent: "#F46F0F",
			accentBg: "rgba(244,111,15,0.16)",
			accentText: HAZEL_ACCENT_TEXT,
			accentOn: INK_ON_BRIGHT_ACCENT,
			fallbackIcon: "HazelIcon",
			docsUrl: "https://hazel.sh/docs/integrations/maple",
			docsLabel: "Hazel integration guide",
		},
	],
	[
		"linear",
		{
			type: "linear",
			label: "Linear",
			description: "Open one Linear issue per alert rule in a team, and comment on it as it changes.",
			accent: LINEAR_ACCENT,
			accentBg: "rgba(94,106,213,0.18)",
			accentText: "light-dark(#4651B8, #A9B0F0)",
			accentOn: INK_ON_DARK_ACCENT,
			fallbackIcon: "LinearIcon",
		},
	],
	[
		"discord",
		{
			type: "discord",
			label: "Discord",
			description: "Post alerts to a Discord channel via incoming webhook.",
			accent: "#5865F2",
			accentBg: "rgba(88,101,242,0.18)",
			accentText: "light-dark(#404EED, #C7CDFF)",
			accentOn: INK_ON_DARK_ACCENT,
			fallbackIcon: "DiscordIcon",
			docsUrl: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
			docsLabel: "Discord webhook docs",
		},
	],
	[
		"telegram",
		{
			type: "telegram",
			label: "Telegram",
			description: "Send alerts to a Telegram chat, group, or channel via a bot you create.",
			accent: "#26A5E4",
			accentBg: "rgba(38,165,228,0.16)",
			accentText: "light-dark(#0B6E9E, #26A5E4)",
			accentOn: INK_ON_BRIGHT_ACCENT,
			fallbackIcon: "TelegramIcon",
			docsUrl: "https://maple.dev/docs/alerting/notification-destinations#telegram",
			docsLabel: "Telegram setup guide",
		},
	],
	[
		"google-chat",
		{
			type: "google-chat",
			label: "Google Chat",
			description: "Post alerts to a Google Chat space via incoming webhook.",
			accent: "#00AC47",
			accentBg: "rgba(0,172,71,0.16)",
			accentText: "light-dark(#00762F, #34C26B)",
			accentOn: INK_ON_BRIGHT_ACCENT,
			fallbackIcon: "GoogleChatIcon",
			docsUrl: "https://maple.dev/docs/alerting/notification-destinations#google-chat",
			docsLabel: "Google Chat setup guide",
		},
	],
	[
		"email",
		{
			type: "email",
			label: "Email",
			description: "Send alert notifications to one or more email addresses.",
			accent: "#E8872A",
			accentBg: "rgba(232,135,42,0.16)",
			accentText: "light-dark(#9A4E10, #E8872A)",
			accentOn: INK_ON_BRIGHT_ACCENT,
			fallbackIcon: "EnvelopeIcon",
		},
	],
	[
		"chat",
		{
			type: "chat",
			label: "Chat",
			description: "Post alerts to a channel in a chat workspace linked to Maple.",
			accent: "light-dark(#3F3A33, #D8D2C8)",
			accentBg: "color-mix(in srgb, currentColor 10%, transparent)",
			accentOn: `light-dark(${INK_ON_DARK_ACCENT}, ${INK_ON_BRIGHT_ACCENT})`,
			fallbackIcon: "ChatBubbleIcon",
		},
	],
])

const WEBHOOK = PROVIDERS.get("webhook")
const CHAT = PROVIDERS.get("chat")

/** `CHAT_PROVIDERS`: a `chat` destination drawn as its connector (name, accent and mark). */
const CHAT_PROVIDERS: ReadonlyMap<string, DestinationProvider> = new Map(
	chatConnectorManifests.flatMap((manifest) =>
		CHAT === undefined
			? []
			: [
					[
						manifest.id,
						{
							...CHAT,
							label: manifest.name,
							accent: manifest.accent,
							accentBg: `color-mix(in srgb, ${manifest.accent} 18%, transparent)`,
							fallbackIcon: undefined,
							fallbackGlyph: manifest.icon,
						},
					] as const,
				],
	),
)

/** `destinationProvider`: a `chat` destination's connector, else the type's provider. */
export const destinationProvider = (
	type: AlertDestinationType,
	chatConnector?: string,
): DestinationProvider =>
	(type === "chat" && chatConnector !== undefined ? CHAT_PROVIDERS.get(chatConnector) : undefined) ??
	providerOf(type)

export const providerOf = (type: AlertDestinationType): DestinationProvider =>
	PROVIDERS.get(type) ??
	WEBHOOK ?? {
		type,
		label: type,
		description: "",
		accent: "currentColor",
		accentBg: "transparent",
		accentOn: "",
	}

/** `DESTINATION_TYPES` / `destinationTypesFor`: the provider tiles, in the order people reach for them. */
export const DESTINATION_TYPES: ReadonlyArray<AlertDestinationType> = [
	"pagerduty",
	"email",
	"webhook",
	"telegram",
	"google-chat",
	"hazel-oauth",
	"linear",
]
export const destinationTypesFor = (isDiscordLinked: boolean): ReadonlyArray<AlertDestinationType> =>
	isDiscordLinked ? [...DESTINATION_TYPES, "discord"] : ["discord", ...DESTINATION_TYPES]

export type ProviderLogoOptions<M> = Readonly<{
	type: AlertDestinationType
	/** For a `chat` destination, the connector whose mark to draw. */
	chatConnector?: string
	size?: number
	className?: string
	isBare?: boolean
	/** The brand image failed to load (blocked or 404): the monogram plate shows instead. */
	isLogoBroken: boolean
	/** Omitted where the image already failed elsewhere on the page (a menu over the same logos). */
	onLogoError?: M
}>

/** `ProviderLogo`: the brand image, else a monogram plate, else the provider's icon. */
export const providerLogo = <M>(h: HtmlBuilder<M>, options: ProviderLogoOptions<M>): Html => {
	const provider = destinationProvider(options.type, options.chatConnector)
	const size = options.size ?? 40
	const inner = size - 14
	const content = ((): ReadonlyArray<Html> => {
		if (provider.brandfetchDomain !== undefined && !options.isLogoBroken)
			return [
				h.img([
					h.Src(brandfetchUrl(provider.brandfetchDomain, Math.max(inner * 2, 64))),
					h.Alt(`${provider.label} logo`),
					h.Attribute("width", String(inner)),
					h.Attribute("height", String(inner)),
					h.Attribute("loading", "lazy"),
					h.Attribute("referrerpolicy", "no-referrer"),
					...(options.onLogoError === undefined ? [] : [h.OnError(options.onLogoError)]),
					h.Class("rounded-md object-contain"),
					h.Style({ width: `${inner}px`, height: `${inner}px` }),
				]),
			]
		if (provider.monogram !== undefined || options.isLogoBroken) {
			const mono = provider.monogram ?? {
				letter: provider.label.slice(0, 1),
				gradient: [provider.accent, provider.accent] as const,
			}
			return [
				h.span(
					[
						h.Class("flex items-center justify-center rounded-md font-semibold"),
						h.Style({
							width: `${inner}px`,
							height: `${inner}px`,
							"font-size": `${Math.round(inner * 0.55)}px`,
							background: `linear-gradient(135deg, ${mono.gradient[0]}, ${mono.gradient[1]})`,
							color: provider.accentOn,
						}),
					],
					[mono.letter],
				),
			]
		}
		if (provider.fallbackGlyph !== undefined)
			return [
				h.span(
					[
						h.Class("flex items-center justify-center rounded-md"),
						h.Style({ width: `${inner}px`, height: `${inner}px`, color: provider.accent }),
					],
					[manifestGlyph(h, provider.fallbackGlyph, Math.round(inner * 0.65))],
				),
			]
		if (provider.fallbackIcon !== undefined)
			return [
				h.span(
					[
						h.Class("flex items-center justify-center rounded-md"),
						h.Style({ width: `${inner}px`, height: `${inner}px`, color: provider.accent }),
					],
					[icon(h, provider.fallbackIcon, { size: Math.round(inner * 0.65) })],
				),
			]
		return []
	})()
	if (options.isBare === true)
		return h.span(options.className === undefined ? [] : [h.Class(options.className)], content)
	return h.span(
		[
			h.Class(
				cn(
					"relative inline-flex shrink-0 items-center justify-center rounded-md border border-border/60 bg-card",
					options.className,
				),
			),
			h.Style({ width: `${size}px`, height: `${size}px` }),
		],
		[
			h.span([
				h.AriaHidden(true),
				h.Class("absolute inset-0 rounded-md opacity-70"),
				h.Style({
					background: `radial-gradient(circle at 30% 20%, ${provider.accentBg}, transparent 70%)`,
				}),
			]),
			h.span([h.Class("relative")], content),
		],
	)
}
