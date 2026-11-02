import { cn } from "@maple/ui/lib/utils"
import { sheetTitleStyles } from "@maple/ui/styles/ui/sheet"
import { linkButton } from "@maple/views/ui/button"
import * as ContextMenu from "@maple/views/ui/context-menu"
import * as ContextMenuView from "@maple/views/ui/context-menu-view"
import { MapleMark } from "@maple/views/ui/control-icons"
import * as Dialog from "@maple/views/ui/dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { iconNode } from "@maple/views/ui/icon"
import * as NavigationMenu from "@maple/views/ui/navigation-menu"
import { Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../foldkit-island/island"
import { APP_SIGN_IN_URL, APP_SIGN_UP_URL, APP_URL } from "../lib/app-urls"
import { watchSignedInUser } from "../lib/clerk-session"
import { features } from "../lib/features"
import { formatStars, GITHUB_REPO_URL, OCTOCAT_PATH } from "../lib/github-stars"
import { featurePath, useCasePath } from "../lib/page-registry"
import { identifyLanding, trackLanding } from "../lib/telemetry"
import { useCases } from "../lib/use-cases"
import * as m from "../paraglide/messages.js"
import { broadcastSignedIn } from "./auth-signal"

/**
 * The site header on every page: the mega-menu (desktop), the menu sheet (below `lg`), the
 * logo's brand-asset menu, and the Log in / CTA pair that follows the visitor's Clerk session.
 */

// LINKS

type MenuLink = Readonly<{ href: string; label: () => string; desc: () => string }>

const localized = (locale: string, path: string): string => (locale === "en" ? path : `/${locale}${path}`)

// From the registries, so adding a feature cannot leave the nav pointing at seven of eight.
// Labels stay thunks: Paraglide resolves the locale per call, at render.
const featureLinks = (locale: string): ReadonlyArray<MenuLink> =>
	features.map((feature) => ({
		href: featurePath(locale, feature.slug),
		label: feature.navLabel,
		desc: feature.navDesc,
	}))

const useCaseLinks = (locale: string): ReadonlyArray<MenuLink> =>
	useCases.map((useCase) => ({
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
	{ href: localized(locale, "/integrations/nextjs"), label: () => m.nav_nextjs(), desc: () => m.nav_desc_nextjs() },
	{ href: localized(locale, "/integrations/python"), label: () => m.nav_python(), desc: () => m.nav_desc_python() },
	{ href: localized(locale, "/integrations/nodejs"), label: () => m.nav_nodejs(), desc: () => m.nav_desc_nodejs() },
]

const compare = (locale: string, slug: string, label: () => string, desc: () => string): MenuLink => ({
	href: localized(locale, `/compare/${slug}`),
	label,
	desc,
})

const compareLinks = (locale: string): ReadonlyArray<MenuLink> => [
	compare(locale, "datadog", () => m.nav_vs_datadog(), () => m.nav_desc_vs_datadog()),
	compare(locale, "grafana", () => m.nav_vs_grafana(), () => m.nav_desc_vs_grafana()),
	compare(locale, "new-relic", () => m.nav_vs_new_relic(), () => m.nav_desc_vs_new_relic()),
	compare(locale, "dash0", () => m.nav_vs_dash0(), () => m.nav_desc_vs_dash0()),
	compare(locale, "signoz", () => m.nav_vs_signoz(), () => m.nav_desc_vs_signoz()),
	compare(locale, "axiom", () => m.nav_vs_axiom(), () => m.nav_desc_vs_axiom()),
	compare(locale, "better-stack", () => m.nav_vs_better_stack(), () => m.nav_desc_vs_better_stack()),
	compare(locale, "honeycomb", () => m.nav_vs_honeycomb(), () => m.nav_desc_vs_honeycomb()),
]

/** The plain links beside the Product menu, in the header and the sheet. */
const pageLinks = (locale: string): ReadonlyArray<Readonly<{ href: string; label: string }>> => [
	{ href: localized(locale, "/pricing"), label: m.nav_pricing() },
	{ href: localized(locale, "/local"), label: m.nav_local() },
	{ href: "/docs", label: m.nav_docs() },
	{ href: "/guides", label: m.nav_guides() },
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
const toLogoMenu = Command.mapMessage((message: ContextMenu.Message) => Message.GotLogoMenuMessage({ message }))

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
		commands: [...(next.commands ?? []).map(toLogoMenu), ...(picked === undefined ? [] : [picked])],
	}
}

const sheetStep = (
	model: Model,
	next: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage>,
): UpdateReturn => ({ model: { ...model, sheet: next.model }, commands: (next.commands ?? []).map(toSheet) })

const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotMenuMessage: ({ message: child }) => {
			const next = NavigationMenu.update(model.menu, child)
			return { model: { ...model, menu: next.model }, commands: (next.commands ?? []).map(toMenu) }
		},
		GotSheetMessage: ({ message: child }) => sheetStep(model, Dialog.update(model.sheet, child)),
		GotLogoMenuMessage: ({ message: child }) => logoMenuStep(model, child),
		// The link navigates on its own; the sheet just closes.
		ClickedSheetLink: () => sheetStep(model, Dialog.close(model.sheet)),
		// `useAuth` re-renders on every Clerk emit; the page only hears about changes.
		ChangedSignedInUser: ({ userId }) =>
			model.isAnnounced && userId === model.userId
				? { model }
				: { model: { ...model, userId, isAnnounced: true }, commands: [AnnounceSignedInUser({ userId })] },
		ChangedCtaCollapsed: ({ isCollapsed }) => ({ model: { ...model, isCtaCollapsed: isCollapsed } }),
		CompletedSideEffect: () => ({ model }),
	})

