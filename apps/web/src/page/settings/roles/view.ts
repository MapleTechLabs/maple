import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr, Option } from "effect"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { dividedList } from "@maple/views/ui/rule"
import { errorState } from "@maple/views/ui/error-state"
import { fieldGroupLabel } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry, MenuItemEntry } from "@maple/views/ui/menu-view"
import { personAvatarStack } from "@maple/views/ui/person-avatar"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import * as SelectView from "@maple/views/ui/select-view"
import { skeleton } from "@maple/views/ui/skeleton"
import { vstack } from "@maple/views/ui/stack"
import {
	ROW_LINK_LIFT,
	rowNameLink,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { docsUrl } from "../../kit/docs"
import { denialTooltipContent, gatedControl } from "../../kit/session-grants"
import { settingsSection, settingsSections } from "../../kit/settings-section"
import * as CreateDialog from "./create-dialog"
import { canManageRoles, Message, type Model } from "./model"
import { findRole, memberCountLabel, type RoleEntry, roleHref } from "./roles"
import { entriesOf } from "./update"
import { holderLabel, permissionMeter, roleTypeBadge } from "./view-parts"

// `/settings/roles`: every role, built-in first, with what each holds and who holds it.

type H = HtmlBuilder<Message>

export const description = <M>(h: HtmlBuilder<M>): Html =>
	h.span(
		[],
		[
			"A role is a set of permissions that decides what a member can see and change. Each member holds one. ",
			textLink(
				h,
				{
					href: docsUrl("roles"),
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				["Learn more"],
			),
		],
	)

// Below `sm` the type and permissions columns give their width to the role's name.
const COLUMN = {
	type: "w-28 max-sm:hidden",
	members: "w-32",
	permissions: "w-40 max-sm:hidden",
	actions: "w-12",
} as const

/** The tab's primary action, in the settings page header beside the `<h1>`. */
export const headerActions = Submodel.defineView<Model, Message, Readonly<{}>>((model, _inputs, h) =>
	gatedControl(h, model, "roles:manage", (isDisabled) =>
		button(
			h,
			{ size: "sm", isDisabled, attributes: isDisabled ? [] : [h.OnClick(Message.ClickedCreate())] },
			[icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }), "Create role"],
		),
	),
)

const lockedUnless = (h: H, isAllowed: boolean): Pick<MenuItemEntry, "isDisabled" | "tooltip"> =>
	isAllowed ? {} : { isDisabled: true, tooltip: { content: denialTooltipContent(h, "roles:manage") } }

const rowEntries = (h: H, model: Model, role: RoleEntry): ReadonlyArray<MenuEntry> => {
	const canManage = canManageRoles(model)
	const duplicate: MenuEntry = {
		_tag: "Item",
		value: "duplicate",
		label: "Duplicate",
		icon: "CopyIcon",
		...lockedUnless(h, canManage),
	}
	return role.isBuiltIn
		? [{ _tag: "Item", value: "view", label: "View", icon: "EyeIcon" }, duplicate]
		: [
				canManage
					? { _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" }
					: { _tag: "Item", value: "view", label: "View", icon: "EyeIcon" },
				duplicate,
				{
					_tag: "Item",
					value: "delete",
					label: "Delete",
					icon: "TrashIcon",
					variant: "destructive",
					...lockedUnless(h, canManage),
				},
			]
}

/** Who holds the role: their avatars, each naming them on hover, then "+N"; a dash when nobody does. */
const holdersCell = (h: H, role: RoleEntry): Html =>
	role.memberCount === 0
		? typography(h, { size: "xs", tone: "muted" }, ["None"])
		: h.span(
				[h.Class(ROW_LINK_LIFT)],
				[
					personAvatarStack(h, {
						label: `${memberCountLabel(role.memberCount)} hold ${role.name}`,
						total: role.memberCount,
						people: Arr.map(role.holders, (holder) => ({
							name: holder.name ?? holder.identifier,
							imageUrl: holder.imageUrl ?? undefined,
							detail: holder.identifier,
						})),
					}),
				],
			)

const roleRow = (h: H, model: Model, role: RoleEntry): Html => {
	const menuId = `role-actions-${role.key}`
	return tableRow(
		h,
		[
			truncatedTableCell(h, [
				vstack(h, { gap: "0.5", shrink: true }, [
					rowNameLink(h, { href: roleHref(role.key), name: role.name }),
					typography(h, { size: "xs", tone: "muted", truncate: true }, [role.description]),
				]),
			]),
			tableCell(h, [roleTypeBadge(h, role.isBuiltIn)], COLUMN.type),
			tableCell(h, [holdersCell(h, role)], COLUMN.members),
			tableCell(h, [permissionMeter(h, role.permissions.length, role.isBuiltIn)], COLUMN.permissions),
			tableCell(h, [
				h.span(
					[h.Class(ROW_LINK_LIFT)],
					[
						rowActionsMenu(h, {
							slotId: menuId,
							model: model.rowMenus[menuId] ?? Menu.init(menuId),
							label: `Actions for ${role.name}`,
							entries: rowEntries(h, model, role),
							toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
						}),
					],
				),
			]),
		],
		"hover:bg-surface-sunken active:bg-surface-sunken",
		[h.Key(role.key)],
	)
}

const skeletonRow = (h: H, index: number): Html =>
	tableRow(
		h,
		[
			tableCell(h, [vstack(h, { gap: "1.5" }, [skeleton(h, "h-3.5 w-28"), skeleton(h, "h-3 w-56")])]),
			tableCell(h, [skeleton(h, "h-4 w-16")], COLUMN.type),
			tableCell(h, [skeleton(h, "h-3 w-6")]),
			tableCell(h, [skeleton(h, "h-3 w-28")], COLUMN.permissions),
			tableCell(h, []),
		],
		undefined,
		[h.Key(`skeleton-${index}`)],
	)

const rolesTable = (h: H, rows: ReadonlyArray<Html>): Html =>
	table(h, { className: "table-fixed", ariaLabel: "Roles" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Role"]),
				tableHead(h, ["Type"], COLUMN.type),
				tableHead(h, ["Members"], COLUMN.members),
				tableHead(h, ["Permissions"], COLUMN.permissions),
				tableHead(h, [], COLUMN.actions),
			]),
		]),
		tableBody(h, rows),
	])

