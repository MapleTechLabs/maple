import { orgSupportChannels, type OrgSupportChannelRow } from "@maple/db"
import type { OrgId, UserId } from "@maple/domain/http"
import {
	SupportChannelBusyError,
	SupportChannelNoEmailError,
	SupportChannelNotConfiguredError,
	supportChannelName,
	SupportChannelUnavailableError,
} from "@maple/domain/support-channel"
import { and, eq, isNull, lt, or } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SupportSlackClient } from "./SupportSlackClient"

/** How long a creation may sit unfinished before another request may take it over. */
export const CREATE_LEASE_MS = 2 * 60 * 1000

/** `name_taken` retries before giving up; each adds a numeric suffix. */
const MAX_NAME_ATTEMPTS = 5

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
				createdAtMs: row.createdAt.getTime(),
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
	const slack = yield* SupportSlackClient
	const members = yield* OrgMembersService
	const organizations = yield* OrganizationService

	const findRow = (orgId: OrgId) =>
		database
			.execute((db) => db.select().from(orgSupportChannels).where(eq(orgSupportChannels.orgId, orgId)))
			.pipe(
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
				Effect.mapError(persistenceError("find")),
			)

	const retrieve = Effect.fn("SupportChannelService.retrieve")(function* (orgId: OrgId) {
		if (!slack.configured) return { status: "unavailable" } satisfies SupportChannelView
		const row = yield* findRow(orgId)
		return Option.match(row, {
			onNone: (): SupportChannelView => ({ status: "not_created" }),
			onSome: toActive,
		})
	})

	/** Insert the reservation row, or take over a stale one. Reports whether this call won. */
	const reserve = Effect.fn("SupportChannelService.reserve")(function* (orgId: OrgId, userId: UserId) {
		const now = yield* Clock.currentTimeMillis
		const inserted = yield* database
			.execute((db) =>
				db
					.insert(orgSupportChannels)
					.values({
						orgId,
						reservedAt: new Date(now),
						createdByUserId: userId,
						createdAt: new Date(now),
						updatedAt: new Date(now),
					})
					.onConflictDoNothing()
					.returning({ orgId: orgSupportChannels.orgId }),
			)
			.pipe(Effect.mapError(persistenceError("reserve")))
		if (inserted.length > 0) return true
		const takenOver = yield* database
			.execute((db) =>
				db
					.update(orgSupportChannels)
					.set({ reservedAt: new Date(now), createdByUserId: userId, updatedAt: new Date(now) })
					.where(
						and(
							eq(orgSupportChannels.orgId, orgId),
							isNull(orgSupportChannels.slackChannelId),
							or(
								isNull(orgSupportChannels.reservedAt),
								lt(orgSupportChannels.reservedAt, new Date(now - CREATE_LEASE_MS)),
							),
						),
					)
					.returning({ orgId: orgSupportChannels.orgId }),
			)
			.pipe(Effect.mapError(persistenceError("reserve")))
		return takenOver.length > 0
	})

	const releaseReservation = (orgId: OrgId) =>
		database
			.execute((db) =>
				db
					.update(orgSupportChannels)
					.set({ reservedAt: null })
					.where(
						and(eq(orgSupportChannels.orgId, orgId), isNull(orgSupportChannels.slackChannelId)),
					),
			)
			.pipe(Effect.ignore)

	/** `conversations.create`, stepping past names another channel already holds. */
	const createSlackChannel = Effect.fn("SupportChannelService.createSlackChannel")(function* (
		orgId: OrgId,
	) {
		const orgName = yield* organizations.retrieve(orgId).pipe(
			Effect.map((org) => org.name),
			Effect.orElseSucceed(() => null),
		)
		for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
			const name = supportChannelName(orgName, orgId, attempt)
			const created = yield* slack.call("conversations.create", { name, is_private: true }).pipe(
				Effect.map(Option.some),
				Effect.catchTag("@maple/backend/support/SupportSlackRefusedError", (refused) =>
					refused.error === "name_taken"
						? Effect.succeedNone
						: Effect.fail(
								new SupportChannelUnavailableError({
									message: refused.message,
									operation: refused.method,
									slackError: refused.error,
								}),
							),
				),
			)
			if (Option.isSome(created) && created.value.channel !== undefined) {
				return { channel: created.value.channel, orgName }
			}
		}
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
		const won = yield* reserve(orgId, userId)
		if (!won) {
			// Lost the race: the winner may have finished between our read and our insert.
			const row = yield* findRow(orgId)
			const view = Option.map(row, toActive)
			if (Option.isSome(view) && view.value.status === "active")
				return { view: view.value, created: false }
			return yield* new SupportChannelBusyError({
				message: `Support channel for ${orgId} is being created`,
			})
		}

		// Create and record as one step: once Slack has the channel, a cancelled request must not
		// skip the write that remembers it, or the next press would make a second channel.
		const { channel, orgName, row } = yield* Effect.uninterruptible(
			Effect.gen(function* () {
				const { channel, orgName } = yield* createSlackChannel(orgId).pipe(
					Effect.tapError(() => releaseReservation(orgId)),
				)
				yield* Effect.annotateCurrentSpan({ "maple.support_channel.id": channel.id })
				const now = yield* Clock.currentTimeMillis
				const [row] = yield* database
					.execute((db) =>
						db
							.update(orgSupportChannels)
							.set({
								slackChannelId: channel.id,
								slackChannelName: channel.name,
								reservedAt: null,
								createdAt: new Date(now),
								updatedAt: new Date(now),
							})
							.where(eq(orgSupportChannels.orgId, orgId))
							.returning(),
					)
					.pipe(
						Effect.mapError(persistenceError("finalize")),
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
				message: "Support channel row vanished before it was finalized",
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
