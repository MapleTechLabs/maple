import { rowToAlertIncidentDocument } from "@maple/web-data/collections/alerts"
import { Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import { type OrgCollectionSet, type OrgCollections, orgLive } from "../../data/collections/org-collections"
import { liveQueryStream } from "../../data/live-query"
import { collectionLoadFailed, ENRICHMENT_LOAD_TIMEOUT_MS } from "../alerts/shared/collection-load"
import type { Resources } from "../../platform/resources"
import type { PageSubscriptionInput } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { Message as SetupMessage } from "./setup-checklist"
import { isMounted } from "./setup-checklist-update"
import { pollTicks } from "../../data/poll"

const withSet = (
	orgId: string,
	stream: (set: OrgCollectionSet) => Stream.Stream<Message>,
): Stream.Stream<Message, never, OrgCollections> => orgLive(orgId, stream)

/** `useAlertIncidentsList()`: newest trigger first, reduced to what the banner and health read. */
const incidents = (orgId: string) =>
	withSet(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ i: set.alertIncidents }).orderBy(({ i }) => i.last_triggered_at, "desc"),
			(rows) =>
				Message.UpdatedIncidents({
					orgId,
					incidents: rows.map(rowToAlertIncidentDocument).map((incident) => ({
						status: incident.status,
						groupKey: incident.groupKey,
						severity: incident.severity,
					})),
				}),
		),
	)

/** `useAlertRulesList()`'s rules query, reduced to `enabled` (the banner counts them). */
const rules = (orgId: string) =>
	withSet(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ r: set.alertRules }).orderBy(({ r }) => r.updated_at, "desc"),
			(rows) => Message.UpdatedRules({ orgId, enabled: rows.map((row) => row.enabled) }),
		),
	)

/** `useAlertRulesList()`'s states query: synced alongside the rules, unread by this page. */
const ruleStates = (orgId: string) =>
	withSet(orgId, (set) =>
		liveQueryStream(
			(q) => q.from({ s: set.alertRuleStates }),
			() => Message.UpdatedRuleStates({ orgId }),
		),
	)

const byOrg = (stream: (orgId: string) => Stream.Stream<Message, never, OrgCollections>) => ({
	modelToDependencies: ({ context }: PageSubscriptionInput<Model>) => ({ orgId: context.orgId }),
	dependenciesToStream: ({ orgId }: { readonly orgId: string }) => stream(orgId),
})

export const subscriptions = Subscription.make<PageSubscriptionInput<Model>, Message, Resources>()(
	(entry) => ({
		incidents: entry({ orgId: Schema.String }, byOrg(incidents)),
		/** The banner and health counts stop waiting on an alert sync that failed or stalled. */
		incidentsLoadFailed: entry(
			{ orgId: Schema.String, isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isWaiting: AsyncData.isLoading(model.incidents),
				}),
				dependenciesToStream: ({ orgId, isWaiting }) =>
					isWaiting
						? collectionLoadFailed(
								`alert_incidents:${orgId}`,
								() => Message.FailedLoadIncidents({ orgId }),
								ENRICHMENT_LOAD_TIMEOUT_MS,
							)
						: Stream.empty,
			},
		),
		/** Same for the rules: without an end state a stalled sync would leave the page loading for good. */
		rulesLoadFailed: entry(
			{ orgId: Schema.String, isWaiting: Schema.Boolean },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: context.orgId,
					isWaiting: AsyncData.isLoading(model.rules),
				}),
				dependenciesToStream: ({ orgId, isWaiting }) =>
					isWaiting
						? collectionLoadFailed(
								`alert_rules:${orgId}`,
								() => Message.FailedLoadRules({ orgId }),
								ENRICHMENT_LOAD_TIMEOUT_MS,
							)
						: Stream.empty,
			},
		),
		rules: entry({ orgId: Schema.String }, byOrg(rules)),
		ruleStates: entry({ orgId: Schema.String }, byOrg(ruleStates)),
		/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the setup card is mounted. */
		setupPoll: entry(
			{ isPolling: Schema.Boolean },
			{
				modelToDependencies: ({ model }) => ({
					isPolling: model.setup !== null && isMounted(model.setup) && model.setup.window !== null,
				}),
				dependenciesToStream: ({ isPolling }) =>
					isPolling
						? pollTicks("15 seconds").pipe(
								Stream.map(() =>
									Message.GotSetupMessage({ message: SetupMessage.TickedPoll() }),
								),
							)
						: Stream.empty,
			},
		),
	}),
)
