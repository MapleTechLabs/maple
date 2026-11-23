import { cn } from "@maple/ui/lib/utils"
import { sheetTitleStyles } from "@maple/views/ui/sheet.styles"
import { linkButton } from "@maple/views/ui/button"
import * as ContextMenu from "@maple/views/ui/context-menu"
import * as ContextMenuView from "@maple/views/ui/context-menu-view"
import { MapleMark } from "@maple/views/ui/control-icons"
import * as Dialog from "@maple/views/ui/dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { iconNode, type IconNode } from "@maple/views/ui/icon-node"
import type { IconName } from "@maple/views/ui/icons.generated"
import * as NavigationMenu from "@maple/views/ui/navigation-menu"
import { Effect, Queue, Schema, Stream, Array as Arr } from "effect"
import { Command, Mount, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../foldkit-island/island"
import { brandMark, markColor, type BrandMarkId } from "../lib/brand-marks"
import { APP_SIGN_IN_URL, APP_SIGN_UP_URL, APP_URL } from "../lib/app-urls"
import { watchSignedInUser } from "../lib/clerk-session"
import { featureBySlug, features } from "../lib/features"
import { isPillar, PILLARS, type PillarIcon } from "../lib/feature-pillars"
import { NAV_ICONS, RESOURCE_ICONS, type ResourceIcon } from "../lib/nav-icons"
import { formatStars, GITHUB_REPO_URL, OCTOCAT_PATH } from "../lib/github-stars"
import { featurePath, featuresIndexPath, useCasePath } from "../lib/page-registry"
import { identifyLanding, trackLanding } from "../lib/telemetry"
import { useCases } from "../lib/use-cases"
import * as m from "../paraglide/messages.js"
import { broadcastSignedIn } from "./auth-signal"

/**
 * The site header on every page: the mega-menu (desktop), the menu sheet (below `lg`), the
 * logo's brand-asset menu, and the Log in / CTA pair that follows the visitor's Clerk session.
 */

// LINKS

/** `mark` is a vendor's brand mark, shown beside the label (the compare links). */
type MenuLink = Readonly<{ href: string; label: () => string; desc?: () => string; mark?: BrandMarkId }>

const localized = (locale: string, path: string): string => (locale === "en" ? path : `/${locale}${path}`)

type PillarLink = MenuLink & Readonly<{ icon: PillarIcon }>

// From the registry, so a renamed or retired feature cannot leave a dead pillar behind.
// Labels stay thunks: Paraglide resolves the locale per call, at render.
const pillarLinks = (locale: string): ReadonlyArray<PillarLink> =>
	Arr.flatMap(PILLARS, ({ slug, icon }) => {
		const feature = featureBySlug(slug)
		return feature === undefined
			? []
			: [
					{
						href: featurePath(locale, slug),
						label: feature.navLabel,
						desc: feature.navDesc,
						icon,
					},
				]
	})

/** Every feature that is not a pillar, then Maple Local. */
const moreLinks = (locale: string): ReadonlyArray<MenuLink> => [
	...Arr.map(
		Arr.filter(features, (feature) => !isPillar(feature.slug)),
		(feature) => ({ href: featurePath(locale, feature.slug), label: feature.navLabel }),
	),
	{ href: localized(locale, "/local"), label: () => m.nav_local() },
]

const useCaseLinks = (locale: string): ReadonlyArray<MenuLink> =>
	Arr.map(useCases, (useCase) => ({
		href: useCasePath(locale, useCase.slug),
		label: useCase.navLabel,
		desc: useCase.navDesc,
	}))

const integrationLinks = (locale: string): ReadonlyArray<MenuLink> => [
	{
		href: localized(locale, "/integrations"),
		label: () => m.nav_all_integrations(),
		desc: () => m.nav_desc_all_integrations(),
	},
	{
		href: localized(locale, "/integrations/nextjs"),
		label: () => m.nav_nextjs(),
		desc: () => m.nav_desc_nextjs(),
	},
	{
		href: localized(locale, "/integrations/python"),
		label: () => m.nav_python(),
		desc: () => m.nav_desc_python(),
	},
	{
		href: localized(locale, "/integrations/nodejs"),
		label: () => m.nav_nodejs(),
		desc: () => m.nav_desc_nodejs(),
	},
]

// Brand names, not translated; the "Switching from" heading carries the comparison.
const COMPARE: ReadonlyArray<Readonly<{ slug: string; mark: BrandMarkId; name: string }>> = [
	{ slug: "datadog", mark: "datadog", name: "Datadog" },
	{ slug: "grafana", mark: "grafana", name: "Grafana" },
	{ slug: "new-relic", mark: "newrelic", name: "New Relic" },
	{ slug: "honeycomb", mark: "honeycomb", name: "Honeycomb" },
	{ slug: "signoz", mark: "signoz", name: "SigNoz" },
	{ slug: "axiom", mark: "axiom", name: "Axiom" },
	{ slug: "better-stack", mark: "betterstack", name: "Better Stack" },
	{ slug: "dash0", mark: "dash0", name: "Dash0" },
]

const compareLinks = (locale: string): ReadonlyArray<MenuLink> =>
	Arr.map(COMPARE, ({ slug, mark, name }) => ({
		href: localized(locale, `/compare/${slug}`),
		label: () => name,
		mark,
	}))

type ResourceLink = MenuLink & Readonly<{ icon: ResourceIcon }>

const resourceLinks = (locale: string): ReadonlyArray<ResourceLink> => [
	{
		href: "/guides",
		label: () => m.nav_guides(),
		desc: () => m.nav_desc_guides(),
		icon: "BookBookmarkIcon",
	},
	{ href: "/blog", label: () => m.nav_blog(), desc: () => m.nav_desc_blog(), icon: "PenWritingIcon" },
	{
		href: "/changelog",
		label: () => m.nav_changelog(),
		desc: () => m.nav_desc_changelog(),
		icon: "CircleHalfDottedClockIcon",
	},
	{
		href: "/customers",
		label: () => m.nav_customers(),
		desc: () => m.nav_desc_customers(),
		icon: "UsersIcon",
	},
	{
		href: localized(locale, "/roadmap"),
		label: () => m.footer_roadmap(),
		desc: () => m.nav_desc_roadmap(),
		icon: "RoadmapIcon",
	},
	{
		href: localized(locale, "/opentelemetry"),
		label: () => m.footer_opentelemetry(),
		desc: () => m.nav_desc_opentelemetry(),
		icon: "PlugIcon",
	},
]

/** The plain links after the menus, in the header and the sheet. */
const pageLinks = (locale: string): ReadonlyArray<Readonly<{ href: string; label: string }>> => [
	{ href: "/docs", label: m.nav_docs() },
	{ href: localized(locale, "/pricing"), label: m.nav_pricing() },
]

// MODEL

const Model = Schema.Struct({
	locale: Schema.String,
	stars: Schema.NullOr(Schema.Number),
	menu: NavigationMenu.Model,
	sheet: Dialog.Model,
	logoMenu: ContextMenu.Model,
	/** Null until Clerk names a user; `isAnnounced` once the header told the page either way. */
	userId: Schema.NullOr(Schema.String),
	isAnnounced: Schema.Boolean,
	/** Below `sm`, while the page's hero CTA is on screen. */
	isCtaCollapsed: Schema.Boolean,
})
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	GotMenuMessage: { message: NavigationMenu.Message },
	GotSheetMessage: { message: Dialog.Message },
	GotLogoMenuMessage: { message: ContextMenu.Message },
	ClickedSheetLink: {},
	ChangedSignedInUser: { userId: Schema.NullOr(Schema.String) },
	ChangedCtaCollapsed: { isCollapsed: Schema.Boolean },
	CompletedSideEffect: {},
})
type Message = typeof Message.Type

