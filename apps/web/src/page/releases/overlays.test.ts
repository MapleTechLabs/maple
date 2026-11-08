import { describe, expect, test } from "vitest"
import * as HoverCard from "@maple/views/ui/hover-card"
import { commitTriggerId, init, Message, update } from "./overlays"
import { Array as Arr } from "effect"

// `CommitShaHoverCard`'s arm on the releases pages: 20 ms into a hover the lookup starts, once.

const SHA = "f8f3f66ef8f3f66ef8f3f66ef8f3f66ef8f3f66e"
const triggerId = commitTriggerId("releases-list", SHA)
const card = (message: HoverCard.Message) => Message.GotCommitCardMessage({ message })

describe("releases commit card", () => {
	test("a hover arms the lookup, which fetches the commit once", () => {
		const entered = update(
			init("releases"),
			card(HoverCard.Message.EnteredTrigger({ triggerId })),
			"org_acme",
		)
		expect(Arr.map(entered.commands ?? [], (command) => command.name)).toContain(
			"ArmReleasesCommitLookup",
		)
		const armed = update(
			entered.model,
			Message.ElapsedCommitArm({ sha: SHA, generation: entered.model.commitArm }),
			"org_acme",
		)
		expect(Arr.map(armed.commands ?? [], (command) => command.name)).toEqual([
			"FetchReleasesCommitDetail",
		])
		const again = update(armed.model, card(HoverCard.Message.EnteredTrigger({ triggerId })), "org_acme")
		expect(Arr.map(again.commands ?? [], (command) => command.name)).not.toContain(
			"ArmReleasesCommitLookup",
		)
	})

	test("leaving before the arm elapses drops it", () => {
		const entered = update(
			init("releases"),
			card(HoverCard.Message.EnteredTrigger({ triggerId })),
			"org_acme",
		)
		const left = update(entered.model, card(HoverCard.Message.LeftTrigger()), "org_acme")
		const late = update(
			left.model,
			Message.ElapsedCommitArm({ sha: SHA, generation: entered.model.commitArm }),
			"org_acme",
		)
		expect(late.commands ?? []).toEqual([])
	})
})
