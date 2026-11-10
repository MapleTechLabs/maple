import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	StatusPageComponents,
	StatusPageCustomDomains,
	StatusPages,
	StatusPageSubscribers,
} from "@maple/db/tables"
import {
	StatusPageSubscriptionInvalidError,
	StatusPageSubscriptionPageNotFoundError,
	StatusPageSubscriptionTokenInvalidError,
	StatusPageSubscriptionUnavailableError,
	type StatusPageSubscribeRequest,
} from "@maple/domain/http"
import {
	type OrgId,
	type StatusPageComponentId,
	type StatusPageId,
	StatusPageSubscriberId,
} from "@maple/primitives"
import { sha256Base64Url } from "@maple/domain/status-page"
import { renderStatusPageConfirmEmail } from "@maple/email/status-page-subscription"
import { Clock, Context, Effect, Layer, Option, Redacted, Array as Arr, String as Str } from "effect"
import { runAfterResponse } from "@maple/backend/platform/after-response"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { newConfirmToken, verifyUnsubscribeToken } from "./subscription-tokens"

/** How long a confirmation link works. */
export const STATUS_PAGE_CONFIRM_TTL_MS = 48 * 60 * 60_000
/**
 * A pending address gets another confirmation email at most this often. One hour, the cap's
 * window: each row then holds at most one send in the window, so counting rows counts emails.
 */
export const STATUS_PAGE_CONFIRM_RESEND_MS = 60 * 60_000
/** Confirmation emails one page sends per hour at most, whoever asks: the cap on mailing strangers. */
export const STATUS_PAGE_CONFIRMATIONS_PER_HOUR = 50

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u

/**
 * Where a page lives; every link in a subscriber email starts here. Its active custom domain when
 * it has one, else `<status Worker origin>/s/<slug>`; none when this deployment has neither.
 */
export const statusPagePublicUrl = (input: {
	readonly baseUrl: Option.Option<string>
	readonly slug: string
	readonly customDomain: string | null
}): Option.Option<string> =>
	input.customDomain !== null
		? Option.some(`https://${input.customDomain}`)
		: Option.map(input.baseUrl, (baseUrl) => `${Str.replace(/\/+$/u, "")(baseUrl)}/s/${input.slug}`)

/** A page's active custom domain hostname, or null. */
export const activeCustomDomain = (db: MapleDb, pageId: StatusPageId) =>
	db
		.run(
			PG.from(StatusPageCustomDomains)
				.select(($) => ({ hostname: $.hostname }))
				.where(($) => [$.pageId.eq(pageId), $.status.eq("active")])
				.limit(1),
		)
		.pipe(Effect.map(([row]) => row?.hostname ?? null))

export interface StatusPageSubscriptionsServiceApi {
	/**
	 * Answers the same whether the address is new, pending or already confirmed, so the form cannot
	 * be used to learn who subscribes. A new or pending address is emailed a confirmation link, unless
	 * one went out recently or the page has sent its hourly share.
	 */
	readonly subscribe: (
		pageId: StatusPageId,
		input: StatusPageSubscribeRequest,
	) => Effect.Effect<
		void,
		| StatusPageSubscriptionPageNotFoundError
		| StatusPageSubscriptionInvalidError
		| StatusPageSubscriptionUnavailableError
	>
	readonly confirm: (
		pageId: StatusPageId,
		token: string,
	) => Effect.Effect<
		void,
		| StatusPageSubscriptionPageNotFoundError
		| StatusPageSubscriptionTokenInvalidError
		| StatusPageSubscriptionUnavailableError
	>
	/** Idempotent: a valid link whose subscription is already gone still succeeds. */
	readonly unsubscribe: (
		pageId: StatusPageId,
		token: string,
	) => Effect.Effect<
		void,
		| StatusPageSubscriptionPageNotFoundError
		| StatusPageSubscriptionTokenInvalidError
		| StatusPageSubscriptionUnavailableError
	>
}

interface PublicPage {
	readonly id: StatusPageId
	readonly orgId: OrgId
	readonly name: string
	readonly slug: string
	readonly customDomain: string | null
}

const unavailable = (cause: unknown) =>
	new StatusPageSubscriptionUnavailableError({ message: "Subscription storage failed", cause })
const invalid = (message: string) => new StatusPageSubscriptionInvalidError({ message })
const pageNotFound = (pageId: StatusPageId) =>
	new StatusPageSubscriptionPageNotFoundError({ pageId, message: "Status page not found" })
const tokenInvalid = (message: string) => new StatusPageSubscriptionTokenInvalidError({ message })

const hashToken = (token: string) => Effect.promise(() => sha256Base64Url(token))

