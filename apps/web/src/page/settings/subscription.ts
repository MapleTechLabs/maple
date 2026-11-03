import type { ApiKeyRow } from "@maple/web-data/collections/api-keys"
import { Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { type OrgCollections, orgLive } from "../../data/collections/org-collections"
import { liveQueryStream } from "../../data/live-query"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message as IngestionMessage } from "./ingestion/message"
import { Message } from "./message"
import { Message as DataPlatformMessage } from "./data-platform/model"
import { isRunActive } from "./data-platform/update"
import { Message as AutomationMessage } from "./automation/model"
import { destinationRows } from "../alerts/shared/collections"
import { collectionLoadFailed } from "../alerts/shared/collection-load"
import { rowsToAlertDestinationDocuments } from "@maple/web-data/collections/alerts"
import type { Model } from "./model"
import { pollTicks } from "../../data/poll"

/**
 * Tabs that read the `api_keys` shape: Keys lists them, the audit log names their actors, and an
 * MCP key creation preloads it (`useApiKeyMutationSync().prepareForMutation`).
 */
const readsApiKeys = (model: Model): boolean => {
	const tab = model.tab
	if (tab === null) return false
	switch (tab._tag) {
		case "Keys":
			return true
		case "Mcp":
			return tab.model.createKey.isCreating || tab.model.createKey.created !== null
		case "AuditLog":
			return true
		default:
			return false
	}
}

/** Like the alerts hub: a keys list still empty after this shows the error block with Try again. */
const KEYS_LOAD_TIMEOUT_MS = 10_000

/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the Ingestion tab is mounted. */
const INGEST_POLL = "15 seconds"

/** `useApiKeysList()`: newest first, as one live query over the org's collection. */
export const apiKeyRows = <M>(
	orgId: string,
	toMessage: (rows: ReadonlyArray<ApiKeyRow>) => M,
): Stream.Stream<M, never, OrgCollections> =>
	orgLive(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ key: set.apiKeys }).orderBy(({ key }) => key.created_at, "desc"),
			(rows) => toMessage(rows),
		),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		apiKeys: entry(
			{ orgId: Schema.String, isReading: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isReading: readsApiKeys(model),
				}),
				dependenciesToStream: ({ orgId, isReading }) =>
					isReading
						? apiKeyRows(orgId, (rows) => Message.UpdatedApiKeys({ orgId, rows }))
						: Stream.empty,
			},
		),
		/** `useCollectionLoadFailed` while a tab waits on the first `api_keys` answer. */
		apiKeysLoad: entry(
			{ orgId: Schema.String, isWatching: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isWatching: readsApiKeys(model) && model.apiKeys === null && !model.isApiKeysLoadFailed,
				}),
				dependenciesToStream: ({ orgId, isWatching }) =>
					isWatching
						? collectionLoadFailed(
								`api_keys:${orgId}`,
								() => Message.FailedLoadApiKeys({ orgId }),
								KEYS_LOAD_TIMEOUT_MS,
							)
						: Stream.empty,
			},
		),
		/** `useAlertDestinationsList()` while the Automation tab routes to them. */
		destinations: entry(
			{ orgId: Schema.String, isReading: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isReading: model.tab?._tag === "Automation",
				}),
				dependenciesToStream: ({ orgId, isReading }) =>
					isReading
						? destinationRows(orgId, (rows) =>
								Message.GotAutomationMessage({
									message: AutomationMessage.UpdatedDestinations({
										destinations: rowsToAlertDestinationDocuments(rows),
									}),
								}),
							)
						: Stream.empty,
			},
		),
		ingestPoll: entry(
			{ isPolling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({ isPolling: model.tab?._tag === "Ingestion" }),
				dependenciesToStream: ({ isPolling }) =>
					isPolling
						? pollTicks(INGEST_POLL).pipe(
								Stream.map(() =>
									Message.GotIngestionMessage({ message: IngestionMessage.TickedPoll() }),
								),
							)
						: Stream.empty,
			},
		),
		/** `useIntervalRefresh(refreshStatus, { intervalMs: 2_000, enabled: runActive })`. */
		applyPoll: entry(
			{ isPolling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isPolling: model.tab?._tag === "DataPlatform" && isRunActive(model.tab.model),
				}),
				dependenciesToStream: ({ isPolling }) =>
					isPolling
						? pollTicks("2 seconds").pipe(
								Stream.map(() =>
									Message.GotDataPlatformMessage({
										message: DataPlatformMessage.TickedApplyPoll(),
									}),
								),
							)
						: Stream.empty,
			},
		),
	}),
)
