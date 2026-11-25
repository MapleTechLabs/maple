import * as Policy from "@maple/domain/policy"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Option, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { collapsible } from "@maple/views/ui/collapsible"
import { badge } from "@maple/views/ui/display"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyMessage,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { label } from "@maple/views/ui/label"
import { dividedList } from "@maple/views/ui/rule"
import { searchInput } from "@maple/views/ui/search-input"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import * as SelectView from "@maple/views/ui/select-view"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { saveBar } from "../../kit/save-bar"
import * as TabsView from "@maple/views/ui/tabs-view"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { detailTitle, detailTitleSkeleton } from "../../kit/detail-header"
import { expandChevron } from "../../kit/expand-chevron"
import { denialReason, gatedControl } from "../../kit/session-grants"
import * as CreateDialog from "../roles/create-dialog"
import {
	findRole,
	isSensitive,
	isValidRoleDescription,
	isValidRoleName,
	memberCountLabel,
	membersHref,
	type RoleEntry,
	rolesHref,
} from "../roles/roles"
import { entriesOf } from "../roles/update"
import { holderLabel, roleTextField, roleTypeBadge } from "../roles/view-parts"
import { Message } from "./message"
import { canManageRoles } from "../roles/model"
import type { Model, PermissionFilter } from "./model"
import { isEditable, isValidDraft, requiredBy, roleOf, unsavedChanges } from "./update"

type H = HtmlBuilder<Message>

const backLink = (h: H): Html =>
	textLink(h, { href: rolesHref(), tone: "muted" }, [icon(h, "ArrowLeftIcon", { size: 12 }), "All roles"])

const titleBlock = (h: H, role: RoleEntry): Html =>
	vstack(h, { gap: "2", shrink: true }, [
		backLink(h),
		detailTitle(h, {
			title: [role.name],
			adornment: roleTypeBadge(h, role.isBuiltIn),
			meta: [typography(h, { size: "xs", tone: "muted" }, [memberCountLabel(role.memberCount)])],
		}),
	])

