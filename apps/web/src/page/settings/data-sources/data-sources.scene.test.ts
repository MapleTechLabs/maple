import { encodePublicId, PublicIdPrefixes, V2DataSource, V2DataSourceCatalog } from "@maple/domain/http/v2"
import { Array as Arr, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, scene, given, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { clerkInstanceOf, draftErrors } from "./draft"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as tabView } from "./view"
import { visibleErrors } from "./view-form"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const source = Schema.decodeSync(V2DataSource)({
	id: encodePublicId(PublicIdPrefixes.dataSource, "6f1c2a4e-8d3b-4c7a-9e21-3b5d7f9a1c2e"),
	object: "data_source",
	name: "shop-prod",
	kind: "clickhouse",
	query_language: "sql:clickhouse",
	description: "Production storefront database",
	environment: "production",
	tags: ["shop"],
	agent_access: true,
	agent_pii: false,
	connection: { type: "clickhouse", url: "https://ch.example.com:8443", user: "reader", database: "shop" },
	secret_hint: "9f2c",
	status: "error",
	last_checked_at: "2026-11-08T12:00:00.000Z",
	last_error: "connection refused",
	catalog_refreshed_at: null,
	catalog_error: null,
	catalog_entry_count: 0,
	created_at: "2026-11-08T12:00:00.000Z",
	updated_at: "2026-11-08T12:00:00.000Z",
})

const view = withViewInputs(tabView, {
	canManage: true,
	nowMs: Date.parse("2026-11-08T12:00:00Z"),
	timeZone: "UTC",
})()

const loaded = (sources: ReadonlyArray<V2DataSource>): Model =>
	update(init().model, Message.CompletedFetchSources({ result: Result.succeed(sources) })).model

const step = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, model, (current, message) => update(current, message).model)

const type = (field: "name" | "description" | "url" | "user" | "password" | "secretKey", value: string) =>
	Message.ChangedField({ field, value })