// COMMANDS

/** Tells the hero CTA and late islands (`maple:signed-in`), and names the session's visitor. */
const AnnounceSignedInUser = Command.define("AnnounceSignedInUser", {
	args: { userId: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedSideEffect],
	execute: ({ userId }) =>
		Effect.sync(() => {
			broadcastSignedIn(userId !== null)
			// The only place Clerk runs on the site, so the only place that can name the visitor.
			identifyLanding(userId)
			return Message.CompletedSideEffect()
		}),
})

const MARK_SVG = "/brand/logo/maple-mark-amber.svg"
const BRAND_KIT = "/brand/maple-brand-kit.zip"

class BrandAssetLoadError extends Schema.TaggedError<BrandAssetLoadError>()(
	"@maple/landing/BrandAssetLoadError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

const CopyMark = Command.define("CopyMapleMarkSvg", {
	messages: [Message.CompletedSideEffect],
	// A chunk that no longer loads (a deploy since, offline) counts as a failed copy.
	execute: Effect.tryPromise({
		try: () => import("../lib/copy-brand-asset"),
		catch: (cause) => new BrandAssetLoadError({ message: "Couldn't load the brand copy module", cause }),
	}).pipe(
		Effect.flatMap(({ copyBrandAsset }) => copyBrandAsset(MARK_SVG)),
		Effect.orElseSucceed(() => false),
		Effect.map((copied) => {
			trackLanding("brand_asset_copied", { asset: MARK_SVG, copied })
			return Message.CompletedSideEffect()
		}),
	),
})

// A synthesised `download` anchor: the menu item stays one interactive role, not a link in a button.
const DownloadAsset = Command.define("DownloadBrandAsset", {
	args: { href: Schema.String },
	messages: [Message.CompletedSideEffect],
	execute: ({ href }) =>
		Effect.sync(() => {
			trackLanding("brand_asset_downloaded", { asset: href })
			const anchor = document.createElement("a")
			anchor.href = href
			anchor.download = ""
			anchor.click()
			return Message.CompletedSideEffect()
		}),
})

const OpenBrandPage = Command.define("OpenBrandPage", {
	messages: [Message.CompletedSideEffect],
	execute: Effect.sync(() => {
		window.location.assign("/brand")
		return Message.CompletedSideEffect()
	}),
})

// MOUNTS

const WatchSignedInUser = Mount.defineStream("WatchSignedInUser", {
	messages: [Message.ChangedSignedInUser],
	execute: () => watchSignedInUser.pipe(Stream.map((userId) => Message.ChangedSignedInUser({ userId }))),
})

/**
 * Collapses the header CTA below `sm` while the page's hero CTA (`[data-hero-cta]`) is on screen;
 * from `sm` up, and on pages without one, it always shows.
 */
const WatchHeroCta = Mount.defineStream("WatchHeroCta", {
	messages: [Message.ChangedCtaCollapsed],
	execute: () =>
		Stream.callback<typeof Message.ChangedCtaCollapsed.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const target = document.querySelector("[data-hero-cta]")
					const desktop = window.matchMedia("(min-width: 640px)")
					let isHeroVisible = false
					const emit = () =>
						Queue.offerUnsafe(
							queue,
							Message.ChangedCtaCollapsed({ isCollapsed: isHeroVisible && !desktop.matches }),
						)
					const observer = new IntersectionObserver(([entry]) => {
						isHeroVisible = entry?.isIntersecting ?? false
						emit()
					})
					if (target !== null) {
						observer.observe(target)
						desktop.addEventListener("change", emit)
					}
					return { observer, desktop, emit }
				}),
				({ observer, desktop, emit }) =>
					Effect.sync(() => {
						observer.disconnect()
						desktop.removeEventListener("change", emit)
					}),
			).pipe(Effect.andThen(Effect.never)),
		),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const toMenu = Command.mapMessage((message: NavigationMenu.Message) => Message.GotMenuMessage({ message }))
