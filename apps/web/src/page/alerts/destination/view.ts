import type { AlertDestinationType } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { dialogTitleStyles } from "@maple/ui/styles/ui/dialog"
import { suggestedDestinationName } from "@maple/web-data/alerts/form-utils"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { cardButton } from "../../../ui/card-button"
import * as DialogView from "../../../ui/dialog-view"
import { titleId } from "../../../ui/dialog"
import { eyebrow } from "../../../ui/eyebrow"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input } from "../../../ui/field"
import type { FieldState } from "../../../ui/input"
import { inlineCode } from "../../../ui/inline-code"
import { panel } from "../../../ui/panel"
import { settingRow } from "../../../ui/setting-row"
import { switchControl } from "../../../ui/switch"
import { destinationProvider, providerLogo, providerOf, destinationTypesFor } from "../shared/providers"
import {
	isFormReady,
	isValidGoogleChatWebhookUrl,
	isValidPagerDutyKey,
	isValidTelegramToken,
	Message,
	type Model,
} from "./dialog"
import { chatFields } from "./chat-fields-view"
import { emailFields } from "./email-fields-view"
import { linearFields } from "./linear-fields-view"
import { waitingFor } from "../shared/chat-connect"
import { spinner } from "../../../ui/spinner"
import { type TextField, toFormState } from "./form"

// The destination dialog. The Email, Linear and chat fields live in `*-fields-view.ts`.

type H = HtmlBuilder<Message>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const TELEGRAM_CHAT_TYPE_LABELS = new Map([
	["private", "Direct message"],
	["group", "Group"],
	["supergroup", "Group"],
	["channel", "Channel"],
])

const ids = (name: string, hasDescription = false): FieldIds => {
	const base = {
		control: `destination-${name}`,
		label: `destination-${name}-label`,
		error: `destination-${name}-error`,
	}
	return hasDescription ? { ...base, description: `destination-${name}-description` } : base
}

const stateOf = (value: string): FieldState => ({ ...IDLE, isFilled: value !== "" })

const textInput = (
	h: H,
	model: Model,
	options: Readonly<{
		name: string
		field: TextField
		placeholder: string
		className?: string
		type?: string
		hasDescription?: boolean
	}>,
) =>
	input(h, {
		ids: ids(options.name, options.hasDescription),
		state: stateOf(model.form[options.field]),
		attributes: [
			h.Value(model.form[options.field]),
			h.Placeholder(options.placeholder),
			h.OnInput((value) => Message.ChangedField({ field: options.field, value })),
			...(options.type === undefined ? [] : [h.Type(options.type), h.Attribute("autocomplete", "off")]),
		],
		className: options.className,
	})

const logo = (h: H, model: Model, type: AlertDestinationType, size: number, chatConnector?: string) =>
	providerLogo(h, {
		type,
		chatConnector,
		size,
		isLogoBroken: model.brokenLogos.includes(type),
		onLogoError: Message.FailedLoadProviderLogo({ type }),
	})

const providerTile = (
	h: H,
	model: Model,
	options: Readonly<{
		key: string
		type: AlertDestinationType
		chatConnector?: string
		label?: string
		description?: string
		isSelected: boolean
		/** `busy`: the tile's popup is out; it disables and spins. */
		isBusy?: boolean
		onSelect: Message
	}>,
): Html => {
	const provider = destinationProvider(options.type, options.chatConnector)
	return cardButton(
		h,
		{
			onClick: options.onSelect,
			isSelected: options.isSelected,
			isDisabled: options.isBusy === true,
			// Selection takes the provider's accent; a busy tile stays solid so its spinner reads.
			className: cn(
				"relative flex flex-col items-start gap-2 overflow-hidden p-3 disabled:opacity-100",
				options.isSelected &&
					"border-(--tile-accent) bg-surface-sunken hover:border-(--tile-accent) active:border-(--tile-accent) hover:bg-surface-sunken active:bg-surface-sunken",
			),
			attributes: [h.Key(options.key), h.Style({ "--tile-accent": provider.accent })],
		},
		[
			h.span([
				h.AriaHidden(true),
				h.Class(
					cn(
						"pointer-events-none absolute inset-0 transition-opacity",
						options.isSelected ? "opacity-100" : "opacity-0",
					),
				),
				h.Style({
					background: `radial-gradient(circle at 0% 0%, ${provider.accentBg}, transparent 60%)`,
				}),
			]),
			h.div(
				[h.Class("relative flex w-full items-center gap-2.5")],
				[
					logo(h, model, options.type, 32, options.chatConnector),
					h.span([h.Class("truncate text-sm font-semibold")], [options.label ?? provider.label]),
					...(options.isBusy === true ? [spinner(h, "ml-auto", 12)] : []),
				],
			),
			h.p(
				[h.Class("relative text-2xs leading-snug text-muted-foreground")],
				[options.description ?? provider.description],
			),
		],
	)
}

