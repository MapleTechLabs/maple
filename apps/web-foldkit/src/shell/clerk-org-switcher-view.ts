import { MAPLE_REGION_LABELS } from "@maple/domain/organization-regions"
import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import { hasMultipleRegions } from "@maple/web/lib/region"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import type { ClerkOrganization } from "../platform/clerk"
import { avatarFallback, badge } from "../ui/display"
import { icon } from "../ui/icon"
import * as MenuView from "../ui/menu-view"
import { button } from "../ui/button"
import * as DialogView from "../ui/dialog-view"
import { input } from "../ui/input"
import type { Align, Side } from "../ui/overlay/position"
import {
	ALL_NAMESPACES,
	CREATE_VALUE,
	Message,
	type Model,
	NAMESPACE_PREFIX,
	NAMESPACE_SUBMENU,
	ORG_PREFIX,
} from "./clerk-org-switcher"

/** The namespace submenu's data (`NamespaceScopeList`), sidebar switcher only. */
export type NamespaceScope = Readonly<{
	pinned: Option.Option<string>
	observed: ReadonlyArray<string>
	isLoading: boolean
}>

export type ViewInputs = Readonly<{
	memberships: ReadonlyArray<ClerkOrganization>
	activeOrgId: Option.Option<string>
	side?: Side
	align?: Align
	namespaceScope?: NamespaceScope
	toView: (
		render: Readonly<{
			trigger: ReadonlyArray<ChildAttribute>
			withTrigger: (button: Html) => ReadonlyArray<Html>
		}>,
	) => Html
}>

type H = HtmlBuilder<Message>

/** `OrgAvatar`: the org's initials on the primary colour (no image in a stubbed or fresh org). */
export const orgAvatar = <M>(h: HtmlBuilder<M>, name: string, className?: string): Html =>
	avatarFallback(
		h,
		{
			className: cn("size-8 rounded-md bg-transparent", className),
			fallbackClassName: "rounded-[inherit] bg-primary text-primary-foreground text-xs font-semibold",
		},
		initialsFrom(name),
	)

/** `RegionBadge`. */
const regionBadge = (h: H, organization: ClerkOrganization): Html => {
	const label = MAPLE_REGION_LABELS[organization.homeRegion]
	return badge(
		h,
		{ variant: "meta", size: "xs", mono: true, className: "ml-auto", attributes: [h.Title(`Data region: ${label.name}`)] },
		[label.short],
	)
}

const organizationItem = (h: H, organization: ClerkOrganization, isActive: boolean): MenuView.MenuItemEntry => ({
	_tag: "Item",
	value: `${ORG_PREFIX}${organization.id}`,
	label: organization.name,
	content: [
		orgAvatar(h, organization.name),
		h.span([h.Class("truncate"), h.Title(organization.name)], [organization.name]),
		...(hasMultipleRegions && !organization.isRegionOpen ? [regionBadge(h, organization)] : []),
		...(isActive ? [icon(h, "CheckIcon", hasMultipleRegions ? {} : { className: "ml-auto" })] : []),
	],
})

const checkIcon = (h: H): Html => icon(h, "CheckIcon", { className: "ml-auto" })

const namespaceItem = (h: H, value: string, label: string, isPinned: boolean): MenuView.MenuItemEntry => ({
	_tag: "Item",
	value,
	label,
	content: [h.span([h.Class("truncate")], [label]), ...(isPinned ? [checkIcon(h)] : [])],
})

