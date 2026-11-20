import type { FleetIntegrationStatus } from "@maple/domain/http"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import * as Field from "@maple/views/ui/field"
import { input } from "@maple/views/ui/input"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { AppRoute, hrefOf } from "../../../route"
import { codeBlock } from "../../kit/code-block"
import { providerBrand } from "../../kit/providers"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "../message"
import { canManage, manageLock, type Model } from "../model"
import {
	connectedIntegrationCard,
	disconnectButton,
	integrationActions,
	integrationAlertNotice,
	integrationErrorNotice,
	integrationStatusCard,
} from "../view-integration-card"
import {
	connectRequestOf,
	FLEET_SETUP_COMMAND,
	type FleetCardModel,
	FleetMessage,
	fleetNameOf,
	hasExtraRole,
	licenseLabel,
} from "./fleet"

type H = HtmlBuilder<Message>

const BRAND = providerBrand("fleet")

/** A Fleet message, as the hub carries it. */
export const toHub = (message: FleetMessage): Message => Message.GotFleetMessage({ message })

const URL_IDS: Field.FieldIds = {
	control: "fleet-url",
	label: "fleet-url-label",
	error: "fleet-url-error",
	description: "fleet-url-description",
}
const TOKEN_IDS: Field.FieldIds = {
	control: "fleet-token",
	label: "fleet-token-label",
	error: "fleet-token-error",
	description: "fleet-token-description",
}

/** The URL and token fields; `replace` keeps the saved URL and offers Cancel. */
const fleetForm = (
	h: H,
	form: FleetCardModel["form"],
	options: Readonly<{ mode: "connect" | "replace"; canCancel: boolean }>,
): Html => {
	const isValid = Option.isSome(connectRequestOf(form))
	const hasError = !form.isSubmitting && form.error !== null
	const urlState = Field.stateOf(form.url, false)
	const tokenState = Field.stateOf(form.token, false)
	return h.form(
		[h.Class("flex w-full flex-col gap-4 text-left"), h.OnSubmit(toHub(FleetMessage.SubmittedConnect()))],
		[
			Field.field(h, { className: "items-stretch gap-2", state: urlState }, [
				Field.fieldLabel(h, { ids: URL_IDS, state: urlState }, "Fleet URL"),
				input(h, {
					id: URL_IDS.control,
					type: "url",
					fieldState: urlState,
					attributes: [
						h.Autocomplete("off"),
						h.Placeholder("https://fleet.example.com"),
						...Field.controlAttributes(h, form.url, (message) =>
							toHub(FleetMessage.GotUrlMessage({ message })),
						),
						h.AriaLabelledBy(URL_IDS.label),
					],
				}),
			]),
			Field.field(h, { className: "items-stretch gap-2", state: tokenState }, [
				Field.fieldLabel(h, { ids: TOKEN_IDS, state: tokenState }, "API token"),
				input(h, {
					id: TOKEN_IDS.control,
					type: "password",
					fieldState: tokenState,
					attributes: [
						h.Autocomplete("off"),
						h.Placeholder("Paste the API-only user's token"),
						...Field.controlAttributes(h, form.token, (message) =>
							toHub(FleetMessage.GotTokenMessage({ message })),
						),
						h.AriaLabelledBy(TOKEN_IDS.label),
					],
				}),
				Field.fieldDescription(
					h,
					{ ids: TOKEN_IDS, state: tokenState },
					"Maple checks the token with your server before saving it.",
				),
			]),
			// The server's answer can be about the address or the token, so it belongs to the form.
			...(hasError
				? [alert(h, { variant: "crit", size: "sm" }, [alertDescription(h, [form.error ?? ""])])]
				: []),
			hstack(h, { gap: "2", wrap: true }, [
				button(h, { type: "submit", isDisabled: !isValid, isLoading: form.isSubmitting }, [
					options.mode === "replace" ? "Update token" : "Connect",
				]),
				...(options.canCancel
					? [
							button(
								h,
								{
									variant: "outline",
									isDisabled: form.isSubmitting,
									attributes: [h.OnClick(toHub(FleetMessage.ClickedReplaceCancel()))],
								},
								["Cancel"],
							),
						]
					: []),
			]),
		],
	)
}

/** How to make the API-only user Maple reads with. */
const setupHelp = (h: H, card: FleetCardModel): Html =>
	vstack(h, { gap: "2" }, [
		typography(h, { size: "xs", as: "p" }, [
			"Create an API-only user with the Observer role. With fleetctl, this prints the token:",
		]),
		codeBlock(h, {
			code: FLEET_SETUP_COMMAND,
			language: "fleetctl",
			lang: "bash",
			copy: card.commandCopy,
			toCopyMessage: (message) => toHub(FleetMessage.GotCommandCopyMessage({ message })),
		}),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"Or in Fleet, open Settings, then Users, then Add user, choose API-only user and give it the Observer role. Maple only reads from Fleet.",
		]),
	])

