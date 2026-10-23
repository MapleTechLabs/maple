import { OrgId } from "@maple/domain"
import { SecurityAuditForbiddenError, SecurityAuditTargetNotFoundError } from "@maple/domain/http"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	keydown,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { findingsOf, TARGET_IDS, targetsOf } from "../../../lab/security-fixture"
import { AppRoute } from "../../../route"
import * as Field from "../../../ui/field"
import * as ToggleGroup from "../../../ui/toggle-group"
import type { PageContext } from "../../contract"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 9, 23, 14, 32)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const route = AppRoute.SecurityFinding({
	targetId: Schema.decodeSync(SecurityAuditTargetId)(TARGET_IDS.gateway),
	fingerprint: "exports-tenant-body-8b9e",
})

const loaded = (): Model => {
	const entered = init(route, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedReadIsAdmin({ isAdmin: true }),
		Message.CompletedFetchFindings({
			key: entered.findings.key ?? "",
			result: Result.succeed(findingsOf(NOW, TARGET_IDS.gateway)),
		}),
		Message.CompletedFetchTargets({
			key: entered.targets.key ?? "",
			result: Result.succeed(targetsOf(NOW)),
		}),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("security finding", () => {
	test("a confirmed finding shows its record, exploit and fix", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(text("Tenant id taken from request body in /v1/exports")).toExist(),
			expectView(text("How it is exploited")).toExist(),
			expectView(text("How to fix it")).toExist(),
		)
	})

	test("dismissing needs a reason before anything is sent", () => {
		const picked = pageUpdate(
			loaded(),
			Message.GotTriageMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "dismissed", index: 1 }),
			}),
		).model
		const empty = pageUpdate(picked, Message.SubmittedTriage())
		expect(names(empty.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(empty.model),
			expectView(
				text("A reason is required. It is recorded in the org audit log with your name."),
			).toExist(),
		)
		const reasoned = pageUpdate(
			picked,
			Message.GotReasonMessage({
				message: Field.Message.ChangedValue({ value: "Behind the admin VPN" }),
			}),
		).model
		const sent = pageUpdate(reasoned, Message.SubmittedTriage())
		expect(names(sent.commands)).toEqual(["SecurityApiUpdateFindingStatus"])
	})

	test("every triage option is reachable from the keyboard and selectable", () => {
		const nth = (index: number) =>
			ToggleGroup.FocusItem({
				selector: `[data-slot="toggle-group"][aria-label="Status"] > :nth-child(${index})`,
			})
		const focused = () => Command.resolve(ToggleGroup.FocusItem, ToggleGroup.Message.CompletedFocusItem())
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(role("button", { name: "Open" })).toHaveAttr("aria-pressed", "true"),
			keydown(role("button", { name: "Open" }), "ArrowRight"),
			Command.expectHas(nth(2)),
			focused(),
			keydown(role("button", { name: "Dismiss" }), "ArrowRight"),
			Command.expectHas(nth(3)),
			focused(),
			click(role("button", { name: "Accept risk" })),
			expectView(role("button", { name: "Accept risk" })).toHaveAttr("aria-pressed", "true"),
			expectView(role("button", { name: "Open" })).toHaveAttr("aria-pressed", "false"),
		)
	})

	test("the status the finding already has is not written again", () => {
		const reasoned = pageUpdate(
			loaded(),
			Message.GotReasonMessage({ message: Field.Message.ChangedValue({ value: "still open" }) }),
		).model
		expect(names(pageUpdate(reasoned, Message.SubmittedTriage()).commands)).toEqual([])
	})

	test("an unknown target or finding renders not found with a way back to the findings", () => {
		const entered = init(route, context).model
		const missing = pageUpdate(
			entered,
			Message.CompletedFetchFindings({
				key: entered.findings.key ?? "",
				result: Result.fail(
					toLoadFailure(
						new SecurityAuditTargetNotFoundError({
							message: "no target",
							targetId: route.targetId,
						}),
					),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(missing),
			expectView(text("Finding not found")).toExist(),
			expectView(role("link", { name: "Back to findings" })).toHaveAttr("href", "/security/findings"),
			expectView(text(/^Failed to load/)).not.toExist(),
		)
	})

	test("a member sees the admins-only state instead of the record", () => {
		const entered = init(route, context).model
		const gated = pageUpdate(
			entered,
			Message.CompletedFetchFindings({
				key: entered.findings.key ?? "",
				result: Result.fail(
					toLoadFailure(new SecurityAuditForbiddenError({ message: "Admins only" })),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(gated),
			expectView(text("Findings and reports are visible to org admins only")).toExist(),
		)
	})
})
