import { cn } from "@maple/ui/lib/utils"
import {
	sidebarContainerDefaultStyles,
	sidebarContainerLeftStyles,
	sidebarContainerStyles,
	sidebarContentScrollAreaStyles,
	sidebarContentStyles,
	sidebarDesktopStyles,
	sidebarFooterStyles,
	sidebarGapDefaultStyles,
	sidebarGapStyles,
	sidebarGroupActionStyles,
	sidebarGroupContentStyles,
	sidebarGroupLabelStyles,
	sidebarGroupStyles,
	sidebarHeaderStyles,
	sidebarInnerStyles,
	sidebarInsetStyles,
	sidebarMenuBadgeStyles,
	sidebarMenuButtonVariants,
	sidebarMenuItemStyles,
	sidebarMenuStyles,
	sidebarMenuSubButtonIconCollapsibleStyles,
	sidebarMenuSubButtonMdStyles,
	sidebarMenuSubButtonStyles,
	sidebarMenuSubItemStyles,
	sidebarMenuSubStyles,
	sidebarMobileHeaderStyles,
	sidebarMobileInnerStyles,
	sidebarMobileStyles,
	sidebarRailStyles,
	sidebarSeparatorStyles,
	sidebarTriggerLabelStyles,
	sidebarTriggerStyles,
	sidebarWrapperStyles,
} from "@maple/ui/styles/ui/sidebar"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { separatorStyles } from "@maple/ui/styles/ui/separator"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { icon } from "./icon"
import { scrollArea } from "./scroll-area"
import { leftSheet } from "./sheet"

// The Foldkit side of packages/ui/src/components/ui/sidebar.tsx: same markup, same class composition.

export type SidebarState = "expanded" | "collapsed"

type Children = ReadonlyArray<Html | string>
type Attributes<Message> = ReadonlyArray<Attribute<Message> | ChildAttribute>

const slot = <Message>(h: HtmlBuilder<Message>, name: string): ReadonlyArray<Attribute<Message>> => [
	h.DataAttribute("sidebar", name),
	h.DataAttribute("slot", `sidebar-${name}`),
]

/** `<SidebarProvider>`'s wrapper div and its width variables. */
export const sidebarWrapper = <Message>(
	h: HtmlBuilder<Message>,
	children: Children,
	attributes: Attributes<Message> = [],
	className?: string,
): Html =>
	h.div(
		[
			h.Class(cn(sidebarWrapperStyles, className)),
			h.DataAttribute("slot", "sidebar-wrapper"),
			h.Style({ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" }),
			...attributes,
		],
		children,
	)

const sidebarInner = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.div(
		[
			h.Class(sidebarInnerStyles),
			h.DataAttribute("sidebar", "sidebar"),
			h.DataAttribute("slot", "sidebar-inner"),
		],
		children,
	)

/** `<Sidebar collapsible="icon">` above `md`: the gap that reserves width and the fixed container. */
export const sidebarDesktop = <Message>(
	h: HtmlBuilder<Message>,
	state: SidebarState,
	children: Children,
	/** `<Sidebar className>`: lands on the fixed container. */
	className?: string,
	/** Snap to `state` without the width transition (keyboard toggles). */
	isInstant = false,
): Html =>
	h.div(
		[
			h.Class(sidebarDesktopStyles),
			...(isInstant ? [h.DataAttribute("instant", "")] : []),
			h.DataAttribute("collapsible", state === "collapsed" ? "icon" : ""),
			h.DataAttribute("side", "left"),
			h.DataAttribute("slot", "sidebar"),
			h.DataAttribute("state", state),
			h.DataAttribute("variant", "sidebar"),
		],
		[
			h.div(
				[
					h.Class(cn(...sidebarGapStyles, sidebarGapDefaultStyles)),
					h.DataAttribute("slot", "sidebar-gap"),
				],
				[],
			),
			h.div(
				[
					h.Class(
						cn(
							sidebarContainerStyles,
							sidebarContainerLeftStyles,
							sidebarContainerDefaultStyles,
							className,
						),
					),
					h.DataAttribute("slot", "sidebar-container"),
				],
				[sidebarInner(h, children)],
			),
		],
	)

/** `<Sidebar>` below `md`: a left sheet (`data-mobile`) with the sr-only "Sidebar" header. */
export const sidebarMobile = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ id: string; onDismiss: Message }>,
	children: Children,
): Html =>
	leftSheet(
		h,
		{
			id: options.id,
			className: sidebarMobileStyles,
			title: "Sidebar",
			description: "Displays the mobile sidebar.",
			headerClassName: sidebarMobileHeaderStyles,
			slot: "sidebar",
			popupAttributes: [
				h.DataAttribute("mobile", "true"),
				h.DataAttribute("sidebar", "sidebar"),
				h.Style({ "--nested-dialogs": "0", "--sidebar-width": "18rem" }),
			],
			onDismiss: options.onDismiss,
		},
		[h.div([h.Class(sidebarMobileInnerStyles)], children)],
	)
