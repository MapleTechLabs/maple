import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { field, fieldError, type FieldIds, fieldLabel } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import type { FieldState } from "../../../ui/input"
import { panel } from "../../../ui/panel"
import * as SelectView from "../../../ui/select-view"
import { providerOf } from "../shared/providers"
import type { DestinationForm } from "./form"
import {
	CHANNEL_SELECT_ID,
	type HazelOrganization,
	Message as HazelMessage,
	type Model as HazelModel,
	ORGANIZATION_SELECT_ID,
} from "./hazel-fields"

// `HazelOAuthFields`' view. TODO(destination-dialog): an org logo that fails to load keeps its
// broken image; it should fall back to the Hazel mark.

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const idsOf = (id: string): FieldIds => ({
	control: id,
	label: SelectView.selectLabelId(id),
	error: `${id}-error`,
})

type Inputs<M> = Readonly<{
	model: HazelModel
	form: DestinationForm
	isEditing: boolean
	toMessage: (message: HazelMessage) => M
}>

const orgAvatar = <M>(h: HtmlBuilder<M>, logoUrl: string | null, name: string, size = 16): Html =>
	logoUrl !== null
		? h.img([
				h.Src(logoUrl),
				h.Alt(`${name} logo`),
				h.Width(String(size)),
				h.Height(String(size)),
				h.Attribute("loading", "lazy"),
				h.Attribute("referrerpolicy", "no-referrer"),
				h.Class("shrink-0 rounded-sm object-cover"),
				h.Style({ width: `${size}px`, height: `${size}px` }),
			])
		: h.span(
				[
					h.Class("flex shrink-0 items-center justify-center rounded-sm"),
					h.Style({
						width: `${size}px`,
						height: `${size}px`,
						background: "rgba(244,111,15,0.16)",
						color: "#F46F0F",
					}),
				],
				[icon(h, "HazelIcon", { size: Math.round(size * 0.7) })],
			)

const isFailed = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	AsyncData.isFailure(data) || AsyncData.isStale(data)

const connectPanel = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const accent = providerOf("hazel-oauth")
	return h.div(
		[h.Class("space-y-2 rounded-md border border-dashed border-border/60 p-3")],
		[
			...(isFailed(inputs.model.status.data)
				? [
						h.p(
							[h.Class("text-xs text-severity-error")],
							[
								"Couldn't check your Hazel connection status. This may be a temporary issue, so try connecting again.",
							],
						),
					]
				: []),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					"Connect Maple to your Hazel account via OAuth. We'll fetch the organizations and channels you can post into and provision a dedicated webhook for this destination.",
				],
			),
			button(
				h,
				{
					size: "sm",
					isLoading: inputs.model.isConnecting,
					isDisabled: inputs.model.isDisconnecting,
					attributes: [
						h.OnClick(inputs.toMessage(HazelMessage.ClickedConnect())),
						h.Style({
							background: accent.accent,
							"border-color": accent.accent,
							color: inputs.model.isConnecting ? "transparent" : accent.accentOn,
						}),
					],
				},
				["Connect Hazel"],
			),
		],
	)
}

const note = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.p([h.Class("text-2xs text-muted-foreground")], [text])

const organizationField = <M>(
	h: HtmlBuilder<M>,
	inputs: Inputs<M>,
	organizations: ReadonlyArray<HazelOrganization>,
): Html => {
	const { form, model } = inputs
	const ids = idsOf(ORGANIZATION_SELECT_ID)
	const selected = organizations.find((org) => org.id === form.hazelOrganizationId)
	const name = selected?.name ?? form.hazelOrganizationName
	const logoUrl = selected?.logoUrl ?? form.hazelOrganizationLogoUrl ?? null
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldLabel(h, { ids, className: "text-xs", state: IDLE }, "Hazel organization"),
		h.submodel({
			slotId: ORGANIZATION_SELECT_ID,
			model: model.organizationSelect,
			view: SelectView.view,
			toParentMessage: (message) =>
				inputs.toMessage(HazelMessage.GotOrganizationSelectMessage({ message })),
			viewInputs: {
				toView: (parts) => h.div([h.Class("contents")], parts),
				entries: [
					{
						_tag: "Group",
						label: "",
						items: organizations.map((org) => ({ value: org.id, label: org.name })),
					},
				],
				labelledBy: ids.label,
				className: "w-full",
				renderValue: () =>
					name === ""
						? [h.span([h.Class("text-muted-foreground")], ["Pick an organization"])]
						: [
								h.span(
									[h.Class("flex items-center gap-2")],
									[orgAvatar(h, logoUrl, name), h.span([h.Class("truncate")], [name])],
								),
							],
				renderItem: (option) => {
					const org = organizations.find((candidate) => candidate.id === option.value)
					return [
						h.span(
							[h.Class("flex items-center gap-2")],
							[
								orgAvatar(h, org?.logoUrl ?? null, option.label),
								h.span([h.Class("truncate")], [option.label]),
							],
						),
					]
				},
			},
		}),
		...(isFailed(model.organizations.data)
			? [
					fieldError(
						h,
						{ ids, className: "text-2xs", state: IDLE },
						"Couldn't load your Hazel organizations. Try reconnecting or refreshing.",
					),
				]
			: organizations.length === 0
				? [
						note(
							h,
							"No organizations returned. Make sure your Hazel account is a member of at least one organization.",
						),
					]
				: []),
	])
}

