import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgSupportChannels, type OrgSupportChannelRow } from "@maple/db/tables"
import type { OrgId, UserId } from "@maple/domain/http"
import {
	SupportChannelBusyError,
	SupportChannelNoEmailError,
	SupportChannelNotConfiguredError,
	supportChannelName,
	SupportChannelUnavailableError,
} from "@maple/domain/support-channel"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Result, Schedule, Stream } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SupportSlackClient } from "./SupportSlackClient"

/** How long a creation may sit unfinished before another request may take it over. */
export const CREATE_LEASE_MS = 2 * 60 * 1000

/** Upper bound on the Slack side of creation; must stay well under the lease. */
const CREATE_TIMEOUT_MS = 60 * 1000

/** `name_taken` retries before giving up; each adds a numeric suffix. */
const MAX_NAME_ATTEMPTS = 5

/** Pages of the bot's own channels to search when adopting one; 200 per page. */
const MAX_CHANNEL_PAGES = 10

/** `users.conversations` arguments; `cursor` only after the first page. */
type UsersConversationsArgs = {
	types: string
	exclude_archived: boolean
	limit: number
	cursor?: string
}

interface SlackChannelRef {
	readonly id: string
	readonly name: string
}

export type SupportChannelView =
	| { readonly status: "unavailable" }
	| { readonly status: "not_created" }
	| {
			readonly status: "active"
			readonly channelId: string
			readonly channelName: string
			readonly createdAtMs: number
	  }

export type ActiveSupportChannel = Extract<SupportChannelView, { status: "active" }>

export interface SupportChannelForCaller {
	readonly channel: ActiveSupportChannel
	/** Where the caller's invite goes: their own login email, resolved server-side. */
	readonly email: string
	/** True only for the call that created the channel. */
	readonly created: boolean
}

export interface SupportChannelServiceApi {
	readonly retrieve: (orgId: OrgId) => Effect.Effect<SupportChannelView, SupportChannelUnavailableError>
	/**
	 * Resolve the caller's email and create the org's channel if it has none. Split from
	 * {@link SupportChannelServiceApi.sendInvite} so the route can audit a creation even when the
	 * invite that follows fails.
	 */
	readonly ensureForCaller: (
		tenant: TenantContext,
	) => Effect.Effect<
		SupportChannelForCaller,
		| SupportChannelNotConfiguredError
		| SupportChannelBusyError
		| SupportChannelNoEmailError
		| SupportChannelUnavailableError
	>
	/** Send a Slack Connect invite for the channel to `email`. */
	readonly sendInvite: (
		channel: ActiveSupportChannel,
		email: string,
	) => Effect.Effect<void, SupportChannelUnavailableError>
}

const toActive = (row: OrgSupportChannelRow): SupportChannelView =>
	row.slackChannelId !== null && row.slackChannelName !== null
		? {
				status: "active",
				channelId: row.slackChannelId,
				channelName: row.slackChannelName,
				createdAtMs: row.createdAt,
			}
		: { status: "not_created" }

const persistenceError = (operation: string) => (cause: unknown) =>
	new SupportChannelUnavailableError({
		message: "Support channel persistence failed",
		operation,
		cause,
	})

