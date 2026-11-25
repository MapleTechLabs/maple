import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Tabs from "@maple/views/ui/tabs"
import type { PageContext } from "../page/contract"
import { Message as RoleMessage } from "../page/settings/role/message"
import * as RoleModel from "../page/settings/role/model"
import * as RoleUpdate from "../page/settings/role/update"
import * as RoleView from "../page/settings/role/view"
import {
	CHECKOUT_TEAM,
	ON_CALL,
	roleList,
	roleMembers,
	STATUS_EDITOR,
} from "../page/settings/roles/test-roles"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/role-editor`: one role's editor over fixtures, seen by an admin. `?state=` picks a start: a
// custom role with unsaved changes compared with Member (`custom`), the built-in Engineer role
// read-only (`built-in`), a custom role nobody holds on its Members tab (`members-empty`), a role
// limited to two namespaces (`limited`), or a custom role whose limit was just turned on, with no
// namespace chosen yet (`limiting`).

export const LabState = Schema.Literals(["custom", "built-in", "members-empty", "limited", "limiting"])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "custom",
	),
}))

export const Model = Schema.Struct({ editor: RoleModel.Model })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotEditorMessage: { message: RoleMessage } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const ORG = "org_lab"
const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }

const ROLE_KEYS = {
	custom: ON_CALL.id,
	"built-in": "engineer",
	"members-empty": STATUS_EDITOR.id,
	limited: CHECKOUT_TEAM.id,
	limiting: ON_CALL.id,
} as const satisfies {
	readonly [State in LabState]: string
}

const HOLDERS = roleMembers([
	{ id: "user_grace", name: "Grace Hopper" },
	{ id: "user_alan", name: "Alan Turing" },
	{ id: "user_katherine", name: "Katherine Johnson" },
])

/** The custom role's unsaved edits: two permissions added, one removed and a new description. */
const EDITS: ReadonlyArray<RoleMessage> = [
	RoleMessage.ToggledPermission({ permission: "uptime_monitors:manage" }),
	RoleMessage.ToggledPermission({ permission: "status_pages:edit" }),
	RoleMessage.ToggledPermission({ permission: "ai:act" }),
	RoleMessage.ChangedDescription({ value: "Member, plus alerting, on-call, SLOs and uptime." }),
]

const step = (model: RoleModel.Model, message: RoleMessage): RoleModel.Model =>
	RoleUpdate.update(model, message, context).model

export const init = (flags: Flags): Return => {
	const fresh = RoleUpdate.init({ _tag: "RoleEditor", roleId: ROLE_KEYS[flags.state] }, context).model
	const loaded = Arr.reduce(
		[
			RoleMessage.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:admin"]) }),
			RoleMessage.CompletedFetchRoles({
				result: Result.succeed(roleList([CHECKOUT_TEAM, ON_CALL, STATUS_EDITOR])),
			}),
			RoleMessage.CompletedFetchNamespaces({
				result: Result.succeed(["checkout", "payments", "platform", "search"]),
			}),
			RoleMessage.CompletedFetchMembers({
				result: Result.succeed(flags.state === "members-empty" ? roleMembers([]) : HOLDERS),
			}),
			...(flags.state === "custom" ? EDITS : []),
			...(flags.state === "limiting" ? [RoleMessage.ToggledLimit()] : []),
		],
		fresh,
		step,
	)
	const editor =
		flags.state === "members-empty"
			? { ...loaded, tabs: Tabs.init({ idBase: 0, values: loaded.tabs.values, selected: "members" }) }
			: loaded
	return { model: { editor } }
}

/** Kit commands run; every roles read and write is dropped, so a save stays pending. */
export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotEditorMessage: ({ message: child }) => {
			const next = RoleUpdate.update(model.editor, child, context)
			return {
				model: { editor: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (message) =>
					Message.GotEditorMessage({ message }),
				),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Role editor" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-role-editor",
		model: model.editor,
		view: RoleView.view,
		viewInputs: { context },
		toParentMessage: (message: RoleMessage) => Message.GotEditorMessage({ message }),
	})