const toSheet = Command.mapMessage((message: Dialog.Message) => Message.GotSheetMessage({ message }))
const toLogoMenu = Command.mapMessage((message: ContextMenu.Message) =>
	Message.GotLogoMenuMessage({ message }),
)

/** The logo menu: each item and what picking it does (`null` draws the separator). */
const LOGO_MENU: ReadonlyArray<Readonly<{ label: string; pick: () => Command.Command<Message> }> | null> = [
	{ label: "Copy logo as SVG", pick: () => CopyMark() },
	{ label: "Download logo (SVG)", pick: () => DownloadAsset({ href: MARK_SVG }) },
	{ label: "Download brand kit (.zip)", pick: () => DownloadAsset({ href: BRAND_KIT }) },
	null,
	{ label: "Brand guidelines", pick: () => OpenBrandPage() },
]

const logoMenuStep = (model: Model, child: ContextMenu.Message): UpdateReturn => {
	const next = ContextMenu.update(model.logoMenu, child)
	const picked =
		next.outMessage?._tag === "SelectedItem" ? LOGO_MENU[next.outMessage.index]?.pick() : undefined
	return {
		model: { ...model, logoMenu: next.model },
		commands: [...Arr.map(next.commands ?? [], toLogoMenu), ...(picked === undefined ? [] : [picked])],
	}
}

