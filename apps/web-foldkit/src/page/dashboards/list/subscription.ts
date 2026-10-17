import type { DashboardDocument } from "@maple/domain/http"
import type { DashboardRow } from "@maple/web-data/collections/dashboards"
import { Array as Arr, Effect, Option, Order, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { rowToDocument } from "../../../data/collections/dashboards"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { dashboardsOf } from "../kit/store"
import { dashboardDomains, readsFromLabel } from "../kit/summary"
import { Message } from "./message"
import type { Glyph, ListDashboard, Model } from "./model"

/** `dashboardGlyph`. */
const glyphOf = (document: DashboardDocument): Glyph => {
	if (document.widgets.length === 0) return "GridIcon"
	switch (dashboardDomains(document)[0]) {
		case "Traces":
			return "PulseIcon"
		case "Logs":
			return "TextWrapIcon"
		case "Errors":
			return "CircleWarningIcon"
		case "Metrics":
			return "ChartBarIcon"
		case "Raw SQL":
			return "CodeIcon"
		case undefined:
			return "FileIcon"
	}
}

const toListDashboard = (document: DashboardDocument): ListDashboard => {
	const reads = readsFromLabel(document)
	return {
		id: document.id,
		name: document.name,
		description: document.description ?? null,
		tags: document.tags ?? [],
		widgetCount: document.widgets.length,
		readsShort: reads.short,
		readsFull: reads.full,
		glyph: glyphOf(document),
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	}
}

const byUpdatedDesc = Order.flip(Order.mapInput(Order.String, (row: DashboardRow) => row.updated_at))

/** `deriveDashboardsList`: newest-updated first; an undecodable payload drops its row. */
export const deriveDashboardsList = (rows: ReadonlyArray<DashboardRow>): ReadonlyArray<ListDashboard> =>
	Arr.flatMap(Arr.sort(rows, byUpdatedDesc), (row: DashboardRow) =>
		Option.toArray(Option.map(rowToDocument(row), toListDashboard)),
	)

/** `DashboardsListModel`: the org's synced `dashboards` collection. */
const dashboards = (orgId: string) =>
	Stream.unwrap(
		Effect.map(dashboardsOf(orgId), (collection) =>
			liveQueryStream(
				(q) => q.from({ d: collection }),
				(rows) => Message.UpdatedDashboards({ orgId, dashboards: deriveDashboardsList(rows) }),
			),
		),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		dashboards: entry(
			{ orgId: Schema.String },
			{
				modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
				dependenciesToStream: ({ orgId }) => dashboards(orgId),
			},
		),
	}),
)