// SIDEBAR PARTS

export const sidebarHeader = <Message>(
	h: HtmlBuilder<Message>,
	children: Children,
	className?: string,
): Html => h.div([h.Class(cn(sidebarHeaderStyles, className)), ...slot(h, "header")], children)

export const sidebarFooter = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	// Opaque, so nav rows scrolled under its edge never show through.
	h.div([h.Class(cn(sidebarFooterStyles, "relative bg-sidebar")), ...slot(h, "footer")], children)

/**
 * `<SidebarContent>`: a fading `ScrollArea` around the scrolling nav (`viewportAttributes`: its measuring Mount).
 * The viewport is the only scroller; its fade runs taller than a row so a cut row reads as "more below".
 */
export const sidebarContent = <Message>(
	h: HtmlBuilder<Message>,
	children: Children,
	viewportAttributes: ReadonlyArray<Attribute<Message>> = [],
): Html =>
	scrollArea(
		h,
		{
			className: cn(
				sidebarContentScrollAreaStyles,
				"*:data-[slot=scroll-area-viewport]:[--fade-size:3rem]",
			),
			scrollFade: true,
			idPrefix: "sidebar-content",
			viewportAttributes,
		},
		[h.div([h.Class(cn(sidebarContentStyles, "overflow-visible")), ...slot(h, "content")], children)],
	)

export const sidebarGroup = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html => h.div([h.Class(cn(sidebarGroupStyles, className)), ...slot(h, "group")], children)

export const sidebarGroupLabel = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.div(
		[
			h.Class(cn(...sidebarGroupLabelStyles, className)),
			h.DataAttribute("sidebar", "group-label"),
			h.DataAttribute("slot", "sidebar-group-label"),
		],
		children,
	)

export const sidebarGroupContent = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.div(
		[
			h.Class(cn(sidebarGroupContentStyles)),
			h.DataAttribute("sidebar", "group-content"),
			h.DataAttribute("slot", "sidebar-group-content"),
		],
		children,
	)

/** `<SidebarGroupAction aria-label>`: the icon button in a group label's corner. */
export const sidebarGroupAction = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ ariaLabel: string; className?: string; attributes?: Attributes<Message> }>,
	children: Children,
): Html =>
	h.button(
		[
			h.AriaLabel(options.ariaLabel),
			h.Class(cn(...sidebarGroupActionStyles, options.className)),
			h.DataAttribute("sidebar", "group-action"),
			h.DataAttribute("slot", "sidebar-group-action"),
			h.Type("button"),
			...(options.attributes ?? []),
		],
		children,
	)

