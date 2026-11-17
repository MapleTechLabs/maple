import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { StatusPagePublicId, type V2StatusPageCustomDomain } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../../page/contract"
import { NOW, ORG } from "../../page/kit/alert-test-rows"
import { Message as EditorMessage } from "../../page/status-pages/editor/message"
import { Model as EditorModel } from "../../page/status-pages/editor/model"
import { init as editorInit, update as editorUpdate } from "../../page/status-pages/editor/update"
import { view as editorView } from "../../page/status-pages/editor/view"
import { component, statusPage } from "../../page/status-pages/shared/test-pages"
import type { Resources } from "../../platform/resources"
import { keepLocal } from "../local-commands"
import { defineShellLab } from "../shell-lab"

// `/lab/status-page-settings`: the status page editor's Settings tab over a fixture page. `?state=` picks one.

const LabState = Schema.Literals(["public", "password", "set-password", "internal", "member"])
type LabState = typeof LabState.Type

const Flags = Schema.Struct({ state: LabState })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ state: LabState, editor: EditorModel })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotEditorMessage: { message: EditorMessage } })
type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const CONTEXT: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const M = EditorMessage

const pageFor = (state: LabState) =>
	statusPage(
		state === "password"
			? { visibility: "password", has_password: true }
			: state === "internal"
				? { name: "Ops board", slug: "acme-ops", visibility: "internal" }
				: { break_glass_token_suffix: "x7Qk" },
	)

const NO_DOMAIN: V2StatusPageCustomDomain = {
	object: "status_page_custom_domain",
	page_id: statusPage().id,
	available: true,
	cname_target: "status-domains.maple.dev",
	hostname: null,
	status: null,
	dns_records: [],
	last_error: null,
	last_checked_at: null,
	activated_at: null,
	created_at: null,
}

const editorFor = (state: LabState): EditorModel => {
	const page = pageFor(state)
	const entered = editorInit(
		{
			_tag: "StatusPage",
			pageId: Schema.encodeSync(StatusPagePublicId)(page.id),
			search: { view: "settings" },
		},
		CONTEXT,
	).model
	return Arr.reduce(
		[
			M.ReadClock({ nowMs: NOW }),
			M.CompletedFetchSession({
				orgId: ORG,
				grants: Policy.grantsOf([state === "member" ? "org:member" : "org:admin"]),
			}),
			M.CompletedFetchPage({ key: entered.page.key ?? "", result: Result.succeed(page) }),
			M.CompletedFetchComponents({
				key: entered.components.key ?? "",
				result: Result.succeed([component(1), component(2)]),
			}),
			M.CompletedFetchIncidents({ key: entered.incidents.key ?? "", result: Result.succeed([]) }),
			M.CompletedFetchMonitors({ key: entered.monitors.key ?? "", result: Result.succeed([]) }),
			M.CompletedFetchCustomDomain({
				key: entered.customDomain.key ?? "",
				result: Result.succeed(NO_DOMAIN),
			}),
			...(state === "set-password" ? [M.ClickedChangePassword()] : []),
		],
		entered,
		(model, message) => editorUpdate(model, message, CONTEXT).model,
	)
}

const init = (flags: Flags): Return => ({ model: { state: flags.state, editor: editorFor(flags.state) } })

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotEditorMessage: ({ message: child }) => {
			const next = editorUpdate(model.editor, child, CONTEXT)
			return {
				model: { ...model, editor: next.model },
				commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
					Message.GotEditorMessage({ message: inner }),
				),
			}
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "lab-status-page-settings",
		model: model.editor,
		view: editorView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: EditorMessage) => Message.GotEditorMessage({ message }),
	})

export const lab = defineShellLab("Status page settings", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({
		state: Option.getOrElse(
			Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
			(): LabState => "public",
		),
	})),
	init,
	update,
	view,
	currentPath: "/lab/status-page-settings",
	breadcrumbs: [{ label: "Lab" }, { label: "Status page settings" }],
})