const notConnectedView = (h: H, model: Model): Html =>
	connectedIntegrationCard(h, model, {
		integration: null,
		brand: BRAND,
		title: "Connect Fleet",
		badge: null,
		summary: [
			"Bring your Fleet server's admin activity into the audit log, and its failing policies and vulnerable software into Security, Devices.",
		],
		body: canManage(model) ? [setupHelp(h, model.fleetCard)] : [],
		actions: canManage(model)
			? fleetForm(h, model.fleetCard.form, { mode: "connect", canCancel: false })
			: typography(h, { size: "xs", tone: "muted", as: "p" }, [
					manageLock(model) ?? "You can't connect integrations.",
				]),
		contentGap: "gap-4",
	})

const details = (h: H, model: Model, status: FleetIntegrationStatus, timeZone: string): Html =>
	keyValueList(h, { layout: "grid" }, [
		...(status.baseUrl !== null ? [keyValue(h, { label: "URL", mono: true }, [status.baseUrl])] : []),
		...(status.serverVersion !== null
			? [keyValue(h, { label: "Server version", mono: true }, [status.serverVersion])]
			: []),
		...(status.licenseTier !== null
			? [keyValue(h, { label: "License" }, [licenseLabel(status.licenseTier)])]
			: []),
		...(status.apiUserName !== null || status.apiUserRole !== null
			? [
					keyValue(h, { label: "API user" }, [
						status.apiUserName ?? "Unknown",
						...(status.apiUserRole !== null
							? [typography(h, { tone: "muted" }, [` (${status.apiUserRole})`])]
							: []),
					]),
				]
			: []),
		...(status.connectedAt !== null
			? [
					keyValue(h, { label: "Connected" }, [
						relativeTime(h, { value: status.connectedAt, nowMs: model.nowMs, timeZone }),
					]),
				]
			: []),
		keyValue(h, { label: "Last synced" }, [
			status.lastSyncedAt !== null
				? relativeTime(h, { value: status.lastSyncedAt, nowMs: model.nowMs, timeZone })
				: "Not yet",
		]),
	])

const connectedView = (h: H, model: Model, status: FleetIntegrationStatus, timeZone: string): Html => {
	const card = model.fleetCard
	const isManager = canManage(model)
	const name = fleetNameOf(status)
	return connectedIntegrationCard(h, model, {
		integration: "fleet",
		brand: BRAND,
		title: name ?? "Fleet",
		badge: status.authFailed
			? badge(h, { variant: "crit" }, ["Token rejected"])
			: status.lastError !== null
				? badge(h, { variant: "warn" }, ["Needs attention"])
				: badge(h, { variant: "ok" }, ["Connected"]),
		summary: [
			"Fleet",
			...(status.lastSyncedAt !== null
				? [
						" · ",
						relativeTime(h, {
							value: status.lastSyncedAt,
							nowMs: model.nowMs,
							timeZone,
							prefix: "synced",
						}),
					]
				: [" · waiting for the first sync"]),
		],
		notice: status.authFailed
			? integrationAlertNotice(
					h,
					isManager
						? "Fleet rejected the saved token, so syncing is paused. Save a new token to resume."
						: "Fleet rejected the saved token, so syncing is paused. An admin can save a new one.",
				)
			: status.lastError !== null
				? integrationErrorNotice(h, "Last error: ", status.lastError)
				: null,
		body: [
			details(h, model, status, timeZone),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Failing policies and vulnerable software are in ",
				textLink(h, { href: hrefOf(AppRoute.SecurityDevices()) }, ["Security, Devices"]),
				"; admin activity is in the ",
				textLink(h, { href: hrefOf(AppRoute.SecurityAuditLog({ search: { provider: "fleet" } })) }, [
					"audit log",
				]),
				".",
			]),
			...(hasExtraRole(status)
				? [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							`This token's user has the ${status.apiUserRole ?? ""} role. Maple only reads, so an API-only user with the Observer role is enough.`,
						]),
					]
				: []),
		],
		actions: !isManager
			? null
			: status.authFailed
				? // A server that can no longer issue a token must still be removable.
					vstack(h, { gap: "3" }, [
						fleetForm(h, card.form, { mode: "replace", canCancel: false }),
						integrationActions(h, [disconnectButton(h, model)]),
					])
				: card.isReplacing
					? fleetForm(h, card.form, { mode: "replace", canCancel: true })
					: integrationActions(h, [
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									attributes: [h.OnClick(toHub(FleetMessage.ClickedReplaceToken()))],
								},
								["Update token"],
							),
							disconnectButton(h, model),
						]),
		contentGap: "gap-3",
	})
}

export const fleetCard = (h: H, model: Model, timeZone: string): Html =>
	integrationStatusCard(h, model.statuses.fleet, {
		name: "fleet",
		failureTitle: "Couldn't load the Fleet integration",
		render: (status) =>
			status.connected ? connectedView(h, model, status, timeZone) : notConnectedView(h, model),
	})
