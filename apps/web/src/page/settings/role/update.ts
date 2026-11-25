import { type CustomRoleResponse, RoleKey, RoleListResponse } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import { failureMessage } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Select from "@maple/views/ui/select"
import * as Tabs from "@maple/views/ui/tabs"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { acceptGrants } from "../../kit/session-grants"
import * as CreateDialog from "../roles/create-dialog"
import {
	findRole,
	isTickable,
	isValidRoleDescription,
	isValidRoleName,
	type RoleDraft,
	type RoleEntry,
	roleHref,
	tickedPermissions,
} from "../roles/roles"
import { entriesOf } from "../roles/update"
import { canManageRoles } from "../roles/model"
import { FetchNamespaces, FetchRoleMembers, FetchRoles, FetchSession, SaveRole } from "./command"
import { Message } from "./message"
import type { EditorTab, Model } from "./model"

type Return = PageReturn<Model, Message>
type RoleRoute = Extract<AppRoute, { readonly _tag: "RoleEditor" }>

const TABS: ReadonlyArray<EditorTab> = ["permissions", "members"]

/** The role the page is for, once the list answers. */
export const roleOf = (model: Model): Option.Option<RoleEntry> => findRole(entriesOf(model), model.roleKey)

/** A custom role, and a viewer who may change roles. */
export const isEditable = (model: Model): boolean =>
	canManageRoles(model) && Option.exists(roleOf(model), (role) => !role.isBuiltIn)

const differs = (a: ReadonlyArray<Policy.Permission>, b: ReadonlyArray<Policy.Permission>) =>
	Arr.filter(Policy.allPermissions, (permission) => a.includes(permission) !== b.includes(permission))

/** The namespaces the draft limits the role to: none while the limit is off. */
export const draftNamespaces = (model: Model): ReadonlyArray<string> =>
	model.isLimited ? Policy.normalizeNamespaces(model.namespaces) : []

const sameNamespaces = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (namespace, index) => namespace === b[index])

/** Changes not saved yet: each permission added or removed, a new name, a new description and a new namespace limit. */
export const unsavedChanges = (model: Model): number =>
	model.isDraftLoaded
		? Option.match(roleOf(model), {
				onNone: () => 0,
				onSome: (role) =>
					differs(tickedPermissions(role.permissions), model.permissions).length +
					(Str.trim(model.name) === role.name ? 0 : 1) +
					(Str.trim(model.description) === role.description ? 0 : 1) +
					(sameNamespaces(Policy.normalizeNamespaces(role.namespaces), draftNamespaces(model))
						? 0
						: 1),
			})
		: 0

/** The role's holders; a key that names no role has none to read. */
const membersCommand = (roleKey: string) =>
	Option.match(Schema.decodeOption(RoleKey)(roleKey), {
		onNone: () => [],
		onSome: (roleId) => [FetchRoleMembers({ roleId })],
	})

/** Member is the usual baseline; the member role itself is compared with analyst. */
const defaultCompare = (roleKey: string): string => (roleKey === "member" ? "analyst" : "member")

export const init = (route: RoleRoute, context: PageContext): Return => {
	const members = membersCommand(route.roleId)
	return {
		model: {
			roleKey: route.roleId,
			grants: [],
			list: AsyncData.Loading(),
			members: members.length === 0 ? AsyncData.Idle() : AsyncData.Loading(),
			name: "",
			description: "",
			permissions: [],
			autoTicked: [],
			isLimited: false,
			namespaces: [],
			setAside: [],
			isNamespaceListFailed: false,
			namespacesBox: Combobox.init("role-namespaces", "multiple"),
			knownNamespaces: [],
			isDraftLoaded: false,
			tabs: Tabs.init({ idBase: 0, values: TABS, selected: "permissions" }),
			filter: "",
			show: "all",
			compare: Select.init("role-compare", {
				value: defaultCompare(route.roleId),
				selectedIndex: null,
			}),
			collapsedGroups: [],
			isSaving: false,
			create: CreateDialog.init("role-duplicate"),
		},
		commands: [FetchSession({ orgId: context.orgId }), FetchRoles(), FetchNamespaces(), ...members],
	}
}

const withDrafts = (model: Model, role: RoleEntry): Model => ({
	...model,
	name: role.name,
	description: role.description,
	permissions: tickedPermissions(role.permissions),
	autoTicked: [],
	isLimited: role.namespaces.length > 0,
	namespaces: role.namespaces,
	setAside: [],
	isDraftLoaded: true,
})

/** The first answer fills the drafts; later ones leave edits alone. */
const loadDrafts = (model: Model): Model =>
	model.isDraftLoaded
		? model
		: Option.match(roleOf(model), { onNone: () => model, onSome: (role) => withDrafts(model, role) })

