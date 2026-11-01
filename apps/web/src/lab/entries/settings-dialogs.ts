import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2ApiKeyWithSecret, V2Source } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../../page/contract"
import { deleteDialog } from "../../page/dashboards/list/view-dialogs"
import * as DashboardList from "../../page/dashboards/list/update"
import * as DashboardListModel from "../../page/dashboards/list/model"
import type { Message as DashboardListMessage } from "../../page/dashboards/list/message"
import * as Integrations from "../../page/integrations/update"
import type * as IntegrationsModel from "../../page/integrations/model"
import type { Message as IntegrationsMessage } from "../../page/integrations/message"
import { disconnectDialog } from "../../page/integrations/view-disconnect"
import * as Profile from "../../page/settings/account/profile/update"
import * as ProfileView from "../../page/settings/account/profile/view"
import * as General from "../../page/settings/general/update"
import type { OrgInfo } from "../../page/settings/general/model"
import * as GeneralView from "../../page/settings/general/view"
import * as KeyDialog from "../../page/settings/keys/create-dialog"
import * as KeyDialogView from "../../page/settings/keys/create-dialog-view"
import * as SourceDetail from "../../page/sources/detail/update"
import type * as SourceDetailModel from "../../page/sources/detail/model"
import { Message as SourceMessage } from "../../page/sources/detail/message"
import { settingsTab } from "../../page/sources/detail/view-tabs"
import * as Destination from "../../page/alerts/destination/dialog"
import * as DestinationView from "../../page/alerts/destination/view"
import { AppRoute } from "../../route"
import * as Dialog from "../../ui/dialog"
import { defineLab } from "../define"

// `/lab/settings-dialogs?item=`: the disconnect, delete and create dialogs and the settings danger
// zones over fixtures, each rendered open. Child messages are dropped: the fixture never changes.

const ITEMS = [
	"disconnect",
	"disconnect-pending",
	"dashboard-delete",
	"dashboard-delete-pending",
	"key-create",
	"key-created",
	"destination",
	"general",
	"profile",
	"profile-dirty",
	"source-settings",
	"source-settings-dirty",
] as const

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const opened = (dialog: Dialog.Model): Dialog.Model => Dialog.init(dialog.id, dialog.kind, { isOpen: true })

const integrations = (isPending: boolean): IntegrationsModel.Model => {
	const model = Integrations.init({ search: { integration: "linear" } }, context).model
	return { ...model, disconnect: { dialog: opened(model.disconnect.dialog), isPending } }
}

const dashboards = (isDeleting: boolean): DashboardListModel.Model => {
	const model = DashboardList.init({ search: {} }, context).model
	const pendingDelete = {
		id: "dash_lab",
		name: "Checkout latency",
		description: null,
		tags: [],
		widgetCount: 6,
		readsShort: "6 widgets",
		readsFull: "6 widgets",
		glyph: "GridIcon",
		createdAt: "2026-09-01T12:00:00.000Z",
		updatedAt: "2026-10-01T12:00:00.000Z",
	}
	return {
		...model,
		pendingDelete: Schema.decodeUnknownSync(DashboardListModel.ListDashboard)(pendingDelete),
		deleteDialog: opened(model.deleteDialog),
		isDeleting,
	}
}

const createdKey = Schema.decodeUnknownSync(V2ApiKeyWithSecret)({
	id: "key_aXwpxqBkqtYwtBtmsGbR41",
	object: "api_key",
	name: "ci-pipeline",
	description: "Publishes deploys from the CI pipeline",
	key_prefix: "maple_ak_9f2c",
	kind: "standard",
	scopes: ["dashboards:read", "alerts:write"],
	revoked: false,
	revoked_at: null,
	last_used_at: null,
	expires_at: null,
	created_at: "2026-07-01T12:00:00.000Z",
	created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
	created_by_email: "ci@acme.com",
	secret: "maple_ak_9f2cB1x8Kt7pQ2wR5vN0sL3dJ6hM4gY9",
})

const keyDialog = (isCreated: boolean): KeyDialog.Model => {
	const model = KeyDialog.init("lab-key-create")
	return { ...model, dialog: opened(model.dialog), created: isCreated ? createdKey : null }
}

const ORG: OrgInfo = { id: "org_lab", name: "Acme", hasImage: false, region: "us" }

const general = () => {
	const model = General.init(true).model
	return {
		...model,
		org: AsyncData.Success({ data: ORG }),
		admins: AsyncData.Success({ data: { count: 2, firstAdminName: "Dana" } }),
	}
}

const user = {
	id: "user_lab",
	firstName: "Dana",
	lastName: "Reyes",
	fullName: "Dana Reyes",
	hasImage: false,
	primaryEmail: "dana@acme.dev",
	primaryEmailAddressId: "email_lab",
	emails: [{ id: "email_lab", email: "dana@acme.dev", isVerified: true }],
	passkeys: [],
	externalAccounts: [],
	passwordEnabled: true,
	totpEnabled: false,
	backupCodeEnabled: false,
	deleteSelfEnabled: true,
}