export class StatusPageSubscriptionsService extends Context.Service<
	StatusPageSubscriptionsService,
	StatusPageSubscriptionsServiceApi
>()("@maple/backend/services/status-pages/StatusPageSubscriptionsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const email = yield* EmailService
		const featureFlags = yield* OrganizationFeatureFlagsService
		const dbExecute = makeDbExecute(database, "StatusPageSubscriptionsService", unavailable)

		/** A published page of an org in the rollout; anything else is not found. */
		const requirePublicPage = Effect.fnUntraced(function* (pageId: StatusPageId) {
			const [page] = yield* dbExecute((db) =>
				db.run(
					PG.from(StatusPages)
						.select(($) => ({
							id: $.id,
							orgId: $.orgId,
							name: $.name,
							slug: $.slug,
							draft: $.draft,
						}))
						.where(($) => [$.id.eq(pageId)])
						.limit(1),
				),
			)
			if (page === undefined || page.draft) return yield* pageNotFound(pageId)
			const flags = yield* featureFlags.flags(page.orgId)
			if (!flags.statusPages) return yield* pageNotFound(pageId)
			yield* Effect.annotateCurrentSpan({ orgId: page.orgId })
			const customDomain = yield* dbExecute((db) => activeCustomDomain(db, page.id))
			return {
				id: page.id,
				orgId: page.orgId,
				name: page.name,
				slug: page.slug,
				customDomain,
			} satisfies PublicPage
		})

		const sendConfirmation = (input: {
			readonly to: string
			readonly page: PublicPage
			readonly pageUrl: string
			readonly token: string
			readonly scope: string
		}) =>
			email
				.send(
					input.to,
					`Confirm your subscription to ${input.page.name} status updates`,
					renderStatusPageConfirmEmail({
						pageName: input.page.name,
						scope: input.scope,
						confirmUrl: `${input.pageUrl}/subscribe/confirm?token=${encodeURIComponent(input.token)}`,
						expiresIn: "48 hours",
					}),
				)
				.pipe(
					Effect.catch((error) =>
						Effect.logWarning("Status page confirmation email failed").pipe(
							Effect.annotateLogs({ "error.message": error.message }),
						),
					),
					Effect.withSpan("StatusPageSubscriptionsService.sendConfirmation"),
				)

		const subscribe = Effect.fn("StatusPageSubscriptionsService.subscribe")(function* (
			pageId: StatusPageId,
			input: StatusPageSubscribeRequest,
		) {
			yield* Effect.annotateCurrentSpan({ "maple.status_page.id": pageId })
			const address = Str.toLowerCase(Str.trim(input.email))
			if (!EMAIL_PATTERN.test(address)) return yield* invalid("Enter a valid email address.")
			const componentIds = input.componentIds === undefined ? null : Arr.dedupe(input.componentIds)
			if (componentIds !== null && componentIds.length === 0)
				return yield* invalid("Pick at least one component, or subscribe to all of them.")
			const page = yield* requirePublicPage(pageId)
			const pageUrl = statusPagePublicUrl({
				baseUrl: env.MAPLE_STATUS_PAGE_BASE_URL,
				slug: page.slug,
				customDomain: page.customDomain,
			})
			if (Option.isNone(pageUrl)) {
				return yield* new StatusPageSubscriptionUnavailableError({
					message: "Email subscriptions are not configured on this deployment",
				})
			}
			const token = newConfirmToken()
			const tokenHash = yield* hashToken(token)
			const now = yield* Clock.currentTimeMillis

			const componentNames = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// Serializes subscribes per page, so concurrent requests can't each pass the cap.
						yield* db.run(
							PG.from(StatusPages)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.id.eq(page.id)])
								.forUpdate(),
						)
						const names = yield* componentNamesOnPage(db, page, componentIds)
						const [existing] = yield* db.run(
							PG.from(StatusPageSubscribers)
								.select()
								.where(($) => [$.pageId.eq(page.id), $.email.eq(address)])
								.limit(1)
								.forUpdate(),
						)
						if (existing !== undefined) {
							// Confirmed: nothing changes, and the visitor is told the same as anyone.
							if (existing.confirmedAt !== null) return Option.none<ReadonlyArray<string>>()
							if (
								existing.confirmationSentAt !== null &&
								now - existing.confirmationSentAt < STATUS_PAGE_CONFIRM_RESEND_MS
							)
								return Option.none<ReadonlyArray<string>>()
						}
						// Resends count too, so pending rows can't be cycled to mail strangers past the cap.
						const [recent] = yield* db.run(
							PG.from(StatusPageSubscribers)
								.select(() => ({ count: PG.count() }))
								.where(($) => [
									$.pageId.eq(page.id),
									$.confirmationSentAt.gt(now - 60 * 60_000),
								]),
						)
						if (Number(recent?.count ?? 0) >= STATUS_PAGE_CONFIRMATIONS_PER_HOUR) {
							yield* Effect.logWarning("Status page confirmation cap reached")
							return Option.none<ReadonlyArray<string>>()
						}
						if (existing !== undefined) {
							yield* db.run(
								PG.update(StatusPageSubscribers)
									.set({
										componentIds,
										confirmTokenSha256: tokenHash,
										confirmExpiresAt: now + STATUS_PAGE_CONFIRM_TTL_MS,
										confirmationSentAt: now,
										updatedAt: now,
									})
									.where(($) => [$.id.eq(existing.id)]),
							)
							return Option.some(names)
						}
						// A concurrent subscribe for the same address loses the race and sends nothing.
						const inserted = yield* db.run(
							PG.insertInto(StatusPageSubscribers)
								.values({
									id: StatusPageSubscriberId.make(randomUUID()),
									orgId: page.orgId,
									pageId: page.id,
									email: address,
									componentIds,
									confirmedAt: null,
									confirmTokenSha256: tokenHash,
									confirmExpiresAt: now + STATUS_PAGE_CONFIRM_TTL_MS,
									confirmationSentAt: now,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoNothing()
								.returning(($) => ({ id: $.id })),
						)
						return inserted.length === 0
							? Option.none<ReadonlyArray<string>>()
							: Option.some(names)
					}),
				),
			)
			if (Option.isNone(componentNames)) return
			// After the response: the answer's timing must not say whether an email went out.
			yield* runAfterResponse(
				sendConfirmation({
					to: address,
					page,
					pageUrl: pageUrl.value,
					token,
					scope: componentIds === null ? "all components" : Arr.join(componentNames.value, ", "),
				}),
			)
		})

		const confirm = Effect.fn("StatusPageSubscriptionsService.confirm")(function* (
			pageId: StatusPageId,
			token: string,
		) {
			yield* Effect.annotateCurrentSpan({ "maple.status_page.id": pageId })
			const page = yield* requirePublicPage(pageId)
			const tokenHash = yield* hashToken(token)
			const now = yield* Clock.currentTimeMillis
			const confirmed = yield* dbExecute((db) =>
				db.run(
					PG.update(StatusPageSubscribers)
						.set({
							confirmedAt: now,
							confirmTokenSha256: null,
							confirmExpiresAt: null,
							updatedAt: now,
						})
						.where(($) => [
							$.pageId.eq(page.id),
							$.confirmTokenSha256.eq(tokenHash),
							$.confirmExpiresAt.gt(now),
						])
						.returning(($) => ({ id: $.id })),
				),
			)
			if (confirmed.length === 0)
				return yield* tokenInvalid("This confirmation link has expired or was already used.")
		})

		const unsubscribe = Effect.fn("StatusPageSubscriptionsService.unsubscribe")(function* (
			pageId: StatusPageId,
			token: string,
		) {
			yield* Effect.annotateCurrentSpan({ "maple.status_page.id": pageId })
			const subscriberId = verifyUnsubscribeToken(
				Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
				token,
			)
			if (Option.isNone(subscriberId)) return yield* tokenInvalid("This unsubscribe link is invalid.")
			const page = yield* requirePublicPage(pageId)
			yield* dbExecute((db) =>
				db.run(
					PG.deleteFrom(StatusPageSubscribers).where(($) => [
						$.pageId.eq(page.id),
						$.id.eq(subscriberId.value),
					]),
				),
			)
		})

		return { subscribe, confirm, unsubscribe } satisfies StatusPageSubscriptionsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(EmailService.layer, OrganizationFeatureFlagsService.layer)),
	)
}

/** The chosen components' names, in page order; a component from another page is refused. */
const componentNamesOnPage = (
	db: MapleDb,
	page: PublicPage,
	componentIds: ReadonlyArray<StatusPageComponentId> | null,
) =>
	Effect.gen(function* () {
		const [first, ...rest] = componentIds ?? []
		if (first === undefined) return []
		const rows = yield* db.run(
			PG.from(StatusPageComponents)
				.select(($) => ({ name: $.name, position: $.position }))
				.where(($) => [$.pageId.eq(page.id), $.id.in_(first, ...rest)])
				.orderBy(["position", "asc"]),
		)
		if (rows.length !== rest.length + 1) return yield* invalid("Pick components from this status page.")
		return Arr.map(rows, (row) => row.name)
	})
