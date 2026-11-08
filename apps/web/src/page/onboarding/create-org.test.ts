import { OrganizationProviderError, UnauthorizedError } from "@maple/domain/http"
import { Cause } from "effect"
import { describe, expect, test } from "vitest"
import { OrganizationCreateError } from "../../shell/clerk-org-switcher"
import { createFailureMessage, SIGN_IN_EXPIRED_MESSAGE } from "./create-org"

const failedWith = (error: unknown, message: string) =>
	new OrganizationCreateError({ message, cause: Cause.fail(error) })

describe("createFailureMessage", () => {
	test("a 401 the fresh token did not fix asks them to sign in again, not to click again", () => {
		const error = failedWith(
			new UnauthorizedError({ message: "Invalid Clerk token" }),
			"Invalid Clerk token",
		)
		expect(createFailureMessage(error)).toBe(SIGN_IN_EXPIRED_MESSAGE)
	})

	test("any other refusal keeps the API's own reason", () => {
		const error = failedWith(
			new OrganizationProviderError({ message: "Name already taken" }),
			"Name already taken",
		)
		expect(createFailureMessage(error)).toBe("Name already taken")
	})
})