const sheetStep = (
	model: Model,
	next: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
): UpdateReturn => ({
	model: { ...model, sheet: next.model },
	commands: Arr.map(next.commands ?? [], toSheet),
})

const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotMenuMessage: ({ message: child }) => {
			const next = NavigationMenu.update(model.menu, child)
			return { model: { ...model, menu: next.model }, commands: Arr.map(next.commands ?? [], toMenu) }
		},
		GotSheetMessage: ({ message: child }) => sheetStep(model, Dialog.update(model.sheet, child)),
		GotLogoMenuMessage: ({ message: child }) => logoMenuStep(model, child),
		// The link navigates on its own; the sheet just closes.
		ClickedSheetLink: () => sheetStep(model, Dialog.close(model.sheet)),
		// `useAuth` re-renders on every Clerk emit; the page only hears about changes.
		ChangedSignedInUser: ({ userId }) =>
			model.isAnnounced && userId === model.userId
				? { model }
				: {
						model: { ...model, userId, isAnnounced: true },
						commands: [AnnounceSignedInUser({ userId })],
					},
		ChangedCtaCollapsed: ({ isCollapsed }) => ({ model: { ...model, isCtaCollapsed: isCollapsed } }),
		CompletedSideEffect: () => ({ model }),
	})

// VIEW

type H = HtmlBuilder<Message>

const MENU_ID = "site-nav"
const SHEET_ID = "site-nav-sheet"
const LOGO_MENU_ID = "site-logo-menu"

/** `BrandMarkIcon.astro`'s markup, for the menu's compare links. */
const brandMarkSvg = (h: H, id: BrandMarkId, className: string): Html => {
	const mark = brandMark(id)
	const paths =
		mark.layers === undefined
			? [
					h.path(
						[
							h.Attribute("d", mark.path),
							...(mark.fillRule === undefined ? [] : [h.Attribute("fill-rule", mark.fillRule)]),
						],
						[],
					),
				]
			: Arr.map(mark.layers, (layer) =>
					h.path([h.Attribute("d", layer.path), h.Attribute("fill", layer.fill)], []),
				)
	const overlay =
		mark.overlay === undefined
			? []
			: [
					h.path(
						[
							h.Attribute("d", mark.overlay.path),
							h.Attribute("fill", mark.overlay.fill),
							...(mark.overlay.fillRule === undefined
								? []
								: [h.Attribute("fill-rule", mark.overlay.fillRule)]),
						],
						[],
					),
				]
	return h.svg(
		[
			h.Class(className),
			h.Attribute("viewBox", mark.viewBox ?? "0 0 24 24"),
			h.Attribute("fill", "currentColor"),
			h.Style({ color: markColor(mark) }),
			h.AriaHidden(true),
		],
		[...paths, ...overlay],
	)
}

const octocat = (h: H, className: string): Html =>
	h.svg(
		[
			h.Class(className),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("fill", "currentColor"),
			h.AriaHidden(true),
		],
		[h.path([h.Attribute("d", OCTOCAT_PATH)], [])],
	)

/** `GithubStarButton.astro`'s markup; `className` carries the flex display. */
const starButton = (h: H, stars: number | null, className: string): Html =>
	stars === null
		? h.a(
				[
					h.Href(GITHUB_REPO_URL),
					h.Target("_blank"),
					h.Rel("noopener noreferrer"),
					h.AriaLabel("GitHub"),
					h.Class(`items-center text-fg-muted transition-colors hover:text-fg ${className}`),
				],
				[octocat(h, "w-4 h-4")],
			)
		: h.a(
				[
					h.Href(GITHUB_REPO_URL),
					h.Target("_blank"),
					h.Rel("noopener noreferrer"),
					h.AriaLabel(`Star Maple on GitHub, ${formatStars(stars)} stars`),
					h.Class(
						`items-stretch h-7 overflow-hidden rounded-lg border border-border text-fg-muted transition-colors hover:border-fg-muted/40 hover:text-fg ${className}`,
					),
				],
				[
					h.span([h.Class("flex items-center px-2.5")], [octocat(h, "w-4 h-4")]),
					h.span(
						[
							h.Class(
								"flex items-center border-l border-border px-2.5 text-xs font-medium tabular-nums",
							),
						],
						[formatStars(stars)],
					),
				],
			)

/**
 * The href flips with the label: signed out, "Get started" has to name `/sign-up`, because the app
 * root sends a session-less visitor to `/sign-in`. The track label tells a conversion from a return.
 */
