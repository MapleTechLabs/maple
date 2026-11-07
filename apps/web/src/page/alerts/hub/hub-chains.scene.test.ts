import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import * as Animation from "@foldkit/ui/animation"
import { EscalationChainId } from "@maple/domain/http"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { MountDialog } from "@maple/views/ui/dialog"
import {
	click,
	Command,
	expect as expectView,
	Mount,
	given,
	role,
	scene,
	selector,
	submit,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { V2EscalationChain } from "@maple/domain/http/v2"
import type { PageContext } from "../../contract"
import { CHAIN_IN_USE_CODE } from "../shared/escalation-chains"
import { chainDestinations, chainUuid, populatedChains } from "../shared/escalation-test-fixtures"
import { NOW, ORG, ruleId, ruleRow } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { chainMenuId, init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])
const RULES = [ruleRow(1, { name: "Checkout errors" }), ruleRow(2, { name: "Checkout p95" }), ruleRow(3)]
const CHAINS = populatedChains([ruleId(1), ruleId(2), ruleId(3)])

const onRouting = (grants: ReturnType<typeof Policy.grantsOf>, chains: ReadonlyArray<V2EscalationChain>) => {
	const entered = init({ _tag: "Alerts", search: { tab: "routing" } }, context)
	expect(names(entered.commands)).toContain("FetchAlertsHubChains")
	return Arr.reduce(
		[
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchSession({ orgId: ORG, grants }),
			Message.UpdatedDestinations({ orgId: ORG, rows: chainDestinations }),
			Message.UpdatedRules({ orgId: ORG, rows: RULES }),
			Message.CompletedFetchChains({
				key: entered.model.chains.key ?? "",
				result: Result.succeed(chains),
			}),
		],
		entered.model,
		(model, message) => pageUpdate(model, message).model,
	)
}

const openDialog = () => [
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
	Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
]

describe("alerts hub, escalation chains", () => {
	test("an org without chains learns what one is and can create the first", () => {
		scene(
			{ update: pageUpdate, view },
			given(onRouting(ENGINEER, [])),
			expectView(text("No escalation chains")).toExist(),
			expectView(text(/waits for someone to acknowledge, then pages the next/u)).toExist(),
			expectView(role("button", { name: "Create chain" })).toExist(),
		)
	})

	test("each chain reads as its steps in one line and the rules that start it", () => {
		scene(
			{ update: pageUpdate, view },
			given(onRouting(ENGINEER, CHAINS)),
			expectView(text("Checkout on-call")).toExist(),
			expectView(
				text(
					"Slack #alerts-api, then PagerDuty Checkout after 10m, then Email on-call after 15m; repeats twice",
				),
			).toExist(),
			expectView(text("Used by 2 rules")).toExist(),
			expectView(text("Not used by any rule")).toExist(),
			expectView(role("button", { name: "Actions for Checkout on-call" })).toExist(),
			expectView(role("button", { name: "New chain" })).toExist(),
		)
	})

	test("a chain counts the rules that start it before the rules list has loaded", () => {
		scene(
			{ update: pageUpdate, view },
			given({ ...onRouting(ENGINEER, CHAINS), rules: null }),
			expectView(text("Used by 2 rules")).toExist(),
		)
	})

	test("a member sees the chains but cannot create, edit or delete one", () => {
		scene(
			{ update: pageUpdate, view },
			given(onRouting(MEMBER, [])),
			expectView(role("button", { name: "Create chain" })).not.toExist(),
			expectView(text(/Ask an org admin to create one/u)).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(onRouting(MEMBER, CHAINS)),
			expectView(role("button", { name: "Actions for Checkout on-call" })).not.toExist(),
		)
	})

	test("saving a new chain without a name or destinations shows what is missing and sends nothing", () => {
		scene(
			{ update: pageUpdate, view },
			given(onRouting(ENGINEER, CHAINS)),
			click(role("button", { name: "New chain" })),
			...openDialog(),
			expectView(role("dialog", { name: "New escalation chain" })).toExist(),
			submit(selector("form")),
			Command.expectNone(),
			expectView(text("Name the chain")).toExist(),
			expectView(text("Pick at least one destination, person or schedule")).toExist(),
		)
	})

	test("a refused delete stays open and names the rules that still start the chain", () => {
		const model = onRouting(ENGINEER, CHAINS)
		const chainId = Schema.decodeSync(EscalationChainId)(chainUuid(1))
		const asked = pageUpdate(
			pageUpdate(
				model,
				Message.GotRowMenuMessage({
					menuId: chainMenuId(chainId),
					message: Menu.Message.ClickedItem({ index: 2, item: { kind: "Item", value: "delete" } }),
				}),
			).model,
			Message.ClickedConfirmDeleteChain(),
		)
		expect(names(asked.commands)).toEqual(["DeleteEscalationChain"])
		const refused = pageUpdate(
			asked.model,
			Message.CompletedDeleteChain({
				chainId,
				result: Result.fail({
					_tag: "@maple/http/errors/EscalationChainInUseError",
					type: "conflict_error",
					code: CHAIN_IN_USE_CODE,
					title: "Escalation chain is in use",
					message: "The escalation chain is used by one or more alert rules.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		expect(refused.model.deleteChainError).toBe(
			"Still used by Checkout errors, Checkout p95. Remove it from their severity tiers first.",
		)
		expect(refused.model.confirmDeleteChainId).toBe(chainId)
		// The chains are read again, so a retry names a rule attached since the tab opened.
		expect(names(refused.commands)).toContain("FetchAlertsHubChains")

		// Before the rules list has loaded the rules cannot be named, only counted.
		const unloaded = pageUpdate(
			{ ...asked.model, rules: null },
			Message.CompletedDeleteChain({
				chainId,
				result: Result.fail({
					_tag: "@maple/http/errors/EscalationChainInUseError",
					type: "conflict_error",
					code: CHAIN_IN_USE_CODE,
					title: "Escalation chain is in use",
					message: "The escalation chain is used by one or more alert rules.",
					retryable: false,
					recovery: "fix_request",
				}),
			}),
		)
		expect(unloaded.model.deleteChainError).toBe(
			"Alert rules still start this chain. Remove it from their severity tiers first.",
		)
	})
})
