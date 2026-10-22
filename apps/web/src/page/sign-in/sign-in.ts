import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { MapleAuthApi } from "../../platform/auth-api"

// MODEL

/** Why the root password was not accepted; the view turns it into copy. */
export const SignInFailure = defineTaggedUnion({
	Rejected: { message: Schema.String },
	Unreachable: {},
	Unexpected: {},
})
export type SignInFailure = typeof SignInFailure.Type

export const Submission = defineTaggedUnion({
	NotSubmitted: {},
	Submitting: {},
	Failed: { failure: SignInFailure },
})
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
	password: Schema.String,
	/** Base UI field state: focused now, and blurred at least once. */
	isPasswordFocused: Schema.Boolean,
	isPasswordTouched: Schema.Boolean,
	submission: Submission,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	password: "",
	isPasswordFocused: false,
	isPasswordTouched: false,
	submission: Submission.NotSubmitted(),
})

// MESSAGE

export const Message = defineMessageUnion({
	UpdatedPassword: { value: Schema.String },
	FocusedPassword: {},
	BlurredPassword: {},
	SubmittedSignIn: {},
	SucceededSignInWithRootPassword: { token: Schema.String },
	FailedSignInWithRootPassword: { failure: SignInFailure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SucceededSignIn: { token: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const rejected = (error: { readonly message: string }) =>
	Effect.succeed(
		Message.FailedSignInWithRootPassword({ failure: SignInFailure.Rejected({ message: error.message }) }),
	)

/** `POST /api/auth/login` with the root password. */
export const SignInWithRootPassword = Command.define("SignInWithRootPassword", {
	args: { password: Schema.String },
	messages: [Message.SucceededSignInWithRootPassword, Message.FailedSignInWithRootPassword],
	execute: ({ password }) =>
		Effect.gen(function* () {
			const auth = yield* MapleAuthApi
			const session = yield* auth.login(password)
			return Message.SucceededSignInWithRootPassword({ token: session.token })
		}).pipe(
			Effect.catchTags({
				"@maple/http/errors/SelfHostedInvalidPasswordError": rejected,
				"@maple/http/errors/SelfHostedAuthDisabledError": rejected,
				"@maple/http/errors/SelfHostedLoginThrottledError": rejected,
				"@maple/http/errors/SelfHostedLoginUnavailableError": rejected,
				HttpClientError: (error) =>
					Effect.succeed(
						Message.FailedSignInWithRootPassword({
							failure:
								error.reason._tag === "TransportError"
									? SignInFailure.Unreachable()
									: SignInFailure.Unexpected(),
						}),
					),
			}),
			Effect.orElseSucceed(() =>
				Message.FailedSignInWithRootPassword({ failure: SignInFailure.Unexpected() }),
			),
		),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, MapleAuthApi>

export const update = (model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		UpdatedPassword: ({ value }) => ({ model: modifyFields(model, { password: () => value }) }),
		FocusedPassword: () => ({ model: modifyFields(model, { isPasswordFocused: () => true }) }),
		BlurredPassword: () => ({
			model: modifyFields(model, { isPasswordFocused: () => false, isPasswordTouched: () => true }),
		}),
		SubmittedSignIn: () =>
			Submission.match(model.submission, {
				Submitting: () => ({ model }),
				NotSubmitted: () => submit(model),
				Failed: () => submit(model),
			}),
		SucceededSignInWithRootPassword: ({ token }) => ({
			model,
			outMessage: OutMessage.SucceededSignIn({ token }),
		}),
		FailedSignInWithRootPassword: ({ failure }) => ({
			model: modifyFields(model, { submission: () => Submission.Failed({ failure }) }),
		}),
	})

const submit = (model: Model): UpdateReturn => ({
	model: modifyFields(model, { submission: () => Submission.Submitting() }),
	commands: [SignInWithRootPassword({ password: model.password })],
})