/** The ticked permissions that need `permission`: while any stays ticked, so does it. */
export const requiredBy = (
	permissions: ReadonlyArray<Policy.Permission>,
	permission: Policy.Permission,
): ReadonlyArray<Policy.Permission> =>
	Arr.filter(permissions, (held) => Policy.implicationsOf(held).includes(permission))

interface PermissionDraft {
	readonly permissions: ReadonlyArray<Policy.Permission>
	readonly autoTicked: ReadonlyArray<Policy.Permission>
}

/**
 * Ticking adds what the permission implies, remembered as ticked for it. Unticking one another ticked
 * permission needs does nothing; unticking any other also unticks what it alone had ticked.
 */
const toggled = (draft: PermissionDraft, permission: Policy.Permission): PermissionDraft => {
	const { permissions, autoTicked } = draft
	if (!permissions.includes(permission)) {
		const next = Policy.withImplied([...permissions, permission])
		const added = Arr.filter(next, (held) => held !== permission && !permissions.includes(held))
		return { permissions: next, autoTicked: Arr.union(autoTicked, added) }
	}
	if (requiredBy(permissions, permission).length > 0) return draft
	const implied = Policy.implicationsOf(permission)
	const kept = Arr.filter(
		permissions,
		(held) => held !== permission && !(implied.includes(held) && autoTicked.includes(held)),
	)
	// Whatever a remaining permission still needs comes back.
	const next = Policy.withImplied(kept)
	return { permissions: next, autoTicked: Arr.filter(autoTicked, (held) => next.includes(held)) }
}

/**
 * Turning the limit on unticks what needs telemetry from every namespace, Read telemetry included,
 * and sets it aside. Turning it off ticks that back; a role that was limited when it loaded has
 * nothing aside, so it gets Read telemetry and goes on reading, now from every namespace.
 */
const toggledLimit = (model: Model): Model => {
	if (!model.isLimited) {
		return {
			...model,
			isLimited: true,
			permissions: Arr.filter(model.permissions, Policy.holdableWhenScoped),
			autoTicked: Arr.filter(model.autoTicked, Policy.holdableWhenScoped),
			setAside: Arr.filter(model.permissions, (permission) => !Policy.holdableWhenScoped(permission)),
		}
	}
	const back = model.setAside.length === 0 ? (["telemetry:read"] as const) : model.setAside
	return {
		...model,
		isLimited: false,
		permissions: Policy.withImplied([...model.permissions, ...back]),
		setAside: [],
	}
}

const isNamespace = Schema.is(Policy.RoleNamespace)
const areRoleNamespaces = Schema.is(Policy.RoleNamespaces)

/** Whether the drafted name, description and namespace limit make a role the API accepts. */
export const isValidDraft = (model: Model): boolean =>
	isValidRoleName(model.name) &&
	isValidRoleDescription(model.description) &&
	(!model.isLimited || (model.namespaces.length > 0 && areRoleNamespaces(draftNamespaces(model))))

/** The drafts as one update: a rename and a permission change are the same call. */
const savePayload = (model: Model): RoleDraft => ({
	name: Str.trim(model.name),
	description: Str.trim(model.description),
	permissions: model.permissions,
	namespaces: draftNamespaces(model),
})

const replaceSaved = (list: RoleListResponse, saved: CustomRoleResponse): RoleListResponse =>
	new RoleListResponse({
		builtIn: list.builtIn,
		custom: Arr.map(list.custom, (role) => (role.id === saved.id ? saved : role)),
		customRoleLimit: list.customRoleLimit,
		holders: list.holders,
	})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const liftCreate = (model: Model, step: ReturnType<typeof CreateDialog.update>): Return => ({
	model: { ...model, create: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotCreateMessage({ message })),
	outMessage:
		step.outMessage === undefined
			? undefined
			: PageOutMessage.RequestedNavigation({
					url: roleHref(step.outMessage.key),
					isReplace: false,
					toast: { type: "success", title: `${step.outMessage.name} created`, description: "" },
				}),
})