const make = Effect.gen(function* () {
	const database = yield* Database
	const dbExecute = (operation: string) =>
		makeDbExecute(database, "SupportChannelService", persistenceError(operation))
	const slack = yield* SupportSlackClient
	const members = yield* OrgMembersService
	const organizations = yield* OrganizationService

	const findRow = (orgId: OrgId) =>
		dbExecute("find")((db) =>
			db.run(
				PG.from(OrgSupportChannels)
					.select()
					.where(($) => [$.orgId.eq(orgId)]),
			),
		).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))

	const retrieve = Effect.fn("SupportChannelService.retrieve")(function* (orgId: OrgId) {
		if (!slack.configured) return { status: "unavailable" } satisfies SupportChannelView
		const row = yield* findRow(orgId)
		return Option.match(row, {
			onNone: (): SupportChannelView => ({ status: "not_created" }),
			onSome: toActive,
		})
	})

	/**
	 * Insert the reservation row, or take over a stale one. Answers the reservation id this call
	 * now owns; only its owner may finalize or release it.
	 */
	const reserve = Effect.fn("SupportChannelService.reserve")(function* (orgId: OrgId, userId: UserId) {
		const now = yield* Clock.currentTimeMillis
		const reservationId = crypto.randomUUID()
		const inserted = yield* dbExecute("reserve")((db) =>
			db.run(
				PG.insertInto(OrgSupportChannels)
					.values({
						orgId,
						reservationId,
						reservedAt: now,
						createdByUserId: userId,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing()
					.returning("orgId"),
			),
		)
		if (inserted.length > 0) return Option.some(reservationId)
		const takenOver = yield* dbExecute("reserve")((db) =>
			db.run(
				PG.update(OrgSupportChannels)
					.set({
						reservationId,
						reservedAt: now,
						createdByUserId: userId,
						updatedAt: now,
					})
					.where(($) => [
						$.orgId.eq(orgId),
						$.slackChannelId.isNull(),
						PG.or($.reservedAt.isNull(), $.reservedAt.lt(now - CREATE_LEASE_MS)),
					])
					.returning("orgId"),
			),
		)
		return takenOver.length > 0 ? Option.some(reservationId) : Option.none()
	})

	/** Rows this reservation still owns and that have no channel yet. */
	const ownedBy =
		(orgId: OrgId, reservationId: string) =>
		($: PG.ColumnAccessor<typeof OrgSupportChannels.columns>) => [
			$.orgId.eq(orgId),
			$.reservationId.eq(reservationId),
			$.slackChannelId.isNull(),
		]

	const releaseReservation = (orgId: OrgId, reservationId: string) =>
		database
			.execute((db) =>
				db.run(
					PG.update(OrgSupportChannels)
						.set({ reservedAt: null, reservationId: null })
						.where(ownedBy(orgId, reservationId)),
				),
			)
			.pipe(Effect.ignore)

	/**
	 * A channel the bot itself made that no org has recorded: left behind when a create timed out after
	 * Slack accepted it, or a request died before saving. Nobody was invited to it and nothing was
	 * posted, so it is safe to adopt instead of stepping to a suffixed name.
	 */
	const findUnrecordedChannel = Effect.fn("SupportChannelService.findUnrecordedChannel")(function* (
		name: string,
	) {
		// Only channels the bot created: it can be a member of any private channel in the
		// workspace, and a name alone would let an org name steer an invite into one of those.
		const botUserId = (yield* slack.call("auth.test", {})).user_id
		if (botUserId === undefined) return Option.none<SlackChannelRef>()
		// Pages stop at the first page holding a match; the stream is read lazily.
		const match = yield* Stream.paginate({ page: 0, cursor: "" }, ({ page, cursor }) => {
			const args: UsersConversationsArgs = {
				types: "private_channel",
				exclude_archived: true,
				limit: 200,
				...(cursor !== "" ? { cursor } : undefined),
			}
			return slack.call("users.conversations", args).pipe(
				Effect.map((response) => {
					const found = response.channels?.find(
						(channel) => channel.name === name && channel.creator === botUserId,
					)
					const next = response.response_metadata?.next_cursor ?? ""
					const more = found === undefined && next !== "" && page + 1 < MAX_CHANNEL_PAGES
					return [
						found === undefined ? [] : [found],
						more ? Option.some({ page: page + 1, cursor: next }) : Option.none(),
					] as const
				}),
			)
		}).pipe(Stream.runHead)
		if (Option.isNone(match)) return Option.none<SlackChannelRef>()

		const recorded = yield* dbExecute("findUnrecordedChannel")((db) =>
			db.run(
				PG.from(OrgSupportChannels)
					.select("orgId")
					.where(($) => [$.slackChannelId.eq(match.value.id)]),
			),
		)
		return recorded.length === 0
			? Option.some<SlackChannelRef>(match.value)
			: Option.none<SlackChannelRef>()
	})

	/** `conversations.create`, stepping past names another channel already holds. */
	const createSlackChannel = Effect.fn("SupportChannelService.createSlackChannel")(function* (
		orgId: OrgId,
	) {
		const orgName = yield* organizations.retrieve(orgId).pipe(
			Effect.map((org) => org.name),
			Effect.orElseSucceed(() => null),
		)
		const channel = yield* Effect.findFirstFilter(
			Arr.makeBy(MAX_NAME_ATTEMPTS, (attempt) => attempt),
			(attempt) => {
				const name = supportChannelName(orgName, orgId, attempt)
				return slack.call("conversations.create", { name, is_private: true }).pipe(
					Effect.map(Option.some),
					Effect.catchTag("@maple/backend/support/SupportSlackRefusedError", (refused) =>
						refused.error === "name_taken"
							? findUnrecordedChannel(name).pipe(
									Effect.catchTag("@maple/backend/support/SupportSlackRefusedError", () =>
										Effect.succeed(Option.none<SlackChannelRef>()),
									),
									Effect.map((adopted) =>
										Option.map(adopted, (channel) => ({ ok: true, channel })),
									),
								)
							: Effect.fail(
									new SupportChannelUnavailableError({
										message: refused.message,
										operation: refused.method,
										slackError: refused.error,
									}),
								),
					),
					Effect.map((created) =>
						Option.isSome(created) && created.value.channel !== undefined
							? Result.succeed(created.value.channel)
							: Result.failVoid,
					),
				)
			},
		)
		if (Option.isSome(channel)) return { channel: channel.value, orgName }
		return yield* new SupportChannelUnavailableError({
			message: `Every candidate channel name for ${orgId} is taken`,
			operation: "conversations.create",
			slackError: "name_taken",
		})
	})

	/** Bring the Maple team in and say hello. Best-effort: the channel is usable without either. */
	const prepareChannel = Effect.fn("SupportChannelService.prepareChannel")(
		function* (channelId: string, orgName: string | null) {
			if (slack.teamUserIds.length > 0) {
				yield* slack
					.call("conversations.invite", { channel: channelId, users: slack.teamUserIds.join(",") })
					.pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Support channel team invite failed", error),
						),
						Effect.ignore,
					)
			}
			yield* slack
				.call("chat.postMessage", {
					channel: channelId,
					text: `This is ${orgName ?? "your team"}'s shared channel with the Maple team. Ask us anything here: setup, bugs, billing or feature requests.`,
				})
				.pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Support channel welcome message failed", error),
					),
				)
		},
		(effect) => Effect.ignore(effect),
	)

	const ensureChannel = Effect.fn("SupportChannelService.ensureChannel")(function* (
		orgId: OrgId,
		userId: UserId,
	) {
		const existing = yield* findRow(orgId)
		if (Option.isSome(existing)) {
			const view = toActive(existing.value)
			if (view.status === "active") return { view, created: false }
		}
		const reservation = yield* reserve(orgId, userId)
		if (Option.isNone(reservation)) {
			// Lost the race: the winner may have finished between our read and our insert.
			const row = yield* findRow(orgId)
			const view = Option.map(row, toActive)
			if (Option.isSome(view) && view.value.status === "active")
				return { view: view.value, created: false }
			return yield* new SupportChannelBusyError({
				message: `Support channel for ${orgId} is being created`,
			})
		}
		const reservationId = reservation.value

		// Creating is interruptible and bounded well inside the lease, so no one can take the
		// reservation over while we are still talking to Slack. Once Slack has answered, recording
		// the channel is not: a cancelled request must not skip the write that remembers it.
		const { channel, orgName, row } = yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const { channel, orgName } = yield* restore(
					createSlackChannel(orgId).pipe(
						Effect.timeoutOrElse({
							duration: CREATE_TIMEOUT_MS,
							orElse: () =>
								Effect.fail(
									new SupportChannelUnavailableError({
										message: "Creating the Slack channel timed out",
										operation: "conversations.create",
									}),
								),
						}),
					),
				).pipe(Effect.tapError(() => releaseReservation(orgId, reservationId)))
				yield* Effect.annotateCurrentSpan({ "maple.support_channel.id": channel.id })
				const now = yield* Clock.currentTimeMillis
				const [row] = yield* dbExecute("finalize")((db) =>
					db.run(
						PG.update(OrgSupportChannels)
							.set({
								slackChannelId: channel.id,
								slackChannelName: channel.name,
								reservedAt: null,
								reservationId: null,
								createdAt: now,
								updatedAt: now,
							})
							.where(ownedBy(orgId, reservationId))
							.returning(),
					),
				).pipe(
					// A transient write failure must not strand a channel Slack already made.
					Effect.retry({ times: 3, schedule: Schedule.exponential("200 millis") }),
					// The channel exists in Slack but not here; name it so it can be cleaned up.
					Effect.tapError(() =>
						Effect.logError("Support channel created but not recorded", {
							orgId,
							channelId: channel.id,
						}),
					),
				)
				return { channel, orgName, row }
			}),
		)
		if (row === undefined) {
			return yield* new SupportChannelUnavailableError({
				message: `Support channel ${channel.id} was created after this request lost its reservation`,
				operation: "finalize",
			})
		}
		const view = toActive(row)
		if (view.status !== "active") {
			return yield* new SupportChannelUnavailableError({
				message: "Support channel row is incomplete after finalize",
				operation: "finalize",
			})
		}
		yield* prepareChannel(channel.id, orgName)
		return { view, created: true }
	})

	const callerEmail = Effect.fn("SupportChannelService.callerEmail")(function* (tenant: TenantContext) {
		const resolved = yield* members.resolveMembers(tenant.orgId, [tenant.userId]).pipe(
			Effect.catchTags({
				"@maple/http/errors/AlertMemberDirectoryUnavailableError": (cause) =>
					Effect.fail(
						new SupportChannelUnavailableError({
							message: "Member directory lookup failed",
							operation: "resolveMembers",
							cause,
						}),
					),
				"@maple/http/errors/AlertMemberDirectoryNotConfiguredError": () => Effect.succeed([]),
				"@maple/http/errors/AlertRecipientSelectionError": () => Effect.succeed([]),
			}),
		)
		const email = resolved[0]?.email
		if (email === undefined || !email.includes("@")) {
			return yield* new SupportChannelNoEmailError({ message: `No email for ${tenant.userId}` })
		}
		return email
	})

	const ensureForCaller = Effect.fn("SupportChannelService.ensureForCaller")(function* (
		tenant: TenantContext,
	) {
		yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
		if (!slack.configured) {
			return yield* new SupportChannelNotConfiguredError({
				message: "Support Slack bot token is not set",
			})
		}
		// Before creating anything: a caller with nowhere to send the invite gets no channel.
		const email = yield* callerEmail(tenant)
		const { view, created } = yield* ensureChannel(tenant.orgId, tenant.userId)
		return { channel: view, email, created } satisfies SupportChannelForCaller
	})

	const sendInvite = Effect.fn("SupportChannelService.sendInvite")(function* (
		channel: ActiveSupportChannel,
		email: string,
	) {
		yield* slack
			.call("conversations.inviteShared", {
				channel: channel.channelId,
				emails: email,
				// Let the customer's side bring in their own teammates without asking us.
				external_limited: false,
			})
			.pipe(
				Effect.catchTag("@maple/backend/support/SupportSlackRefusedError", (refused) =>
					Effect.fail(
						new SupportChannelUnavailableError({
							message: refused.message,
							operation: refused.method,
							slackError: refused.error,
						}),
					),
				),
			)
	})

	return { retrieve, ensureForCaller, sendInvite } satisfies SupportChannelServiceApi
})

export class SupportChannelService extends Context.Service<SupportChannelService, SupportChannelServiceApi>()(
	"@maple/backend/services/support/SupportChannelService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(SupportSlackClient.layer, OrgMembersService.layer, OrganizationService.layer),
		),
	)
}