/** `ProviderPicker`: linked chat workspaces first, then the provider types. */
const providerPicker = (h: H, model: Model): Html => {
	const connectors = model.connectors ?? []
	const isDiscordLinked = connectors.some((c) => c.id === "discord" && c.workspaces.length > 0)
	return h.div(
		[h.Class("grid grid-cols-2 gap-2")],
		[
			...connectors.flatMap((connector) => {
				if (connector.workspaces.length > 0)
					return connector.workspaces.map((workspace) =>
						providerTile(h, model, {
							key: workspace.id,
							type: "chat",
							chatConnector: connector.id,
							label:
								connector.workspaces.length > 1
									? `${connector.name} · ${workspace.name}`
									: connector.name,
							description: `Post to a channel in ${workspace.name}.`,
							isSelected:
								model.form.type === "chat" && model.form.chatWorkspaceId === workspace.id,
							onSelect: Message.ClickedChatWorkspace({
								connector: connector.id,
								workspaceId: workspace.id,
							}),
						}),
					)
				if (!connector.available || connector.id === "discord") return []
				// Not linked yet: the tile links a workspace in a popup, the form stays as it is.
				const isWaiting = waitingFor(model.chatConnect) === connector.id
				return [
					providerTile(h, model, {
						key: connector.id,
						type: "chat",
						chatConnector: connector.id,
						label: connector.name,
						description: isWaiting
							? `Finish in the ${connector.name} window. This form stays as it is.`
							: `Connect a ${connector.name} workspace, then pick a channel.`,
						isSelected: false,
						isBusy: isWaiting,
						onSelect: Message.ClickedConnectChat({ connector: connector.id }),
					}),
				]
			}),
			...destinationTypesFor(isDiscordLinked).map((type) =>
				providerTile(h, model, {
					key: type,
					type,
					label: type === "discord" && isDiscordLinked ? "Discord webhook" : undefined,
					isSelected: model.form.type === type,
					onSelect: Message.ClickedProvider({ type }),
				}),
			),
		],
	)
}

const fieldBlock = (h: H, children: ReadonlyArray<Html>, state: FieldState = IDLE) =>
	field(h, { className: "items-stretch gap-1.5", state }, children)

