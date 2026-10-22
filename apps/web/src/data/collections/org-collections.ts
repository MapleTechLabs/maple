import { createEffectCollection } from "@maple/effect-db/electric"
import { electricSyncBaseUrl } from "../../lib/services/common/electric-sync-url"
import {
	Context,
	Duration,
	Effect,
	Layer,
	ManagedRuntime,
	Option,
	type Scope,
	Stream,
	SubscriptionRef,
	SynchronizedRef,
} from "effect"
import { MapleApiV2Client } from "../../platform/api-clients"
import { SessionBearer } from "../../platform/session-bearer"
import { makeDashboardsCollection } from "./dashboards"
import {
	AlertDestinationRowSchema,
	AlertIncidentRowSchema,
	AlertRuleRowSchema,
	AlertRuleStateRowSchema,
} from "@maple/web-data/collections/alerts"
import { InvestigationRowSchema } from "@maple/web-data/collections/investigations"
import { ApiKeyRowSchema } from "@maple/web-data/collections/api-keys"
import { timestamptzParser } from "@maple/web-data/collections/shape-parsers"

/** `getOrgCollections`'s 30 s fallback: a superseded set is cleaned up even if a reader lingers. */
const CLEANUP_FALLBACK = Duration.seconds(30)

/** `syncProxyUrl` (`shape-fetch.ts`): the authenticating shape proxy, never Electric itself. */
const syncProxyUrl = `${electricSyncBaseUrl}/api/sync/shape`

/**
 * Electric's `fetchClient` contract is a `fetch`, so this is one; it adds the session bearer like
 * `mapleSyncFetch` and leaves `init.signal` alone (live requests long-poll and abort themselves).
 */
const makeSyncFetch =
	(context: Context.Context<SessionBearer>): typeof globalThis.fetch =>
	(input, init) =>
		Effect.runPromiseWith(context)(
			Effect.gen(function* () {
				const bearer = yield* SessionBearer
				const token = yield* bearer.token
				const headers = new Headers(init?.headers)
				if (Option.isSome(token) && !headers.has("authorization"))
					headers.set("authorization", `Bearer ${token.value}`)
				return { ...init, headers }
			}),
		).then((authorized) => globalThis.fetch(input, authorized))

const makeSet = (
	orgId: string,
	runtime: ManagedRuntime.ManagedRuntime<never, never>,
	fetchClient: typeof globalThis.fetch,
	client: MapleApiV2Client["Service"],
) => ({
	orgId,
	// `createDashboardsCollection`: writes PATCH/DELETE through the v2 API.
	dashboards: makeDashboardsCollection({ orgId, url: syncProxyUrl, runtime, fetchClient, client }),
	apiKeys: createEffectCollection({
		id: `api_keys:${orgId}`,
		runtime,
		schema: ApiKeyRowSchema,
		getKey: (row) => row.id,
		shapeOptions: {
			url: syncProxyUrl,
			params: { shape: "api_keys", org: orgId },
			fetchClient,
			parser: timestamptzParser,
		},
	}),
	// `createSyncedCollection`'s shape: id `<shape>:<org>`, `org=` param for URL cache keying only.
	alertRules: createEffectCollection({
		id: `alert_rules:${orgId}`,
		runtime,
		schema: AlertRuleRowSchema,
		getKey: (row) => row.id,
		shapeOptions: {
			url: syncProxyUrl,
			params: { shape: "alert_rules", org: orgId },
			fetchClient,
			parser: timestamptzParser,
		},
	}),
	alertRuleStates: createEffectCollection({
		id: `alert_rule_states:${orgId}`,
		runtime,
		schema: AlertRuleStateRowSchema,
		// Composite key (org_id, rule_id, group_key), as `createAlertRuleStatesCollection`.
		getKey: (row) => `${row.rule_id}:${row.group_key}`,
		shapeOptions: {
			url: syncProxyUrl,
			params: { shape: "alert_rule_states", org: orgId },
			fetchClient,
			parser: timestamptzParser,
		},
	}),
	alertIncidents: createEffectCollection({
		id: `alert_incidents:${orgId}`,
		runtime,
		schema: AlertIncidentRowSchema,
		getKey: (row) => row.id,
		shapeOptions: {
			url: syncProxyUrl,
			params: { shape: "alert_incidents", org: orgId },
			fetchClient,
			parser: timestamptzParser,
		},
	}),
	alertDestinations: createEffectCollection({
		id: `alert_destinations_v2:${orgId}`,
		runtime,
		schema: AlertDestinationRowSchema,
		getKey: (row) => row.id,
		shapeOptions: {
			url: syncProxyUrl,
			params: { shape: "alert_destinations_v2", org: orgId },
			fetchClient,
			parser: timestamptzParser,
		},
	}),
})
export type OrgCollectionSet = ReturnType<typeof makeSet>

