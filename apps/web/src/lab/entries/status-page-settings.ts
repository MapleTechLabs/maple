import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { StatusPagePublicId, type V2StatusPageCustomDomain } from "@maple/domain/http/v2"
import { DEFAULT_STATUS_PAGE_THEME } from "@maple/domain/status-page"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../../page/contract"
import { NOW, ORG } from "../../page/kit/alert-test-rows"
import { PickBrandingImage, ReadBrandingImage } from "../../page/status-pages/editor/command"
import { Message as EditorMessage } from "../../page/status-pages/editor/message"
import { Model as EditorModel } from "../../page/status-pages/editor/model"
import { init as editorInit, update as editorUpdate } from "../../page/status-pages/editor/update"
import { view as editorView } from "../../page/status-pages/editor/view"
import { component, statusPage } from "../../page/status-pages/shared/test-pages"
import type { Resources } from "../../platform/resources"
import { keepLocal } from "../local-commands"
import { LAB_FAVICON, LAB_LOGO, LAB_LOGO_DARK } from "../status-pages-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/status-page-settings`: the status page editor over a fixture page: Settings > Basic settings,
// with Who can view under the custom domain, or the Appearance tab (`appearance*` states). `?state=` picks one.

const LabState = Schema.Literals([
	"public",
	"password",
	"set-password",
	"internal",
	"member",
	/** A custom domain just added: the CNAME and the ownership record to publish. */
	"domain-pending",
	/** Uploaded logo, dark logo and favicon; the theme in Auto, so only the accent has a picker. */
	"appearance",
	/** Forced dark with colour overrides: every colour has a picker. */
	"appearance-dark",
	/** No branding yet: empty upload targets. */
	"appearance-empty",
])
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

const UPLOADED = { logo_url: LAB_LOGO, logo_dark_url: LAB_LOGO_DARK, favicon_url: LAB_FAVICON }

const isAppearance = (state: LabState): boolean => Str.startsWith("appearance")(state)

const pageFor = (state: LabState) =>
	statusPage(
		state === "appearance"
			? UPLOADED
			: state === "appearance-dark"
				? {
						...UPLOADED,
						theme: {
							...DEFAULT_STATUS_PAGE_THEME,
							preset: "midnight",
							appearance: "dark",
							accent: "#a78bfa",
							card: "#1e1b2e",
						},
					}
				: state === "appearance-empty"
					? {}
					: state === "password"
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

const PENDING_DOMAIN: V2StatusPageCustomDomain = {
	...NO_DOMAIN,
	hostname: "status.acme.com",
	status: "pending_dns",
	dns_records: [
		{ type: "CNAME", name: "status.acme.com", value: "status-domains.maple.dev", purpose: "routing" },
		{
			type: "TXT",
			name: "_maple-challenge.status.acme.com",
			value: "maple-status-page=1c2ba8fdad86fbbe9cdd85449b0e85c6",
			purpose: "ownership",
		},
	],
	last_error:
		"Maple did not find the ownership TXT record yet. DNS changes can take a few minutes to appear.",
	last_checked_at: "2026-10-01T12:01:00.000Z",
	created_at: "2026-10-01T12:00:00.000Z",
}

const editorFor = (state: LabState): EditorModel => {
	const page = pageFor(state)
	const entered = editorInit(
		{
			_tag: "StatusPage",
			pageId: Schema.encodeSync(StatusPagePublicId)(page.id),
			search: { view: "settings", section: isAppearance(state) ? "appearance" : "basic" },
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
				result: Result.succeed(state === "domain-pending" ? PENDING_DOMAIN : NO_DOMAIN),
			}),
			...(state === "set-password" ? [M.PickedVisibility({ visibility: "password" })] : []),
		],
		entered,
		(model, message) => editorUpdate(model, message, CONTEXT).model,
	)
}

const init = (flags: Flags): Return => ({ model: { state: flags.state, editor: editorFor(flags.state) } })

const BRANDING_COMMANDS: ReadonlySet<string> = new Set([PickBrandingImage.name, ReadBrandingImage.name])

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotEditorMessage: ({ message: child }) => {
			const next = editorUpdate(model.editor, child, CONTEXT)
			return {
				model: { ...model, editor: next.model },
				commands: Command.mapMessages(
					[
						...keepLocal(next.commands),
						// Picking and reading an upload stay in the browser: try a real file.
						...Arr.filter(next.commands ?? [], (command) => BRANDING_COMMANDS.has(command.name)),
					],
					(inner) => Message.GotEditorMessage({ message: inner }),
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