/** `<SidebarSeparator>`: Base UI's horizontal Separator in the sidebar's border colour. */
export const sidebarSeparator = <Message>(h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.AriaOrientation("horizontal"),
			h.Class(cn(separatorStyles, sidebarSeparatorStyles)),
			h.DataAttribute("orientation", "horizontal"),
			h.DataAttribute("sidebar", "separator"),
			h.DataAttribute("slot", "sidebar-separator"),
			h.Role("separator"),
		],
		[],
	)

export const sidebarMenu = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html => h.ul([h.Class(cn(sidebarMenuStyles, className)), ...slot(h, "menu")], children)

export const sidebarMenuItem = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.li(
		[
			h.Class(cn(sidebarMenuItemStyles, className)),
			h.DataAttribute("sidebar", "menu-item"),
			h.DataAttribute("slot", "sidebar-menu-item"),
		],
		children,
	)

export const sidebarMenuBadge = <Message>(h: HtmlBuilder<Message>, children: Children): Html =>
	h.div(
		[
			h.Class(cn(...sidebarMenuBadgeStyles)),
			h.DataAttribute("sidebar", "menu-badge"),
			h.DataAttribute("slot", "sidebar-menu-badge"),
		],
		children,
	)

export const sidebarMenuSub = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.ul(
		[
			h.Class(cn(...sidebarMenuSubStyles, className)),
			h.DataAttribute("sidebar", "menu-sub"),
			h.DataAttribute("slot", "sidebar-menu-sub"),
		],
		children,
	)

export const sidebarMenuSubItem = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.li(
		[
			h.Class(cn(sidebarMenuSubItemStyles, className)),
			h.DataAttribute("sidebar", "menu-sub-item"),
			h.DataAttribute("slot", "sidebar-menu-sub-item"),
		],
		children,
	)
// SIDEBAR BUTTONS

/** TanStack `<Link>`'s active test (`resolveIsActive`, default options): the path or a descendant. */
export const isLinkActive = (currentPath: string, href: string): boolean =>
	currentPath.startsWith(href) && (currentPath.length === href.length || currentPath[href.length] === "/")

/** What a TanStack `<Link>` adds to its element: `href`, and when active `aria-current`, `data-status` and `active`. */
export type LinkTarget = Readonly<{ href: string; currentPath: string }>

export type SidebarMenuButtonOptions<Message> = Readonly<{
	size?: "default" | "lg" | "sm"
	className?: string
	isActive?: boolean
	/** Rendered as a router link instead of a button. */
	link?: LinkTarget
	/** `render={<a href />}`: a plain anchor, no router active state (apps/local-ui's hash links). */
	href?: string
	/** `tooltip` was given: Base UI marks the element as a tooltip trigger. */
	hasTooltip?: boolean
	/** `data-slot` when the button is another primitive's trigger (`dropdown-menu-trigger`). */
	slot?: string
	attributes?: Attributes<Message>
	/**
	 * The 2px leading lane a row reserves: `lane` keeps it empty, `active` paints it (and the
	 * label) in `sidebar-primary` while the row is active.
	 */
	rail?: "lane" | "active"
}>

const RAIL_CLASS = {
	lane: ROW_LANE,
	active: `${ROW_LANE} data-[active=true]:rounded-l-none data-[active=true]:before:bg-sidebar-primary data-[active=true]:text-sidebar-primary`,
} satisfies Record<"lane" | "active", string>

