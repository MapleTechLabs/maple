import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import {
	encodePublicId,
	PublicIdPrefixes,
	SourcePublicId,
	V2Source,
	V2SourceUsage,
	V2SourceUsageSummary,
} from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "@maple/views/ui/button"
import { AppRoute } from "../../route"
import type { PageContext } from "../../page/contract"
import { Message as ListMessage } from "../../page/sources/list/message"
import { Model as ListModel } from "../../page/sources/list/model"
import { init as listInit, update as listUpdate } from "../../page/sources/list/update"
import { view as listView } from "../../page/sources/list/view"
import { Message as DetailMessage } from "../../page/sources/detail/message"
import { Model as DetailModel } from "../../page/sources/detail/model"
import { init as detailInit, update as detailUpdate } from "../../page/sources/detail/update"
import { view as detailView } from "../../page/sources/detail/view"
import { Message as NewMessage } from "../../page/sources/new/message"
import { Model as NewModel } from "../../page/sources/new/model"
import { initPage as newInit, update as newUpdate } from "../../page/sources/new/update"
import { view as newView } from "../../page/sources/new/view"
import { defineShellLab } from "../shell-lab"

// `/lab/sources`: the sources list, one source and the connect page as an engineer or a member
// (`?page=list|detail|new&role=engineer|member`), over fixture sources.

const PAGES = ["list", "detail", "new"] as const
const ROLES = ["engineer", "member"] as const
type LabPage = (typeof PAGES)[number]
type LabRole = (typeof ROLES)[number]

const NOW = Date.UTC(2026, 10, 6, 12)
const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_sources"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const source = (index: number, fields: Readonly<Record<string, unknown>>): V2Source =>
	Schema.decodeSync(V2Source)({
		id: encodePublicId(PublicIdPrefixes.source, `0199a0e1-0000-7000-8000-00000000000${index}`),
		object: "source",
		name: `Source ${index}`,
		description: null,
		platform: "nodejs",
		kind: "token",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: null,
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: "2026-11-06T11:58:00.000Z",
		rolled_at: null,
		created_at: "2026-10-01T12:00:00.000Z",
		updated_at: "2026-10-01T12:00:00.000Z",
		health: {
			status: "healthy",
			last_data_at: "2026-11-06T11:58:00.000Z",
			problem: null,
			resources: null,
		},
		...fields,
	})

const CHECKOUT = source(2, { name: "Checkout API" })
const SOURCES: ReadonlyArray<V2Source> = [
	source(1, {
		name: "Default",
		platform: "opentelemetry",
		kind: "default",
		is_default: true,
		key_prefix: null,
	}),
	CHECKOUT,
	source(3, { name: "Web storefront", platform: "browser", key_prefix: "maple_src_Lp3Rb" }),
]

const USAGE = Schema.decodeSync(V2SourceUsage)({
	object: "source_usage",
	window_start: "2026-11-05T13:00:00.000Z",
	window_end: "2026-11-06T12:00:00.000Z",
	buckets: Arr.map(Arr.range(0, 23), (hour) => ({
		hour: new Date(Date.UTC(2026, 10, 5, 13 + hour)).toISOString(),
		spans: 4_000 + ((hour * 937) % 2_500),
		logs: 1_200 + ((hour * 421) % 900),
		metrics: 600,
		bytes: 2_400_000 + ((hour * 91_000) % 800_000),
	})),
})

const encodeSourceId = Schema.encodeSync(SourcePublicId)

const SUMMARY = Schema.decodeSync(V2SourceUsageSummary)({
	object: "source_usage_summary",
	window_start: "2026-11-05T13:00:00.000Z",
	window_end: "2026-11-06T12:00:00.000Z",
	data: Arr.map(SOURCES, (row, index) => ({
		source_id: encodeSourceId(row.id),
		spans: 48_000 * (index + 1),
		logs: 12_500 * (index + 1),
		metrics: 14_400,
		bytes: 61_000_000 * (index + 1),
	})),
})

const grantsOf = (role: LabRole): ReadonlyArray<Policy.Permission> =>
	role === "member" ? [] : Policy.allPermissions

const listModel = (role: LabRole): ListModel => {
	const step = (model: ListModel, message: ListMessage) => listUpdate(model, message, context).model
	const entered = listInit({ _tag: "Sources" }, context).model
	return Arr.reduce(
		[
			ListMessage.ReadClock({ nowMs: NOW }),
			ListMessage.CompletedReadGrants({ grants: grantsOf(role) }),
			ListMessage.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed(SOURCES) }),
			ListMessage.CompletedFetchUsage({
				key: entered.usage.key ?? "",
				result: Result.succeed(SUMMARY),
			}),
		],
		entered,
		step,
	)
}