const duplicateAction = (h: H, model: Model): Html =>
	gatedControl(h, model, "roles:manage", (isDisabled) =>
		button(
			h,
			{
				size: "sm",
				isDisabled,
				attributes: isDisabled ? [] : [h.OnClick(Message.ClickedDuplicate())],
			},
			[
				icon(h, "CopyIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
				"Duplicate to customize",
			],
		),
	)

// Permissions

/** The permissions a role's page lists: all of them for a built-in role, the grantable ones for a custom role. */
const listable = (role: RoleEntry): ReadonlyArray<Policy.Permission> =>
	role.isBuiltIn ? Policy.allPermissions : Arr.filter(Policy.allPermissions, Policy.grantableToCustomRoles)

const matchesFilter = (model: Model, permission: Policy.Permission): boolean => {
	const query = Str.toLowerCase(Str.trim(model.filter))
	const spec = Policy.permissions[permission]
	const matchesQuery =
		query === "" ||
		Arr.some([spec.label, permission, spec.description], (text) =>
			Str.includes(query)(Str.toLowerCase(text)),
		)
	const matchesShow = {
		all: true,
		granted: model.permissions.includes(permission),
		sensitive: isSensitive(permission),
	} satisfies Record<PermissionFilter, boolean>
	return matchesQuery && matchesShow[model.show]
}

const compareRole = (model: Model): Option.Option<RoleEntry> =>
	findRole(entriesOf(model), model.compare.value)

/** How this role differs from the compared one on a permission: only a difference is marked. */
type CompareDiff = "added" | "removed" | "same"

const diffOf = (model: Model, permission: Policy.Permission, compared: RoleEntry): CompareDiff => {
	const here = model.permissions.includes(permission)
	const there = compared.permissions.includes(permission)
	return here === there ? "same" : here ? "added" : "removed"
}

const COMPARE_COLUMN = "w-24 shrink-0"

const compareCell = (
	h: H,
	model: Model,
	permission: Policy.Permission,
	compared: Option.Option<RoleEntry>,
): Html =>
	hstack(
		h,
		{ as: "span", justify: "center", className: COMPARE_COLUMN },
		Option.match(compared, {
			onNone: () => [],
			onSome: (role) => {
				const diff = diffOf(model, permission, role)
				return diff === "same"
					? [
							h.span(
								[h.Class("sr-only")],
								[
									model.permissions.includes(permission)
										? `${role.name} has it too`
										: `${role.name} doesn't have it either`,
								],
							),
						]
					: [
							badge(h, { variant: diff === "added" ? "ok" : "crit", size: "xs" }, [
								diff === "added" ? "Added" : "Removed",
							]),
							h.span(
								[h.Class("sr-only")],
								[
									diff === "added"
										? `, ${role.name} doesn't have it`
										: `, ${role.name} has it`,
								],
							),
						]
			},
		}),
	)

/** "+3 added, 1 removed" against the compared role, or that they match. */
const compareSummary = (model: Model, role: RoleEntry, compared: RoleEntry): string => {
	const diffs = Arr.map(listable(role), (permission) => diffOf(model, permission, compared))
	const added = Arr.filter(diffs, (diff) => diff === "added").length
	const removed = Arr.filter(diffs, (diff) => diff === "removed").length
	if (added === 0 && removed === 0) return "Same permissions"
	return Arr.join(
		[...(added > 0 ? [`${added} added`] : []), ...(removed > 0 ? [`${removed} removed`] : [])],
		", ",
	)
}

/** "Required by Run raw SQL", or "… and 3 more" when several ticked permissions need it. */
const requiredNote = (needers: ReadonlyArray<Policy.Permission>): string => {
	const [first, ...rest] = Arr.map(needers, (needer) => Policy.permissions[needer].label)
	return rest.length === 0 ? `Required by ${first}` : `Required by ${first} and ${rest.length} more`
}

/** The row's text: label, code and badges on one line, the description under it. */
const permissionText = (
	h: H,
	permission: Policy.Permission,
	needers: ReadonlyArray<Policy.Permission>,
): Html => {
	const spec = Policy.permissions[permission]
	return vstack(h, { gap: "0.5", shrink: true, grow: true, as: "span" }, [
		// The requirement note sits on the title line, so ticking a permission never moves the rows below.
		hstack(h, { gap: "2", wrap: true, as: "span" }, [
			typography(h, { size: "sm", weight: "medium" }, [spec.label]),
			typography(h, { size: "xs", tone: "faint", mono: true }, [permission]),
			...(isSensitive(permission) ? [badge(h, { variant: "warn", size: "xs" }, ["Sensitive"])] : []),
			...(needers.length === 0
				? []
				: [badge(h, { variant: "meta", size: "xs" }, [requiredNote(needers)])]),
		]),
		typography(h, { size: "xs", tone: "muted" }, [spec.description]),
	])
}

/** A read-only row's mark: a plain check or a dash, so nothing reads as a control. */
const grantMark = (h: H, isGranted: boolean): Html =>
	hstack(h, { as: "span", justify: "center", className: "mt-0.5 size-4 shrink-0" }, [
		isGranted
			? icon(h, "CheckIcon", { size: 14, className: "text-foreground" })
			: icon(h, "MinusIcon", { size: 14, className: "text-foreground-faint" }),
		h.span([h.Class("sr-only")], [isGranted ? "Granted" : "Not granted"]),
	])

const ROW = "flex items-start gap-3 px-3 py-3"

const permissionRow = (
	h: H,
	model: Model,
	permission: Policy.Permission,
	compared: Option.Option<RoleEntry>,
): Html => {
	const isChecked = model.permissions.includes(permission)
	if (!isEditable(model))
		return h.div(
			[h.Key(permission), h.Class(ROW)],
			[
				grantMark(h, isChecked),
				permissionText(h, permission, []),
				compareCell(h, model, permission, compared),
			],
		)
	const needers = requiredBy(model.permissions, permission)
	const inputId = `role-permission-${Str.replaceAll(":", "-")(permission)}`
	return label(
		h,
		{
			className: cn(ROW, "font-normal hover:bg-surface-sunken active:bg-surface-sunken"),
			attributes: [h.Key(permission), h.Id(Checkbox.labelId(inputId))],
		},
		[
			...Checkbox.view(h, {
				model: { isChecked },
				toParentMessage: () => Message.ToggledPermission({ permission }),
				id: `${inputId}-root`,
				inputId,
				isDisabled: needers.length > 0,
				className: "mt-0.5",
			}),
			permissionText(h, permission, needers),
			compareCell(h, model, permission, compared),
		],
	)
}

const groupPanel = (
	h: H,
	model: Model,
	role: RoleEntry,
	group: (typeof Policy.permissionGroups)[number],
	compared: Option.Option<RoleEntry>,
): ReadonlyArray<Html> => {
	const inGroup = Arr.filter(
		listable(role),
		(permission) => Policy.permissions[permission].group === group.id,
	)
	const shown = Arr.filter(inGroup, (permission) => matchesFilter(model, permission))
	if (shown.length === 0) return []
	const granted = Arr.filter(inGroup, (permission) => model.permissions.includes(permission)).length
	const isOpen = !model.collapsedGroups.includes(group.id)
	return [
		collapsible(
			h,
			{
				isOpen,
				onToggle: Message.ToggledGroup({ group: group.id }),
				panelId: `role-group-${group.id}`,
				attributes: [h.Key(group.id), h.Class("overflow-hidden rounded-lg border")],
				triggerClassName:
					"flex w-full items-center gap-3 bg-surface-faint px-3 py-2 text-left hover:bg-surface-sunken active:bg-surface-sunken",
				trigger: [
					// A 16px slot, the checkbox's width, so the group name lines up with the permission names.
					hstack(h, { as: "span", justify: "center", className: "size-4 shrink-0" }, [
						expandChevron(h, isOpen),
					]),
					typography(h, { size: "sm", weight: "medium", className: "grow" }, [group.label]),
					typography(h, { size: "xs", tone: "muted", numeric: true }, [
						`${granted} of ${inGroup.length}`,
					]),
					typography(
						h,
						{
							size: "xs",
							tone: "muted",
							className: cn(COMPARE_COLUMN, "text-center"),
							truncate: true,
						},
						[Option.match(compared, { onNone: () => "", onSome: (entry) => `vs ${entry.name}` })],
					),
				],
			},
			[
				dividedList(
					h,
					{ as: "div", bordered: false, className: "border-t" },
					Arr.map(shown, (permission) => permissionRow(h, model, permission, compared)),
				),
			],
		),
	]
}

const SHOW_OPTIONS = [
	{ value: "all", label: "All" },
	{ value: "granted", label: "Granted" },
	{ value: "sensitive", label: "Sensitive" },
] as const

const compareSelect = (h: H, model: Model, role: RoleEntry): Html =>
	hstack(h, { gap: "2" }, [
		...Option.match(compareRole(model), {
			onNone: () => [],
			onSome: (compared) => [
				typography(
					h,
					{ size: "xs", tone: "muted", numeric: true, attributes: [h.AriaLive("polite")] },
					[compareSummary(model, role, compared)],
				),
			],
		}),
		typography(h, { size: "xs", tone: "muted", as: "span", attributes: [h.Id("role-compare-label")] }, [
			"Compare with",
		]),
		h.submodel({
			slotId: "role-compare",
			model: model.compare,
			view: SelectView.view,
			toParentMessage: (message) => Message.GotCompareMessage({ message }),
			viewInputs: {
				entries: Arr.flatMap(entriesOf(model), (entry): ReadonlyArray<SelectView.SelectEntry> =>
					entry.key === role.key
						? []
						: [{ _tag: "Item", item: { value: entry.key, label: entry.name } }],
				),
				labelledBy: "role-compare-label",
				size: "sm",
				className: "w-36",
				renderValue: (value) => [
					Option.match(findRole(entriesOf(model), value), {
						onNone: () => value,
						onSome: (entry) => entry.name,
					}),
				],
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
		}),
	])

const permissionsPanel = (h: H, model: Model, role: RoleEntry): ReadonlyArray<Html> => {
	const compared = compareRole(model)
	const groups = Arr.flatMap(Policy.permissionGroups, (group) =>
		groupPanel(h, model, role, group, compared),
	)
	return [
		vstack(h, { gap: "3", className: "pt-4" }, [
			hstack(h, { gap: "3", wrap: true, justify: "between" }, [
				hstack(h, { gap: "2", wrap: true }, [
					searchInput(h, {
						id: "role-permission-filter",
						value: model.filter,
						placeholder: "Filter permissions…",
						ariaLabel: "Filter permissions",
						size: "sm",
						className: "w-56",
						onInput: (value) => Message.ChangedFilter({ value }),
						onClear: Message.ClearedFilter(),
					}),
					segmentedSelect(h, {
						options: SHOW_OPTIONS,
						value: model.show,
						onChange: (show) => Message.ChangedShow({ show }),
						size: "sm",
						ariaLabel: "Show",
					}),
				]),
				compareSelect(h, model, role),
			]),
			...(groups.length === 0 ? [emptyMessage(h, {}, ["No permissions match"])] : groups),
		]),
	]
}

// Members

const membersEmpty = (h: H, role: RoleEntry): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "UserIcon")]),
			emptyTitle(h, [`No one holds ${role.name} yet`]),
			emptyDescription(h, ["Assign it from the Members page. A member holds one role at a time."]),
		]),
		emptyContent(h, [
			linkButton(h, { size: "sm", variant: "outline", href: membersHref() }, ["Open Members page"]),
		]),
	])