describe("data sources tab", () => {
	test("reads the list on entry and shows the empty state's list when there is none", () => {
		expect(names(init().commands)).toEqual(["FetchDataSources"])
		const empty = loaded([])
		expect(AsyncData.getOrElse(empty.sources, () => null)).toEqual([])
		expect(empty.screen._tag).toBe("List")
	})

	test("connect goes through the kind picker into an empty form", () => {
		const model = step(loaded([source]), Message.ClickedConnect(), Message.ClickedKind({ kind: "clerk" }))
		expect(model.screen).toEqual({ _tag: "Form", kind: "clerk", editing: null })
		expect(model.draft.name).toBe("")
	})

	test("a submit without a description or with a bad slug sends nothing and names both fields", () => {
		const form = step(loaded([]), Message.ClickedConnect(), Message.ClickedKind({ kind: "clickhouse" }))
		expect(visibleErrors(form, "clickhouse", false)).toEqual({})
		const filled = step(
			form,
			type("name", "Shop Prod"),
			type("url", "https://ch.example.com"),
			type("user", "reader"),
		)
		const submitted = update(filled, Message.ClickedSubmit())
		expect(names(submitted.commands)).toEqual([])
		const errors = visibleErrors(submitted.model, "clickhouse", false)
		expect(errors.name).toContain("lowercase")
		expect(errors.description).toContain("Assistants read it")
	})

	test("a valid ClickHouse form creates the source with the password and nothing blank", () => {
		const form = step(
			loaded([]),
			Message.ClickedKind({ kind: "clickhouse" }),
			type("name", "shop-prod"),
			type("description", "  Orders and payments "),
			type("url", "https://ch.example.com:8443"),
			type("user", "reader"),
			type("password", "s3cret"),
		)
		const submitted = update(form, Message.ClickedSubmit())
		expect(submitted.commands?.[0]).toMatchObject({
			name: "CreateDataSource",
			args: {
				payload: {
					name: "shop-prod",
					description: "Orders and payments",
					connection: {
						type: "clickhouse",
						url: "https://ch.example.com:8443",
						user: "reader",
						database: "default",
						password: "s3cret",
					},
				},
			},
		})
		expect(submitted.model.isSaving).toBe(true)
	})

	test("a Clerk key names its instance, and editing keeps the stored key when left blank", () => {
		expect(clerkInstanceOf("sk_live_abc")).toBe("production")
		expect(clerkInstanceOf("sk_test_abc")).toBe("development")
		expect(clerkInstanceOf("pk_live_abc")).toBeNull()
		const draft = { ...init().model.draft, name: "clerk-prod", description: "Users", secretKey: "" }
		expect(draftErrors(draft, "clerk", false).secretKey).toContain("sk_live_")
		expect(draftErrors(draft, "clerk", true).secretKey).toBeUndefined()
	})

	test("an edit without a new password sends no connection", () => {
		const form = step(
			loaded([source]),
			Message.ClickedEdit({ id: source.id }),
			type("description", "Orders only"),
		)
		const submitted = update(form, Message.ClickedSubmit())
		expect(submitted.commands?.[0]).toMatchObject({ name: "UpdateDataSource" })
		expect(submitted.commands?.[0]).not.toHaveProperty("args.payload.connection")
	})

	test("a failed connection keeps the form open with the source's message, a taken name lands on the field", () => {
		const form = step(loaded([]), Message.ClickedKind({ kind: "clickhouse" }))
		const failure = {
			_tag: "@maple/http/data-sources/DataSourceInvalidError",
			type: "invalid_request_error",
			code: "data_source_invalid",
			title: "Invalid data source",
			message: "Could not connect: connection refused",
			retryable: false,
			recovery: "fix_request",
			param: "connection",
		} as const
		const refused = update(form, Message.CompletedSave({ result: Result.fail(failure) })).model
		expect(refused.screen._tag).toBe("Form")
		expect(refused.saveError?.message).toBe("Could not connect: connection refused")
		const taken = update(
			form,
			Message.CompletedSave({
				result: Result.fail({ ...failure, message: "Name taken", param: "name" }),
			}),
		)
		expect(visibleErrors(taken.model, "clickhouse", false).name).toBe("Name taken")
	})

	test("opening a source reads its catalog, and a saved source opens with a toast", () => {
		expect(names(update(loaded([source]), Message.ClickedOpen({ id: source.id })).commands)).toEqual([
			"FetchDataSourceCatalog",
		])
		const saved = update(
			step(loaded([]), Message.ClickedKind({ kind: "clickhouse" })),
			Message.CompletedSave({ result: Result.succeed({ ...source, warnings: [] }) }),
		)
		expect(saved.model.screen).toEqual({ _tag: "Detail", id: source.id })
		expect(saved.outMessage).toMatchObject({ title: "Connected shop-prod" })
	})

	test("a connect whose test warns shows the warning on the source it opens", () => {
		const form = step(loaded([]), Message.ClickedConnect(), Message.ClickedKind({ kind: "clickhouse" }))
		const saved = update(
			form,
			Message.CompletedSave({
				result: Result.succeed({ ...source, warnings: ["This user can write"] }),
			}),
		).model
		expect(saved.screen).toEqual({ _tag: "Detail", id: source.id })
		scene(
			{ update, view },
			given(saved),
			expectView(text("Connected, with a warning")).toExist(),
			expectView(text("This user can write")).toExist(),
		)
	})

	test("an opened catalog entry lists a field's sample values", () => {
		const catalog = Schema.decodeSync(V2DataSourceCatalog)({
			object: "data_source_catalog",
			source_id: source.id,
			refreshed_at: null,
			error: null,
			entries: [
				{
					object: "data_source_catalog_entry",
					name: "shop.payments",
					kind: "table",
					exposed: true,
					note: null,
					row_estimate: null,
					time_field: null,
					fields: [
						{
							name: "status",
							type: "string",
							native_type: "LowCardinality(String)",
							note: null,
							pii: false,
							sample_values: ["paid", "refunded", "failed"],
						},
					],
				},
			],
		})
		const opened = step(
			loaded([source]),
			Message.ClickedOpen({ id: source.id }),
			Message.CompletedFetchCatalog({ result: Result.succeed(catalog) }),
			Message.ClickedEditEntry({ name: "shop.payments" }),
		)
		scene({ update, view }, given(opened), expectView(text("e.g. paid, refunded, failed")).toExist())
	})
})
