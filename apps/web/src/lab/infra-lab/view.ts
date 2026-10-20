import { buildInfraLabFixture, type InfraLabFixture } from "../infra-fixture"
import { RailwayIntegrationStatus } from "@maple/domain/http"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { FLEET_BAND_BOXED } from "../../page/infra/kit/fleet-band"
import { pageHero, searchToolbar } from "../../page/infra/kit/page-parts"
import { filterHosts } from "../../page/infra/hosts/list/derive"
import { HOST_SORT_ACCESSORS } from "../../page/infra/hosts/list/view"
import { hostSummaryBand } from "../../page/infra/hosts/list/view-band"
import { hostTable } from "../../page/infra/hosts/list/view-table"
import type { Finding } from "../../page/infra/overview/model"
import { FINDINGS_LIST_CLASS, findingRow } from "../../page/infra/overview/view-findings"
import { sourceRow } from "../../page/infra/overview/view-sources"
import type * as RailwayList from "../../page/infra-integrations/railway/list/message"
import type { Model as RailwayModel } from "../../page/infra-integrations/railway/list/model"
import { servicesList } from "../../page/infra-integrations/railway/list/view"
import { sectionHeading } from "../../page/kit/section-heading"
import { sortRowsBy } from "../../page/kit/table-sort"
import { eyebrow } from "../../ui/eyebrow"
import { Message, type Model } from "./update"

type H = HtmlBuilder<Message>

const RANK = { crit: 0, warn: 1, stale: 2 } as const

/** `Frame`: one surface under its route label. */
const frame = (h: H, label: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("space-y-6 border-b pb-16"), h.DataAttribute("lab-frame", label)],
		[eyebrow(h, { as: "div" }, [label]), ...children],
	)

const overview = (h: H, fixture: InfraLabFixture): Html => {
	const findings: ReadonlyArray<Finding> = fixture.summaries
		.flatMap(([, summary]) => summary.findings)
		.toSorted((a, b) => RANK[a.tone] - RANK[b.tone])
	return frame(h, "/infra overview", [
		pageHero(h, {
			title: "Infrastructure",
			description: "6 sources reporting. What needs a look comes first.",
		}),
		h.div(
			[h.Class("space-y-3")],
			[
				sectionHeading(h, { title: "Needs attention", hint: "across every source, worst first" }),
				h.div(
					[h.Class(FINDINGS_LIST_CLASS)],
					findings.map((finding) => findingRow(h, finding, {})),
				),
			],
		),
		h.div(
			[h.Class("space-y-3")],
			[
				sectionHeading(h, { title: "Sources", hint: "one row per source reporting to this org" }),
				h.div(
					[h.Class("divide-y overflow-hidden rounded-lg border")],
					fixture.summaries.map(([id, summary]) =>
						sourceRow(h, id, { status: "ready", summary }, {}),
					),
				),
			],
		),
	])
}

const hosts = (h: H, model: Model, fixture: InfraLabFixture): Html => {
	const shown = filterHosts(fixture.hosts, model.hostScope, model.hostQuery, fixture.end)
	return frame(h, "/infra/hosts", [
		pageHero(h, {
			title: "Hosts",
			description: "Every machine sending CPU, memory, disk and network metrics, busiest first.",
		}),
		h.div(
			[h.Class("space-y-4")],
			[
				hostSummaryBand(h, {
					hosts: fixture.hosts,
					referenceTime: fixture.end,
					activeScope: model.hostScope,
					onScopeChange: (scope) => Message.ChangedHostScope({ scope }),
					className: FLEET_BAND_BOXED,
				}),
				searchToolbar(h, {
					id: "lab-hosts-search",
					value: model.hostQuery,
					onInput: (value) => Message.ChangedHostQuery({ value }),
					onClear: Message.ChangedHostQuery({ value: "" }),
					placeholder: "Search hosts…",
					trailing: `${shown.length} of ${fixture.hosts.length} hosts`,
				}),
				// `HostTable` keeps its own sort: CPU, descending, until a head is pressed.
				hostTable(h, sortRowsBy(shown, model.hostSort, HOST_SORT_ACCESSORS), {
					nowMs: model.nowMs,
					timeZone: model.timeZone,
					isWaiting: false,
					sort: model.hostSort,
					onSort: (key) => Message.ClickedHostSort({ key }),
				}),
			],
		),
	])
}

type RailwayInputs = Readonly<{ fixture: InfraLabFixture; nowMs: number; timeZone: string }>

/** `RailwayFleetBand`, the inert search and `RailwayServiceTable`: the Railway page's list body. */
const railwayView = Submodel.defineView<RailwayModel, RailwayList.Message, RailwayInputs>(
	(railway, inputs, h) =>
		servicesList(
			h,
			railway,
			new RailwayIntegrationStatus({
				connected: true,
				workspaceNames: null,
				connectedByUserId: null,
				connectedAt: null,
				authFailed: false,
				lastSyncedAt: null,
				lastError: null,
				environments: inputs.fixture.railwayEnvironments,
			}),
			inputs.fixture.railway,
			{ nowMs: inputs.nowMs, timeZone: inputs.timeZone },
			false,
			false,
		),
)

const railway = (h: H, model: Model, fixture: InfraLabFixture): Html =>
	frame(h, "/infra/railway", [
		pageHero(h, {
			title: "Railway",
			description:
				"CPU, memory, network and disk for every Railway service, polled from Railway's metrics API.",
		}),
		h.submodel({
			slotId: "lab-railway",
			model: model.railway,
			view: railwayView,
			viewInputs: { fixture, nowMs: model.nowMs, timeZone: model.timeZone },
			toParentMessage: (message: RailwayList.Message) => Message.GotRailwayMessage({ message }),
		}),
	])

export const view = (model: Model, h: H): Html => {
	const fixture = buildInfraLabFixture(model.nowMs)
	return h.div(
		[h.Class("mx-auto max-w-6xl space-y-16 p-8")],
		[overview(h, fixture), hosts(h, model, fixture), railway(h, model, fixture)],
	)
}
