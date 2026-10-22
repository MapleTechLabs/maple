import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { MapleApiClient } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"
import * as OtpField from "../../ui/otp-field"
import { endpointMessage, localeTimeOf } from "./request"

// `/cli-login`: approve a terminal's device code.

// MODEL

export const DeviceInfo = Schema.Struct({
	userCode: Schema.String,
	deviceName: Schema.String,
	/** `new Date(expiresAt).toLocaleTimeString()`, formatted by the Command that read it. */
	expiresAtLabel: Schema.String,
})
export type DeviceInfo = typeof DeviceInfo.Type

export const State = defineTaggedUnion({
	Entry: {},
	Loading: {},
	Ready: { info: DeviceInfo },
	Approved: {},
	Denied: {},
	Failed: { message: Schema.String },
})
export type State = typeof State.Type

export const Model = Schema.TaggedStruct("CliLogin", {
	state: State,
	otp: OtpField.Model,
	/** The code the in-flight inspection is for; another answer is stale. */
	pendingCode: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

/** `normalizeCliUserCode`: upper-case alphanumerics, eight at most, `XXXX-XXXX`. */
export const normalizeCliUserCode = (value: string): string => {
	const normalized = value
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "")
		.slice(0, 8)
	return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized
}

/** The code field's id: the first slot, which its label's `for` points at. */
export const CODE_FIELD_ID = "cli-login-code"
export const CODE_LABEL_ID = `${CODE_FIELD_ID}-label`

// MESSAGE

export const Message = defineMessageUnion({
	GotOtpMessage: { message: OtpField.Message },
	SucceededInspectCliDevice: {
		userCode: Schema.String,
		info: DeviceInfo,
		status: Schema.Literals(["pending", "approved", "denied", "complete"]),
	},
	FailedInspectCliDevice: { userCode: Schema.String, message: Schema.String },
	ClickedDecision: { action: Schema.Literals(["approve", "deny"]) },
	SucceededDecideCliDevice: { action: Schema.Literals(["approve", "deny"]) },
	FailedDecideCliDevice: { message: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const INSPECT_FALLBACK = "This CLI login code is invalid or expired."

/** `inspectCliDevice`: `GET /api/auth/cli/device/:userCode`. */
export const InspectCliDevice = Command.define("InspectCliDevice", {
	args: { userCode: Schema.String },
	messages: [Message.SucceededInspectCliDevice, Message.FailedInspectCliDevice],
	execute: ({ userCode }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			const response = yield* client.auth.cliDeviceInspect({ params: { userCode } })
			const expiresAtLabel = yield* localeTimeOf(response.expiresAt)
			return Message.SucceededInspectCliDevice({
				userCode,
				info: { userCode: response.userCode, deviceName: response.deviceName, expiresAtLabel },
				status: response.status,
			})
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedInspectCliDevice({
						userCode,
						message: endpointMessage(error, INSPECT_FALLBACK),
					}),
				),
			),
		),
})

/** `actOnCliDevice`: `POST /api/auth/cli/device/:userCode/approve|deny`. */
export const DecideCliDevice = Command.define("DecideCliDevice", {
	args: { userCode: Schema.String, action: Schema.Literals(["approve", "deny"]) },
	messages: [Message.SucceededDecideCliDevice, Message.FailedDecideCliDevice],
	execute: ({ userCode, action }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			yield* action === "approve"
				? client.auth.cliDeviceApprove({ params: { userCode } })
				: client.auth.cliDeviceDeny({ params: { userCode } })
			return Message.SucceededDecideCliDevice({ action })
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedDecideCliDevice({
						message: endpointMessage(error, `Unable to ${action} CLI access.`),
					}),
				),
			),
		),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Resources>

const inspect = (model: Model, code: string): UpdateReturn => {
	const normalized = normalizeCliUserCode(code)
	if (normalized.replace("-", "").length !== 8) {
		return {
			model: modifyFields(model, {
				state: () =>
					State.Failed({ message: "Enter the eight-character code shown in your terminal." }),
			}),
		}
	}
	return {
		model: modifyFields(model, { state: () => State.Loading(), pendingCode: () => normalized }),
		commands: [InspectCliDevice({ userCode: normalized })],
	}
}

/** `useState(() => initialCode ? loading : entry)`, then the mount effect's inspection. */
export const init = (initialCode: string | undefined): UpdateReturn => {
	const model: Model = {
		_tag: "CliLogin",
		state: State.Entry(),
		otp: OtpField.init({
			id: CODE_FIELD_ID,
			length: 8,
			value: normalizeCliUserCode(initialCode ?? "").replace("-", ""),
			validation: "alphanumeric",
			isUppercase: true,
		}),
		pendingCode: null,
	}
	return initialCode === undefined || initialCode === "" ? { model } : inspect(model, initialCode)
}

/** Base UI's `onValueComplete` fires when the value reaches its full length. */
const updateOtp = (model: Model, otpMessage: OtpField.Message): UpdateReturn => {
	const next = OtpField.update(model.otp, otpMessage)
	const otpCommands = Command.mapMessages(next.commands ?? [], (child) =>
		Message.GotOtpMessage({ message: child }),
	)
	const withOtp = modifyFields(model, { otp: () => next.model })
	if (OtpField.isComplete(model.otp) || !OtpField.isComplete(next.model)) {
		return { model: withOtp, commands: otpCommands }
	}
	const inspected = inspect(withOtp, OtpField.valueOf(next.model))
	return { model: inspected.model, commands: [...otpCommands, ...(inspected.commands ?? [])] }
}

const settled = (model: Model, userCode: string, state: State): UpdateReturn =>
	model.pendingCode === userCode
		? { model: modifyFields(model, { pendingCode: () => null, state: () => state }) }
		: { model }

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotOtpMessage: ({ message: otpMessage }) => updateOtp(model, otpMessage),
		SucceededInspectCliDevice: ({ userCode, info, status }) =>
			settled(
				model,
				userCode,
				status === "denied"
					? State.Denied()
					: status === "approved" || status === "complete"
						? State.Approved()
						: State.Ready({ info }),
			),
		FailedInspectCliDevice: ({ userCode, message: failure }) =>
			settled(model, userCode, State.Failed({ message: failure })),
		// The in-flight guard: a decision is only taken from the ready card.
		ClickedDecision: ({ action }) =>
			model.state._tag === "Ready"
				? {
						model: modifyFields(model, { state: () => State.Loading() }),
						commands: [DecideCliDevice({ userCode: model.state.info.userCode, action })],
					}
				: { model },
		SucceededDecideCliDevice: ({ action }) => ({
			model: modifyFields(model, {
				state: () => (action === "approve" ? State.Approved() : State.Denied()),
			}),
		}),
		FailedDecideCliDevice: ({ message: failure }) => ({
			model: modifyFields(model, { state: () => State.Failed({ message: failure }) }),
		}),
	})