const profile = (isDirty: boolean) => {
	const model = Profile.init().model
	return {
		...model,
		isLoaded: true,
		user,
		draft: isDirty ? { userId: user.id, firstName: "Dani", lastName: "Reyes" } : null,
	}
}

const SOURCE_ID = encodePublicId(PublicIdPrefixes.source, "0199a0e1-0000-7000-8000-000000000002")
const source = Schema.decodeUnknownSync(V2Source)({
	id: SOURCE_ID,
	object: "source",
	name: "Railway production",
	description: null,
	platform: "railway",
	kind: "integration",
	is_default: false,
	key_prefix: null,
	integration_id: null,
	status: "active",
	allowed_signals: null,
	rate_limit_rps: null,
	resource_attributes: [],
	expires_at: null,
	paused_at: null,
	paused_until: null,
	last_used_at: null,
	rolled_at: null,
	created_at: "2026-09-01T12:00:00.000Z",
	updated_at: "2026-09-01T12:00:00.000Z",
	health: { status: "healthy", last_data_at: "2026-10-01T11:56:00.000Z", problem: null, resources: null },
})

const sourceDetail = (isDirty: boolean): SourceDetailModel.Model => {
	const entered = SourceDetail.init(
		AppRoute.Source({ sourceId: SOURCE_ID, search: { tab: "settings" } }),
		context,
	).model
	const loaded = SourceDetail.update(
		entered,
		SourceMessage.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed([source]) }),
		context,
	).model
	return isDirty && loaded.settings !== null
		? { ...loaded, settings: { ...loaded.settings, name: "Railway prod" } }
		: loaded
}

const Model = Schema.Struct({ item: Schema.String })
type Model = typeof Model.Type

const Message = defineMessageUnion({ Ignored: {} })
type Message = typeof Message.Type
const ignore = () => Message.Ignored()

const disconnectView = Submodel.defineView<IntegrationsModel.Model, IntegrationsMessage>((model, h) =>
	disconnectDialog(h, model, "linear"),
)
const dashboardView = Submodel.defineView<DashboardListModel.Model, DashboardListMessage>(
	(model, h) => deleteDialog(h, model),
)
const sourceView = Submodel.defineView<SourceDetailModel.Model, SourceMessage>((model, h) =>
	settingsTab(h, model, source),
)

const render = (h: HtmlBuilder<Message>, item: string): Html => {
	switch (item) {
		case "disconnect":
		case "disconnect-pending":
			return h.submodel({
				slotId: "lab-disconnect",
				model: integrations(item === "disconnect-pending"),
				view: disconnectView,
				toParentMessage: ignore,
			})
		case "dashboard-delete":
		case "dashboard-delete-pending":
			return h.submodel({
				slotId: "lab-dashboard-delete",
				model: dashboards(item === "dashboard-delete-pending"),
				view: dashboardView,
				toParentMessage: ignore,
			})
		case "key-create":
		case "key-created":
			return h.submodel({
				slotId: "lab-key",
				model: keyDialog(item === "key-created"),
				view: KeyDialogView.view,
				toParentMessage: ignore,
				viewInputs: { slotId: "lab-key-popup" },
			})
		case "destination": {
			const model = Destination.init("lab-destination")
			return h.submodel({
				slotId: "lab-destination",
				model: { ...model, dialog: opened(model.dialog) },
				view: DestinationView.view,
				toParentMessage: ignore,
				viewInputs: { id: "lab-destination" },
			})
		}
		case "general":
			return h.submodel({
				slotId: "lab-general",
				model: general(),
				view: GeneralView.view,
				toParentMessage: ignore,
				viewInputs: { isKnownMember: true },
			})
		case "profile":
		case "profile-dirty":
			return h.submodel({
				slotId: "lab-profile",
				model: profile(item === "profile-dirty"),
				view: ProfileView.view,
				toParentMessage: ignore,
				viewInputs: {},
			})
		default:
			return h.submodel({
				slotId: "lab-source",
				model: sourceDetail(item === "source-settings-dirty"),
				view: sourceView,
				toParentMessage: ignore,
			})
	}
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto flex max-w-3xl flex-col gap-6 p-8")],
		[
			h.nav(
				[h.Class("flex flex-wrap gap-2 text-xs")],
				ITEMS.map((item) =>
					h.a(
						[
							h.Href(`/lab/settings-dialogs?item=${item}`),
							h.Class(item === model.item ? "font-medium text-foreground" : "text-muted-foreground"),
						],
						[item],
					),
				),
			),
			render(h, model.item),
		],
	)

export const lab = defineLab("Settings dialogs", {
	Model,
	init: () => ({ model: { item: new URLSearchParams(window.location.search).get("item") ?? "disconnect" } }),
	update: (model) => ({ model }),
	view,
})
