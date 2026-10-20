import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2Source } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { orderSources } from "../kit/shared"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const NOW = Date.UTC(2026, 9, 1, 12)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const source = (index: number, fields: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(V2Source)({
		id: encodePublicId(PublicIdPrefixes.source, `0199a0e1-0000-7000-8000-00000000000${index}`),
		object: "source",
		name: `Source ${index}`,
		description: null,
		platform: "nodejs",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: null,
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: null,
		created_at: "2026-09-01T12:00:00.000Z",
		updated_at: "2026-09-01T12:00:00.000Z",
		health: { status: "pending", last_data_at: null, problem: null, resources: null },
		...fields,
	})

const defaultSource = source(1, { name: "Default", platform: "opentelemetry", is_default: true, key_prefix: null })

const loaded = (rows: ReadonlyArray<V2Source>): Model => {
	const entered = init({ _tag: "Sources" }, context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed(rows) }),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("sources list", () => {
	test("entry reads the clock and the list", () => {
		expect(names(init({ _tag: "Sources" }, context).commands)).toEqual(["ReadSourcesClock", "FetchSourcesList"])
	})

	test("the default source is listed before the sources added ahead of it", () => {
		const added = source(2, { name: "Checkout" })
		expect(orderSources([added, defaultSource]).map(({ name }) => name)).toEqual(["Default", "Checkout"])
		scene(
			{ update: pageUpdate, view },
			given(loaded([added, defaultSource])),
			expectView(role("link", { name: "Default" })).toExist(),
			expectView(role("link", { name: "Checkout" })).toExist(),
		)
	})

	test("the default source alone shows the empty state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([defaultSource])),
			expectView(role("link", { name: "Default" })).toExist(),
			expectView(text("Org ingest keys")).toExist(),
			expectView(text("Connect your first source")).toExist(),
		)
	})

	test("an added source hides the empty state and opens on click", () => {
		const added = source(2, { health: { status: "healthy", last_data_at: "2026-10-01T11:56:00.000Z", problem: null, resources: null } })
		const model = loaded([added, defaultSource])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Connect your first source")).not.toExist(),
			expectView(text("Receiving")).toExist(),
		)
		const href = `/sources/${encodePublicId(PublicIdPrefixes.source, "0199a0e1-0000-7000-8000-000000000002")}`
		expect(pageUpdate(model, Message.ClickedSource({ url: href })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: href, isReplace: false }),
		)
	})

	test("a failure shows the error state and retry refreshes; a stale answer is dropped", () => {
		const entered = init({ _tag: "Sources" }, context).model
		const stale = pageUpdate(entered, Message.CompletedFetchList({ key: "other", result: Result.succeed([]) })).model
		expect(stale.list).toEqual(entered.list)
		const failed = [
			Message.ReadClock({ nowMs: NOW }),
			Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.fail(toLoadFailure(new Error("boom"))) }),
		].reduce((model, message) => pageUpdate(model, message).model, entered)
		scene({ update: pageUpdate, view }, given(failed), expectView(text("Couldn't load sources")).toExist())
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toEqual(["FetchSourcesList"])
	})
})

describe("integrations on the sources list", () => {
	const rows = [
		defaultSource,
		source(2, { name: "Checkout" }),
		source(3, { name: "node-exporter", platform: "prometheus", key_prefix: null }),
		source(4, { name: "GitHub acme", platform: "github", key_prefix: null }),
	]

	test("each row says how its data arrives", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			expectView(role("columnheader", { name: "Via" })).toExist(),
			expectView(text("Org ingest keys")).toExist(),
			expectView(text("maple_src_Q7xZa…")).toExist(),
			expectView(text("Scrape target")).toExist(),
			expectView(text("GitHub App")).toExist(),
		)
	})

	test("the kind filter narrows the table to integrations or OpenTelemetry sources", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			click(role("button", { name: /^Integrations/ })),
			expectView(role("link", { name: "node-exporter" })).toExist(),
			expectView(role("link", { name: "Checkout" })).not.toExist(),
			click(role("button", { name: /^OpenTelemetry/ })),
			expectView(role("link", { name: "Checkout" })).toExist(),
			expectView(role("link", { name: "GitHub acme" })).not.toExist(),
		)
	})

	test("integrations nothing comes from yet link to their connect step", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			expectView(role("link", { name: "Cloudflare" })).toHaveAttr(
				"href",
				"/sources/new?integration=cloudflare",
			),
			expectView(role("link", { name: "GitHub" })).not.toExist(),
		)
	})

	test("Needs attention narrows to the sources to fix, worst first, with a zone count", () => {
		const cloudflare = source(5, {
			name: "Cloudflare acme",
			platform: "cloudflare",
			key_prefix: null,
			health: {
				status: "failing",
				last_data_at: null,
				problem: "Token revoked",
				resources: { total: 3, unhealthy: 1 },
			},
		})
		const all = [...rows, cloudflare]
		expect(orderSources(all).map((row) => row.name)[1]).toBe("Cloudflare acme")
		scene(
			{ update: pageUpdate, view },
			given(loaded(all)),
			expectView(text("1 of 3 unhealthy")).toExist(),
			click(role("button", { name: /^Needs attention/ })),
			expectView(role("link", { name: "Cloudflare acme" })).toExist(),
			expectView(role("link", { name: "Checkout" })).not.toExist(),
		)
	})

	test("a filter that hides every source says so", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([defaultSource, source(2, { name: "Checkout" })])),
			click(role("button", { name: /^Integrations/ })),
			expectView(text("No sources match these filters.")).toExist(),
		)
	})
})