/**
 * `createInvestigationCollection` (lib/collections/investigation-collections.ts): the
 * `investigation_v2` shape scoped to one investigation, read-only. Not part of the org set: its
 * lifecycle is the page's, so the caller releases it when its live query lets go.
 */
const makeInvestigationCollection = (
	orgId: string,
	investigationId: string,
	runtime: ManagedRuntime.ManagedRuntime<never, never>,
	fetchClient: typeof globalThis.fetch,
) =>
	createEffectCollection({
		id: `investigation_v2:${orgId}:${investigationId}`,
		runtime,
		schema: InvestigationRowSchema,
		getKey: (row) => row.id,
		shapeOptions: {
			url: syncProxyUrl,
			params: { shape: "investigation_v2", org: orgId, scope: investigationId },
			fetchClient,
			parser: timestamptzParser,
		},
	})
export type InvestigationCollection = ReturnType<typeof makeInvestigationCollection>
type SyncedCollection =
	| OrgCollectionSet["dashboards"]
	| OrgCollectionSet["apiKeys"]
	| OrgCollectionSet["alertRules"]
	| OrgCollectionSet["alertRuleStates"]
	| OrgCollectionSet["alertIncidents"]
	| OrgCollectionSet["alertDestinations"]
	| InvestigationCollection

/** `cleanupCollectionWhenIdle`: wait for the last live query to let go, then clean up. */
const cleanupWhenIdle = (collection: SyncedCollection): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		if (collection.subscriberCount === 0) return resume(Effect.void)
		const off = collection.on("subscribers:change", (event) => {
			if (event.subscriberCount === 0) resume(Effect.void)
		})
		return Effect.sync(off)
	}).pipe(
		Effect.timeoutOption(CLEANUP_FALLBACK),
		Effect.andThen(Effect.tryPromise(() => collection.cleanup())),
		Effect.ignore,
	)

/**
 * The Electric collections of the signed-in org (`org-collections.ts`): one live set, minted per
 * org, the superseded set cleaned up once drained. A resource because every liveQuery
 * Subscription must read the same collection instances.
 */
export class OrgCollections extends Context.Service<
	OrgCollections,
	{
		readonly forOrg: (orgId: string) => Effect.Effect<OrgCollectionSet>
		/** A fresh scoped collection for one investigation; the caller releases it. */
		readonly forInvestigation: (
			orgId: string,
			investigationId: string,
		) => Effect.Effect<InvestigationCollection>
		/** Cleans the collection up once its last live query has let go (in the background). */
		readonly releaseInvestigation: (collection: InvestigationCollection) => Effect.Effect<void>
		/** `retryOrgCollections`: a fresh set for the open org; live streams move onto it. */
		readonly recreate: Effect.Effect<void>
		/**
		 * `useOrgCollections`: `build` over the org's set, rebuilt on each `recreate` (the old
		 * stream is torn down first, so its live queries let the superseded set drain).
		 */
		readonly liveFor: <A, R>(
			orgId: string,
			build: (set: OrgCollectionSet) => Stream.Stream<A, never, R>,
		) => Stream.Stream<A, never, R>
	}
