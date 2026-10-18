import type { ApiKeyRow } from "@maple/web-data/collections/api-keys"
import { Effect, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { OrgCollections } from "../../data/collections/org-collections"
import { liveQueryStream } from "../../data/live-query"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message as IngestionMessage } from "./ingestion/message"
import { Message } from "./message"
import { Message as AutomationMessage } from "./automation/model"
import { destinationRows } from "../alerts/shared/collections"
import { rowToAlertDestinationDocument } from "@maple/web-data/collections/alerts"
import type { Model } from "./model"

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
		case "Unported":
			return tab.tab === "audit-log"
		default:
			return false
	}
}

/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the Ingestion tab is mounted. */
const INGEST_POLL = "15 seconds"

/** `useApiKeysList()`: newest first, as one live query over the org's collection. */
export const apiKeyRows = <M>(
	orgId: string,
	toMessage: (rows: ReadonlyArray<ApiKeyRow>) => M,
): Stream.Stream<M, never, OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const set = yield* (yield* OrgCollections).forOrg(orgId)
			return liveQueryStream(
				(q) => q.from({ key: set.apiKeys }).orderBy(({ key }) => key.created_at, "desc"),
				(rows) => toMessage(rows),
			)
		}),
	)

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()((entry) => ({
	apiKeys: entry(
		{ orgId: Schema.String, isReading: Schema.Boolean },
		{
			modelToDependencies: ({ model, context }) => ({ orgId: context.orgId, isReading: readsApiKeys(model) }),
			dependenciesToStream: ({ orgId, isReading }) => (isReading ? apiKeyRows(orgId, (rows) => Message.UpdatedApiKeys({ orgId, rows })) : Stream.empty),
		},
	),
	/** `useAlertDestinationsList()` while the Automation tab routes to them. */
	destinations: entry(
		{ orgId: Schema.String, isReading: Schema.Boolean },
		{
			modelToDependencies: ({ model, context }) => ({ orgId: context.orgId, isReading: model.tab?._tag === "Automation" }),
			dependenciesToStream: ({ orgId, isReading }) =>
				isReading
					? destinationRows(orgId, (rows) =>
							Message.GotAutomationMessage({
								message: AutomationMessage.UpdatedDestinations({ destinations: rows.map(rowToAlertDestinationDocument) }),
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
					? Stream.tick(INGEST_POLL).pipe(
							Stream.drop(1),
							Stream.map(() => Message.GotIngestionMessage({ message: IngestionMessage.TickedPoll() })),
						)
					: Stream.empty,
		},
	),
}))
