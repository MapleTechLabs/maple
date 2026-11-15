import { OrgId } from "@maple/domain"
import {
	CloudCostPersistenceError,
	type CostBudget,
	CostBudgetForbiddenError,
	CostBudgetInvalidError,
	CostBudgetNotFoundError,
	LimitedRoleError,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option, Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import {
	budgetDestinationsOf,
	budgetFormOptions,
	budgetsOf,
	FINANCE_CHANNEL_ID,
} from "../../../lab/cost-budgets-fixture"
import { AppRoute } from "../../../route"
import type { CostBudgetNewSearch } from "../../../route/search"
import { type PageContext, PageOutMessage } from "../../contract"
import { budgetsHref } from "../kit/budget-format"
import { SaveBudget } from "./command"
import { formIssues, scopeItemOf, scopeItemValue, wirePayload } from "./derive"
import { Message, type Model } from "./model"
import { enter, update } from "./update"
import { view as pageView } from "./view"

const ORG = "org_acme"
const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.UTC(2026, 10, 16, 10, 0)
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const ENGINEER = Policy.grantsOf(["org:engineer"])
const MEMBER = Policy.grantsOf(["org:member"])

/** The hosted product: the session, not the build, says who may write a budget. */
const init = (search: CostBudgetNewSearch = {}) => enter(AppRoute.CostBudgetNew({ search }), context, true)

const fold = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	Arr.reduce(messages, model, (current, toMessage) => pageUpdate(current, toMessage(current)).model)

const grantsRead = (grants: ReadonlyArray<Policy.Permission>) => () =>
	Message.CompletedReadGrants({ orgId: ORG, grants: [...grants] })
const destinations = () =>
	Message.UpdatedDestinations({ orgId: ORG, rows: [...budgetDestinationsOf(ORG, NOW)] })
const options = () => Message.CompletedFetchOptions({ result: Result.succeed(budgetFormOptions) })
const typed = (field: "name" | "amount", value: string) => () => Message.ChangedText({ field, value })

/** The new-budget editor as an engineer sees it, once its reads answered. */
const fresh = (search: CostBudgetNewSearch = {}): Model =>
	fold(init(search).model, [grantsRead(ENGINEER), destinations, options])

/** One of the fixture's budgets as `get` answers it: without where it stands. */
const stored = (index: number): CostBudget => {
	const { progress: _, ...budget } = Option.getOrThrow(Arr.get(budgetsOf(NOW).budgets, index))
	return budget
}

const EDITED = stored(1)

const existing = (result: Result.Result<CostBudget, ReturnType<typeof toLoadFailure>>) => (model: Model) =>
	Message.CompletedFetchExisting({ key: model.existing.key ?? "", result })

/** The editor on a budget, once it was read; the fixture's "AWS production" unless told. */
const editing = (budget: CostBudget = EDITED): Model =>
	fold(init({ budgetId: budget.id }).model, [
		grantsRead(ENGINEER),
		destinations,
		options,
		existing(Result.succeed(budget)),
	])

const optionsFailed = () =>
	Message.CompletedFetchOptions({
		result: Result.fail(
			toLoadFailure(new CloudCostPersistenceError({ message: "Cost could not be read" })),
		),
	})

const create = role("button", { name: "Create budget" })

describe("cost budget editor", () => {
	test("a new budget reads what it can offer, and no budget", () => {
		expect(names(init().commands)).toContain("FetchCostBudgetFormOptions")
		expect(names(init().commands)).not.toContain("FetchCostBudget")
	})

	test("an edit also reads the budget it is on", () => {
		expect(names(init({ budgetId: EDITED.id }).commands)).toContain("FetchCostBudget")
	})

	// All spend, monthly, a warning on the forecast and a critical on the spend: only a name and
	// an amount are missing.
	test("a new budget starts with both alerts on and says what still blocks saving", () => {
		const model = fresh()

		expect(formIssues(model.form)).toEqual(["Name the budget.", "Set an amount above zero."])
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("heading", { name: "New budget" })).toExist(),
			expectView(text("All spend in the budget's currency")).toExist(),
			expectView(role("switch", { name: "Open a warning incident" })).toHaveAttr(
				"aria-checked",
				"true",
			),
			expectView(role("switch", { name: "Open a critical incident" })).toHaveAttr(
				"aria-checked",
				"true",
			),
			expectView(text("Name the budget.")).toExist(),
			expectView(create).toBeDisabled(),
		)
	})

	test("a new budget takes the currency most of the org's cost is in, and an edit keeps its own", () => {
		const euros = { ...budgetFormOptions, currency: "EUR" }
		const answered = (model: Model) =>
			pageUpdate(model, Message.CompletedFetchOptions({ result: Result.succeed(euros) })).model

		expect(answered(init().model).form.currency).toBe("EUR")
		expect(answered(editing()).form.currency).toBe("USD")
	})

	test("a link from the Cost page opens the editor on the slice it was filtered to", () => {
		const model = fresh({ provider: ["aws"], region: ["us-east-1"] })

		expect(Option.getOrThrow(wirePayload({ ...model.form, name: "x", amount: "1" })).filters).toEqual({
			provider: ["aws"],
			region: ["us-east-1"],
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Provider: AWS")).toExist(),
			expectView(text("Region: us-east-1")).toExist(),
			expectView(role("button", { name: "Remove Provider: AWS" })).toExist(),
		)
	})

	test("removing a filter widens the slice, and a menu pick names its dimension and value", () => {
		const model = fresh({ provider: ["aws"], region: ["us-east-1"] })
		const removed = pageUpdate(model, Message.RemovedScope({ dimension: "provider", value: "aws" })).model

		expect(removed.form.scope.provider).toEqual([])
		expect(removed.form.scope.region).toEqual(["us-east-1"])
		// A service's own name can hold a colon: only the first one splits.
		expect(scopeItemOf(scopeItemValue("cloud_service", "Amazon EC2: Compute"))).toEqual(
			Option.some({ dimension: "cloud_service", value: "Amazon EC2: Compute" }),
		)
		expect(scopeItemOf("planet:earth")).toEqual(Option.none())
	})

	test("an alert says in money when it opens", () => {
		scene(
			{ update: pageUpdate, view },
			given(fold(fresh(), [typed("amount", "2000")])),
			expectView(text(/Opens when the month's forecast reaches \$2,000\.00\./u)).toExist(),
			expectView(text("Opens when the spend reaches $2,000.00.")).toExist(),
			expectView(text(/\$2,000\.00 per calendar month, in UTC/u)).toExist(),
		)
	})

	test("saving sends the form as the API takes it, with only the alerts that are on", () => {
		const filled = fold(fresh({ provider: ["aws"] }), [
			typed("name", "  AWS production  "),
			typed("amount", "6000"),
			() => Message.PickedPeriod({ period: "quarter" }),
			() => Message.ChangedPercent({ severity: "warning", value: "80" }),
			() => Message.PickedBasis({ severity: "warning", basis: "actual" }),
			() => Message.ToggledAlert({ severity: "critical" }),
		])
		const saving = pageUpdate(filled, Message.ClickedSave())

		expect(saving.model.isSaving).toBe(true)
		expect(saving.commands).toMatchObject([
			{
				name: SaveBudget.name,
				args: {
					editingId: null,
					payload: {
						name: "AWS production",
						enabled: true,
						amount: 6000,
						currency: "USD",
						period: "quarter",
						metric: "billed",
						filters: { provider: ["aws"] },
						alerts: [{ severity: "warning", percent: 80, basis: "actual", destinationIds: [] }],
					},
				},
			},
		])
		// A second press while the save is out sends nothing.
		expect(pageUpdate(saving.model, Message.ClickedSave()).commands ?? []).toEqual([])
		// Nor can the form change under it: the save's answer would replace what was typed.
		scene(
			{ update: pageUpdate, view },
			given(saving.model),
			expectView(role("textbox", { name: "Name" })).toBeDisabled(),
			expectView(role("textbox", { name: "Amount" })).toBeDisabled(),
			expectView(role("button", { name: "Yearly" })).toBeDisabled(),
			expectView(role("switch", { name: "Open a warning incident" })).toHaveAttr(
				"aria-disabled",
				"true",
			),
		)
	})

	test("a budget needs an alert, and an alert that is on needs a percent the API takes", () => {
		const base = fold(fresh(), [typed("name", "Everything"), typed("amount", "100")])
		const bothOff = fold(base, [
			() => Message.ToggledAlert({ severity: "warning" }),
			() => Message.ToggledAlert({ severity: "critical" }),
		])
		const badPercent = fold(base, [() => Message.ChangedPercent({ severity: "critical", value: "0" })])

		expect(formIssues(base.form)).toEqual([])
		expect(formIssues(bothOff.form)).toEqual(["Turn on at least one alert."])
		expect(formIssues(badPercent.form)).toEqual(["Set the critical alert from 1% to 1,000%."])
		expect(pageUpdate(bothOff, Message.ClickedSave()).commands ?? []).toEqual([])
		// Off, the same bad percent blocks nothing: it is not sent.
		expect(
			formIssues(fold(badPercent, [() => Message.ToggledAlert({ severity: "critical" })]).form),
		).toEqual([])
	})

	test("an amount that is not a positive number is refused before the API is asked", () => {
		const issuesOf = (amount: string) =>
			formIssues(fold(fresh(), [typed("name", "x"), typed("amount", amount)]).form)
		const saidOf = (amounts: ReadonlyArray<string>) =>
			Arr.dedupe(Arr.map(amounts, (amount) => Arr.join(issuesOf(amount), " ")))

		expect(saidOf(["", "0", "0.00"])).toEqual(["Set an amount above zero."])
		expect(saidOf(["-20", "12,000", "abc"])).toEqual([
			"Write the amount as a plain number, like 1000 or 49.50.",
		])
		// As a decimal keypad types it, a leading or trailing point included.
		expect(saidOf(["49.50", ".5", "1."])).toEqual([""])
		// Above the API's cap the amount is a number: the form says what is wrong with it.
		expect(
			formIssues(fold(fresh(), [typed("name", "x"), typed("amount", "2000000000000")]).form),
		).toEqual(["Keep the amount to a trillion or less."])
	})

	test("a link that prefills more values than the API takes is refused before it is asked", () => {
		const provider = Arr.makeBy(51, (index) => `provider-${index}`)
		const model = fold(fresh({ provider }), [typed("name", "x"), typed("amount", "1")])

		expect(formIssues(model.form)).toEqual(["Keep each filter to 50 values of at most 300 characters."])
		expect(pageUpdate(model, Message.ClickedSave()).commands ?? []).toEqual([])
	})

	// Until the currencies answer a new budget would be created in a guess.
	test("a new budget waits for the org's currencies, and an edit does not", () => {
		const waiting = fold(init().model, [grantsRead(ENGINEER), typed("name", "x"), typed("amount", "1")])

		expect(pageUpdate(waiting, Message.ClickedSave()).commands ?? []).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(waiting),
			expectView(text("Wait for the org's currencies to load.")).toExist(),
			expectView(create).toBeDisabled(),
		)
		expect(names(pageUpdate(fold(waiting, [options]), Message.ClickedSave()).commands)).toContain(
			SaveBudget.name,
		)
		const edit = fold(init({ budgetId: EDITED.id }).model, [
			grantsRead(ENGINEER),
			existing(Result.succeed(EDITED)),
		])
		expect(names(pageUpdate(edit, Message.ClickedSave()).commands)).toContain(SaveBudget.name)
	})

	test("a failed options read says so, reads again on request, and stops holding the form", () => {
		const failed = fold(init().model, [
			grantsRead(ENGINEER),
			typed("name", "x"),
			typed("amount", "1"),
			optionsFailed,
		])

		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't read the org's spend")).toExist(),
			expectView(text(/The currency is a guess \(USD\)/u)).toExist(),
			expectView(create).toBeEnabled(),
		)
		const retried = pageUpdate(failed, Message.ClickedRetryOptions())
		expect(names(retried.commands)).toContain("FetchCostBudgetFormOptions")
		scene(
			{ update: pageUpdate, view },
			given(fold(retried.model, [options])),
			expectView(text("Couldn't read the org's spend")).toBeAbsent(),
			expectView(create).toBeEnabled(),
		)
	})

	test("an edit saves the budget's own currency, metric and switch, not a new budget's", () => {
		const savedFrom = (budget: CostBudget) => pageUpdate(editing(budget), Message.ClickedSave()).commands

		expect(savedFrom({ ...stored(3), metric: "effective" })).toMatchObject([
			{ args: { payload: { currency: "EUR", metric: "effective", enabled: true, period: "quarter" } } },
		])
		expect(savedFrom(stored(4))).toMatchObject([
			{ args: { payload: { currency: "USD", metric: "billed", enabled: false, period: "year" } } },
		])
	})

	// The API takes two dimensions the form's menu does not offer.
	test("an edit shows and keeps the filters only the API can set", () => {
		const narrowed = {
			...EDITED,
			filters: { ...EDITED.filters, usage_type: ["BoxUsage"], service: ["checkout"] },
		} satisfies CostBudget
		const model = editing(narrowed)

		expect(Option.getOrThrow(wirePayload(model.form)).filters).toEqual(narrowed.filters)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Usage type: BoxUsage")).toExist(),
			expectView(role("button", { name: "Remove Telemetry service: checkout" })).toExist(),
		)
	})

	test("an answer to another read of the budget is dropped", () => {
		const model = fold(init({ budgetId: EDITED.id }).model, [grantsRead(ENGINEER)])
		const stale = pageUpdate(
			model,
			Message.CompletedFetchExisting({
				key: "another read",
				result: Result.succeed({ ...EDITED, name: "Someone else's" }),
			}),
		)

		expect(stale.model.form.name).toBe("")
		expect(stale.model.existing).toBe(model.existing)
	})

	test("an edit fills the form from the budget and saves it under its id", () => {
		const model = editing()

		expect(model.form).toMatchObject({
			name: "AWS production",
			amount: "6000",
			period: "month",
			scope: { provider: ["aws"], account: ["123456789012"] },
			alerts: {
				warning: {
					isOn: true,
					percent: "100",
					basis: "forecast",
					destinationIds: [FINANCE_CHANNEL_ID],
				},
				critical: { isOn: true, percent: "100", basis: "actual" },
			},
		})
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("heading", { name: "Edit budget" })).toExist(),
			expectView(text("#finance")).toExist(),
			expectView(role("button", { name: "Save changes" })).toBeEnabled(),
		)
		expect(pageUpdate(model, Message.ClickedSave()).commands?.[0]).toMatchObject({
			name: SaveBudget.name,
			args: { editingId: EDITED.id },
		})
	})

	// A budget with one alert reads back with the other off, not missing: it can be turned on.
	test("an alert the budget does not have is off, at a new budget's values", () => {
		const oneAlert = { ...EDITED, alerts: [EDITED.alerts[0]] } satisfies CostBudget
		const model = fold(init({ budgetId: EDITED.id }).model, [
			grantsRead(ENGINEER),
			existing(Result.succeed(oneAlert)),
		])

		expect(model.form.alerts.critical).toEqual({
			isOn: false,
			percent: "100",
			basis: "actual",
			destinationIds: [],
		})
	})

	test("a budget the org does not have, or an id that is not one, reads as not found", () => {
		const gone = fold(init({ budgetId: EDITED.id }).model, [
			grantsRead(ENGINEER),
			existing(
				Result.fail(
					toLoadFailure(
						new CostBudgetNotFoundError({ budgetId: EDITED.id, message: "Budget not found" }),
					),
				),
			),
		])
		const malformed = fold(init({ budgetId: "not-an-id" }).model, [grantsRead(ENGINEER)])

		Arr.forEach([gone, malformed], (model) =>
			scene(
				{ update: pageUpdate, view },
				given(model),
				expectView(text("Budget not found")).toExist(),
				expectView(role("link", { name: "Back to budgets" })).toHaveAttr("href", budgetsHref()),
			),
		)
		expect(names(init({ budgetId: "not-an-id" }).commands)).not.toContain("FetchCostBudget")
	})

	test("a member is told who can change budgets and is shown no form", () => {
		scene(
			{ update: pageUpdate, view },
			given(fold(init().model, [grantsRead(MEMBER)])),
			expectView(text("Only org admins and engineers can create or change budgets")).toExist(),
			expectView(create).toBeAbsent(),
		)
	})

	// An analyst holds no permission at all: an empty answer is a refusal, not a failed read.
	test("an analyst is refused like a member", () => {
		scene(
			{ update: pageUpdate, view },
			given(fold(init().model, [grantsRead(Policy.grantsOf(["org:analyst"]))])),
			expectView(text("Only org admins and engineers can create or change budgets")).toExist(),
			expectView(create).toBeAbsent(),
		)
	})

	test("a write the API refuses for the viewer's role replaces the form", () => {
		const filled = fold(fresh(), [typed("name", "x"), typed("amount", "1"), () => Message.ClickedSave()])
		const refusals = [
			new CostBudgetForbiddenError({ message: "Managing alerts needs the engineer role" }),
			new LimitedRoleError({ message: "Analysts cannot change the organization" }),
		]

		Arr.forEach(refusals, (refusal) =>
			scene(
				{ update: pageUpdate, view },
				given(
					fold(filled, [
						() => Message.CompletedSave({ result: Result.fail(toLoadFailure(refusal)) }),
					]),
				),
				expectView(text("Only org admins and engineers can create or change budgets")).toExist(),
				expectView(create).toBeAbsent(),
			),
		)
	})

	test("a save the API refuses stays on the form with the server's words, until the form changes", () => {
		const filled = fold(fresh(), [typed("name", "AWS production"), typed("amount", "100")])
		const refused = toLoadFailure(
			new CostBudgetInvalidError({
				message: "A budget or alert rule named 'AWS production' already exists; pick another name",
			}),
		)
		const failed = fold(filled, [
			() => Message.ClickedSave(),
			() => Message.CompletedSave({ result: Result.fail(refused) }),
		])

		expect(failed.isSaving).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't save the budget")).toExist(),
			expectView(text(/already exists; pick another name/u)).toExist(),
		)
		expect(fold(failed, [typed("name", "AWS production 2")]).saveFailure).toBeNull()
	})

	test("a saved budget goes back to the list with a word on what happened", () => {
		const saved = pageUpdate(
			fold(fresh(), [typed("name", "x"), typed("amount", "1"), () => Message.ClickedSave()]),
			Message.CompletedSave({ result: Result.succeed(EDITED) }),
		)

		expect(saved.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: budgetsHref(),
				isReplace: true,
				toast: { type: "success", title: "Budget created", description: "" },
			}),
		)
	})
})
