import {
	Command,
	expect,
	expectNoOutMessage,
	expectOutMessage,
	given,
	label,
	role,
	scene,
	submit,
	text,
	type,
	within,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { init, Message, OutMessage, SignInFailure, SignInWithRootPassword, update, view } from "./index"

const passwordField = label("Root password")
const signInButton = role("button", { name: "Sign in" })
const form = role("form")

describe("self-hosted sign-in", () => {
	test("typing the password fills the field and marks it dirty", () => {
		scene(
			{ update, view },
			given(init()),
			expect(passwordField).toHaveValue(""),
			type(passwordField, "hunter2"),
			expect(passwordField).toHaveValue("hunter2"),
			expect(passwordField).toHaveAttr("data-filled", ""),
			expect(passwordField).toHaveAttr("data-dirty", ""),
			expect(passwordField).not.toHaveAttr("aria-invalid"),
		)
	})

	test("a successful sign-in shows the loading button, then hands the token to the root", () => {
		scene(
			{ update, view },
			given(init()),
			type(passwordField, "correct-horse"),
			submit(form),
			Command.expectExact(SignInWithRootPassword({ password: "correct-horse" })),
			expect(signInButton).toBeDisabled(),
			expect(signInButton).toHaveAttr("data-loading", ""),
			expect(passwordField).toBeDisabled(),
			Command.resolve(
				SignInWithRootPassword,
				Message.SucceededSignInWithRootPassword({ token: "session-token" }),
			),
			expectOutMessage(OutMessage.SucceededSignIn({ token: "session-token" })),
		)
	})

	test("a rejected password shows the API's message and keeps the form usable", () => {
		scene(
			{ update, view },
			given(init()),
			type(passwordField, "wrong"),
			submit(form),
			Command.resolve(
				SignInWithRootPassword,
				Message.FailedSignInWithRootPassword({
					failure: SignInFailure.Rejected({ message: "Invalid root password" }),
				}),
			),
			expectNoOutMessage(),
			expect(within(form, role("alert"))).toHaveText("Invalid root password"),
			expect(passwordField).toHaveAttr("aria-invalid", "true"),
			expect(signInButton).toBeEnabled(),
			expect(passwordField).toBeEnabled(),
		)
	})

	test("an unreachable API shows the browser's fetch failure, like apps/web", () => {
		scene(
			{ update, view },
			given(init()),
			type(passwordField, "anything"),
			submit(form),
			Command.resolve(
				SignInWithRootPassword,
				Message.FailedSignInWithRootPassword({ failure: SignInFailure.Unreachable() }),
			),
			expect(text("Failed to fetch")).toExist(),
		)
	})
})