const ctaButton = (
	h: H,
	options: Readonly<{ isSignedIn: boolean; location: string; className?: string; isHidden?: boolean }>,
): Html => {
	const href = options.isSignedIn ? APP_URL : APP_SIGN_UP_URL
	const label = options.isSignedIn ? m.nav_dashboard() : m.nav_get_started()
	return linkButton(
		h,
		{
			size: "lg",
			href,
			className: options.className,
			attributes: [
				h.DataAttribute("track", "cta_click"),
				h.DataAttribute("track-location", options.location),
				h.DataAttribute("track-label", label),
				h.DataAttribute("track-destination", href),
				...(options.isHidden === true ? [h.AriaHidden(true), h.Tabindex(-1)] : []),
			],
		},
		[label],
	)
}

const eyebrow = (h: H, text: string): Html =>
	h.div(
		[h.Class("px-2")],
		[h.span([h.Class("text-[11px] uppercase tracking-wider font-medium text-primary")], [text])],
	)

const linkLabel = (h: H, link: MenuLink, className: string): Html =>
	h.span(
		[h.Class(className)],
		[
			...(link.mark === undefined ? [] : [brandMarkSvg(h, link.mark, "h-3.5 w-3.5 shrink-0")]),
			link.label(),
		],
	)

const megaLink = (h: H, link: MenuLink): Html =>
	NavigationMenu.navigationMenuLink(
		h,
		link.href,
		[
			linkLabel(
				h,
				link,
				"inline-flex items-center gap-1.5 text-[13px] font-medium text-fg transition-colors group-hover/link:text-primary",
			),
			...(link.desc === undefined
				? []
				: [h.span([h.Class("text-[11px] leading-snug text-fg-muted")], [link.desc()])]),
		],
		"group/link flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 hover:bg-muted/20",
	)

const megaColumn = (
	h: H,
	group: Readonly<{ title: string; lead?: string; links: ReadonlyArray<MenuLink> }>,
	className?: string,
): Html =>
	h.div(
		[h.Class(cn("px-2 py-4", className))],
		[
			eyebrow(h, group.title),
			...(group.lead === undefined
				? []
				: [h.p([h.Class("px-2 pt-0.5 text-[11px] leading-snug text-fg-muted")], [group.lead])]),
			h.div(
				[h.Class("mt-2 flex flex-col gap-0.5")],
				Arr.map(group.links, (link) => megaLink(h, link)),
			),
		],
	)

/** A link with its icon in a bordered square, the label and a two-line description beside it. */
const iconTile = (h: H, link: MenuLink, icon: IconNode, iconName: IconName): Html =>
	NavigationMenu.navigationMenuLink(
		h,
		link.href,
		[
			h.span(
				[
					h.Class(
						"flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-fg-muted transition-colors group-hover/pillar:border-primary/40 group-hover/pillar:text-primary",
					),
				],
				[iconNode(h, icon, iconName, { size: 16 })],
			),
			h.span(
				[h.Class("flex min-w-0 flex-col gap-0.5")],
				[
					h.span([h.Class("text-[13px] font-medium text-fg")], [link.label()]),
					...(link.desc === undefined
						? []
						: [
								h.span(
									[h.Class("line-clamp-2 text-[11px] leading-snug text-fg-muted")],
									[link.desc()],
								),
							]),
				],
			),
		],
		"group/pillar flex flex-row items-start gap-3 rounded-lg p-2.5 hover:bg-muted/20",
	)

const pillarTile = (h: H, link: PillarLink): Html => iconTile(h, link, NAV_ICONS[link.icon], link.icon)

const resourceTile = (h: H, link: ResourceLink): Html =>
	iconTile(h, link, RESOURCE_ICONS[link.icon], link.icon)

const alsoLink = (h: H, link: MenuLink): Html =>
	NavigationMenu.navigationMenuLink(
		h,
		link.href,
		[link.label()],
		"inline-flex w-auto flex-none rounded-md px-2 py-1 text-xs font-medium text-fg-muted hover:bg-muted/20 hover:text-fg",
	)

