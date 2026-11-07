import type { V2SupportChannel } from "@maple/domain/http/v2"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { Message, type Model } from "./support-channel"
import { typography } from "@maple/views/ui/typography"
import { hstackClass } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"

type H = HtmlBuilder<Message>

const ID = "shell-support-channel"

const panel = (h: H, children: ReadonlyArray<Html>, className?: string): Html =>
	DialogView.dialogPanel(h, "dialog", ID, children, className)

/** `OpenInSlack`: an outline button that is a link into Slack, in a new tab. */
const openInSlackButton = (h: H, url: string): Html =>
	linkButton(
		h,
		{
			variant: "outline",
			href: url,
			attributes: [
				h.AriaLabel("Open in Slack"),
				h.Attribute("target", "_blank"),
				h.Attribute("rel", "noopener noreferrer"),
			],
		},
		["Open in Slack", icon(h, "ExternalLinkIcon")],
	)

const invitedBody = (h: H, invited: V2SupportChannel): ReadonlyArray<Html> => [
	panel(h, [
		typography(h, { size: "sm", as: "p" }, [
			"Invite sent to ",
			typography(h, { weight: "medium" }, [invited.invited_email ?? ""]),
			". Open the email or Slack and accept it to add",
			" ",
			typography(h, { mono: true }, ["#", invited.channel_name ?? ""]),
			" to your workspace.",
		]),
	]),
	...(invited.slack_url
		? [DialogView.dialogFooter(h, "dialog", [openInSlackButton(h, invited.slack_url)])]
		: []),
]

/** `SupportChannelBody`: skeleton, the read's error, the invite outcome or the channel's offer. */
const body = (h: H, model: Model, email: Option.Option<string>): ReadonlyArray<Html> => {
	if (model.invited !== null) return invitedBody(h, model.invited)
	return AsyncData.match(model.channel, {
		onIdle: () => loadingBody(h),
		onLoading: () => loadingBody(h),
		onFailure: (failure) => [
			panel(h, [errorState(h, { failure, onRetry: Message.ClickedRetry(), variant: "inline" })]),
		],
		onRefreshing: (channel) => channelBody(h, model, channel, email),
		onStale: ({ data }) => channelBody(h, model, data, email),
		onSuccess: (channel) => channelBody(h, model, channel, email),
	})
}

const loadingBody = (h: H): ReadonlyArray<Html> => [
	panel(h, [skeleton(h, "h-4 w-full"), skeleton(h, "h-4 w-2/3")], "space-y-2"),
]

/** `SupportChannelDialog`; `email` is the Clerk user's primary address. */
export const view = Submodel.defineView<Model, Message, Readonly<{ email: Option.Option<string> }>>(
	(model, inputs, h) =>
		h.submodel({
			slotId: ID,
			model: model.dialog,
			view: DialogView.view,
			viewInputs: {
				hasTrigger: false,
				hasDescription: true,
				toView: ({ portal }) => portal,
				toContent: () => [
					DialogView.dialogHeader(h, "dialog", [
						DialogView.dialogTitle(
							h,
							"dialog",
							ID,
							[icon(h, "SlackIcon", { size: 18 }), "Shared Slack channel"],
							hstackClass({ gap: "2" }),
						),
						DialogView.dialogDescription(
							h,
							"dialog",
							ID,
							"A private channel between your team and the people who build Maple, in your own Slack workspace.",
						),
					]),
					...(model.dialog.isOpen ? body(h, model, inputs.email) : []),
				],
			},
			toParentMessage: (message) => Message.GotDialogMessage({ message }),
		}),
)

const channelBody = (
	h: H,
	model: Model,
	channel: V2SupportChannel,
	email: Option.Option<string>,
): ReadonlyArray<Html> => {
	if (channel.status === "unavailable")
		return [
			panel(h, [
				typography(h, { size: "sm", tone: "muted", as: "p" }, [
					"Shared Slack channels are not set up on this Maple instance. Email",
					" ",
					textLink(
						h,
						{ href: "mailto:support@maple.dev", tone: "inherit", className: "inline underline" },
						["support@maple.dev"],
					),
					" ",
					"and we will get back to you.",
				]),
			]),
		]
	const target = Option.match(email, {
		onNone: (): Html | string => "your email",
		onSome: (address) => typography(h, { weight: "medium" }, [address]),
	})
	const isActive = channel.status === "active"
	return [
		panel(
			h,
			[
				isActive
					? typography(h, { size: "sm", as: "p" }, [
							"Your team's channel is ",
							typography(h, { mono: true }, ["#", channel.channel_name ?? ""]),
							". We will send a Slack Connect invite to ",
							target,
							" so you can join it.",
						])
					: typography(h, { size: "sm", as: "p" }, [
							"We will create the channel and send a Slack Connect invite to ",
							target,
							". Accept it in Slack and the channel shows up in your workspace. Teammates can join the same way from here.",
						]),
				...(model.inviteError === null
					? []
					: [
							errorState(h, {
								failure: model.inviteError,
								title: "Couldn't send the invite",
								variant: "inline",
								className: "py-0",
							}),
						]),
			],
			"space-y-3",
		),
		DialogView.dialogFooter(h, "dialog", [
			...(isActive && channel.slack_url ? [openInSlackButton(h, channel.slack_url)] : []),
			button(h, { isLoading: model.isInviting, attributes: [h.OnClick(Message.ClickedInvite())] }, [
				isActive ? "Send me an invite" : "Create channel",
			]),
		]),
	]
}