// VIEW

type H = HtmlBuilder<Message>

const MENU_ID = "site-nav"
const SHEET_ID = "site-nav-sheet"
const LOGO_MENU_ID = "site-logo-menu"

const octocat = (h: H, className: string): Html =>
	h.svg(
		[h.Class(className), h.Attribute("viewBox", "0 0 24 24"), h.Attribute("fill", "currentColor"), h.AriaHidden(true)],
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
						[h.Class("flex items-center border-l border-border px-2.5 text-xs font-medium tabular-nums")],
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

const megaLink = (h: H, link: MenuLink): Html =>
	NavigationMenu.navigationMenuLink(
		h,
		link.href,
		[
			h.span(
				[h.Class("text-xs font-medium text-fg transition-colors group-hover/link:text-primary")],
				[link.label()],
			),
			h.span([h.Class("text-[11px] leading-snug text-fg-muted")], [link.desc()]),
		],
		"group/link flex flex-col items-start gap-0.5 rounded-lg p-2 hover:bg-muted/20",
	)

const megaColumn = (h: H, title: string, links: ReadonlyArray<MenuLink>): Html =>
	h.div(
		[h.Class("col-span-3 border-l border-border pl-2")],
		[eyebrow(h, title), h.div([h.Class("mt-2 flex flex-col gap-0.5")], links.map((link) => megaLink(h, link)))],
	)

/** Features (2x4), use cases and integrations; the compare row; the footer strip. */
const productMenu = (h: H, locale: string): ReadonlyArray<Html> => [
	h.div(
		[h.Class("w-[820px] max-w-[calc(100vw-1.5rem)]")],
		[
			h.div(
				[h.Class("grid grid-cols-12 gap-x-2 p-4")],
				[
					h.div(
						[h.Class("col-span-6")],
						[
							eyebrow(h, m.nav_features()),
							h.div(
								[h.Class("mt-2 grid grid-cols-2 gap-0.5")],
								featureLinks(locale).map((link) => megaLink(h, link)),
							),
						],
					),
					megaColumn(h, m.nav_use_cases(), useCaseLinks(locale)),
					megaColumn(h, m.nav_integrations(), integrationLinks(locale)),
				],
			),
			h.div(
				[h.Class("border-t border-border px-4 pt-3 pb-4")],
				[
					eyebrow(h, m.nav_compare()),
					h.div(
						[h.Class("mt-2 grid grid-cols-4 gap-0.5")],
						compareLinks(locale).map((link) => megaLink(h, link)),
					),
				],
			),
			NavigationMenu.navigationMenuLink(
				h,
				localized(locale, "/"),
				[
					h.span([h.Class("text-xs font-medium text-fg")], [m.nav_product_footer()]),
					h.span(
						[
							h.Class(
								"inline-flex items-center gap-1 text-xs text-primary transition-transform group-hover/cta:translate-x-0.5",
							),
						],
						[m.nav_product_footer_cta()],
					),
				],
				"group/cta flex items-center justify-between rounded-none border-t border-border bg-muted/10 px-6 py-3.5 hover:bg-muted/20",
			),
		],
	),
]

const PAGE_LINK_CLASS =
	"inline-flex h-10 w-max items-center justify-center bg-transparent px-2.5 py-1.5 text-[15px] font-medium text-fg-muted hover:bg-muted/20 hover:text-fg transition-all"

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
						{
							_tag: "Trigger",
							value: "product",
							label: m.nav_product(),
							className:
								"h-10 bg-transparent hover:bg-muted/20 text-[15px] text-fg-muted hover:text-fg data-popup-open:text-fg",
							contentClassName: "p-0",
							content: productMenu(h, model.locale),
						},
						...pageLinks(model.locale).map((link): NavigationMenu.NavigationMenuItem => ({
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

const sheetGroup = (h: H, title: string, links: ReadonlyArray<MenuLink>): Html =>
	h.div(
		[],
		[
			h.span([h.Class("text-[10px] text-fg-muted uppercase tracking-wider")], [title]),
			h.div(
				[h.Class("mt-1.5 flex flex-col gap-1")],
				links.map((link) =>
					h.a(
						[
							h.Href(link.href),
							h.OnClick(Message.ClickedSheetLink()),
							h.Class("text-xs text-fg-muted hover:text-fg transition-colors py-1.5"),
						],
						[link.label()],
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
					h.span([h.Class("text-[11px] text-primary uppercase tracking-wider font-medium")], [m.nav_product()]),
					h.div(
						[h.Class("mt-3 flex flex-col gap-5")],
						[
							sheetGroup(h, m.nav_features(), featureLinks(model.locale)),
							sheetGroup(h, m.nav_use_cases(), useCaseLinks(model.locale)),
							sheetGroup(h, m.nav_integrations(), integrationLinks(model.locale)),
							sheetGroup(h, m.nav_compare(), compareLinks(model.locale)),
						],
					),
				],
			),
			h.div(
				[h.Class("py-4 border-b border-border flex flex-col gap-1")],
				pageLinks(model.locale).map((link) =>
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
							h.Class("flex items-center justify-between text-xs text-fg-muted hover:text-fg transition-colors"),
						],
						[
							h.span([h.Class("flex items-center gap-2")], [octocat(h, "w-4 h-4"), "GitHub"]),
							...(model.stars === null ? [] : [h.span([h.Class("tabular-nums")], [formatStars(model.stars)])]),
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
									MENU_ICON_LINES.map((y) =>
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
			entries: LOGO_MENU.map((item): ContextMenuView.Entry =>
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