const menuFooter = (h: H, href: string, label: string, cta: string): Html =>
	NavigationMenu.navigationMenuLink(
		h,
		href,
		[
			h.span([h.Class("text-xs text-fg-muted")], [label]),
			h.span(
				[
					h.Class(
						"inline-flex items-center gap-1 text-xs text-primary transition-transform group-hover/cta:translate-x-0.5",
					),
				],
				[cta],
			),
		],
		"group/cta flex items-center justify-between rounded-none border-t border-border px-4 py-3 hover:bg-muted/20",
	)

/** Nine pillars, the rest of the platform as one quiet line, the way to all of it below. */
const productMenu = (h: H, locale: string): ReadonlyArray<Html> => [
	h.div(
		[h.Class("w-[840px] max-w-[calc(100vw-1.5rem)]")],
		[
			h.div(
				[h.Class("grid grid-cols-3 gap-1 p-3")],
				Arr.map(pillarLinks(locale), (link) => pillarTile(h, link)),
			),
			h.div(
				[h.Class("border-t border-border px-4 py-3")],
				[
					h.span(
						[h.Class("text-[11px] uppercase tracking-wider font-medium text-primary")],
						[m.nav_also_in_maple()],
					),
					h.div(
						[h.Class("-mx-2 mt-1.5 flex flex-wrap gap-0.5")],
						Arr.map(moreLinks(locale), (link) => alsoLink(h, link)),
					),
				],
			),
			menuFooter(h, featuresIndexPath(locale), m.nav_product_footer(), m.nav_product_footer_cta()),
		],
	),
]

/** Who it is for and how to get there: use cases, SDKs, and the tools people move from. */
const solutionsMenu = (h: H, locale: string): ReadonlyArray<Html> => [
	h.div(
		[h.Class("grid w-[760px] max-w-[calc(100vw-1.5rem)] grid-cols-[1fr_1fr_1.2fr]")],
		[
			megaColumn(h, { title: m.nav_use_cases(), links: useCaseLinks(locale) }),
			megaColumn(
				h,
				{ title: m.nav_integrations(), links: integrationLinks(locale) },
				"border-l border-border",
			),
			h.div(
				[h.Class("border-l border-border px-2 py-4")],
				[
					eyebrow(h, m.nav_switching_from()),
					h.div(
						[h.Class("mt-2 grid grid-cols-2 gap-0.5")],
						Arr.map(compareLinks(locale), (link) => megaLink(h, link)),
					),
				],
			),
		],
	),
]

const resourcesMenu = (h: H, locale: string): ReadonlyArray<Html> => [
	h.div(
		[h.Class("grid w-[560px] max-w-[calc(100vw-1.5rem)] grid-cols-2 gap-1 p-3")],
		Arr.map(resourceLinks(locale), (link) => resourceTile(h, link)),
	),
]

const PAGE_LINK_CLASS =
	"inline-flex h-10 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-[15px] font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"

const trigger = (
	value: string,
	label: string,
	content: ReadonlyArray<Html>,
): NavigationMenu.NavigationMenuItem => ({
	_tag: "Trigger",
	value,
	label,
	className:
		"h-10 bg-transparent hover:bg-muted/20 text-[15px] text-fg-muted hover:text-fg data-popup-open:text-fg",
	contentClassName: "p-0",
	content,
})

const desktopMenu = (h: H, model: Model): Html =>
	h.div(
		[h.Class("absolute left-1/2 hidden -translate-x-1/2 lg:block")],
		[
			h.submodel({
				slotId: MENU_ID,
				model: model.menu,
				view: NavigationMenu.view,
				viewInputs: {
					className: "flex",
					items: [
						trigger("product", m.nav_product(), productMenu(h, model.locale)),
						trigger("solutions", m.nav_solutions(), solutionsMenu(h, model.locale)),
						trigger("resources", m.nav_resources(), resourcesMenu(h, model.locale)),
						...Arr.map(pageLinks(model.locale), (link): NavigationMenu.NavigationMenuItem => ({
							_tag: "Item",
							content: [h.a([h.Href(link.href), h.Class(PAGE_LINK_CLASS)], [link.label])],
						})),
					],
				},
				toParentMessage: (message: NavigationMenu.Message) => Message.GotMenuMessage({ message }),
			}),
		],
	)

const MENU_ICON_LINES = ["6", "12", "18"]

const sheetHeading = (h: H, text: string): Html =>
	h.span([h.Class("text-[11px] text-primary uppercase tracking-wider font-medium")], [text])

