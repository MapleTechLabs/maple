import { Option } from "effect"
import { expect as expectView, given, Mount, scene, selector, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import type { PendingSessionTask } from "../../platform/clerk"
import { AppRoute } from "../../route"
import { MountClerkCard } from "./clerk-card"
import { init, type Inputs, Message, update } from "./index"
import { initCustomer } from "./plan-gate"
import { view } from "./view"

const inputsOf = (task: PendingSessionTask): Inputs => ({
	session: "SignedIn",
	maybeOrgId: Option.none(),
	maybeOrganization: Option.none(),
	memberships: [],
	maybeUser: Option.none(),
	customer: initCustomer(),
	timeZone: "UTC",
	maybePendingTask: Option.some(task),
})

const expectTaskCard = (task: PendingSessionTask, component: string, other: string) => {
	const inputs = inputsOf(task)
	const route = AppRoute.SignIn({ search: { redirect_url: "/services" } })
	const step = Option.getOrThrow(init(route, `SessionTask:${task}`, inputs))
	scene(
		{ update: (model, message) => update(model, message, inputs), view: withViewInputs(view, inputs)() },
		given(step.model),
		Mount.resolveAll([MountClerkCard, Message.CompletedMountClerkCard()]),
		expectView(selector(`[data-clerk-component="${component}"]`)).toExist(),
		expectView(selector(`[data-clerk-component="${other}"]`)).not.toExist(),
		expectView(selector('[data-clerk-component="SignIn"]')).not.toExist(),
	)
}

describe("session task screen", () => {
	test("a pending password reset mounts Clerk's reset-password card", () => {
		expectTaskCard("reset-password", "TaskResetPassword", "TaskSetupMFA")
	})

	test("a pending MFA setup mounts Clerk's setup-MFA card", () => {
		expectTaskCard("setup-mfa", "TaskSetupMFA", "TaskResetPassword")
	})
})
