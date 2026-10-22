import { cn } from "@maple/ui/lib/utils"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import { initialsFrom } from "@maple/ui/lib/initials"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { kbd } from "../ui/display"
import { menuGroup, menuItem, menuLabel, menuSeparator, menuShortcut } from "../ui/dropdown-menu"
import { icon, iconColor } from "../ui/icon"
import { switchControl } from "../ui/switch"
import { popupIdOf } from "./menus"
import { MountNamespaceSearch } from "./mounts"
import { hasNamespaceSearch, namespaceRows, namespaceSearchRow, noNamespacesMatch } from "./namespace-search"
import { Menu, Message } from "./message"
import type { Model, ShellClerk } from "./model"
import { partitionSubItems } from "./nav"
import { shellNavGroups, surfacesOf } from "./view-nav"
import { pinnedNamespaceOf, userAvatar, userImageOf, userNameOf } from "./view-sidebar"

// The open menu's content: GuestMenu, SupportMenu, the self-hosted org switcher's namespace list
// and the collapsed rail's section menus.

type Item = Readonly<{
	content: ReadonlyArray<Html | string>
	href?: string
	external?: Readonly<{ ariaLabel: string; isNewTab: boolean }>
	onSelect?: Message
}>

const items = (
	h: HtmlBuilder<Message>,
	menu: Menu,
	entries: ReadonlyArray<Item>,
	offset = 0,
): ReadonlyArray<Html> =>
	entries.map((entry, index) => {
		const id = `${popupIdOf(menu)}-item-${offset + index}`
		return menuItem(
			h,
			{
				id,
				href: entry.href,
				onSelect: entry.onSelect,
				onHighlight: Message.HoveredMenuItem({ itemId: id }),
				attributes:
					entry.external === undefined
						? []
						: [
								h.AriaLabel(entry.external.ariaLabel),
								...(entry.external.isNewTab
									? [
											h.Attribute("rel", "noopener noreferrer"),
											h.Attribute("target", "_blank"),
										]
									: []),
							],
			},
			entry.content,
		)
	})

const keyboardShortcuts = (h: HtmlBuilder<Message>): Item => ({
	content: [icon(h, "KeyboardIcon"), "Keyboard shortcuts", menuShortcut(h, ["?"])],
	onSelect: Message.ClickedKeyboardShortcuts(),
})

/** `ThemeToggle`: a plain row, not an item, so flipping the switch keeps the menu open. */
const themeToggle = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.Class("flex items-center gap-2 rounded-md px-2 py-2 text-xs select-none")],
		[
			icon(h, model.theme === "dark" ? "MoonIcon" : "SunIcon", {
				size: 16,
				className: "shrink-0 text-muted-foreground",
			}),
			h.span([], ["Dark mode"]),
			h.span(
				[h.Class("ml-auto flex items-center gap-2")],
				[
					kbd(h, undefined, ["T"]),
					...switchControl(h, {
						id: "shell-theme-switch",
						inputId: "shell-theme-switch-input",
						isChecked: model.theme === "dark",
						ariaLabel: "Toggle dark mode",
						onToggle: Message.ClickedThemeSwitch(),
					}),
				],
			),
		],
	)

const guestMenu = (h: HtmlBuilder<Message>, model: Model, menu: Menu): ReadonlyArray<Html> => [
	menuGroup(h, undefined, [themeToggle(h, model)]),
	menuSeparator(h),
	menuGroup(
		h,
		undefined,
		items(h, menu, [
			{ content: [icon(h, "GearIcon"), "Settings"], href: "/settings" },
			keyboardShortcuts(h),
		]),
	),
	menuSeparator(h),
	menuGroup(
		h,
		undefined,
		items(
			h,
			menu,
			[{ content: [icon(h, "LogoutIcon"), "Log out"], onSelect: Message.ClickedLogOut() }],
			2,
		),
	),
]