const sheetGroup = (h: H, title: string, links: ReadonlyArray<MenuLink>): Html =>
	h.div(
		[],
		[
			h.span([h.Class("text-[10px] text-fg-muted uppercase tracking-wider")], [title]),
			h.div(
				[h.Class("mt-1.5 flex flex-col gap-1")],
				Arr.map(links, (link) =>
					h.a(
						[
							h.Href(link.href),
							h.OnClick(Message.ClickedSheetLink()),
							h.Class(
								"inline-flex items-center gap-2 text-xs text-fg-muted hover:text-fg transition-colors py-1.5",
							),
						],
						[linkLabel(h, link, "inline-flex items-center gap-2")],
					),
				),
			),
		],
	)

const sheetContent = (h: H, model: Model, isSignedIn: boolean): ReadonlyArray<Html> => [
	DialogView.dialogHeader(h, "sheet", [
		h.h2(
			[
				h.Class(cn(sheetTitleStyles, "text-fg text-sm font-medium")),
				h.DataAttribute("slot", "sheet-title"),
				h.Id(Dialog.titleId(SHEET_ID)),
			],
			["Menu"],
		),
	]),
	h.nav(
		[h.Class("flex flex-col px-4 pb-6")],
		[
			h.div(
				[h.Class("py-4 border-b border-border")],
				[
					sheetHeading(h, m.nav_product()),
					h.div(
						[h.Class("mt-3 grid grid-cols-2 gap-x-4 gap-y-5")],
						[
							sheetGroup(h, m.nav_features(), pillarLinks(model.locale)),
							sheetGroup(h, m.nav_also_in_maple(), moreLinks(model.locale)),
						],
					),
					h.a(
						[
							h.Href(featuresIndexPath(model.locale)),
							h.OnClick(Message.ClickedSheetLink()),
							h.Class("mt-5 inline-flex py-1.5 text-xs font-medium text-primary"),
						],
						[m.nav_product_footer_cta()],
					),
				],
			),
			h.div(
				[h.Class("py-4 border-b border-border")],
				[
					sheetHeading(h, m.nav_solutions()),
					h.div(
						[h.Class("mt-3 grid grid-cols-2 gap-x-4 gap-y-5")],
						[
							sheetGroup(h, m.nav_use_cases(), useCaseLinks(model.locale)),
							sheetGroup(h, m.nav_integrations(), integrationLinks(model.locale)),
							sheetGroup(h, m.nav_switching_from(), compareLinks(model.locale)),
						],
					),
				],
			),
			h.div(
				[h.Class("py-4 border-b border-border")],
				[sheetGroup(h, m.nav_resources(), resourceLinks(model.locale))],
			),
			h.div(
				[h.Class("py-4 border-b border-border flex flex-col gap-1")],
				Arr.map(pageLinks(model.locale), (link) =>
					h.a(
						[
							h.Href(link.href),
							h.OnClick(Message.ClickedSheetLink()),
							h.Class("text-xs text-fg hover:text-fg transition-colors py-2 font-medium"),
						],
						[link.label],
					),
				),
			),
			h.div(
				[h.Class("pt-6 flex flex-col gap-4")],
				[
					h.a(
						[
							h.Href(GITHUB_REPO_URL),
							h.Target("_blank"),
							h.Rel("noopener noreferrer"),
							h.Class(
								"flex items-center justify-between text-xs text-fg-muted hover:text-fg transition-colors",
							),
						],
						[
							h.span([h.Class("flex items-center gap-2")], [octocat(h, "w-4 h-4"), "GitHub"]),
							...(model.stars === null
								? []
								: [h.span([h.Class("tabular-nums")], [formatStars(model.stars)])]),
						],
					),
					ctaButton(h, { isSignedIn, location: "nav_mobile" }),
				],
			),
		],
	),
]