/** The member opens `?tab=settings`, which lands on the overview; the engineer opens the overview. */
const detailModel = (role: LabRole): DetailModel => {
	const step = (model: DetailModel, message: DetailMessage) => detailUpdate(model, message, context).model
	const route = AppRoute.Source({
		sourceId: CHECKOUT.id,
		search: role === "member" ? { tab: "settings" } : {},
	})
	const entered = detailInit(route, context).model
	const loaded = Arr.reduce(
		[
			DetailMessage.ReadClock({ nowMs: NOW }),
			DetailMessage.CompletedFetchList({
				key: entered.list.key ?? "",
				result: Result.succeed(SOURCES),
			}),
			DetailMessage.CompletedReadGrants({ grants: grantsOf(role) }),
		],
		entered,
		step,
	)
	return step(
		loaded,
		DetailMessage.CompletedFetchUsage({ key: loaded.usage.key ?? "", result: Result.succeed(USAGE) }),
	)
}

const newModel = (role: LabRole): NewModel =>
	newUpdate(
		newInit(AppRoute.SourcesNew({ search: {} }), context).model,
		NewMessage.CompletedReadGrants({ grants: grantsOf(role) }),
		context,
	).model

const Model = Schema.Struct({
	page: Schema.Literals(PAGES),
	role: Schema.Literals(ROLES),
	list: ListModel,
	detail: DetailModel,
	create: NewModel,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedPage: { page: Schema.Literals(PAGES) },
	ClickedRole: { role: Schema.Literals(ROLES) },
	Ignored: {},
})
type Message = typeof Message.Type

const Flags = Schema.Struct({ page: Schema.Literals(PAGES), role: Schema.Literals(ROLES) })
type Flags = typeof Flags.Type

const decodePage = Schema.decodeUnknownOption(Schema.Literals(PAGES))
const decodeRole = Schema.decodeUnknownOption(Schema.Literals(ROLES))

const build = (page: LabPage, role: LabRole): Model => ({
	page,
	role,
	list: listModel(role),
	detail: detailModel(role),
	create: newModel(role),
})

const update = (model: Model, message: Message) =>
	Message.match(message, {
		ClickedPage: ({ page }) => ({ model: { ...model, page } }),
		ClickedRole: ({ role }) => ({ model: build(model.page, role) }),
		Ignored: () => ({ model }),
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.page === "list"
		? h.submodel({
				slotId: "sources-lab-list",
				model: model.list,
				view: listView,
				viewInputs: { context },
				toParentMessage: () => Message.Ignored(),
			})
		: model.page === "detail"
			? h.submodel({
					slotId: "sources-lab-detail",
					model: model.detail,
					view: detailView,
					viewInputs: { context },
					toParentMessage: () => Message.Ignored(),
				})
			: h.submodel({
					slotId: "sources-lab-new",
					model: model.create,
					view: newView,
					viewInputs: { context },
					toParentMessage: () => Message.Ignored(),
				})

/** The page and role switcher, fixed at the bottom like the other shell labs'. */
const switcher = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.Class(
				"bg-background fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-lg border p-1",
			),
		],
		[
			...Arr.map(PAGES, (page) =>
				button(
					h,
					{
						size: "xs",
						variant: model.page === page ? "secondary" : "ghost",
						attributes: [h.OnClick(Message.ClickedPage({ page }))],
					},
					[page],
				),
			),
			...Arr.map(ROLES, (role) =>
				button(
					h,
					{
						size: "xs",
						variant: model.role === role ? "secondary" : "ghost",
						attributes: [h.OnClick(Message.ClickedRole({ role }))],
					},
					[role],
				),
			),
		],
	)

export const lab = defineShellLab("Sources", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => {
		const params = new URLSearchParams(window.location.search)
		return {
			page: Option.getOrElse(decodePage(params.get("page")), (): LabPage => "list"),
			role: Option.getOrElse(decodeRole(params.get("role")), (): LabRole => "member"),
		}
	}),
	init: (flags: Flags) => ({ model: build(flags.page, flags.role) }),
	update,
	view,
	before: switcher,
	currentPath: "/sources",
	breadcrumbs: (model) =>
		model.page === "list"
			? [{ label: "Sources", isPageHeading: true }]
			: [{ label: "Sources" }, { label: model.page === "detail" ? CHECKOUT.name : "Connect source" }],
})