/** `NamespaceScopeSubmenu`: the pin on the trigger, the observed namespaces inside. */
const namespaceSubmenu = (h: H, scope: NamespaceScope): MenuView.MenuSubmenuEntry => {
	const { pinned, observed } = scope
	const isPinnedObserved = Option.match(pinned, { onNone: () => true, onSome: (name) => observed.includes(name) })
	const entries: ReadonlyArray<MenuView.MenuItemEntry> = [
		namespaceItem(h, ALL_NAMESPACES, "All namespaces", Option.isNone(pinned)),
		...observed.map((name) => namespaceItem(h, `${NAMESPACE_PREFIX}${name}`, name, Option.contains(pinned, name))),
		...(isPinnedObserved
			? []
			: Option.match(pinned, {
					onNone: () => [],
					onSome: (name): ReadonlyArray<MenuView.MenuItemEntry> => [
						{
							_tag: "Item",
							value: `${NAMESPACE_PREFIX}${name}`,
							label: name,
							content: [
								h.span([h.Class("truncate")], [name]),
								h.span([h.Class("ml-2 text-xs text-muted-foreground")], ["no recent data"]),
								checkIcon(h),
							],
						},
					],
				})),
	]
	const isLoadingEmpty = scope.isLoading && observed.length === 0
	const isEmpty = observed.length === 0 && Option.isNone(pinned)
	return {
		_tag: "Submenu",
		value: NAMESPACE_SUBMENU,
		label: "Namespace",
		className: "min-w-52",
		content: [
			icon(h, "LayersIcon"),
			"Namespace",
			h.span(
				[h.Class("ml-auto max-w-32 truncate pl-4 text-xs text-muted-foreground")],
				[Option.getOrElse(pinned, () => "All")],
			),
		],
		entries: isLoadingEmpty || isEmpty ? [] : entries,
		itemsClassName: "max-h-72 overflow-y-auto",
		placeholder: isLoadingEmpty
			? [
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
			: [],
	}
}

const entriesOf = (h: H, inputs: ViewInputs): ReadonlyArray<MenuView.MenuEntry> => [
	{
		_tag: "Group",
		label: "Organizations",
		entries: inputs.memberships.map((organization) =>
			organizationItem(h, organization, Option.contains(inputs.activeOrgId, organization.id)),
		),
	},
	{ _tag: "Separator" },
	{
		_tag: "Group",
		entries: [{ _tag: "Item", value: CREATE_VALUE, label: "Create Organization", icon: "PlusIcon" }],
	},
	...(inputs.namespaceScope === undefined
		? []
		: [{ _tag: "Separator" } as const, namespaceSubmenu(h, inputs.namespaceScope)]),
]

/** `CreateOrganizationDialog`: a `FormDialog` with the name field (one region: no region choice). */
const createDialog = (h: H, model: Model): Html => {
	const id = model.createDialog.id
	const isBlank = model.name.trim() === ""
	return h.submodel({
		slotId: id,
		model: model.createDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			hasDescription: true,
			className: "sm:max-w-md",
			toView: ({ portal }) => portal,
			toContent: (close) => [
				h.form(
					[h.Class("contents"), h.OnSubmit(Message.SubmittedCreateOrganization())],
					[
						DialogView.dialogHeader(h, "dialog", [
							DialogView.dialogTitle(h, "dialog", id, "Create Organization"),
							DialogView.dialogDescription(h, "dialog", id, "Create a new organization to collaborate with your team."),
						]),
						DialogView.dialogPanel(h, "dialog", id, createFields(h, model), "space-y-4"),
						DialogView.dialogFooter(h, "dialog", [
							button(
								h,
								{ variant: "outline", isDisabled: model.isCreating, slot: "dialog-close", attributes: model.isCreating ? [] : close },
								["Cancel"],
							),
							button(h, { type: "submit", isLoading: model.isCreating, isDisabled: model.isCreating || isBlank }, ["Create"]),
						]),
					],
				),
			],
		},
		toParentMessage: (message) => Message.GotCreateDialogMessage({ message }),
	})
}

const createFields = (h: H, model: Model): ReadonlyArray<Html> => [
	input(h, {
		id: `${model.createDialog.id}-name`,
		isDisabled: model.isCreating,
		attributes: [
			h.Maxlength(100),
			h.Placeholder("Organization name"),
			h.Required(true),
			h.Value(model.name),
			h.OnInput((value) => Message.ChangedOrganizationName({ value })),
		],
	}),
	...(model.errorMessage === null
		? []
		: [h.div([h.Class("text-destructive text-xs text-sm"), h.DataAttribute("slot", "field-error")], [model.errorMessage])]),
]

/** `<DropdownMenuContent side align sideOffset={4} className="min-w-56">` around the entries. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const dialog = createDialog(h, model)
	return h.submodel({
		slotId: model.menu.id,
		model: model.menu,
		view: MenuView.view,
		viewInputs: {
			entries: entriesOf(h, inputs),
			className: "min-w-56",
			side: inputs.side ?? "bottom",
			align: inputs.align ?? "start",
			sideOffset: 4,
			toView: ({ trigger, withTrigger }) =>
				inputs.toView({ trigger, withTrigger: (button) => [...withTrigger(button), dialog] }),
		},
		toParentMessage: (message) => Message.GotMenuMessage({ message }),
	})
})
