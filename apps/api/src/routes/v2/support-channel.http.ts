import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { isoTimestamp, MapleApiV2 } from "@maple/domain/http/v2"
import type { V2SupportChannel } from "@maple/domain/http/v2"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import {
	SupportChannelService,
	type SupportChannelView,
} from "@maple/backend/services/support/SupportChannelService"

/** Slack resolves this to the channel in whichever workspace the viewer is signed into. */
const slackUrl = (channelId: string) =>
	`https://slack.com/app_redirect?channel=${encodeURIComponent(channelId)}`

export const toV2SupportChannel = (view: SupportChannelView, invitedEmail: string | null): V2SupportChannel =>
	view.status === "active"
		? {
				object: "support_channel",
				status: "active",
				channel_name: view.channelName,
				slack_url: slackUrl(view.channelId),
				created_at: isoTimestamp(view.createdAtMs),
				invited_email: invitedEmail,
			}
		: {
				object: "support_channel",
				status: view.status,
				channel_name: null,
				slack_url: null,
				created_at: null,
				invited_email: null,
			}

export const HttpV2SupportChannelLive = HttpApiBuilder.group(MapleApiV2, "supportChannel", (handlers) =>
	Effect.gen(function* () {
		const service = yield* SupportChannelService

		return handlers
			.handle("retrieve", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					return toV2SupportChannel(yield* service.retrieve(tenant.orgId), null)
				}),
			)
			.handle("invite", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const { channel, email, created } = yield* service.ensureForCaller(tenant)
					// Audited before the invite: a creation stays on record even if the invite fails.
					if (created) {
						yield* recordHttpAudit("support_channel.created", {
							metadata: { channel_name: channel.channelName },
						})
					}
					yield* service.sendInvite(channel, email)
					yield* recordHttpAudit("support_channel.invite_sent", { metadata: { email } })
					return toV2SupportChannel(channel, email)
				}),
			)
	}),
)