>()("@maple/web/OrgCollections") {
	static readonly layer = Layer.effect(this, makeOrgCollections()).pipe(
		Layer.provide([SessionBearer.layer, MapleApiV2Client.layer]),
	)
}

/** A live stream over the org's collections that follows every `recreate` (Reconnect). */
export const orgLive = <A, R>(
	orgId: string,
	build: (set: OrgCollectionSet) => Stream.Stream<A, never, R>,
): Stream.Stream<A, never, R | OrgCollections> =>
	Stream.unwrap(
		Effect.gen(function* () {
			return (yield* OrgCollections).liveFor(orgId, build)
		}),
	)

function makeOrgCollections(): Effect.Effect<
	OrgCollections["Service"],
	never,
	SessionBearer | MapleApiV2Client | Scope.Scope
> {
	return Effect.gen(function* () {
		const scope = yield* Effect.scope
		const fetchClient = makeSyncFetch(yield* Effect.context<SessionBearer>())
		const client = yield* MapleApiV2Client
		// Collection handlers and backoff logs run here; none of Maple's collections need services.
		const runtime = yield* Effect.acquireRelease(
			Effect.sync(() => ManagedRuntime.make(Layer.empty)),
			(managed) => managed.disposeEffect,
		)
		const current = yield* SynchronizedRef.make(Option.none<OrgCollectionSet>())
		const generation = yield* SubscriptionRef.make(0)
		const retire = (set: OrgCollectionSet) =>
			Effect.asVoid(
				Effect.forkIn(
					Effect.all([
						cleanupWhenIdle(set.dashboards),
						cleanupWhenIdle(set.apiKeys),
						cleanupWhenIdle(set.alertRules),
						cleanupWhenIdle(set.alertRuleStates),
						cleanupWhenIdle(set.alertIncidents),
						cleanupWhenIdle(set.alertDestinations),
					]),
					scope,
				),
			)
		yield* Effect.addFinalizer(() =>
			Effect.flatMap(
				SynchronizedRef.get(current),
				Option.match({ onNone: () => Effect.void, onSome: retire }),
			),
		)

		const forOrg = (orgId: string) =>
			SynchronizedRef.modifyEffect(current, (existing) => {
				if (Option.isSome(existing) && existing.value.orgId === orgId) {
					return Effect.succeed([existing.value, existing] as const)
				}
				const next = makeSet(orgId, runtime, fetchClient, client)
				return Effect.as(Option.match(existing, { onNone: () => Effect.void, onSome: retire }), [
					next,
					Option.some(next),
				] as const)
			})
		const forInvestigation = (orgId: string, investigationId: string) =>
			Effect.sync(() => makeInvestigationCollection(orgId, investigationId, runtime, fetchClient))
		const releaseInvestigation = (collection: InvestigationCollection) =>
			Effect.asVoid(Effect.forkIn(cleanupWhenIdle(collection), scope))
		const recreate = SynchronizedRef.updateEffect(current, (existing) =>
			Option.match(existing, {
				onNone: () => Effect.succeed(existing),
				onSome: (set) =>
					Effect.as(retire(set), Option.some(makeSet(set.orgId, runtime, fetchClient, client))),
			}),
		).pipe(Effect.andThen(SubscriptionRef.update(generation, (value) => value + 1)))
		const liveFor = <A, R>(orgId: string, build: (set: OrgCollectionSet) => Stream.Stream<A, never, R>) =>
			SubscriptionRef.changes(generation).pipe(
				Stream.switchMap(() => Stream.unwrap(Effect.map(forOrg(orgId), build))),
			)
		return { forOrg, forInvestigation, releaseInvestigation, recreate, liveFor }
	})
}
