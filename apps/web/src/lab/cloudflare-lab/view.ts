import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../charts/theme-colors"
import type * as List from "../../page/infra-integrations/cloudflare/list/model"
import { listScopeOf } from "../../page/infra-integrations/cloudflare/list/derive"
import { listBody, THEME_TOKENS, titleRow } from "../../page/infra-integrations/cloudflare/list/view"
import type * as Worker from "../../page/infra-integrations/cloudflare/worker/model"
import { workerPage } from "../../page/infra-integrations/cloudflare/worker/view"
import type * as Zone from "../../page/infra-integrations/cloudflare/zone/model"
import { zonePage } from "../../page/infra-integrations/cloudflare/zone/view"
import { dashboardPage } from "../../page/kit/dashboard-page"
import type * as Shell from "../../shell"
import { segmentedSelect } from "../../ui/segmented-select"
import { listFrame } from "./fixture"
import { LAB_PAGES, Message, type Model, PAGE_LABEL } from "./model"

type H = HtmlBuilder<Message>

/** `ListPage`: the route's title row and time controls around `CloudflareListPage`. */
const listView = Submodel.defineView<List.Model, List.Message, Readonly<{ multiAccount: boolean }>>(
	(model, inputs, h) => {
		const frame = listFrame(inputs.multiAccount)
		const scope = listScopeOf(model, frame.data, frame.accounts)
		return h.div(
			[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
			[
				dashboardPage(
					h,
					{
						scrollClassName: "gap-6",
						...titleRow(h, model, frame.singleAccountName, scope, frame.inPlaceViews === true),
					},
					[
						listBody(
							h,
							model,
							frame,
							{ theme: model.themeColors, isChartReady: model.chartRuntime._tag === "Ready" },
							false,
						),
					],
				),
			],
		)
	},
)

const zoneView = Submodel.defineView<Zone.Model, Zone.Message, Readonly<{ timeZone: string }>>(
	(model, inputs, h) => zonePage(h, model, inputs.timeZone, { isTimed: false, hasFilters: false }),
)

const workerView = Submodel.defineView<Worker.Model, Worker.Message, Readonly<{ timeZone: string }>>(
	(model, inputs, h) => workerPage(h, model, inputs.timeZone, false),
)

export const view = (model: Model, h: H): Html => {
	switch (model.page) {
		case "zone":
			return h.submodel({
				slotId: "cloudflare-lab-zone",
				model: model.zone,
				view: zoneView,
				viewInputs: { timeZone: model.timeZone },
				toParentMessage: (message) => Message.GotZoneMessage({ message }),
			})
		case "worker":
			return h.submodel({
				slotId: "cloudflare-lab-worker",
				model: model.worker,
				view: workerView,
				viewInputs: { timeZone: model.timeZone },
				toParentMessage: (message) => Message.GotWorkerMessage({ message }),
			})
		default:
			return h.submodel({
				slotId: "cloudflare-lab-list",
				model: model.list,
				view: listView,
				viewInputs: { multiAccount: model.page === "accounts" },
				toParentMessage: (message) => Message.GotListMessage({ message }),
			})
	}
}

/** The floating "Lab page" pivot, before the shell in `#app`. */
export const toolbar = (model: Model, h: H): Html =>
	h.div(
		[
			h.Class(
				"fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-popup",
			),
		],
		[
			h.span([h.Class("font-mono text-2xs text-muted-foreground")], ["Cloudflare lab"]),
			segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Lab page",
				options: LAB_PAGES.map((value) => ({ value, label: PAGE_LABEL[value] })),
				value: model.page,
				onChange: (page) => Message.ClickedLabPage({ page }),
			}),
		],
	)

export const breadcrumbs = (model: Model): ReadonlyArray<Shell.BreadcrumbEntry> => [
	{ label: "Infrastructure" },
	{ label: "Cloudflare" },
	...(model.page === "zone"
		? [{ label: "maple.dev" }]
		: model.page === "worker"
			? [{ label: "maple-api" }]
			: []),
]