const connectionFields = (h: H, model: Model, isEditing: boolean): ReadonlyArray<Html> => {
	const { form } = model
	switch (form.type) {
		case "pagerduty": {
			const isBadKey =
				form.integrationKey.trim().length > 0 && !isValidPagerDutyKey(form.integrationKey)
			const fieldIds = ids("integration", true)
			return [
				fieldBlock(h, [
					fieldLabel(
						h,
						{ ids: fieldIds, className: "text-xs", state: stateOf(form.integrationKey) },
						"Integration key",
					),
					textInput(h, model, {
						name: "integration",
						field: "integrationKey",
						placeholder: isEditing
							? "Leave blank to keep current key"
							: "e.g. R0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
						className: "font-mono text-xs",
						hasDescription: true,
					}),
					...(isBadKey
						? [
								fieldError(
									h,
									{
										ids: fieldIds,
										className: "text-2xs",
										state: stateOf(form.integrationKey),
									},
									"That isn't a routing key (must be 32 characters). A ~20-character REST API token won't work. Copy the Events API v2 integration key.",
								),
							]
						: []),
					fieldDescription(
						h,
						{ ids: fieldIds, className: "text-2xs", state: stateOf(form.integrationKey) },
						[
							"In PagerDuty: open the service → Integrations → add or select an",
							" ",
							h.a(
								[
									h.Href(
										"https://maple.dev/docs/alerting/notification-destinations#pagerduty",
									),
									h.Target("_blank"),
									h.Rel("noreferrer"),
									h.Class(
										"underline-offset-2 hover:text-foreground active:text-foreground hover:underline active:underline",
									),
								],
								["Events API v2"],
							),
							" ",
							"integration → copy its Integration Key (32 characters). A REST API token won't work.",
						],
					),
				]),
			]
		}
		case "discord": {
			const fieldIds = ids("discord-webhook", true)
			return [
				fieldBlock(h, [
					fieldLabel(
						h,
						{ ids: fieldIds, className: "text-xs", state: stateOf(form.webhookUrl) },
						"Discord webhook URL",
					),
					textInput(h, model, {
						name: "discord-webhook",
						field: "webhookUrl",
						placeholder: isEditing
							? "Leave blank to keep current webhook"
							: "https://discord.com/api/webhooks/...",
						className: "font-mono text-xs",
						hasDescription: true,
					}),
					fieldDescription(
						h,
						{ ids: fieldIds, className: "text-2xs", state: stateOf(form.webhookUrl) },
						"In Discord: Channel settings → Integrations → Webhooks → New Webhook, then copy the URL.",
					),
				]),
			]
		}
		case "google-chat": {
			const fieldIds = ids("google-chat-webhook", true)
			const isBadUrl =
				form.webhookUrl.trim().length > 0 && !isValidGoogleChatWebhookUrl(form.webhookUrl)
			return [
				fieldBlock(h, [
					fieldLabel(
						h,
						{ ids: fieldIds, className: "text-xs", state: stateOf(form.webhookUrl) },
						"Google Chat webhook URL",
					),
					textInput(h, model, {
						name: "google-chat-webhook",
						field: "webhookUrl",
						placeholder: isEditing
							? "Leave blank to keep current webhook"
							: "https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=...",
						className: "font-mono text-xs",
						hasDescription: true,
					}),
					...(isBadUrl
						? [
								fieldError(
									h,
									{ ids: fieldIds, className: "text-2xs", state: stateOf(form.webhookUrl) },
									"That isn't a Google Chat webhook URL. It starts with https://chat.googleapis.com/v1/spaces/ and has a key and a token; a link to the space won't work.",
								),
							]
						: []),
					fieldDescription(
						h,
						{ ids: fieldIds, className: "text-2xs", state: stateOf(form.webhookUrl) },
						"In Google Chat: open the space → Apps & integrations → Webhooks → Add webhook, then copy the URL.",
					),
				]),
			]
		}
		case "telegram":
			return telegramFields(h, model, isEditing)
		case "webhook":
			return [
				fieldBlock(h, [
					fieldLabel(
						h,
						{ ids: ids("url"), className: "text-xs", state: stateOf(form.url) },
						"Webhook URL",
					),
					textInput(h, model, {
						name: "url",
						field: "url",
						placeholder: isEditing
							? "Leave blank to keep current URL"
							: "https://example.com/maple-alerts",
						className: "font-mono text-xs",
					}),
				]),
				fieldBlock(h, [
					fieldLabel(
						h,
						{ ids: ids("secret"), className: "text-xs", state: stateOf(form.signingSecret) },
						"Signing secret",
					),
					textInput(h, model, {
						name: "secret",
						field: "signingSecret",
						placeholder: isEditing
							? "Leave blank to keep current secret"
							: "Optional HMAC secret",
						className: "font-mono text-xs",
					}),
				]),
			]
		case "email":
			return isClerkAuthEnabled
				? [
						emailFields(h, {
							model: model.email,
							form,
							toMessage: (message) => Message.GotEmailFieldsMessage({ message }),
						}),
					]
				: [
						h.p(
							[h.Class("text-2xs text-muted-foreground")],
							[
								"Email destinations target workspace members and require Clerk authentication, which is not enabled in this deployment.",
							],
						),
					]
		case "linear":
			return [
				linearFields(h, {
					model: model.linear,
					form,
					isEditing,
					toMessage: (message) => Message.GotLinearFieldsMessage({ message }),
				}),
			]
		case "chat":
			return [
				chatFields(h, {
					model: model.chat,
					form,
					isEditing,
					toMessage: (message) => Message.GotChatFieldsMessage({ message }),
				}),
			]
		default:
			return []
	}
}

