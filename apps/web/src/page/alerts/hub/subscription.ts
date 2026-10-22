import { Clock, Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import * as DestinationDialog from "../destination/dialog"
import * as ChatConnectStream from "../shared/chat-connect-stream"
import { collectionLoadFailed } from "../shared/collection-load"
import { destinationRows, incidentRows, ruleRows, ruleStateRows } from "../shared/collections"
import { Message } from "./message"
import type { Model } from "./model"

/** How often the staleness derivation's clock advances (`CLOCK_TICK`). */
const CLOCK_TICK = "30 seconds"

const byOrg = { orgId: Schema.String }

/** How long the hub waits on its live rules and incidents before showing the failure. */
const HUB_LOAD_TIMEOUT_MS = 10_000

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		rules: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, rows })),
		}),
		states: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				ruleStateRows(orgId, (rows) => Message.UpdatedRuleStates({ orgId, rows })),
		}),
		incidents: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
		}),
		/** Rules and incidents gate the hub: a stopped or stalled stream shows the failure, not a skeleton. */
		loadFailed: entry(
			{ orgId: Schema.String, isWatching: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isWatching: (model.rules === null || model.incidents === null) && !model.isLoadFailed,
				}),
				dependenciesToStream: ({ orgId, isWatching }) =>
					isWatching
						? Stream.merge(
								collectionLoadFailed(
									`alert_rules:${orgId}`,
									() => Message.FailedLoadAlerts({ orgId }),
									HUB_LOAD_TIMEOUT_MS,
								),
								collectionLoadFailed(
									`alert_incidents:${orgId}`,
									() => Message.FailedLoadAlerts({ orgId }),
									HUB_LOAD_TIMEOUT_MS,
								),
							)
						: Stream.empty,
			},
		),
		destinations: entry(byOrg, {
			modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
			dependenciesToStream: ({ orgId }) =>
				destinationRows(orgId, (rows) => Message.UpdatedDestinations({ orgId, rows })),
		}),
		/** The destination dialog's workspace connect popup (`useChatWorkspaceConnect`). */
		destinationChatConnect: entry(ChatConnectStream.Dependencies.fields, {
			modelToDependencies: ({ model }) =>
				DestinationDialog.chatConnectDependencies(model.destinationDialog),
			dependenciesToStream: (dependencies) =>
				Stream.map(DestinationDialog.chatConnectStream(dependencies), (message) =>
					Message.GotDestinationDialogMessage({ message }),
				),
		}),
		clock: entry(
			{},
			{
				modelToDependencies: () => ({}),
				dependenciesToStream: () =>
					Stream.tick(CLOCK_TICK).pipe(
						Stream.drop(1),
						Stream.mapEffect(() =>
							Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
						),
					),
			},
		),
	}),
)