const membersPanel = (h: H, model: Model, role: RoleEntry): ReadonlyArray<Html> => [
	h.div(
		[h.Class("pt-4")],
		AsyncData.match(model.members, {
			onIdle: () => [membersEmpty(h, role)],
			onLoading: () => [skeleton(h, "h-24 w-full")],
			onFailure: (failure) => [
				errorState(h, { variant: "row", failure, title: "Couldn't load who holds it" }),
			],
			onSuccess: ({ members }) =>
				members.length === 0
					? [membersEmpty(h, role)]
					: [
							dividedList(
								h,
								{ as: "ul", bordered: true },
								Arr.map(members, (member) =>
									h.li(
										[h.Key(member.userId), h.Class("px-3 py-2.5")],
										[holderLabel(h, member)],
									),
								),
							),
						],
			onRefreshing: () => [],
			onStale: () => [],
		}),
	),
]

// Page

const detailsFields = (h: H, model: Model): Html =>
	grid(h, { cols: 1, sm: 2, gap: "4" }, [
		roleTextField(h, {
			id: "role-name",
			label: "Name",
			value: model.name,
			isDisabled: !isEditable(model),
			isInvalid: isEditable(model) && !isValidRoleName(model.name),
			maxLength: Policy.CUSTOM_ROLE_NAME_MAX,
			onInput: (value) => Message.ChangedName({ value }),
		}),
		roleTextField(h, {
			id: "role-description",
			label: "Description",
			value: model.description,
			isDisabled: !isEditable(model),
			isInvalid: isEditable(model) && !isValidRoleDescription(model.description),
			description: "Shown in the role picker.",
			maxLength: Policy.CUSTOM_ROLE_DESCRIPTION_MAX,
			onInput: (value) => Message.ChangedDescription({ value }),
		}),
	])

