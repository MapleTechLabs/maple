import { Schema, Stream } from "effect"
import { AsyncData, Subscription } from "foldkit"
import type { Resources } from "../../../platform/resources"
import type { PageContext } from "../../contract"
import { incidentRows, ruleRows } from "../../kit/alert-collections"
import { collectionLoadFailed, ENRICHMENT_LOAD_TIMEOUT_MS } from "../../kit/collection-load"
import { Message } from "./message"
import type { Model } from "./model"

/** How long the verdict waits on the live incidents before saying they could not be checked. */
const INCIDENTS_LOAD_TIMEOUT_MS = 10_000

export type Input = Readonly<{ model: Model; context: PageContext }>

const byOrg = { orgId: Schema.String }
const waiting = { orgId: Schema.String, isWaiting: Schema.Boolean }

/** The synced alert incidents and rules the alerts pages read, with an end state for a stalled sync. */
export const subscriptions = Subscription.make<Input, Message, Resources>()((entry) => ({
	analystIncidents: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			incidentRows(orgId, (rows) => Message.UpdatedIncidents({ orgId, rows })),
	}),
	analystIncidentsLoadFailed: entry(waiting, {
		modelToDependencies: ({ model, context }) => ({
			orgId: context.orgId,
			isWaiting: AsyncData.isLoading(model.incidents),
		}),
		dependenciesToStream: ({ orgId, isWaiting }) =>
			isWaiting
				? collectionLoadFailed(
						`alert_incidents:${orgId}`,
						() => Message.FailedLoadIncidents({ orgId }),
						INCIDENTS_LOAD_TIMEOUT_MS,
					)
				: Stream.empty,
	}),
	analystRules: entry(byOrg, {
		modelToDependencies: ({ context }) => ({ orgId: context.orgId }),
		dependenciesToStream: ({ orgId }) =>
			ruleRows(orgId, (rows) => Message.UpdatedRules({ orgId, count: rows.length })),
	}),
	analystRulesLoadFailed: entry(waiting, {
		modelToDependencies: ({ model, context }) => ({
			orgId: context.orgId,
			isWaiting: AsyncData.isLoading(model.ruleCount),
		}),
		dependenciesToStream: ({ orgId, isWaiting }) =>
			isWaiting
				? collectionLoadFailed(
						`alert_rules:${orgId}`,
						() => Message.FailedLoadRules({ orgId }),
						ENRICHMENT_LOAD_TIMEOUT_MS,
					)
				: Stream.empty,
	}),
}))
