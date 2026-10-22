import { MAPLE_REGION_LABELS, MapleRegion } from "@maple/domain/organization-regions"
import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import { currentRegion, hasMultipleRegions } from "../lib/region"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import type { ClerkOrganization } from "../platform/clerk"
import { avatarFallback, badge } from "../ui/display"
import { icon } from "../ui/icon"
import * as MenuView from "../ui/menu-view"
import { button } from "../ui/button"
import * as DialogView from "../ui/dialog-view"
import { field, fieldDescription, fieldLabel } from "../ui/field"
import { input } from "../ui/input"
import * as RadioGroup from "../ui/radio-group"
import type { Align, Side } from "../ui/overlay/position"
import {
	ALL_NAMESPACES,
	CREATE_VALUE,
	Message,
	type Model,
	MountNamespaceSearch,
	NAMESPACE_PREFIX,
	NAMESPACE_SUBMENU,
	ORG_PREFIX,
} from "./clerk-org-switcher"
import { hasNamespaceSearch, namespaceRows, namespaceSearchRow, noNamespacesMatch } from "./namespace-search"

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

/** `OrgAvatar`: the org's logo over its initials on the primary colour. */
export const orgAvatar = <M>(h: HtmlBuilder<M>, name: string, className?: string, imageUrl?: string): Html =>
	avatarFallback(
		h,
		{
			className: cn("size-8 rounded-md bg-transparent", className),
			fallbackClassName: "rounded-[inherit] bg-primary text-primary-foreground text-xs font-semibold",
			imageUrl,
			imageLabel: name,
			imageClassName: "object-cover",
		},
		initialsFrom(name),
	)

/** `RegionBadge`. */
const regionBadge = (h: H, region: MapleRegion, className?: string): Html => {
	const label = MAPLE_REGION_LABELS[region]
	return badge(
		h,
		{
			variant: "meta",
			size: "xs",
			mono: true,
			className,
			attributes: [h.Title(`Data region: ${label.name}`)],
		},
		[label.short],
	)
}

const organizationItem = (
	h: H,
	organization: ClerkOrganization,
	isActive: boolean,
): MenuView.MenuItemEntry => ({
	_tag: "Item",
	value: `${ORG_PREFIX}${organization.id}`,
	label: organization.name,
	content: [
		orgAvatar(h, organization.name, undefined, organization.imageUrl),
		h.span([h.Class("truncate"), h.Title(organization.name)], [organization.name]),
		...(hasMultipleRegions && !organization.isRegionOpen
			? [regionBadge(h, organization.homeRegion, "ml-auto")]
			: []),
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
const namespaceSubmenu = (h: H, model: Model, scope: NamespaceScope): MenuView.MenuSubmenuEntry => {
	const { pinned, observed } = scope
	const rows = namespaceRows(observed, pinned, model.namespaceQuery)
	const entries: ReadonlyArray<MenuView.MenuItemEntry> = [
		...(rows.isFiltered
			? []
			: [namespaceItem(h, ALL_NAMESPACES, "All namespaces", Option.isNone(pinned))]),
		...rows.matches.map((name) =>
			namespaceItem(h, `${NAMESPACE_PREFIX}${name}`, name, Option.contains(pinned, name)),
		),
		...Option.match(rows.unseenPin, {
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
		}),
	]
	const header = hasNamespaceSearch(observed)
		? [
				namespaceSearchRow(h, {
					id: `${model.menu.id}-namespace-search`,
					query: model.namespaceQuery,
					rowAttributes: [h.OnMount(MountNamespaceSearch())],
					attributes: [h.OnInput((value) => Message.ChangedNamespaceQuery({ value }))],
				}),
			]
		: []
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
		header: isLoadingEmpty || isEmpty ? [] : header,
		placeholder: rows.isNoMatch
			? [noNamespacesMatch(h)]
			: isLoadingEmpty
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

const entriesOf = (h: H, model: Model, inputs: ViewInputs): ReadonlyArray<MenuView.MenuEntry> => [
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
		: [{ _tag: "Separator" } as const, namespaceSubmenu(h, model, inputs.namespaceScope)]),
]

/** `CreateOrganizationDialog`: a `FormDialog` with the name field and, with several regions, the region. */
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
							DialogView.dialogDescription(
								h,
								"dialog",
								id,
								"Create a new organization to collaborate with your team.",
							),
						]),
						DialogView.dialogPanel(h, "dialog", id, createFields(h, model), "space-y-4"),
						DialogView.dialogFooter(h, "dialog", [
							button(
								h,
								{
									variant: "outline",
									isDisabled: model.isCreating,
									slot: "dialog-close",
									attributes: model.isCreating ? [] : close,
								},
								["Cancel"],
							),
							button(
								h,
								{
									type: "submit",
									isLoading: model.isCreating,
									isDisabled: model.isCreating || isBlank,
								},
								["Create"],
							),
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
	...(hasMultipleRegions ? [regionField(h, model)] : []),
	...(model.errorMessage === null
		? []
		: [
				h.div(
					[h.Class("text-destructive text-xs text-sm"), h.DataAttribute("slot", "field-error")],
					[model.errorMessage],
				),
			]),
]

const regionIdOf = (model: Model, region: MapleRegion) => `${model.createDialog.id}-region-${region}`
const NO_FIELD_STATE = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

/** The "Data region" radio: fixed at creation, so it is chosen here. */
const regionField = (h: H, model: Model): Html => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(model.region),
		toParentMessage: (message) => Message.GotRegionMessage({ message }),
		items: MapleRegion.literals.map((region) => ({
			value: region,
			id: regionIdOf(model, region),
			inputId: `${regionIdOf(model, region)}-input`,
			isDisabled: model.isCreating,
		})),
	}
	const descriptionId = `${model.createDialog.id}-region-description`
	const ids = {
		control: regionIdOf(model, currentRegion),
		label: `${model.createDialog.id}-region-label`,
		error: `${model.createDialog.id}-region-error`,
		description: descriptionId,
	}
	return field(h, { className: "w-full items-stretch", state: NO_FIELD_STATE }, [
		fieldLabel(h, { ids, state: NO_FIELD_STATE }, "Data region"),
		RadioGroup.radioGroup(
			h,
			{ className: "gap-0 divide-y divide-border overflow-hidden rounded-md border" },
			MapleRegion.literals.map((region) =>
				h.label(
					[
						h.Id(RadioGroup.labelId(`${regionIdOf(model, region)}-input`)),
						h.Class(
							"flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/40 has-[[data-checked]]:bg-accent/64",
						),
					],
					[
						regionBadge(h, region),
						h.span([h.Class("min-w-0 flex-1 text-sm")], [MAPLE_REGION_LABELS[region].name]),
						...RadioGroup.radio(h, config, region),
					],
				),
			),
		),
		fieldDescription(
			h,
			{ ids, state: NO_FIELD_STATE },
			"Telemetry is stored and processed only in this region. It cannot be changed later.",
		),
	])
}

/** `<DropdownMenuContent side align sideOffset={4} className="min-w-56">` around the entries. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const dialog = createDialog(h, model)
	return h.submodel({
		slotId: model.menu.id,
		model: model.menu,
		view: MenuView.view,
		viewInputs: {
			entries: entriesOf(h, model, inputs),
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
