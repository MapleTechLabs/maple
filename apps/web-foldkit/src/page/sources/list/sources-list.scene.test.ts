import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2Source } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
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
		health: { status: "pending", last_data_at: null, problem: null },
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

	test("the default source comes first and alone shows the empty state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([defaultSource])),
			expectView(role("link", { name: "Default" })).toExist(),
			expectView(text("Org ingest keys")).toExist(),
			expectView(text("Connect your first source")).toExist(),
		)
	})

	test("an added source hides the empty state and opens on click", () => {
		const added = source(2, { health: { status: "healthy", last_data_at: "2026-10-01T11:56:00.000Z", problem: null } })
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