const telegramFields = (h: H, model: Model, isEditing: boolean): ReadonlyArray<Html> => {
	const { form } = model
	const tokenIds = ids("telegram-token", true)
	const chatIds = ids("telegram-chat")
	const isTokenReady = isValidTelegramToken(form.telegramBotToken)
	return [
		fieldBlock(h, [
			fieldLabel(
				h,
				{ ids: tokenIds, className: "text-xs", state: stateOf(form.telegramBotToken) },
				"Bot token",
			),
			textInput(h, model, {
				name: "telegram-token",
				field: "telegramBotToken",
				placeholder: isEditing ? "Leave blank to keep current token" : "123456789:ABC-DEF...",
				className: "font-mono text-xs",
				type: "password",
				hasDescription: true,
			}),
			fieldDescription(
				h,
				{ ids: tokenIds, className: "text-2xs", state: stateOf(form.telegramBotToken) },
				[
					"In Telegram: message @BotFather, send",
					" ",
					inlineCode(h, {}, ["/newbot"]),
					", then copy the token it replies with.",
				],
			),
		]),
		h.div(
			[h.Class("space-y-1.5")],
			[
				field(h, { className: "items-stretch gap-2", state: IDLE }, [
					h.div(
						[h.Class("flex items-center justify-between gap-2")],
						[
							fieldLabel(h, { ids: chatIds, className: "text-xs", state: IDLE }, "Chat ID"),
							button(
								h,
								{
									variant: "ghost",
									size: "xs",
									className: "px-2 text-2xs",
									isDisabled: !isTokenReady,
									isLoading: model.isDetectingChats,
									attributes: [
										h.OnClick(Message.ClickedDetectChats()),
										...(isTokenReady
											? []
											: [
													h.Title(
														"Enter the bot token first. Detection reads the bot's chats.",
													),
												]),
									],
								},
								["Detect chats"],
							),
						],
					),
					...(model.telegramError !== null
						? [
								fieldError(
									h,
									{ ids: chatIds, className: "text-2xs", state: IDLE },
									model.telegramError,
								),
							]
						: []),
					...(model.telegramChats !== null && model.telegramChats.length === 0
						? [
								h.p(
									[h.Class("text-2xs text-muted-foreground")],
									[
										"No recent chats. Add the bot to the group or channel (or send it a message), then detect again. Telegram only keeps the last 24 hours.",
									],
								),
							]
						: []),
					...(model.telegramChats !== null && model.telegramChats.length > 0
						? [
								h.div(
									[h.Class("space-y-1 rounded-md border border-border-subtle p-1")],
									model.telegramChats.map((chat) =>
										h.button(
											[
												h.Key(chat.id),
												h.Type("button"),
												h.OnClick(Message.ClickedTelegramChat({ chatId: chat.id })),
												h.Class(
													"flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted active:bg-muted",
												),
											],
											[
												h.span([h.Class("truncate")], [chat.title]),
												h.span(
													[h.Class("shrink-0 text-3xs text-muted-foreground")],
													[TELEGRAM_CHAT_TYPE_LABELS.get(chat.type) ?? chat.type],
												),
											],
										),
									),
								),
							]
						: []),
				]),
				textInput(h, model, {
					name: "telegram-chat",
					field: "telegramChatId",
					placeholder: "-1001234567890 or @mychannel",
					className: "font-mono text-xs",
				}),
				h.p(
					[h.Class("text-2xs text-muted-foreground")],
					[
						"Add the bot to the chat, then hit ",
						h.strong([], ["Detect chats"]),
						", or enter the id by hand. Maple checks the bot can reach it when you save.",
					],
				),
			],
		),
	]
}

const fieldHelper = (h: H, type: AlertDestinationType): ReadonlyArray<Html> => {
	const provider = providerOf(type)
	return provider.docsUrl === undefined
		? []
		: [
				h.a(
					[
						h.Href(provider.docsUrl),
						h.Target("_blank"),
						h.Rel("noreferrer"),
						h.Class(
							"text-2xs text-muted-foreground underline-offset-2 hover:text-foreground active:text-foreground hover:underline active:underline",
						),
					],
					[provider.docsLabel ?? "Docs", " ↗"],
				),
			]
}

