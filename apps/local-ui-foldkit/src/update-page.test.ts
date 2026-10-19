import { Option } from "effect"
import { AsyncData } from "foldkit"
import { fromString } from "foldkit/url"
import { describe, expect, test } from "vitest"
import { FetchSignalPresence, ProbeServer } from "./command"
import { init } from "./main"
import type { Model } from "./model"
import { PageOutMessage } from "./page/contract"
import { foldPageOut } from "./update-page"

const flags = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	rememberedRange: "1h",
	isSidebarOpen: true,
	isMobile: false,
	theme: "dark" as const,
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	hasSavedResults: false,
}
const url = Option.getOrThrow(fromString("http://localhost/#/traces"))

/** Settled: the first probe answered and a fresh presence read is on hand. */
const settled = (): Model => ({
	...init(flags, url).model,
	probe: { isInFlight: false, version: 1 },
	presence: AsyncData.Success({ data: { rows: [], nowMs: 1_000 } }),
})
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const argsOf = (commands: ReadonlyArray<{ readonly args?: unknown }> | undefined) => (commands ?? []).map(({ args }) => args)

describe("refresh in place", () => {
	test("re-probes the server, and the next empty state reads the presence again", () => {
		const refreshed = foldPageOut(settled(), PageOutMessage.RefetchedInPlace())
		expect(names(refreshed.commands)).toEqual([ProbeServer.name])
		const requested = foldPageOut(refreshed.model, PageOutMessage.RequestedSignalPresence())
		expect(names(requested.commands)).toEqual([FetchSignalPresence.name])
		expect(argsOf(requested.commands)).toEqual([{ apiBase: "", lastReadAtMs: null }])
	})

	test("without a refresh, a fresh presence read is offered for reuse", () => {
		const requested = foldPageOut(settled(), PageOutMessage.RequestedSignalPresence())
		expect(argsOf(requested.commands)).toEqual([{ apiBase: "", lastReadAtMs: 1_000 }])
	})
})