const supportMenu = (h: HtmlBuilder<Message>, menu: Menu, isClerk: boolean): ReadonlyArray<Html> => [
	menuGroup(
		h,
		undefined,
		items(h, menu, [
			// The channel is created in Maple's Slack for a Clerk org; self-hosted has neither.
			...(isClerk
				? [
						{
							content: [icon(h, "SlackIcon"), "Shared Slack channel"],
							onSelect: Message.ClickedSupportChannel(),
						},
					]
				: []),
			{
				content: [icon(h, "DiscordIcon"), "Community Discord"],
				href: "https://discord.gg/BnXjKuwJqP",
				external: { ariaLabel: "Community Discord", isNewTab: true },
			},
			{
				content: [icon(h, "EnvelopeIcon"), "Email Support"],
				href: "mailto:support@maple.dev",
				external: { ariaLabel: "Email Support", isNewTab: false },
			},
			keyboardShortcuts(h),
		]),
	),
]
// NAMESPACES

const checkIcon = (h: HtmlBuilder<Message>): Html => icon(h, "CheckIcon", { className: "ml-auto" })

const namespaceItem = (
	h: HtmlBuilder<Message>,
	label: string,
	maybeNamespace: Option.Option<string>,
	isPinned: boolean,
): Item => ({
	content: [h.span([h.Class("truncate")], [label]), ...(isPinned ? [checkIcon(h)] : [])],
	onSelect: Message.ClickedNamespace({ maybeNamespace }),
})

/** `NamespaceScopeList emptyNotice`: the search row appears from eight namespaces. */
const namespaceList = (h: HtmlBuilder<Message>, model: Model, menu: Menu): ReadonlyArray<Html> => {
	const pinned = pinnedNamespaceOf(model)
	const observed: ReadonlyArray<string> = AsyncData.getOrElse(
		model.namespaces,
		(): ReadonlyArray<string> => [],
	)
	const isLoading = AsyncData.isIdle(model.namespaces) || AsyncData.isLoading(model.namespaces)
	if (isLoading && observed.length === 0)
		return [
			h.div(
				[h.Class("flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground")],
				[
					icon(h, "LoaderIcon", {
						className: cn(spinnerStyles, "size-3.5"),
						attributes: [h.AriaLabel("Loading"), h.Role("status")],
					}),
					" Loading namespaces…",
				],
			),
		]
	if (observed.length === 0 && Option.isNone(pinned))
		return [h.div([h.Class("px-2 py-1.5 text-xs text-muted-foreground")], ["No namespaces detected"])]
	const rows = namespaceRows(observed, pinned, model.namespaceQuery)
	const entries: ReadonlyArray<Item> = [
		...(rows.isFiltered
			? []
			: [namespaceItem(h, "All namespaces", Option.none(), Option.isNone(pinned))]),
		...rows.matches.map((name) =>
			namespaceItem(h, name, Option.some(name), Option.contains(pinned, name)),
		),
		...Option.match(rows.unseenPin, {
			onNone: () => [],
			onSome: (name): ReadonlyArray<Item> => [
				{
					content: [
						h.span([h.Class("truncate")], [name]),
						h.span([h.Class("ml-2 text-xs text-muted-foreground")], ["no recent data"]),
						checkIcon(h),
					],
					onSelect: Message.ClickedNamespace({ maybeNamespace: Option.some(name) }),
				},
			],
		}),
	]
	const list = [...items(h, menu, entries), ...(rows.isNoMatch ? [noNamespacesMatch(h)] : [])]
	return [
		...(hasNamespaceSearch(observed)
			? [
					namespaceSearchRow(h, {
						id: `${popupIdOf(menu)}-search`,
						query: model.namespaceQuery,
						rowAttributes: [h.OnMount(MountNamespaceSearch())],
						attributes: [h.OnInput((value) => Message.ChangedNamespaceQuery({ value }))],
					}),
				]
			: []),
		h.div([h.Class("max-h-72 overflow-y-auto")], list),
	]
}