const channelField = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const { form, model } = inputs
	const ids = idsOf(CHANNEL_SELECT_ID)
	const organizationId = form.hazelOrganizationId.trim()
	const channels = AsyncData.getOrElse(model.channels.data, () => [])
	const isLoading =
		organizationId.length > 0 &&
		(AsyncData.isLoading(model.channels.data) || AsyncData.isRefreshing(model.channels.data))
	const placeholder =
		organizationId.length === 0
			? "Pick an organization first"
			: isLoading
				? "Loading channels…"
				: inputs.isEditing && form.hazelChannelName
					? `#${form.hazelChannelName}`
					: "Pick a channel"
	const items = channels.map((channel) => ({
		value: channel.id,
		label: channel.isPrivate ? `${channel.name} (private)` : channel.name,
	}))
	const label = items.find((item) => item.value === form.hazelChannelId)?.label
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldLabel(h, { ids, className: "text-xs", state: IDLE }, "Hazel channel"),
		h.submodel({
			slotId: CHANNEL_SELECT_ID,
			model: model.channelSelect,
			view: SelectView.view,
			toParentMessage: (message) => inputs.toMessage(HazelMessage.GotChannelSelectMessage({ message })),
			viewInputs: {
				toView: (parts) => h.div([h.Class("contents")], parts),
				entries: [{ _tag: "Group", label: "", items }],
				labelledBy: ids.label,
				className: "w-full",
				isDisabled: organizationId.length === 0 || isLoading,
				renderValue: () =>
					label === undefined
						? [h.span([h.Class("text-muted-foreground")], [placeholder])]
						: [label],
				renderItem: (option) => [`#${option.label}`],
			},
		}),
		...(organizationId.length > 0 && !isLoading && isFailed(model.channels.data)
			? [
					fieldError(
						h,
						{ ids, className: "text-2xs", state: IDLE },
						"Couldn't load channels for this organization. Try reselecting the organization.",
					),
				]
			: organizationId.length > 0 && !isLoading && channels.length === 0
				? [
						note(
							h,
							"No channels. Make sure your account is in at least one channel of this organization.",
						),
					]
				: []),
	])
}

export const hazelFields = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const { model } = inputs
	const status = Option.getOrNull(AsyncData.getData(model.status.data))
	if (status === null || !status.connected) return connectPanel(h, inputs)
	const organizations = AsyncData.getOrElse(model.organizations.data, () => [])
	return h.div(
		[h.Class("space-y-3")],
		[
			panel(h, { className: "flex-row items-center justify-between px-3 py-2 text-xs" }, [
				h.div(
					[h.Class("space-y-0.5")],
					[
						h.div([h.Class("font-medium")], ["Connected to Hazel"]),
						h.div([h.Class("text-muted-foreground")], [status.account]),
					],
				),
				button(
					h,
					{
						size: "sm",
						variant: "outline",
						isLoading: model.isDisconnecting,
						isDisabled: model.isConnecting,
						attributes: [h.OnClick(inputs.toMessage(HazelMessage.ClickedDisconnect()))],
					},
					["Disconnect"],
				),
			]),
			organizationField(h, inputs, organizations),
			channelField(h, inputs),
			confirmDialog(h, {
				slotId: "destination-hazel-disconnect",
				model: model.confirmDisconnect,
				toParentMessage: (message) => inputs.toMessage(HazelMessage.GotConfirmMessage({ message })),
				title: "Disconnect Hazel",
				description:
					"Maple loses access to your Hazel organizations and channels until you reconnect.",
				confirmLabel: "Disconnect Hazel",
				onConfirm: inputs.toMessage(HazelMessage.ConfirmedDisconnect()),
				isNested: true,
			}),
		],
	)
}