/** The hamburger (below `lg`, where the centred list no longer fits) and the sheet it opens. */
const mobileMenu = (h: H, model: Model, isSignedIn: boolean): Html =>
	h.submodel({
		slotId: SHEET_ID,
		model: model.sheet,
		view: DialogView.view,
		viewInputs: {
			className: "w-full sm:max-w-sm bg-bg overflow-y-auto",
			side: "right",
			hasDescription: false,
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("contents")],
					[
						h.button(
							[
								...trigger,
								h.Type("button"),
								h.Class(
									"lg:hidden inline-flex size-11 items-center justify-center text-fg-muted hover:text-fg transition-colors",
								),
								h.AriaLabel("Open menu"),
							],
							[
								h.svg(
									[
										h.Class("w-6 h-6"),
										h.Attribute("viewBox", "0 0 24 24"),
										h.Attribute("fill", "none"),
										h.Attribute("stroke", "currentColor"),
										h.Attribute("stroke-width", "2"),
										h.Attribute("stroke-linecap", "square"),
									],
									Arr.map(MENU_ICON_LINES, (y) =>
										h.line(
											[
												h.Attribute("x1", "4"),
												h.Attribute("y1", y),
												h.Attribute("x2", "20"),
												h.Attribute("y2", y),
											],
											[],
										),
									),
								),
							],
						),
						...(portal === null ? [] : [portal]),
					],
				),
			toContent: () => sheetContent(h, model, isSignedIn),
		},
		toParentMessage: (message: Dialog.Message) => Message.GotSheetMessage({ message }),
	})

/** Right-click on the header logo offers the brand assets instead of the browser's menu. */
const logo = (h: H, model: Model): Html =>
	h.submodel({
		slotId: LOGO_MENU_ID,
		model: model.logoMenu,
		view: ContextMenuView.view,
		viewInputs: {
			className: "w-56 p-1",
			triggerClassName: "flex items-center",
			entries: Arr.map(LOGO_MENU, (item): ContextMenuView.Entry =>
				item === null ? { _tag: "Separator" } : { _tag: "Item", label: item.label },
			),
			triggerContent: [
				h.a(
					[h.Href(localized(model.locale, "/")), h.Class("flex items-center gap-2.5")],
					[
						iconNode(h, MapleMark, "MapleMark", { size: 26, className: "text-primary shrink-0" }),
						h.span([h.Class("text-fg font-medium text-sm")], ["Maple"]),
					],
				),
			],
		},
		toParentMessage: (message: ContextMenu.Message) => Message.GotLogoMenuMessage({ message }),
	})

// The CTA folds into nothing (width, padding, border, the gap before it) while collapsed.
const CTA_CLASS = "text-[15px] sm:text-[15px] overflow-hidden transition-all duration-300"
const CTA_COLLAPSED = "pointer-events-none max-w-0 border-0 px-0 opacity-0 -ml-3"
const CTA_SHOWN = "max-w-48 opacity-100 ml-0"

const view = (model: Model, h: H): Html => {
	const isSignedIn = model.userId !== null
	return h.div(
		[h.Class("relative flex items-center justify-between h-full w-full"), h.OnMount(WatchSignedInUser())],
		[
			// The list is centred absolutely, not laid out between the groups, so the asymmetric
			// right group (star pill, Log in, CTA) cannot pull it off centre.
			logo(h, model),
			desktopMenu(h, model),
			h.div(
				[h.Class("flex items-center gap-3 sm:gap-4"), h.OnMount(WatchHeroCta())],
				[
					starButton(h, model.stars, "hidden sm:inline-flex"),
					...(isSignedIn
						? []
						: [
								h.a(
									[
										h.Href(APP_SIGN_IN_URL),
										h.DataAttribute("track", "cta_click"),
										h.DataAttribute("track-location", "nav_login"),
										h.DataAttribute("track-label", m.nav_login()),
										h.DataAttribute("track-destination", APP_SIGN_IN_URL),
										h.Class(
											"hidden text-[15px] font-medium text-fg-muted transition-colors hover:text-fg md:inline-flex",
										),
									],
									[m.nav_login()],
								),
							]),
					ctaButton(h, {
						isSignedIn,
						location: "nav",
						className: cn(CTA_CLASS, model.isCtaCollapsed ? CTA_COLLAPSED : CTA_SHOWN),
						isHidden: model.isCtaCollapsed,
					}),
					mobileMenu(h, model, isSignedIn),
				],
			),
		],
	)
}

export const NavBar = makeIsland({
	name: "NavBar",
	Props: Schema.Struct({ locale: Schema.String, stars: Schema.NullOr(Schema.Number) }),
	Model,
	init: ({ locale, stars }) => ({
		model: {
			locale,
			stars,
			menu: NavigationMenu.init(MENU_ID),
			sheet: Dialog.init(SHEET_ID, "sheet"),
			logoMenu: ContextMenu.init(LOGO_MENU_ID),
			userId: null,
			isAnnounced: false,
			isCtaCollapsed: false,
		},
	}),
	update,
	view,
})
