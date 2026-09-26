// The shared Slack channel between a customer org and the Maple team. The channel lives in
// Maple's workspace and reaches the customer through Slack Connect invites sent by email.

import { Schema } from "effect"
import { HttpTaggedError } from "./http/error-policy"

/** This deployment has no Slack workspace to create support channels in. */
export class SupportChannelNotConfiguredError extends HttpTaggedError<SupportChannelNotConfiguredError>()(
	"@maple/http/errors/SupportChannelNotConfiguredError",
	{ message: Schema.String },
	{
		status: 503,
		code: "support_channel_not_configured",
		title: "Shared Slack channels are not available",
		message: "Shared Slack channels are not available on this instance. Email support@maple.dev instead.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/** Another request is creating the org's channel right now. */
export class SupportChannelBusyError extends HttpTaggedError<SupportChannelBusyError>()(
	"@maple/http/errors/SupportChannelBusyError",
	{ message: Schema.String },
	{
		status: 409,
		code: "support_channel_busy",
		title: "Channel is being created",
		message: "Your team's Slack channel is being created. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** The caller's email could not be resolved, so there is nowhere to send the invite. */
export class SupportChannelNoEmailError extends HttpTaggedError<SupportChannelNoEmailError>()(
	"@maple/http/errors/SupportChannelNoEmailError",
	{ message: Schema.String },
	{
		status: 422,
		code: "support_channel_no_email",
		title: "No email address to invite",
		message: "Maple could not find an email address on your account to send the Slack invite to.",
		retry: "never",
		recovery: "contact_support",
		exposure: "redacted",
	},
) {}

/** Slack, Postgres or the member directory failed. */
export class SupportChannelUnavailableError extends HttpTaggedError<SupportChannelUnavailableError>()(
	"@maple/http/errors/SupportChannelUnavailableError",
	{
		message: Schema.String,
		operation: Schema.String,
		/** Slack's `error` string when Slack refused the call. */
		slackError: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.Defect()),
	},
	{
		status: 503,
		code: "support_channel_unavailable",
		title: "Slack channel is temporarily unavailable",
		message: "Setting up the Slack channel failed. Retry in a few seconds, or email support@maple.dev.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/**
 * `maple-<org>` in Slack's channel-name alphabet: lowercase letters, digits, `-` and `_`, at most
 * 80 characters. Falls back to the org id when the name has nothing usable in it.
 */
export const supportChannelName = (orgName: string | null, orgId: string, attempt = 0): string => {
	const slug = (orgName ?? "")
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
	const base = `maple-${slug.length > 0 ? slug : orgId.toLowerCase().replace(/[^a-z0-9_-]+/g, "")}`
	const suffix = attempt === 0 ? "" : `-${attempt + 1}`
	return `${base.slice(0, 80 - suffix.length).replace(/-$/, "")}${suffix}`
}