const roleTabs = (h: H, model: Model, role: RoleEntry): Html =>
	h.submodel({
		slotId: "role-editor-tabs",
		model: model.tabs,
		view: TabsView.view,
		toParentMessage: (message) => Message.GotTabsMessage({ message }),
		viewInputs: {
			variant: "underline",
			labels: [`Permissions ${model.permissions.length}`, `Members ${role.memberCount}`],
			ariaLabel: role.name,
			hasPanel: () => true,
			panel: (value) =>
				value === "members" ? membersPanel(h, model, role) : permissionsPanel(h, model, role),
		},
	})

const unsavedBar = (h: H, model: Model, role: RoleEntry): ReadonlyArray<Html> =>
	saveBar(h, {
		isDirty: unsavedChanges(model) > 0,
		isPending: model.isSaving,
		changeCount: unsavedChanges(model),
		context: `Applies to ${memberCountLabel(role.memberCount)} on their next request.`,
		onDiscard: Message.ClickedDiscard(),
		onSave: Message.ClickedSave(),
		saveLabel: "Save role",
		isSaveDisabled: !isValidDraft(model),
	})

/** Built-in roles are fixed presets: say so up front, and point at duplicating one to change it. */
const builtInBanner = (h: H): Html =>
	alert(h, { variant: "info", role: "status" }, [
		icon(h, "LockIcon"),
		alertTitle(h, ["Built-in role, read-only"]),
		alertDescription(h, [
			"Maple manages this role's permissions, so they can't be changed. Duplicate it to make a custom role you can edit.",
		]),
	])

const readOnlyNote = (h: H, model: Model, role: RoleEntry): ReadonlyArray<Html> =>
	role.isBuiltIn
		? [builtInBanner(h)]
		: canManageRoles(model)
			? []
			: [typography(h, { size: "xs", tone: "muted", as: "p" }, [denialReason("roles:manage")])]

const createDialog = (h: H, model: Model): Html =>
	h.submodel({
		slotId: "role-duplicate-form",
		model: model.create,
		view: CreateDialog.view,
		toParentMessage: (message) => Message.GotCreateMessage({ message }),
		viewInputs: { entries: entriesOf(model) },
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	if (AsyncData.isFailure(model.list))
		return dashboardPage(h, { titleContent: backLink(h), width: "settings" }, [
			errorState(h, {
				failure: model.list.error,
				title: "Couldn't load the role",
				onRetry: Message.ClickedRetry(),
			}),
		])
	if (!AsyncData.isSuccess(model.list) && !AsyncData.isRefreshing(model.list))
		return dashboardPage(h, { titleContent: detailTitleSkeleton(h), width: "settings" }, [
			skeleton(h, "h-16 w-full"),
			skeleton(h, "h-80 w-full"),
		])
	return Option.match(roleOf(model), {
		onNone: () =>
			dashboardPage(h, { titleContent: backLink(h), width: "settings" }, [
				alert(h, { variant: "warn" }, [
					icon(h, "CircleWarningIcon"),
					alertTitle(h, ["This role doesn't exist"]),
				]),
			]),
		onSome: (role) =>
			dashboardPage(
				h,
				{
					titleContent: titleBlock(h, role),
					actions: role.isBuiltIn ? duplicateAction(h, model) : undefined,
					width: "settings",
				},
				[
					vstack(h, { gap: "6" }, [
						...readOnlyNote(h, model, role),
						detailsFields(h, model),
						roleTabs(h, model, role),
						...unsavedBar(h, model, role),
					]),
					createDialog(h, model),
				],
			),
	})
})
