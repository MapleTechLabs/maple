import { channelPickerView, resolveSearchQuery } from "../../../components/alerts/channel-search"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import * as Combobox from "../../../ui/combobox"
import * as ComboboxView from "../../../ui/combobox-view"
import { field, fieldError, type FieldIds, fieldLabel } from "../../../ui/field"
import type { FieldState } from "../../../ui/input"
import { icon } from "../../../ui/icon"
import { refreshButton } from "../../../ui/refresh-button"
import { destinationProvider } from "../shared/providers"
import {
	CHANNEL_COMBOBOX_ID,
	channelsOf,
	labelOf,
	Message as ChatMessage,
	type Model as ChatModel,
} from "./chat-fields"
import type { DestinationForm } from "./form"

// `ChatDestinationFields`' view. TODO(destination-dialog): the input's clear button and the
// "Showing N of M" status line under a capped list.

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
/** The label points at the combobox input (`htmlFor="destination-chat-channel"`). */
const IDS: FieldIds = {
	control: Combobox.inputId(CHANNEL_COMBOBOX_ID),
	label: "destination-chat-channel-label",
	error: "destination-chat-channel-error",
}

type Inputs<M> = Readonly<{
	model: ChatModel
	form: DestinationForm
	isEditing: boolean
	toMessage: (message: ChatMessage) => M
}>

const errorOf = (model: ChatModel) =>
	AsyncData.isFailure(model.channels.data) || AsyncData.isStale(model.channels.data)
		? AsyncData.getError(model.channels.data)
		: Option.none()

const status = <M>(
	h: HtmlBuilder<M>,
	inputs: Inputs<M>,
	connectorName: string,
	isLoading: boolean,
): ReadonlyArray<Html> => {
	const failure = errorOf(inputs.model)
	const channels = channelsOf(inputs.model)
	if (Option.isSome(failure) && failure.value.code === "integration_not_connected")
		return [
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					fieldError(h, { ids: IDS, className: "text-2xs", state: IDLE }, failure.value.message),
					linkButton(
						h,
						{
							size: "xs",
							variant: "outline",
							href: hrefOf(
								AppRoute.Integrations({
									search: { integration: `chat-${inputs.form.chatConnector}` },
								}),
							),
							attributes: [h.Target("_blank"), h.Rel("noreferrer")],
						},
						[`Open ${connectorName} integration`, icon(h, "ArrowRightIcon")],
					),
				],
			),
		]
	if (Option.isSome(failure)) {
		const isPermission = failure.value.type === "permission_error"
		return [
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					fieldError(
						h,
						{ ids: IDS, className: "text-2xs", state: IDLE },
						isPermission
							? "Listing a workspace's channels is limited to org admins."
							: `Couldn't load ${connectorName} channels.`,
					),
					...(isPermission
						? []
						: [
								button(
									h,
									{
										size: "xs",
										variant: "ghost",
										attributes: [
											h.OnClick(inputs.toMessage(ChatMessage.ClickedRefreshChannels())),
										],
									},
									["Retry"],
								),
							]),
				],
			),
		]
	}
	return channels.length === 0 && !isLoading
		? [
				h.p(
					[h.Class("text-2xs text-muted-foreground")],
					[
						"No channels returned. Make sure the Maple bot can see at least one channel, then hit Refresh.",
					],
				),
			]
		: []
}

const header = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>, isLoading: boolean): Html => {
	const { form } = inputs
	const storedName =
		inputs.isEditing && form.chatChannelId.length === 0 && form.chatChannelName.length > 0
			? form.chatChannelName
			: null
	return h.div(
		[h.Class("flex items-center justify-between gap-2")],
		[
			fieldLabel(h, { ids: IDS, className: "text-xs", state: IDLE }, "Channel"),
			h.div(
				[h.Class("flex min-w-0 items-center gap-1.5")],
				[
					...(storedName === null
						? []
						: [
								h.span(
									[h.Class("truncate text-2xs text-muted-foreground")],
									[
										"Currently ",
										h.span([h.Class("font-medium text-foreground")], [`#${storedName}`]),
									],
								),
							]),
					refreshButton(h, {
						size: "xs",
						variant: "ghost",
						className: "-my-1 h-6 gap-1 px-1.5 text-2xs text-muted-foreground",
						onRefresh: inputs.toMessage(ChatMessage.ClickedRefreshChannels()),
						isPending: isLoading,
					}),
				],
			),
		],
	)
}

export const chatFields = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const { model, form } = inputs
	if (form.chatWorkspaceId === null)
		return h.div(
			[h.Class("space-y-2 rounded-md border border-dashed border-border/60 p-3")],
			[
				h.p(
					[h.Class("text-xs text-muted-foreground")],
					[
						"This destination's chat workspace isn't available. Create a new destination from a linked workspace instead.",
					],
				),
			],
		)
	const connectorName = destinationProvider("chat", form.chatConnector).label
	const isLoading = AsyncData.isLoading(model.channels.data) || AsyncData.isRefreshing(model.channels.data)
	const channels = channelsOf(model)
	const selected = channels.find((channel) => channel.id === form.chatChannelId)
	const query = resolveSearchQuery(
		model.combobox.inputValue,
		selected === undefined ? undefined : { name: selected.name, is_private: selected.private },
	)
	const picker = channelPickerView(
		channels.map((channel) => ({ ...channel, is_private: channel.private, is_member: true })),
		query,
		form.chatChannelId || null,
	)
	const byLabel = new Map(picker.visible.map((channel) => [labelOf(channel), channel] as const))
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		header(h, inputs, isLoading),
		h.submodel({
			slotId: CHANNEL_COMBOBOX_ID,
			model: model.combobox,
			view: ComboboxView.view,
			toParentMessage: (message) => inputs.toMessage(ChatMessage.GotComboboxMessage({ message })),
			viewInputs: {
				items: [...byLabel.keys()],
				placeholder: isLoading ? "Loading channels…" : "Search channels…",
				emptyText: isLoading
					? "Loading channels…"
					: channels.length === 0
						? "No channels loaded yet."
						: "No matching channels.",
				startAddon: icon(h, "MagnifierIcon"),
				className: "w-full",
				renderItem: (label) => {
					const channel = byLabel.get(label)
					return [
						h.span(
							[h.Class("flex items-center gap-2")],
							[
								h.span([h.Class("truncate")], [`#${channel?.name ?? label}`]),
								...(channel?.private === true
									? [h.span([h.Class("text-2xs text-muted-foreground")], ["private"])]
									: []),
							],
						),
					]
				},
				toView: ({ field: input, rest }) => h.div([h.Class("contents")], [input, ...rest]),
			},
		}),
		...status(h, inputs, connectorName, isLoading),
		h.p(
			[h.Class("flex items-start gap-1.5 text-2xs text-muted-foreground")],
			[
				icon(h, "CircleInfoIcon", { size: 12, className: "mt-0.5 shrink-0" }),
				h.span(
					[],
					[
						"Private channels are listed once the Maple bot has been added to them. Use Send test after saving to check it can post.",
					],
				),
			],
		),
	])
}