export const view = Submodel.defineView<Model, Message, Readonly<{ id: string }>>((model, inputs, h) => {
	const isEditing = model.editingId !== null
	const provider = destinationProvider(model.form.type, model.form.chatConnector)
	const nameIds = ids("name")
	return h.submodel({
		slotId: `${inputs.id}-dialog`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			className: "sm:max-w-xl",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					h.h2(
						[
							h.Class(cn(dialogTitleStyles, "flex items-center gap-2.5")),
							h.DataAttribute("slot", "dialog-title"),
							h.Id(titleId(model.dialog.id)),
						],
						[
							...(isEditing
								? [logo(h, model, model.form.type, 28, model.form.chatConnector)]
								: []),
							isEditing ? `Edit ${provider.label} destination` : "Add destination",
						],
					),
					DialogView.dialogDescription(
						h,
						"dialog",
						model.dialog.id,
						"Where Maple sends a rule's notifications. Any rule can reuse it.",
					),
				]),
				h.div(
					[h.Class("min-h-0 flex-1 space-y-5 overflow-y-auto px-6")],
					[
						...(isEditing
							? []
							: [
									h.div(
										[h.Class("space-y-2")],
										[
											eyebrow(h, { variant: "label", as: "div" }, ["Send to"]),
											model.isProviderLocked
												? panel(
														h,
														{
															className:
																"flex-row items-center justify-between gap-3 px-3 py-2",
														},
														[
															h.span(
																[
																	h.Class(
																		"flex min-w-0 items-center gap-2.5",
																	),
																],
																[
																	logo(
																		h,
																		model,
																		model.form.type,
																		28,
																		model.form.chatConnector,
																	),
																	h.span(
																		[
																			h.Class(
																				"truncate text-sm font-medium",
																			),
																		],
																		[provider.label],
																	),
																],
															),
															button(
																h,
																{
																	variant: "ghost",
																	size: "xs",
																	attributes: [
																		h.OnClick(
																			Message.ClickedUnlockProvider(),
																		),
																	],
																},
																["Change"],
															),
														],
													)
												: providerPicker(h, model),
										],
									),
								]),
						h.div(
							[h.Class("space-y-2")],
							[
								h.div(
									[h.Class("flex items-center justify-between")],
									[
										eyebrow(h, { variant: "label", as: "div" }, ["Connection"]),
										...fieldHelper(h, model.form.type),
									],
								),
								panel(h, { padded: true, className: "space-y-3" }, [
									fieldBlock(h, [
										fieldLabel(
											h,
											{
												ids: nameIds,
												className: "text-xs",
												state: stateOf(model.form.name),
											},
											[
												"Name",
												...(isEditing
													? []
													: [
															h.span(
																[
																	h.Class(
																		"font-normal text-muted-foreground",
																	),
																],
																["optional"],
															),
														]),
											],
										),
										textInput(h, model, {
											name: "name",
											field: "name",
											placeholder:
												suggestedDestinationName(toFormState(model.form)) ||
												"Production paging",
										}),
									]),
									...connectionFields(h, model, isEditing),
								]),
							],
						),
						...(isEditing
							? [
									h.div(
										[h.Class("space-y-2")],
										[
											eyebrow(h, { variant: "label", as: "div" }, ["Delivery"]),
											settingRow(h, {
												ids: {
													control: "destination-enabled-input",
													label: "destination-enabled-label",
													description: "destination-enabled-description",
												},
												framed: true,
												className: "border-border-subtle bg-card px-4 py-3",
												label: "Enabled",
												description:
													"Disabled destinations stay attached to rules but won't receive notifications.",
												filled: model.form.enabled,
												control: switchControl(h, {
													id: "destination-enabled",
													inputId: "destination-enabled-input",
													isChecked: model.form.enabled,
													labelledBy: "destination-enabled-label",
													onToggle: Message.ToggledEnabled(),
												}),
											}),
										],
									),
								]
							: []),
					],
				),
				DialogView.dialogFooter(h, "dialog", [
					button(h, { variant: "outline", attributes: [...close] }, ["Cancel"]),
					button(
						h,
						{
							isLoading: model.isSaving,
							isDisabled: !isFormReady(model.form, isEditing),
							attributes: [
								h.OnClick(Message.ClickedSave()),
								h.Style({
									background: providerOf(model.form.type).accent,
									"border-color": providerOf(model.form.type).accent,
									color: model.isSaving
										? "transparent"
										: providerOf(model.form.type).accentOn,
								}),
							],
						},
						[isEditing ? "Save changes" : `Add ${provider.label} destination`],
					),
				]),
			],
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	})
})
