import { expect as expectView, given, scene, text } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { describe, expect, test } from "vitest"
import { approvalCard, asUtcInstant } from "./view-cards"

const Message = defineMessageUnion({ Toggled: {}, Approved: {}, Denied: {} })
type Message = typeof Message.Type

type Model = Readonly<{ muteUntil: string }>

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	approvalCard(h, {
		toolName: "update_alert_rule",
		input: { ruleId: "rule_9182", muteUntil: model.muteUntil },
		timeZone: "America/New_York",
		resolved: undefined,
		isRawOpen: false,
		isDeciding: false,
		onToggleRaw: Message.Toggled(),
		onApprove: Message.Approved(),
		onDeny: Message.Denied(),
	})
const update = (model: Model) => ({ model, commands: [] })

describe("approval card arguments", () => {
	test("keys read as words and times show in the viewer's zone", () => {
		scene(
			{ update, view },
			given<Model>({ muteUntil: "2026-10-07T14:05:00Z" }),
			expectView(text("Mute until")).toExist(),
			expectView(text(/Oct 7, 2026, 10:05/)).toExist(),
		)
	})

	test("a zone-less time is read as the same UTC instant, whatever the browser's zone", () => {
		const instant = (iso: string) => new Date(asUtcInstant(iso)).getTime()
		expect(instant("2026-10-07T14:05:00")).toBe(Date.UTC(2026, 9, 7, 14, 5))
		expect(instant("2026-10-07T14:05:00+02:00")).toBe(Date.UTC(2026, 9, 7, 12, 5))
		expect(instant("2026-10-07T14:05:00Z")).toBe(Date.UTC(2026, 9, 7, 14, 5))
	})
})