/** The rows once the list answers (and while it reads again), skeleton rows before. */
const rolesRows = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.hasData(model.list)
		? Arr.map(entriesOf(model), (role) => roleRow(h, model, role))
		: Arr.map([0, 1, 2, 3], (index) => skeletonRow(h, index))

const rolesSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{ id: "settings-roles", title: "Roles", isLead: true, padded: false },
		AsyncData.isFailure(model.list)
			? [
					errorState(h, {
						variant: "row",
						failure: model.list.error,
						title: "Couldn't load roles",
						onRetry: Message.ClickedRetry(),
					}),
				]
			: [rolesTable(h, rolesRows(h, model))],
	)

/**
 * The roles a deleted role's members may move to: every other one but Admin, which would promote
 * them all at once; making someone an admin is the Members page's confirmed step.
 */
const reassignEntries = (model: Model): ReadonlyArray<SelectView.SelectEntry> =>
	Arr.flatMap(entriesOf(model), (role): ReadonlyArray<SelectView.SelectEntry> =>
		role.key === model.deleting?.id || role.key === "admin"
			? []
			: [{ _tag: "Item", item: { value: role.key, label: role.name } }],
	)

const affectedMembers = (h: H, model: Model): ReadonlyArray<Html> =>
	AsyncData.match(model.deleteMembers, {
		onIdle: () => [],
		onLoading: () => [skeleton(h, "h-9 w-full")],
		onFailure: () => [
			typography(h, { size: "xs", tone: "muted", as: "p" }, ["Couldn't load who holds it."]),
		],
		onSuccess: ({ members }) => [
			dividedList(
				h,
				{ as: "ul", bordered: true, className: "max-h-48 overflow-y-auto" },
				Arr.map(members, (member) =>
					h.li([h.Key(member.userId), h.Class("px-3 py-2")], [holderLabel(h, member)]),
				),
			),
		],
		onRefreshing: () => [],
		onStale: () => [],
	})

const reassignControls = (h: H, model: Model, count: number): ReadonlyArray<Html> => [
	vstack(h, { gap: "4" }, [
		typography(h, { size: "sm", tone: "muted", as: "p" }, [
			`${memberCountLabel(count)} ${count === 1 ? "holds" : "hold"} it. Choose the role they move to.`,
		]),
		vstack(h, { gap: "1.5" }, [
			fieldGroupLabel(h, { attributes: [h.Id("role-reassign-label")] }, "Move members to"),
			h.submodel({
				slotId: "role-reassign",
				model: model.reassignTo,
				view: SelectView.view,
				toParentMessage: (message) => Message.GotReassignMessage({ message }),
				viewInputs: {
					entries: reassignEntries(model),
					labelledBy: "role-reassign-label",
					className: "w-full",
					renderValue: (value) => [
						Option.match(findRole(entriesOf(model), value), {
							onNone: () => value,
							onSome: (role) => role.name,
						}),
					],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
			}),
		]),
		vstack(h, { gap: "1.5" }, [fieldGroupLabel(h, {}, "Who moves"), ...affectedMembers(h, model)]),
	]),
]

const deleteDialog = (h: H, model: Model): Html => {
	const deleting = model.deleting
	const count = deleting?.memberCount ?? 0
	return confirmDialog(h, {
		slotId: "role-delete",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: `Delete ${deleting?.name ?? "role"}?`,
		description:
			count === 0
				? "Nobody holds it. This can't be undone."
				: "Its members keep working on the role you pick.",
		children: count === 0 ? [] : reassignControls(h, model, count),
		confirmLabel: "Delete role",
		tone: "destructive",
		isPending: model.isDeleting,
		onConfirm: Message.ClickedConfirmDelete(),
	})
}

export const view = Submodel.defineView<Model, Message, Readonly<{}>>((model, _inputs, h) =>
	settingsSections(h, [
		rolesSection(h, model),
		h.submodel({
			slotId: "role-create-form",
			model: model.create,
			view: CreateDialog.view,
			toParentMessage: (message) => Message.GotCreateMessage({ message }),
			viewInputs: { entries: entriesOf(model) },
		}),
		deleteDialog(h, model),
	]),
)
