import { BUCKET_SECONDS, PAGE_LABEL, PAGES } from "../gcp-workload-fixture"
import { gcpWorkloadName } from "../../components/infra/gcp/tabs"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type PageData, workloadData } from "../../page/infra-integrations/gcp/workload/derive"
import type * as Workload from "../../page/infra-integrations/gcp/workload/model"
import { workloadPageView } from "../../page/infra-integrations/gcp/workload/view"
import type * as Shell from "../../shell"
import { segmentedSelect } from "../../ui/segmented-select"
import { type LabPage, Message, type Model, SPAN_STATES } from "./model"
import { workloadOf } from "./update"

/** `WorkloadPage`'s props, read off the fixture. */
const dataOf = (page: LabPage): PageData => {
	const workload = workloadOf(page)
	const sql = workload.cloudSql
	return workloadData({
		service: workload.service,
		keys: workload.keys,
		points: workload.points,
		bucketSeconds: BUCKET_SECONDS,
		resource: workload.resource,
		overviewLoaded: true,
		tracedErrors: workload.tracedErrors,
		instance: sql?.instance,
		traceSide:
			sql === undefined
				? undefined
				: { databases: sql.databases, tracedQueries: sql.tracedQueries, services: sql.services },
		statements: sql?.statements ?? [],
		replicas: sql?.replicas ?? [],
	})
}

const DATA = { run: dataOf("run"), sql: dataOf("sql") } as const satisfies Record<LabPage, PageData>

const WorkloadView = Submodel.defineView<
	Workload.Model,
	Workload.Message,
	{ timeZone: string; page: LabPage }
>((model, inputs, h) =>
	// The route's header: the time controls beside the title; the fixture window stays put.
	workloadPageView(h, model, DATA[inputs.page], { timeZone: inputs.timeZone, defaultPreset: "6h" }),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Key(model.page), h.Class("contents")],
		[
			h.submodel({
				slotId: `gcp-workload-${model.page}`,
				model: model.workload,
				view: WorkloadView,
				viewInputs: { timeZone: model.timeZone, page: model.page },
				toParentMessage: (message) => Message.GotWorkloadMessage({ message }),
			}),
		],
	)

export const breadcrumbs = (model: Model): ReadonlyArray<Shell.BreadcrumbEntry> => {
	const workload = workloadOf(model.page)
	return [
		{ label: "Infrastructure" },
		{ label: "Google Cloud" },
		{ label: gcpWorkloadName(workload.service, workload.keys) },
	]
}

/** The floating lab bar: which workload the page shows. */
export const overlay = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.Class(
				"fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 shadow-popup",
			),
		],
		[
			h.span([h.Class("font-mono text-2xs text-muted-foreground")], ["Google Cloud lab"]),
			segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Lab page",
				options: PAGES.map((value) => ({ value, label: PAGE_LABEL[value] })),
				value: model.page,
				onChange: (page) => Message.ClickedLabPage({ page }),
			}),
			...(model.page === "sql"
				? [
						segmentedSelect(h, {
							size: "xs",
							ariaLabel: "Statement spans",
							options: SPAN_STATES.map((value) => ({ value, label: `spans: ${value}` })),
							value: model.spanState,
							onChange: (state) => Message.ClickedSpanState({ state }),
						}),
					]
				: []),
		],
	)