const whenEditable = (model: Model, edit: () => Model): Return => ({
	model: isEditable(model) ? edit() : model,
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchSession: (answer) => ({ model: acceptGrants(model, context.orgId, answer) }),
		CompletedFetchRoles: ({ result }) => ({
			model: loadDrafts({ ...model, list: AsyncData.settle(model.list, result) }),
		}),
		CompletedFetchMembers: ({ result }) => ({
			model: { ...model, members: AsyncData.settle(model.members, result) },
		}),
		ClickedRetry: () => ({ model: { ...model, list: AsyncData.Loading() }, commands: [FetchRoles()] }),
		ChangedName: ({ value }) => whenEditable(model, () => ({ ...model, name: value })),
		ChangedDescription: ({ value }) => whenEditable(model, () => ({ ...model, description: value })),
		ToggledPermission: ({ permission }) =>
			whenEditable(model, () =>
				isTickable(permission) && (!model.isLimited || Policy.holdableWhenScoped(permission))
					? { ...model, ...toggled(model, permission) }
					: model,
			),
		ToggledLimit: () => whenEditable(model, () => toggledLimit(model)),
		// The chips mirror the draft: the combobox's own selection is replaced by the draft's.
		GotNamespacesMessage: ({ message: child }) => {
			const step = Combobox.update({ ...model.namespacesBox, selected: model.namespaces }, child)
			const next = { ...model, namespacesBox: step.model }
			return {
				model:
					isEditable(model) && step.outMessage?._tag === "ChangedSelection"
						? { ...next, namespaces: step.outMessage.selected }
						: next,
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotNamespacesMessage({ message: inner }),
				),
			}
		},
		// Only what a role can name is offered: not the empty "not reported" entry, nor a name the API refuses.
		CompletedFetchNamespaces: ({ result }) => ({
			model: Result.match(result, {
				onSuccess: (namespaces) => ({
					...model,
					knownNamespaces: Arr.filter(namespaces, isNamespace),
					isNamespaceListFailed: false,
				}),
				onFailure: () => ({ ...model, isNamespaceListFailed: true }),
			}),
		}),
		ToggledGroup: ({ group }) => ({
			model: {
				...model,
				collapsedGroups: model.collapsedGroups.includes(group)
					? Arr.filter(model.collapsedGroups, (id) => id !== group)
					: [...model.collapsedGroups, group],
			},
		}),
		ChangedFilter: ({ value }) => ({ model: { ...model, filter: value } }),
		ClearedFilter: () => ({ model: { ...model, filter: "" } }),
		ChangedShow: ({ show }) => ({ model: { ...model, show } }),
		GotCompareMessage: ({ message: child }) => {
			const step = Select.update(model.compare, child)
			return {
				model: { ...model, compare: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotCompareMessage({ message: inner }),
				),
			}
		},
		GotTabsMessage: ({ message: child }) => {
			const step = Tabs.update(model.tabs, child)
			return {
				model: { ...model, tabs: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotTabsMessage({ message: inner }),
				),
			}
		},
		ClickedDiscard: () =>
			model.isSaving
				? { model }
				: Option.match(roleOf(model), {
						onNone: () => ({ model }),
						onSome: (role) => ({ model: withDrafts(model, role) }),
					}),
		ClickedSave: () => {
			const role = roleOf(model)
			if (
				!isEditable(model) ||
				model.isSaving ||
				unsavedChanges(model) === 0 ||
				!isValidDraft(model) ||
				Option.isNone(role) ||
				role.value.ref._tag !== "Custom"
			)
				return { model }
			const roleId = role.value.ref.id
			const loaded = Arr.findFirst(
				AsyncData.getOrElse(
					AsyncData.map(model.list, (list) => list.custom),
					() => [],
				),
				(custom) => custom.id === roleId,
			)
			if (Option.isNone(loaded)) return { model }
			return {
				model: { ...model, isSaving: true },
				commands: [
					SaveRole({
						roleId,
						payload: savePayload(model),
						expectedUpdatedAt: loaded.value.updatedAt,
					}),
				],
			}
		},
		CompletedSave: ({ result }) =>
			Result.match(result, {
				onSuccess: (saved) => ({
					model: {
						...model,
						isSaving: false,
						list: AsyncData.map(model.list, (list) => replaceSaved(list, saved)),
						name: saved.name,
						description: saved.description,
						permissions: tickedPermissions(saved.permissions),
						autoTicked: [],
						isLimited: (saved.namespaces ?? []).length > 0,
						namespaces: saved.namespaces ?? [],
						setAside: [],
					},
					outMessage: toast("success", `${saved.name} saved`),
				}),
				onFailure: (failure) => ({
					model: { ...model, isSaving: false },
					outMessage: toast("error", "Couldn't save the role", failureMessage(failure)),
				}),
			}),
		ClickedDuplicate: () =>
			canManageRoles(model)
				? liftCreate(model, CreateDialog.open(model.create, entriesOf(model), model.roleKey))
				: { model },
		GotCreateMessage: ({ message: child }) =>
			liftCreate(model, CreateDialog.update(model.create, child, entriesOf(model))),
	})
