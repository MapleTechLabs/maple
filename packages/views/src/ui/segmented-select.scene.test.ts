import type { Html, HtmlBuilder } from "foldkit/html"
import { click, expect, given, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { segmentedSelect } from "./segmented-select"

type Kind = "http" | "tcp" | "dns"
type Model = Readonly<{ kind: Kind }>
type Message = Readonly<{ _tag: "Picked"; kind: Kind }>

const picked = (kind: Kind): Message => ({ _tag: "Picked", kind })

const update = (_model: Model, message: Message) => ({ model: { kind: message.kind }, commands: [] })

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	segmentedSelect(h, {
		ariaLabel: "Monitor type",
		value: model.kind,
		onChange: picked,
		options: [
			{ value: "http", label: "HTTP" },
			{ value: "tcp", label: "TCP" },
			{ value: "dns", label: "DNS", isDisabled: true },
		],
	})

const option = (name: string) => role("button", { name })

describe("segmented select", () => {
	test("every enabled option is a tab stop, so the keyboard can reach and pick each one", () => {
		scene(
			{ update, view },
			given({ kind: "http" }),
			expect(option("HTTP")).toHaveAttr("tabIndex", "0"),
			expect(option("TCP")).toHaveAttr("tabIndex", "0"),
			expect(option("DNS")).toHaveAttr("tabIndex", "-1"),
			click(option("TCP")),
			expect(option("TCP")).toHaveAttr("aria-pressed", "true"),
			expect(option("HTTP")).toHaveAttr("aria-pressed", "false"),
			expect(option("HTTP")).toHaveAttr("tabIndex", "0"),
		)
	})
})