const orgMenu = (h: HtmlBuilder<Message>, model: Model, menu: Menu): ReadonlyArray<Html> => {
	const labelId = `${popupIdOf(menu)}-label`
	return [menuGroup(h, labelId, [menuLabel(h, labelId, ["Namespace"]), ...namespaceList(h, model, menu)])]
}

/** The collapsed rail's section menu: every child, the ones the org lacks after a separator. */
const navSectionMenu = (
	h: HtmlBuilder<Message>,
	model: Model,
	menu: Menu,
	title: string,
	currentPath: string,
	clerk: ShellClerk | null,
): ReadonlyArray<Html> => {
	const item = shellNavGroups(clerk)
		.flatMap((group) => group.items)
		.find((candidate) => candidate.title === title)
	if (item?.subItems === undefined) return []
	const { shown, hidden } = partitionSubItems(item.subItems, surfacesOf(model), currentPath)
	const toItem = (sub: (typeof shown)[number]): Item => ({
		content: [
			...(sub.icon === undefined ? [] : [icon(h, sub.icon, { size: 16, ...iconColor(sub.iconColor) })]),
			sub.title,
		],
		href: sub.href,
	})
	const labelId = `${popupIdOf(menu)}-label`
	return [
		menuGroup(h, labelId, [menuLabel(h, labelId, [item.title]), ...items(h, menu, shown.map(toItem))]),
		...(hidden.length > 0
			? [menuSeparator(h), menuGroup(h, undefined, items(h, menu, hidden.map(toItem), shown.length))]
			: []),
	]
}

/** `UserMenu` (Clerk): who is signed in, the theme, Account, Settings, shortcuts, Log out. */
const clerkUserMenu = (
	h: HtmlBuilder<Message>,
	model: Model,
	menu: Menu,
	clerk: ShellClerk,
): ReadonlyArray<Html> => {
	const name = userNameOf(clerk)
	const email = Option.getOrElse(
		Option.flatMapNullishOr(clerk.maybeUser, (user) => user.email),
		() => "",
	)
	const labelId = `${popupIdOf(menu)}-label`
	return [
		menuGroup(h, labelId, [
			menuLabel(h, labelId, [
				h.div(
					[h.Class("flex items-center gap-2 py-1 text-left text-sm")],
					[
						userAvatar(h, initialsFrom(name), "size-8 rounded-md text-xs", {
							url: userImageOf(clerk),
							label: name,
						}),
						h.div(
							[h.Class("grid flex-1 text-left text-sm leading-tight")],
							[
								h.span([h.Class("truncate font-medium"), h.Title(name)], [name]),
								...(email === ""
									? []
									: [
											h.span(
												[
													h.Class("truncate text-muted-foreground text-xs"),
													h.Title(email),
												],
												[email],
											),
										]),
							],
						),
					],
				),
			]),
		]),
		menuSeparator(h),
		menuGroup(h, undefined, [themeToggle(h, model)]),
		menuSeparator(h),
		menuGroup(
			h,
			undefined,
			items(h, menu, [
				{ content: [icon(h, "UserIcon"), "Account"], href: "/account" },
				{ content: [icon(h, "GearIcon"), "Settings"], href: "/settings" },
				keyboardShortcuts(h),
			]),
		),
		menuSeparator(h),
		menuGroup(
			h,
			undefined,
			items(
				h,
				menu,
				[{ content: [icon(h, "LogoutIcon"), "Log out"], onSelect: Message.ClickedLogOut() }],
				3,
			),
		),
	]
}

export const menuContent = (
	h: HtmlBuilder<Message>,
	model: Model,
	menu: Menu,
	currentPath: string,
	clerk: ShellClerk | null = null,
): ReadonlyArray<Html> =>
	Menu.match(menu, {
		Org: () => orgMenu(h, model, menu),
		User: () => (clerk === null ? guestMenu(h, model, menu) : clerkUserMenu(h, model, menu, clerk)),
		Support: () => supportMenu(h, menu, clerk !== null),
		NavSection: ({ title }) => navSectionMenu(h, model, menu, title, currentPath, clerk),
	})
