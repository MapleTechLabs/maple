import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	SupportChannelBusyError,
	SupportChannelNoEmailError,
	SupportChannelNotConfiguredError,
	SupportChannelUnavailableError,
} from "../../support-channel"
import { AuthorizationV2 } from "./auth"
import { Timestamp, wireExample } from "./envelopes"
import { publicError, publicErrors } from "./public-error"

export const V2SupportChannelStatus = Schema.Literals(["unavailable", "not_created", "active"])
export type V2SupportChannelStatus = Schema.Schema.Type<typeof V2SupportChannelStatus>

export const V2SupportChannel = Schema.Struct({
	object: Schema.Literal("support_channel").annotate({
		description: 'The object type, always `"support_channel"`.',
		examples: ["support_channel"],
	}),
	status: V2SupportChannelStatus.annotate({
		description:
			"`active` once the org's channel exists, `not_created` before anyone has asked for one, `unavailable` when this Maple instance has no Slack workspace to create it in.",
		examples: ["active"],
	}),
	channel_name: Schema.NullOr(Schema.String).annotate({
		description: "The Slack channel name, without the `#`. `null` until the channel exists.",
		examples: ["maple-acme"],
	}),
	slack_url: Schema.NullOr(Schema.String).annotate({
		description:
			"Opens the channel in Slack for anyone who has accepted the invite. `null` until the channel exists.",
		examples: ["https://slack.com/app_redirect?channel=C0123456789"],
	}),
	created_at: Schema.NullOr(Timestamp).annotate({
		description: "When the channel was created, or `null`.",
	}),
	invited_email: Schema.NullOr(Schema.String).annotate({
		description: "Where the Slack Connect invite was sent. Set only on the invite response.",
		examples: ["jane@acme.com"],
	}),
}).annotate({
	identifier: "SupportChannel",
	title: "Support channel",
	description:
		"The org's shared Slack channel with the Maple team, reached through Slack Connect. One per org.",
	examples: [
		wireExample({
			object: "support_channel",
			status: "active",
			channel_name: "maple-acme",
			slack_url: "https://slack.com/app_redirect?channel=C0123456789",
			created_at: "2026-09-26T12:00:00.000Z",
			invited_email: null,
		}),
	],
})
export type V2SupportChannel = Schema.Schema.Type<typeof V2SupportChannel>

export class V2SupportChannelApiGroup extends HttpApiGroup.make("supportChannel")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2SupportChannel,
			error: publicError(SupportChannelUnavailableError),
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSupportChannel",
				summary: "Retrieve the shared Slack channel",
				description:
					"Reports whether the org has a shared Slack channel with the Maple team. Requires the `support:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("invite", "/invite", {
			success: V2SupportChannel,
			error: publicErrors(
				SupportChannelNotConfiguredError,
				SupportChannelBusyError,
				SupportChannelNoEmailError,
				SupportChannelUnavailableError,
			),
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "inviteToSupportChannel",
				summary: "Join the shared Slack channel",
				description:
					"Creates the org's shared Slack channel if it does not exist yet, then sends a Slack Connect invite to the calling member's email. Calling it again sends a fresh invite to whoever calls it, so each teammate can join on their own. " +
					"Answers `503 support_channel_not_configured` on instances without a Slack workspace. Requires a member session or the `support:write` scope.",
			}),
		),
	)
	.prefix("/v2/support/slack_channel")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Support Channel",
			description: "A shared Slack channel between the org and the Maple team.",
		}),
	) {}
