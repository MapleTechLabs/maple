import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	StatusPageComponents,
	StatusPageIncidentComponents,
	StatusPageIncidents,
	StatusPageIncidentUpdates,
	StatusPages,
	StatusPageSubscribers,
	StatusPageUpdateNotifications,
	type StatusPageIncidentRow,
	type StatusPageSubscriberRow,
	type StatusPageUpdateNotificationRow,
} from "@maple/db/tables"
import { StatusPageIncidentUpdateId, type StatusPageIncidentStatus } from "@maple/domain/primitives"
import { renderStatusPageUpdateEmail } from "@maple/email/status-page-subscription"
import { Context, Effect, Layer, Option, Redacted, Schema, Array as Arr, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { msToSqlTimestamp } from "@maple/backend/platform/time"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { statusPageUrl } from "./StatusPageSubscriptionsService"
import { mintUnsubscribeToken } from "./subscription-tokens"

/** An update older than this when first seen is history, not news: it is never emailed. */
export const STATUS_PAGE_NOTIFY_LOOKBACK_MS = 24 * 60 * 60_000
/** Emails one sweep sends at most; the rest wait for the next minute. */
export const STATUS_PAGE_NOTIFY_SEND_BUDGET = 200
const SUBSCRIBER_BATCH = 50
const PENDING_BATCH = 20
const SEND_CONCURRENCY = 4

/** A Postgres read or write on the notification path failed. */
export class StatusPageNotifyDbError extends Schema.TaggedError<StatusPageNotifyDbError>()(
	"@maple/backend/status-pages/StatusPageNotifyDbError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
) {}

export interface StatusPageNotifySweepResult {
	/** Updates newly queued for their page's subscribers. */
	readonly queued: number
	readonly sent: number
	readonly failed: number
	/** Queued updates finished: every matching subscriber done, or nothing left to send. */
	readonly completed: number
}

export interface StatusPageNotifierApi {
	/**
	 * Queues each incident's newest update (published incident, public page, at least one subscriber
	 * confirmed before it) once, then emails queued updates to the confirmed subscribers whose
	 * components it touches, in subscriber order, resuming where the last sweep stopped.
	 */
	readonly sweep: (nowMs: number) => Effect.Effect<StatusPageNotifySweepResult, StatusPageNotifyDbError>
}

const STATUS_LABEL = {
	investigating: "Investigating",
	identified: "Identified",
	monitoring: "Monitoring",
	resolved: "Resolved",
	scheduled: "Scheduled",
	in_progress: "In progress",
	completed: "Completed",
} as const satisfies Record<StatusPageIncidentStatus, string>

const accentColor = (incident: StatusPageIncidentRow, status: StatusPageIncidentStatus): string => {
	if (status === "resolved" || status === "completed") return "#2eb67d"
	if (incident.kind === "maintenance") return "#3b82f6"
	return incident.impact === "critical" ? "#e01e5a" : incident.impact === "none" ? "#8a8178" : "#e8872a"
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (value: number) => Str.padStart(2, "0")(String(value))

/** `Oct 28, 2026, 12:05 UTC`. */
const formatUtc = (ms: number): string => {
	const date = new Date(ms)
	return `${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

/** An incident naming no component concerns everyone; otherwise a subscriber needs one in common. */
const wantsUpdate = (
	subscriber: Pick<StatusPageSubscriberRow, "componentIds">,
	incidentComponentIds: ReadonlySet<string>,
): boolean =>
	subscriber.componentIds === null ||
	incidentComponentIds.size === 0 ||
	Arr.some(subscriber.componentIds, (id) => incidentComponentIds.has(id))

const QueuedRow = Schema.Struct({ update_id: StatusPageIncidentUpdateId })

/** Each incident's newest update, once, while it is news and someone confirmed before it. */
const queueNewUpdates = (db: MapleDb, nowMs: number) =>
	db.query(
		Orm.sql`
		INSERT INTO status_page_update_notifications (update_id, org_id, page_id, last_subscriber_id, completed_at, created_at)
		SELECT u.id, u.org_id, i.page_id, NULL, NULL, ${msToSqlTimestamp(nowMs)}::timestamptz
		FROM status_page_incident_updates u
		JOIN status_page_incidents i ON i.id = u.incident_id AND i.published
		JOIN status_pages p ON p.id = i.page_id AND NOT p.draft
		WHERE u.created_at > ${msToSqlTimestamp(nowMs - STATUS_PAGE_NOTIFY_LOOKBACK_MS)}::timestamptz
			AND u.id = (
				SELECT newest.id FROM status_page_incident_updates newest
				WHERE newest.incident_id = u.incident_id
				ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
			)
			AND EXISTS (
				SELECT 1 FROM status_page_subscribers s
				WHERE s.page_id = i.page_id AND s.confirmed_at IS NOT NULL AND s.confirmed_at <= u.created_at
			)
		ON CONFLICT (update_id) DO NOTHING
		RETURNING update_id`,
		QueuedRow,
	)

const toDbError = makePersistenceErrorMapper(StatusPageNotifyDbError, "Status page notification write failed")

export class StatusPageNotifier extends Context.Service<StatusPageNotifier, StatusPageNotifierApi>()(
	"@maple/backend/services/status-pages/StatusPageNotifier",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const email = yield* EmailService
			const featureFlags = yield* OrganizationFeatureFlagsService
			const dbExecute = makeDbExecute(database, "StatusPageNotifier", toDbError)
			const secret = Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY)

			/** The update with everything its email shows, or none when it must no longer be sent. */
			const loadContext = (notification: StatusPageUpdateNotificationRow) =>
				dbExecute((db) =>
					Effect.gen(function* () {
						const [update] = yield* db.run(
							PG.from(StatusPageIncidentUpdates)
								.select()
								.where(($) => [$.id.eq(notification.updateId)])
								.limit(1),
						)
						if (update === undefined) return Option.none()
						const [incident] = yield* db.run(
							PG.from(StatusPageIncidents)
								.select()
								.where(($) => [$.id.eq(update.incidentId)])
								.limit(1),
						)
						const [page] = yield* db.run(
							PG.from(StatusPages)
								.select(($) => ({ name: $.name, slug: $.slug, draft: $.draft }))
								.where(($) => [$.id.eq(notification.pageId)])
								.limit(1),
						)
						if (incident === undefined || !incident.published || page === undefined || page.draft)
							return Option.none()
						const components = yield* db.run(
							PG.from(StatusPageIncidentComponents, "l")
								.innerJoin(StatusPageComponents, "c", (l, c) => l.componentId.eq(c.id))
								.select(($) => ({ id: $.c.id, name: $.c.name, position: $.c.position }))
								.where(($) => [$.incidentId.eq(incident.id)])
								.orderBy(["position", "asc"]),
						)
						return Option.some({ update, incident, page, components })
					}),
				)

			const sendOne = (
				subscriber: Pick<StatusPageSubscriberRow, "id" | "email">,
				message: {
					readonly subject: string
					readonly pageUrl: string
					readonly render: (unsubscribeUrl: string) => string
				},
			) => {
				const unsubscribeUrl = `${message.pageUrl}/unsubscribe?token=${encodeURIComponent(mintUnsubscribeToken(secret, subscriber.id))}`
				return email
					.send(subscriber.email, message.subject, message.render(unsubscribeUrl), {
						headers: {
							"List-Unsubscribe": `<${unsubscribeUrl}>`,
							"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
						},
					})
					.pipe(
						Effect.as(true),
						Effect.catch((error) =>
							Effect.logWarning("Status page update email failed").pipe(
								Effect.annotateLogs({ "error.message": error.message }),
								Effect.as(false),
							),
						),
					)
			}

			const complete = (notification: StatusPageUpdateNotificationRow, nowMs: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(StatusPageUpdateNotifications)
							.set({ completedAt: nowMs })
							.where(($) => [$.updateId.eq(notification.updateId)]),
					),
				)

			/** Sends one batch of the update; answers how many went out and failed, and whether it is done. */
			const deliver = Effect.fnUntraced(function* (
				notification: StatusPageUpdateNotificationRow,
				baseUrl: string,
				budget: number,
				nowMs: number,
			) {
				const context = yield* loadContext(notification)
				if (Option.isNone(context)) {
					yield* complete(notification, nowMs)
					return { sent: 0, failed: 0, done: true }
				}
				// Out of the rollout, or Clerk unreadable (which reads the same): held, not dropped,
				// until it is no longer news.
				const flags = yield* featureFlags.flags(notification.orgId)
				if (!flags.statusPages) {
					const expired = notification.createdAt < nowMs - STATUS_PAGE_NOTIFY_LOOKBACK_MS
					if (expired) yield* complete(notification, nowMs)
					return { sent: 0, failed: 0, done: expired }
				}
				const { update, incident, page, components } = context.value
				const limit = Math.min(SUBSCRIBER_BATCH, budget)
				const cursor = notification.lastSubscriberId
				const subscribers = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPageSubscribers)
							.select(($) => ({ id: $.id, email: $.email, componentIds: $.componentIds }))
							.where(($) => [
								$.pageId.eq(notification.pageId),
								$.confirmedAt.lte(update.createdAt),
								...(cursor === null ? [] : [$.id.gt(cursor)]),
							])
							.orderBy(["id", "asc"])
							.limit(limit),
					),
				)
				const touched = new Set<string>(Arr.map(components, (component) => component.id))
				const statusLabel = STATUS_LABEL[update.status]
				const kindLabel = incident.kind === "maintenance" ? "Maintenance" : "Incident"
				const pageUrl = statusPageUrl(baseUrl, page.slug)
				const message = {
					subject:
						incident.kind === "maintenance"
							? `[Maintenance: ${statusLabel}] ${incident.title}`
							: `[${statusLabel}] ${incident.title}`,
					pageUrl,
					render: (unsubscribeUrl: string) =>
						renderStatusPageUpdateEmail({
							pageName: page.name,
							kindLabel,
							statusLabel,
							title: incident.title,
							body: update.body,
							affected:
								components.length === 0
									? "All services"
									: Arr.join(
											Arr.map(components, (component) => component.name),
											", ",
										),
							postedAt: formatUtc(update.createdAt),
							accentColor: accentColor(incident, update.status),
							pageUrl: `${pageUrl}#incident-${incident.id}`,
							unsubscribeUrl,
						}),
				}
				const outcomes = yield* Effect.forEach(
					Arr.filter(subscribers, (subscriber) => wantsUpdate(subscriber, touched)),
					(subscriber) => sendOne(subscriber, message),
					{ concurrency: SEND_CONCURRENCY },
				)
				const done = subscribers.length < limit
				const last = subscribers.at(-1)
				yield* dbExecute((db) =>
					db.run(
						PG.update(StatusPageUpdateNotifications)
							.set({
								...(last === undefined ? undefined : { lastSubscriberId: last.id }),
								...(done ? { completedAt: nowMs } : undefined),
							})
							.where(($) => [$.updateId.eq(notification.updateId)]),
					),
				)
				const sent = Arr.filter(outcomes, Boolean).length
				return { sent, failed: outcomes.length - sent, done }
			})

			const sweep = Effect.fn("StatusPageNotifier.sweep")(function* (nowMs: number) {
				const empty = { queued: 0, sent: 0, failed: 0, completed: 0 }
				// Nothing could be sent, so nothing is queued to pile up.
				if (Option.isNone(env.MAPLE_STATUS_PAGE_BASE_URL) || !email.isConfigured) return empty
				const baseUrl = env.MAPLE_STATUS_PAGE_BASE_URL.value
				const queued = yield* dbExecute((db) => queueNewUpdates(db, nowMs))
				const pending = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPageUpdateNotifications)
							.select()
							.where(($) => [$.completedAt.isNull()])
							.orderBy(["createdAt", "asc"])
							.limit(PENDING_BATCH),
					),
				)
				let result = { ...empty, queued: queued.length }
				for (const notification of pending) {
					const budget = STATUS_PAGE_NOTIFY_SEND_BUDGET - result.sent - result.failed
					if (budget <= 0) break
					const outcome = yield* deliver(notification, baseUrl, budget, nowMs)
					result = {
						...result,
						sent: result.sent + outcome.sent,
						failed: result.failed + outcome.failed,
						completed: result.completed + (outcome.done ? 1 : 0),
					}
				}
				yield* dbExecute((db) =>
					Effect.all([
						// Past the lookback the update cannot be queued again, so its marker can go.
						db.run(
							PG.deleteFrom(StatusPageUpdateNotifications).where(($) => [
								$.completedAt.isNotNull(),
								$.createdAt.lt(nowMs - STATUS_PAGE_NOTIFY_LOOKBACK_MS - 60 * 60_000),
							]),
						),
						// An unconfirmed address whose link expired: forget it.
						db.run(
							PG.deleteFrom(StatusPageSubscribers).where(($) => [
								$.confirmedAt.isNull(),
								$.confirmExpiresAt.lt(nowMs),
							]),
						),
					]),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.notify.queued": result.queued,
					"maple.status_page.notify.sent": result.sent,
					"maple.status_page.notify.failed": result.failed,
				})
				return result
			})

			return { sweep } satisfies StatusPageNotifierApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(EmailService.layer, OrganizationFeatureFlagsService.layer)),
	)
}
