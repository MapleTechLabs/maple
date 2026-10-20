import { Option, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { definePage, type PageSubscriptionInput } from "../../contract"
import { documentStream } from "../../dashboards/kit/document-stream"
import { destinationRows, incidentRows, ruleRows, ruleStateRows } from "../shared/collections"
import { collectionLoadFailed } from "../shared/collection-load"
import * as ChatConnectStream from "../shared/chat-connect-stream"
import * as DestinationDialog from "../destination/dialog"
import { decodeChartParam } from "./draft"
import { init } from "./init"
import { Message } from "./message"
import { Model } from "./model"
import { update } from "./update"
import { breadcrumbsOf, view } from "./view"

const byOrg = { orgId: Schema.String }
const watching = { orgId: Schema.String, isWatching: Schema.Boolean }

/** The dashboard to look the widget up in: both ids, no decodable `chart` snapshot, not an edit. */
const lookupDashboardId = (model: Model): string | null => {
	const { ruleId, dashboardId, widgetId, chart } = model.search
	if (ruleId !== undefined || dashboardId === undefined || widgetId === undefined) return null
	return chart !== undefined && Option.isSome(decodeChartParam(chart)) ? null : dashboardId
}

/** `useAlertRulesList`, `useAlertIncidentsList` and `useAlertDestinationsList`. */
const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	rules: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
	}),
	states: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => ruleStateRows(orgId, (rows) => Message.UpdatedRuleStates({ orgId, rows })),
	}),
	incidents: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) => incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
	}),
	destinations: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
	}),
	/** The Add destination menu's `useChatWorkspaceConnect`, outside the menu so closing it keeps watching. */
	menuChatConnect: entry(ChatConnectStream.Dependencies.fields, {
		modelToDependencies: ({ model }) => ChatConnectStream.dependenciesOf(model.chatConnect),
		dependenciesToStream: (dependencies) =>
			Stream.map(ChatConnectStream.streamOf(dependencies), (message) => Message.GotChatConnectMessage({ message })),
	}),
	destinationChatConnect: entry(ChatConnectStream.Dependencies.fields, {
		modelToDependencies: ({ model }) => DestinationDialog.chatConnectDependencies(model.destinationDialog),
		dependenciesToStream: (dependencies) =>
			Stream.map(DestinationDialog.chatConnectStream(dependencies), (message) =>
				Message.GotDestinationDialogMessage({ message }),
			),
	}),
	/** `useCollectionLoadFailed(rulesCollection.id, pending)` while an edit waits on the rules. */
	rulesLoad: entry(watching, {
		modelToDependencies: ({ model, context }) => ({
			orgId: context.orgId,
			isWatching: model.search.ruleId !== undefined && model.rules === null && !model.isRulesLoadFailed,
		}),
		dependenciesToStream: ({ orgId, isWatching }) =>
			isWatching
				? collectionLoadFailed(`alert_rules:${orgId}`, () => Message.FailedLoadRules({ orgId }))
				: Stream.empty,
	}),
	/** `useDashboardsRead`, only for the id-lookup fallback (a widget link without its snapshot). */
	sourceDashboard: entry(
		{ orgId: Schema.String, dashboardId: Schema.NullOr(Schema.String) },
		{
			modelToDependencies: ({ model, context }) => ({ orgId: context.orgId, dashboardId: lookupDashboardId(model) }),
			dependenciesToStream: ({ orgId, dashboardId }) =>
				dashboardId === null
					? Stream.empty
					: documentStream(orgId, dashboardId, (document) =>
							Message.UpdatedSourceDashboard({ orgId, dashboards: Option.toArray(document) }),
						),
		},
	),
	dashboardsLoad: entry(watching, {
		modelToDependencies: ({ model, context }) => ({
			orgId: context.orgId,
			isWatching: lookupDashboardId(model) !== null && model.sourceDashboards === null && !model.isDashboardsLoadFailed,
		}),
		dependenciesToStream: ({ orgId, isWatching }) =>
			isWatching
				? collectionLoadFailed(`dashboards:${orgId}`, () => Message.FailedLoadDashboards({ orgId }))
				: Stream.empty,
	}),
}))

/** `/alerts/create`: a new rule, a template, a chart's prefill, or `?ruleId=` to edit one. */
export const page = definePage(
	"AlertEditor",
	{ Model, Message },
	{
		routes: ["AlertsCreate"],
		// A different rule or prefill source is a different draft (`RuleDraft.key` remounts the surface).
		key: (route) => JSON.stringify(route.search),
		init,
		update,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