/** `<SidebarMenuButton>`, as a `<button>` or a router `<a>`. */
export const sidebarMenuButton = <Message>(
	h: HtmlBuilder<Message>,
	options: SidebarMenuButtonOptions<Message>,
	children: Children,
): Html => {
	const size = options.size ?? "default"
	const linkActive = options.link !== undefined && isLinkActive(options.link.currentPath, options.link.href)
	const className = cn(
		sidebarMenuButtonVariants({ size, variant: "default" }),
		options.rail === undefined ? undefined : RAIL_CLASS[options.rail],
		options.className,
	)
	const attributes: Array<Attribute<Message> | ChildAttribute> = [
		h.Class(linkActive ? `${className} active` : className),
		h.DataAttribute("active", String(options.isActive ?? false)),
		...(options.hasTooltip === true ? [h.DataAttribute("base-ui-tooltip-trigger", "")] : []),
		h.DataAttribute("sidebar", "menu-button"),
		h.DataAttribute("size", size),
		h.DataAttribute("slot", options.slot ?? "sidebar-menu-button"),
		...(options.attributes ?? []),
	]
	if (options.href !== undefined) return h.a([h.Href(options.href), ...attributes], children)
	if (options.link === undefined) return h.button([h.Type("button"), ...attributes], children)
	return h.a(
		[
			h.Href(options.link.href),
			...(linkActive ? [h.AriaCurrent("page"), h.DataAttribute("status", "active")] : []),
			...attributes,
		],
		children,
	)
}
// SIDEBAR SUB BUTTONS

/** `<SidebarMenuSubButton size="md" render={<Link />}>`. */
export const sidebarMenuSubButton = <Message>(
	h: HtmlBuilder<Message>,
	/** `link` is a router link (active by path); `href` a plain anchor (`<SidebarMenuSubButton href>`). */
	options: Readonly<{ className?: string; isActive: boolean; link?: LinkTarget; href?: string }>,
	children: Children,
): Html => {
	const linkActive = options.link !== undefined && isLinkActive(options.link.currentPath, options.link.href)
	const className = cn(
		...sidebarMenuSubButtonStyles,
		sidebarMenuSubButtonMdStyles,
		sidebarMenuSubButtonIconCollapsibleStyles,
		options.className,
	)
	return h.a(
		[
			h.Href(options.link?.href ?? options.href ?? ""),
			...(linkActive ? [h.AriaCurrent("page"), h.DataAttribute("status", "active")] : []),
			h.Class(linkActive ? `${className} active` : className),
			h.DataAttribute("active", String(options.isActive)),
			h.DataAttribute("sidebar", "menu-sub-button"),
			h.DataAttribute("size", "md"),
			h.DataAttribute("slot", "sidebar-menu-sub-button"),
		],
		children,
	)
}

/** `<SidebarRail>`: the edge strip that toggles the sidebar, out of the tab order. */
export const sidebarRail = <Message>(h: HtmlBuilder<Message>, onToggle: Message): Html =>
	h.button(
		[
			h.AriaLabel("Toggle sidebar"),
			h.Class(cn(...sidebarRailStyles)),
			h.DataAttribute("sidebar", "rail"),
			h.DataAttribute("slot", "sidebar-rail"),
			h.OnClick(onToggle),
			h.Tabindex(-1),
			h.Title("Toggle sidebar"),
			h.Type("button"),
		],
		[],
	)

/** `<SidebarInset>`: the page column beside the sidebar. */
export const sidebarInset = <Message>(
	h: HtmlBuilder<Message>,
	children: Children,
	className?: string,
): Html =>
	h.main(
		[h.Class(cn(...sidebarInsetStyles, className)), h.DataAttribute("slot", "sidebar-inset")],
		children,
	)

/** `<SidebarTrigger className="-ml-1">`: a ghost icon button showing which way the rail moves. */
export const sidebarTrigger = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ state: SidebarState; className?: string; attributes?: Attributes<Message> }>,
): Html =>
	button(
		h,
		{
			className: cn(sidebarTriggerStyles, options.className),
			size: "icon",
			variant: "ghost",
			attributes: [h.DataAttribute("sidebar", "trigger"), ...(options.attributes ?? [])],
			slot: "sidebar-trigger",
		},
		[
			icon(h, options.state === "expanded" ? "LayoutMoveToLeftIcon" : "LayoutMoveToRightIcon"),
			h.span([h.Class(sidebarTriggerLabelStyles)], ["Toggle sidebar"]),
		],
	)
