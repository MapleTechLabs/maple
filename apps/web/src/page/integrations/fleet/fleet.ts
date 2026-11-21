import { FleetConnectRequest, type FleetIntegrationStatus, fleetServerName } from "@maple/domain/http"
import { displayError, isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { Effect, Option, Schema, String as Str } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Field from "@maple/views/ui/field"
import { MapleInternalApiClient } from "../../../platform/api-clients"

// Fleet's part of `/integrations`: one server per org, reached with an API-only user's token.

export const FleetCardModel = Schema.Struct({
	form: Schema.Struct({
		url: Field.Model,
		token: Field.Model,
		isSubmitting: Schema.Boolean,
		/** The server's validation message, shown under the token field. */
		error: Schema.NullOr(Schema.String),
	}),
	/** Update token is open on a healthy connection (a rejected token shows the form anyway). */
	isReplacing: Schema.Boolean,
	/** The setup command's copy button. */
	commandCopy: CopyButton.Model,
})
export type FleetCardModel = typeof FleetCardModel.Type

export const initFleetForm = (url = ""): FleetCardModel["form"] => ({
	url: Field.init(url),
	token: Field.init(),
	isSubmitting: false,
	error: null,
})

export const initFleetCard = (): FleetCardModel => ({
	form: initFleetForm(),
	isReplacing: false,
	commandCopy: CopyButton.init(),
})

/** The Fleet module's own messages; the hub carries them in `GotFleetMessage`. */
export const FleetMessage = defineMessageUnion({
	GotUrlMessage: { message: Field.Message },
	GotTokenMessage: { message: Field.Message },
	GotCommandCopyMessage: { message: CopyButton.Message },
	SubmittedConnect: {},
	SucceededConnect: { title: Schema.String, description: Schema.String },
	FailedConnect: { error: Schema.String },
	ClickedReplaceToken: {},
	ClickedReplaceCancel: {},
})
export type FleetMessage = typeof FleetMessage.Type

/** The hub's status read for Fleet. */
export const FLEET_STATUS_READ = {
	name: "LoadIntegrationsFleetStatus",
	read: (_refresh: boolean) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.integrations.fleetStatus()),
}

/** What an admin runs to make Maple's user; `fleetctl` prints the token. */
export const FLEET_SETUP_COMMAND =
	'fleetctl user create --name "Maple" --email maple@example.com --api-only --global-role observer'

const decodeConnectRequest = Schema.decodeUnknownOption(FleetConnectRequest)

/** The form's request once both fields hold something the server would take. */
export const connectRequestOf = (form: FleetCardModel["form"]): Option.Option<FleetConnectRequest> =>
	decodeConnectRequest({ url: Str.trim(form.url.value), token: Str.trim(form.token.value) })

/** The connection's name: Fleet's organization, else the server's host. */
export const fleetNameOf = (status: FleetIntegrationStatus): string | null =>
	status.baseUrl === null
		? null
		: fleetServerName({ organizationName: status.organizationName, baseUrl: status.baseUrl })

export const licenseLabel = (tier: string): string =>
	tier === "premium" ? "Premium" : tier === "free" ? "Free" : Str.capitalize(tier)

/** Maple only reads, so any role above Observer (Observer+ runs live queries) holds more than it needs. */
export const hasExtraRole = (status: FleetIntegrationStatus): boolean =>
	status.apiUserRole !== null && status.apiUserRole !== "observer"

export const ConnectFleet = Command.define("ConnectFleetFromIntegrations", {
	args: { url: Schema.String, token: Schema.String, mode: Schema.Literals(["connect", "replace"]) },
	messages: [FleetMessage.SucceededConnect, FleetMessage.FailedConnect],
	execute: ({ url, token, mode }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const status = yield* client.integrations.fleetConnect({
				payload: new FleetConnectRequest({ url, token }),
			})
			const name = fleetNameOf(status)
			return FleetMessage.SucceededConnect({
				title: mode === "replace" ? "Fleet token updated" : "Fleet connected",
				description:
					name === null
						? "Its admin activity will show in the audit log."
						: `Admin activity from ${name} will show in the audit log.`,
			})
		}).pipe(
			Effect.catch((error) => {
				const presentation = displayError(error)
				return Effect.succeed(
					FleetMessage.FailedConnect({
						error: isUnexpectedError(presentation)
							? "Couldn't connect Fleet."
							: presentation.message,
					}),
				)
			}),
		),
})
