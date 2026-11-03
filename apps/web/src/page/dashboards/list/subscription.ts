import type { DashboardRow } from "@maple/web-data/collections/dashboards"
import { Array as Arr, Duration, Effect, Option, Order, Schema, Stream } from "effect"
import { Subscription } from "foldkit"
import { rowToDocument } from "../../../data/collections/dashboards"
import { liveQueryStream } from "../../../data/live-query"
import type { Resources } from "../../../platform/resources"
import type { PageSubscriptionInput } from "../../contract"
import { orgLive } from "../../../data/collections/org-collections"
import { Message } from "./message"
import { toListDashboard } from "./derive"
import type { ListDashboard, Model } from "./model"

/** `COLLECTION_LOAD_TIMEOUT_MS`: how long the live list may load before the snapshot stands in. */
export const COLLECTION_LOAD_TIMEOUT_MS = 10_000

const byUpdatedDesc = Order.flip(Order.mapInput(Order.String, (row: DashboardRow) => row.updated_at))

/** `deriveDashboardsList`: newest-updated first; an undecodable payload drops its row. */
export const deriveDashboardsList = (rows: ReadonlyArray<DashboardRow>): ReadonlyArray<ListDashboard> =>
	Arr.flatMap(Arr.sort(rows, byUpdatedDesc), (row: DashboardRow) =>
		Option.toArray(Option.map(rowToDocument(row), toListDashboard)),
	)

/** `DashboardsListModel`: the org's synced `dashboards` collection. */
const dashboards = (orgId: string) =>
	orgLive(orgId, ({ dashboards: collection }) =>
		liveQueryStream(
			(q) => q.from({ d: collection }),
			(rows) => Message.UpdatedDashboards({ orgId, dashboards: deriveDashboardsList(rows) }),
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
		/** `useCollectionLoadFailed`: a live list still loading after the bounded wait has failed. */
		loadWatchdog: entry(
			{ orgId: Schema.NullOr(Schema.String) },
			{
				modelToDependencies: ({ model, context }) => ({
					orgId: model.dashboards === null && model.fallback._tag === "Idle" ? context.orgId : null,
				}),
				dependenciesToStream: ({ orgId }) =>
					orgId === null
						? Stream.empty
						: Stream.fromEffect(
								Effect.as(
									Effect.sleep(Duration.millis(COLLECTION_LOAD_TIMEOUT_MS)),
									Message.TimedOutLiveDashboards({ orgId }),
								),
							),
			},
		),
	}),
)
