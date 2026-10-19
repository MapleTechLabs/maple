/**
 * The alerts-overview unit: rules + live evaluation states + incidents (three
 * Electric-synced collections) + delivery events (HTTP query) combined into
 * one derived rules-with-status view. This is the unitflow pilot — the
 * derivation that used to run as a useMemo pyramid on every render of
 * `AlertsOverviewTab` now recomputes only when a source emits, and lives
 * outside the component tree (importable from a non-React runtime).
 *
 * URL-backed filters and the session/destination atoms stay in the component —
 * they are routing/React concerns. The rule enable/disable toggle is a
 * model-owned `Mutation` (see `toggleRule` below), so the write and its
 * in-flight state live with the data they mutate.
 */

import type { AlertDeliveryEventDocument, AlertRuleDocument } from "@maple/domain/http"
import { Event, Model, Mutation, Query, Registry, Store } from "@maple/unitflow"
import * as Db from "@maple/unitflow/db"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { Reactivity } from "effect/reactivity/Reactivity"

import { type AlertsOverviewData, deriveOverview } from "@maple/web-data/alerts/overview"
import {
	type AlertIncidentRow,
	type AlertRuleRow,
	type AlertRuleStateRow,
	buildRuleStatesByRuleId,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { getOrgCollections } from "@/lib/collections/org-collections"
import {
	collectionFailureMessage,
	makeOrgCollectionsKey,
	orgCollectionStuckOptions,
	orgIdOf,
} from "@/lib/models/org-collections-key"
import { v2DeliveryToDocument } from "@maple/web-data/alerts/form-utils"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"

/** How often the wall-clock input of the staleness derivation advances. */
const CLOCK_TICK = "30 seconds"

interface OverviewSources {
	readonly rules: Db.CollectionState<AlertRuleRow>
	readonly states: Db.CollectionState<AlertRuleStateRow>
	readonly incidents: Db.CollectionState<AlertIncidentRow>
	readonly deliveries: ReadonlyArray<AlertDeliveryEventDocument>
	readonly now: number
}

/** Row-level combine body: phase handling + row→document, then {@link deriveOverview}. */
const buildOverview = (sources: OverviewSources): AlertsOverviewData => {
	// Rules + incidents gate the page — for BOTH error and loading. Evaluation
	// states are secondary/derived (the old tab read them via useAlertRuleStates,
	// which had no error channel and degraded to []): a failing states shape must
	// not blank the overview, it falls back to the rule doc's lastEvaluation* fields.
	const message = collectionFailureMessage(sources.rules) ?? collectionFailureMessage(sources.incidents)
	if (message !== null) {
		return { phase: "error", message }
	}
	if (!AsyncResult.isSuccess(sources.rules) || !AsyncResult.isSuccess(sources.incidents)) {
		return { phase: "loading" }
	}

	const stateRows = AsyncResult.isSuccess(sources.states) ? sources.states.value : []
	const evaluationStateByRule = buildRuleStatesByRuleId(stateRows)
	return deriveOverview({
		rules: sources.rules.value.map((row) => rowToAlertRuleDocument(row, evaluationStateByRule)),
		incidents: sources.incidents.value.map(rowToAlertIncidentDocument),
		states: stateRows,
		deliveryEvents: sources.deliveries,
		now: sources.now,
	})
}

/**
 * The rule enable/disable write, factored out of the model so it is testable
 * through the registry without standing up the full overview model (collections
 * + delivery query). Wrapping the PATCH in `reactivity.mutation(["alertRules"])`
 * keeps atom-world alertRules readers in sync; the model's own alertRules
 * Electric shape self-updates regardless.
 */
export const toggleRuleHandler = (rule: AlertRuleDocument) =>
	Effect.gen(function* () {
		const reactivity = yield* Reactivity
		const client = yield* MapleApiV2AtomClient
		return yield* reactivity.mutation(
			["alertRules"],
			client.alertRules.update({
				params: { id: rule.id },
				payload: { enabled: !rule.enabled },
			}),
		)
	})

export class AlertsOverviewModel extends Model.Service<AlertsOverviewModel>()("maple/alerts/overview")({
	// Not the singleton default (keepAlive): the instance — 3 shape-stream
	// subscriptions, the delivery-events query, and the clock tick — should not
	// stay live for the whole app session once the user leaves /alerts. The idle
	// TTL keeps state warm across quick tab switches and back-navigation, then
	// drains everything after the last View unmounts.
	lifetime: { idleTimeToLive: "5 minutes" },
	make: () =>
		Effect.gen(function* () {
			const orgKey = yield* makeOrgCollectionsKey
			// `orgCollectionStuckOptions` on every one: without a bounded load an
			// unreachable sync endpoint parks each store in `loading` and the hub
			// renders skeletons forever instead of its error state.
			const rules = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).alertRules,
				orgCollectionStuckOptions,
			)
			const states = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).alertRuleStates,
				orgCollectionStuckOptions,
			)
			const incidents = yield* Db.fromCollectionByKey(
				orgKey,
				(key) => getOrgCollections(orgIdOf(key)).alertIncidents,
				orgCollectionStuckOptions,
			)

			// Delivery events stay a capped HTTP read (no Electric shape) — refetched
			// on org/generation change via the dependency store, manually via `refresh`.
			const deliveryEvents = yield* Query.make({
				stores: { orgKey },
				handler: () =>
					Effect.gen(function* () {
						const client = yield* MapleApiV2AtomClient
						const response = yield* client.alertDeliveries.list({
							query: { limit: 100 },
						})
						return { events: response.data.map(v2DeliveryToDocument) }
					}),
			})

			// Atom mutations invalidate `reactivityKeys: ["alertDeliveryEvents"]`
			// (test-notification flows). The runtime shares the atom world's
			// Reactivity instance (see models/runtime.ts), so those invalidations
			// re-trigger this query exactly like the old atom-based fetch did.
			const reactivity = yield* Reactivity
			yield* Registry.run(
				reactivity.stream(["alertDeliveryEvents"], Effect.void).pipe(
					// The stream emits once on subscribe; only invalidations refetch.
					Stream.drop(1),
					Stream.mapEffect(() => Event.emit(deliveryEvents.refresh)),
				),
			)

			// The rule enable/disable toggle is a model-owned write. `Mutation.make`
			// serializes it on one permit and exposes a `state` the switch reflects
			// while the PATCH is in flight. The handler is {@link toggleRuleHandler}
			// (factored out so it is testable through the registry).
			const toggleRule = yield* Mutation.make(toggleRuleHandler)

			// The staleness derivation compares against wall clock; advance it on a
			// coarse tick so a rule can go stale without any source emitting.
			const clock = Store.make(yield* Clock.currentTimeMillis)
			yield* Registry.run(
				Stream.tick(CLOCK_TICK).pipe(
					Stream.mapEffect(() =>
						Effect.flatMap(Clock.currentTimeMillis, (ms) => Store.set(clock, ms)),
					),
				),
			)

			const overview = Store.combine(
				[rules, states, incidents, deliveryEvents.state, clock],
				(rulesState, statesState, incidentsState, deliveriesState, now) =>
					buildOverview({
						rules: rulesState,
						states: statesState,
						incidents: incidentsState,
						// Failed/loading deliveries degrade to [] — same as the tab's orElse.
						deliveries: AsyncResult.isSuccess(deliveriesState)
							? deliveriesState.value.events
							: [],
						now,
					}),
			)

			return {
				inputs: { refreshDeliveries: deliveryEvents.refresh, toggleRule: toggleRule.run },
				outputs: { overview },
				ui: {
					overview,
					refreshDeliveries: deliveryEvents.refresh,
					toggleRule: toggleRule.run,
					toggleState: toggleRule.state,
				},
			}
		}),
}) {}
