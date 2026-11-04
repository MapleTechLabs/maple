import { formatPercent } from "@maple/ui/lib/format"
import type { HtmlBuilder } from "foldkit/html"
import { click, expect as expectView, given, role, scene, text, within } from "foldkit/scene"
import { describe, test } from "vitest"
import type { HostRow } from "./model"
import { hostTable } from "./view-table"

// Rows are cached per host: a second frame must still show what changed and keep what did not.

type Model = ReadonlyArray<HostRow>
type Message = "Refetched"

const host = (hostName: string, cpuPct: number): HostRow => ({
	hostName,
	osType: "linux",
	hostArch: "amd64",
	cloudProvider: "aws",
	lastSeen: "2026-10-01 12:00:00",
	cpuPct,
	memoryPct: 0.2,
	diskPct: 0.2,
	load15: 0.5,
})

const steady = host("steady", 0.11)
const first: Model = [host("busy", 0.42), steady]
// A refetch: `busy` is a new row with new values, `steady` the same row.
const refetched: Model = [host("busy", 0.87), steady]

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.div(
		[],
		[
			h.button([h.OnClick("Refetched")], ["Refetch"]),
			hostTable(h, model, {
				nowMs: Date.parse("2026-10-01T12:00:00Z"),
				timeZone: "UTC",
				isWaiting: false,
				sort: { key: null, dir: "desc" },
			}),
		],
	)

describe("hostTable", () => {
	test("a refetched host re-renders its new values while an unchanged row stays", () => {
		scene(
			{ update: (_model: Model, _message: Message) => ({ model: refetched, commands: [] }), view },
			given(first),
			expectView(within(role("link", { name: /busy/ }), text(formatPercent(0.42)))).toExist(),
			click(role("button", { name: "Refetch" })),
			expectView(within(role("link", { name: /busy/ }), text(formatPercent(0.87)))).toExist(),
			expectView(within(role("link", { name: /busy/ }), text(formatPercent(0.42)))).not.toExist(),
			expectView(within(role("link", { name: /steady/ }), text(formatPercent(0.11)))).toExist(),
		)
	})
})
