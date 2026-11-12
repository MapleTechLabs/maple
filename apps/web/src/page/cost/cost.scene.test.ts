import { OrgId } from "@maple/domain"
import {
	CostBreakdownResponse,
	CostFilters,
	CostSourcesResponse,
	CostTimeseriesResponse,
	CostTotalsResponse,
	GithubCostInstallations,
	GithubCostSourceAdded,
	GithubCostSourceRemoved,
	OpenRouterCostKeyRemoved,
	OpenRouterCostKeySaved,
} from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { VcsInstallationId } from "@maple/domain/vcs"
import { CostSourceId } from "@maple/primitives"
import { Option, Record as Rec, Result, Schema, Array as Arr, String as Str } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../contract"
import * as TimeRangePicker from "../kit/time-range-picker"
import {
	chartRows,
	isUnderADay,
	keyLabel,
	previousPeriodOf,
	requestFilters,
	seriesLabels,
	withFilter,
} from "./derive"
import { Message } from "./message"
import type { Model, Search } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-12 00:00:00", endTime: "2026-11-10 14:30:00" }
const NOW = Date.UTC(2026, 10, 10, 14, 30)

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

type Sent = ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined
const names = (commands: Sent) => Arr.map(commands ?? [], ({ name }) => name)
/** What a read of the window carries; the grouping, order and limit only on the reads that take them. */
const ReadInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	filters: Schema.optionalKey(CostFilters),
	groupBy: Schema.optionalKey(Schema.String),
	sortBy: Schema.optionalKey(Schema.String),
	limit: Schema.optionalKey(Schema.Number),
})
const decodeArgs = Schema.decodeUnknownOption(Schema.Struct({ input: ReadInput }))

/** The input a named read was sent with. */
const inputOf = (commands: Sent, name: string): typeof ReadInput.Type | undefined =>
	Option.getOrUndefined(
		Option.flatMap(
			Arr.findFirst(commands ?? [], (command) => command.name === name),
			(command) => decodeArgs(command.args),
		),
	)?.input

type SourceWire = (typeof CostSourcesResponse.Encoded)["sources"][number]

const source = (over: Partial<SourceWire> = {}): SourceWire => ({
	id: "0190f2b3-0000-7000-8000-00000000c057",
	provider: "aws",
	connectionRef: "0190f2b3-0000-7000-8000-00000000a057",
	accountId: "123456789012",
	status: "ok",
	watermarkDate: "2026-11-09",
	backfillDate: "2025-10-01",
	historyComplete: true,
	lastSyncedAt: NOW - 3_600_000,
	lastError: null,
	lastErrorReason: null,
	requestsThisMonth: 86,
	...over,
})

const sources = (list: ReadonlyArray<SourceWire>) => Schema.decodeSync(CostSourcesResponse)({ sources: list })
const totals = (over: Partial<typeof CostTotalsResponse.Encoded> = {}) =>
	Schema.decodeSync(CostTotalsResponse)({
		cost: 1200,
		previousCost: 1000,
		estimatedDays: 2,
		currency: "USD",
		currencies: ["USD"],
		days: 30,
		...over,
	})
const timeseries = Schema.decodeSync(CostTimeseriesResponse)({
	days: ["2026-11-08", "2026-11-09"],
	series: [
		{ key: "north-1", other: false, total: 900, points: [440, 460] },
		{ key: "", other: false, total: 300, points: [150, 150] },
	],
	estimatedFrom: "2026-11-09",
	currency: "USD",
})
const breakdown = Schema.decodeSync(CostBreakdownResponse)({
	currency: "USD",
	rows: [
		{ key: "north-1", cost: 900, previousCost: 600 },
		{ key: "", cost: 300, previousCost: 400 },
	],
})

/** The page entered at `search`, its window resolved and its sources answered. */
const entered = (search: Search, list: ReadonlyArray<SourceWire>) => {
	const resolved = pageUpdate(
		init({ search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		resolved,
		Message.CompletedLoadSources({
			key: resolved.sources.key ?? "",
			result: Result.succeed(sources(list)),
		}),
	)
}

/** Every read of the window answered. */
const answered = (model: Model, totalsAnswer = totals()): Model =>
	Arr.reduce(
		[
			Message.CompletedLoadTotals({
				key: model.totals.key ?? "",
				result: Result.succeed(totalsAnswer),
			}),
			Message.CompletedLoadTimeseries({
				key: model.timeseries.key ?? "",
				result: Result.succeed(timeseries),
			}),
			Message.CompletedLoadBreakdown({
				key: model.breakdown.key ?? "",
				result: Result.succeed(breakdown),
			}),
		],
		model,
		(next, message) => pageUpdate(next, message).model,
	)

const OPENROUTER_SOURCE = Schema.decodeSync(CostSourceId)("0190f2b3-0000-7000-8000-00000000c060")
const GITHUB_SOURCE = Schema.decodeSync(CostSourceId)("0190f2b3-0000-7000-8000-00000000c061")
const GITHUB_ORG = Schema.decodeSync(VcsInstallationId)("0190f2b3-0000-4000-8000-00000000e061")
const GITHUB_LABS = Schema.decodeSync(VcsInstallationId)("0190f2b3-0000-4000-8000-00000000e062")

type InstallationWire = (typeof GithubCostInstallations.Encoded)["installations"][number]

/** An organization that is a source, one that can be added, a user account and a suspended one. */
const GITHUB_INSTALLATIONS: ReadonlyArray<InstallationWire> = [
	{
		installationId: GITHUB_ORG,
		accountLogin: "example-org",
		state: "added",
		settingsUrl: "https://github.com/organizations/example-org/settings/installations/1000001",
	},
	{
		installationId: GITHUB_LABS,
		accountLogin: "example-labs",
		state: "available",
		settingsUrl: "https://github.com/organizations/example-labs/settings/installations/1000002",
	},
	{
		installationId: "0190f2b3-0000-4000-8000-00000000e063",
		accountLogin: "example-user",
		state: "user_account",
		settingsUrl: "https://github.com/settings/installations/1000003",
	},
	{
		installationId: "0190f2b3-0000-4000-8000-00000000e064",
		accountLogin: "example-archive",
		state: "inactive",
		settingsUrl: "https://github.com/organizations/example-archive/settings/installations/1000004",
	},
]

/** The dialog's GitHub step with its installations read. */
const githubListed = (model: Model, installations: ReadonlyArray<InstallationWire>): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadGithubInstallations({
			result: Result.succeed(Schema.decodeSync(GithubCostInstallations)({ installations })),
		}),
	).model

const populated = (search: Search = { groupBy: "region" }, totalsAnswer = totals()): Model =>
	answered(entered(search, [source()]).model, totalsAnswer)

describe("cost page", () => {
	test("an org with no cost source gets the connect on-ramp and no warehouse read", () => {
		const step = entered({}, [])
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(text("No cost source yet")).toExist(),
			expectView(role("button", { name: "Add a cost source" })).toExist(),
			expectView(text("Group by")).not.toExist(),
			expectView(text("Sources")).not.toExist(),
		)
	})

	test("adding a source offers AWS through its connect flow and OpenRouter through a key form", () => {
		const opened = pageUpdate(entered({}, []).model, Message.ClickedAddSource()).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			resolveTheme,
			dialogMounted,
			expectView(text("Add a cost source")).toExist(),
			expectView(role("link", { name: /^AWS/ })).toHaveAttr("href", "/sources/new?integration=aws"),
			expectView(text(/AWS bills USD.0\.01 for each request Maple makes/)).toExist(),
			expectView(text(/OpenRouter and GitHub requests are free/)).toExist(),
			// An account already connected turns its Cost module on from the AWS integration.
			expectView(
				role("link", { name: "Turn on Cost for an AWS account that is connected" }),
			).toHaveAttr("href", "/integrations?integration=aws"),
			expectView(role("button", { name: /^OpenRouter/ })).toExist(),
			expectView(text("Management key")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(opened, Message.ClickedAddOpenRouter()).model),
			resolveTheme,
			dialogMounted,
			expectView(text("Add OpenRouter")).toExist(),
			expectView(text("Management key")).toExist(),
			expectView(role("link", { name: "Management keys" })).toHaveAttr(
				"href",
				"https://openrouter.ai/settings/management-keys",
			),
			// Nothing typed: there is nothing to save yet.
			expectView(role("button", { name: "Add source" })).toBeDisabled(),
			expectView(role("button", { name: "Back" })).toExist(),
		)
	})

	test("a saved key is sent trimmed; a refusal stays under the field until the key changes", () => {
		const form = pageUpdate(
			pageUpdate(entered({}, []).model, Message.ClickedAddSource()).model,
			Message.ClickedAddOpenRouter(),
		).model
		const typed = (model: Model, value: string) =>
			pageUpdate(model, Message.GotKeyDraftMessage({ message: Field.Message.ChangedValue({ value }) }))
				.model
		// Nothing typed sends nothing.
		expect(names(pageUpdate(form, Message.SubmittedKey()).commands)).toEqual([])

		const saving = pageUpdate(typed(form, "  sk-or-v1-regular-key-0123456789  "), Message.SubmittedKey())
		expect(saving.commands).toMatchObject([
			{ name: "SaveOpenRouterCostKey", args: { apiKey: "sk-or-v1-regular-key-0123456789" } },
		])
		// A key the request would refuse to carry is never sent, and the dialog says why.
		const oversized = pageUpdate(typed(form, `sk-or-v1-${Str.repeat(300)("a")}`), Message.SubmittedKey())
		expect(names(oversized.commands)).toEqual([])
		expect([oversized.model.sourceWrite, oversized.model.keyError]).toEqual([
			"Idle",
			"That is too long to be an OpenRouter key.",
		])
		// A second submit while the first is in flight sends nothing more.
		expect(names(pageUpdate(saving.model, Message.SubmittedKey()).commands)).toEqual([])

		const refused = pageUpdate(
			saving.model,
			Message.CompletedSaveKey({
				result: Result.fail({
					...toLoadFailure("refused"),
					message: "This is a regular API key. Reading spend needs a management key.",
				}),
			}),
		).model
		expect(refused.addDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			resolveTheme,
			dialogMounted,
			expectView(role("alert")).toHaveText(
				"This is a regular API key. Reading spend needs a management key.",
			),
		)
		expect(typed(refused, "sk-or-v1-management-key-0123456789").keyError).toBeNull()
	})

	test("a saved key closes the dialog, says when the sync runs and reads the sources again", () => {
		const form = pageUpdate(
			pageUpdate(entered({}, []).model, Message.ClickedAddSource()).model,
			Message.ClickedAddOpenRouter(),
		).model
		const saving = pageUpdate(
			pageUpdate(
				form,
				Message.GotKeyDraftMessage({
					message: Field.Message.ChangedValue({ value: "sk-or-v1-management-key-0123456789" }),
				}),
			).model,
			Message.SubmittedKey(),
		).model
		const saved = pageUpdate(
			saving,
			Message.CompletedSaveKey({
				result: Result.succeed(new OpenRouterCostKeySaved({ keyLabel: "sk-or-v1-man...789" })),
			}),
		)
		expect(saved.model.addDialog.isOpen).toBe(false)
		// The key does not outlive the dialog.
		expect(saved.model.keyDraft.value).toBe("")
		expect(names(saved.commands)).toContain("FetchCostSources")
		expect(saved.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "OpenRouter added",
				description: "The first sync runs within a few minutes.",
			}),
		)
	})

	test("an OpenRouter source is named by its account, bills no requests and can be replaced or removed", () => {
		const openRouter = source({
			id: "0190f2b3-0000-7000-8000-00000000c060",
			provider: "openrouter",
			accountId: "user_2openrouterAccount",
			backfillDate: "2026-10-13",
			requestsThisMonth: 0,
		})
		const model = answered(entered({}, [source(), openRouter]).model)
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("OpenRouter")).toExist(),
			expectView(text("user_2openrouterAccount")).toExist(),
			// Request billing is AWS's: one line for the AWS source, none for OpenRouter.
			expectView(text("86 provider requests this month (USD 0.86)")).toExist(),
			expectView(text(/0 provider requests/)).not.toExist(),
			expectView(role("link", { name: "Manage connection" })).toHaveAttr(
				"href",
				"/integrations?integration=aws",
			),
			expectView(role("button", { name: "Replace key" })).toExist(),
			expectView(role("button", { name: "Remove" })).toExist(),
		)

		// Replace opens the key form with no providers to go back to.
		const replacing = pageUpdate(model, Message.ClickedReplaceKey()).model
		scene(
			{ update: pageUpdate, view },
			given(replacing),
			resolveTheme,
			dialogMounted,
			expectView(text("Replace the OpenRouter key")).toExist(),
			expectView(role("button", { name: "Back" })).not.toExist(),
		)
		// The providers list a source that exists as added, with nothing to click.
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(model, Message.ClickedAddSource()).model),
			resolveTheme,
			dialogMounted,
			expectView(text("Already added")).toExist(),
			expectView(role("button", { name: /^OpenRouter/ })).not.toExist(),
		)

		const confirming = pageUpdate(
			model,
			Message.ClickedRemoveSource({ sourceId: OPENROUTER_SOURCE }),
		).model
		expect(confirming.removeDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(confirming),
			resolveTheme,
			dialogMounted,
			expectView(text("Remove the OpenRouter source?")).toExist(),
		)
		const removing = pageUpdate(confirming, Message.ClickedConfirmRemove())
		expect(names(removing.commands)).toEqual(["RemoveOpenRouterCostKey"])
		const removed = pageUpdate(
			removing.model,
			Message.CompletedRemoveKey({
				result: Result.succeed(new OpenRouterCostKeyRemoved({ removed: true })),
			}),
		)
		expect(removed.model.removeDialog.isOpen).toBe(false)
		// The reads name the org's sources: without reading them again the removed source's cost stays.
		expect(names(removed.commands)).toEqual(
			expect.arrayContaining([
				"FetchCostSources",
				"FetchCostTotals",
				"FetchCostTimeseries",
				"FetchCostBreakdown",
			]),
		)
		// The removed source's row is gone at once, and adding waits for the list read after the write.
		scene(
			{ update: pageUpdate, view },
			given(removed.model),
			resolveTheme,
			dialogMounted,
			expectView(text("user_2openrouterAccount")).not.toExist(),
			expectView(role("button", { name: "Replace key" })).not.toExist(),
			expectView(role("button", { name: "Add source" })).toBeDisabled(),
		)
		// That read failing brings no action back on the removed source: the list keeps without it.
		const refreshFailed = pageUpdate(
			removed.model,
			Message.CompletedLoadSources({
				key: removed.model.sources.key ?? "",
				result: Result.fail(toLoadFailure("unreachable")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(refreshFailed),
			resolveTheme,
			dialogMounted,
			expectView(text("123456789012")).toExist(),
			expectView(role("button", { name: "Replace key" })).not.toExist(),
			expectView(role("button", { name: "Add source" })).toBeEnabled(),
		)

		// A reload that was still in flight when the removal answered cannot answer for the re-read.
		const reloading = pageUpdate(removing.model, Message.ClickedReload()).model
		const staleKey = reloading.sources.key ?? ""
		const afterWrite = pageUpdate(
			reloading,
			Message.CompletedRemoveKey({
				result: Result.succeed(new OpenRouterCostKeyRemoved({ removed: true })),
			}),
		)
		expect(names(afterWrite.commands)).toContain("FetchCostSources")
		const stale = pageUpdate(
			afterWrite.model,
			Message.CompletedLoadSources({
				key: staleKey,
				result: Result.succeed(sources([source(), openRouter])),
			}),
		).model
		// The reload's list, read before the removal, is dropped: the page still waits for the new one.
		expect(stale.sourceWrite).toBe("Settling")

		// A key saved while the source exists replaces its key, and the toast says so.
		const replaced = pageUpdate(
			pageUpdate(
				pageUpdate(
					replacing,
					Message.GotKeyDraftMessage({
						message: Field.Message.ChangedValue({ value: "sk-or-v1-management-key-0123456789" }),
					}),
				).model,
				Message.SubmittedKey(),
			).model,
			Message.CompletedSaveKey({
				result: Result.succeed(new OpenRouterCostKeySaved({ keyLabel: "sk-or-v1-man...789" })),
			}),
		)
		expect(replaced.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "OpenRouter key replaced",
				description: "The next sync runs within a few minutes.",
			}),
		)
	})

	test("adding GitHub lists the org's installations: one to add, one added, and why the others cannot be", () => {
		const opened = pageUpdate(entered({}, [source()]).model, Message.ClickedAddSource()).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			resolveTheme,
			dialogMounted,
			expectView(role("button", { name: /^GitHub/ })).toExist(),
			expectView(text(/OpenRouter and GitHub requests are free/)).toExist(),
		)
		const reading = pageUpdate(opened, Message.ClickedAddGithub())
		expect(names(reading.commands)).toEqual(["FetchGithubCostInstallations"])
		scene(
			{ update: pageUpdate, view },
			given(reading.model),
			resolveTheme,
			dialogMounted,
			expectView(text("Add GitHub")).toExist(),
			expectView(text("Reading your GitHub organizations")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(githubListed(reading.model, GITHUB_INSTALLATIONS)),
			resolveTheme,
			dialogMounted,
			expectView(role("button", { name: "Add example-labs" })).toBeEnabled(),
			// The organization that is a source already has nothing to click.
			expectView(text("Added")).toExist(),
			expectView(role("button", { name: "Add example-org" })).not.toExist(),
			expectView(text("Only organization accounts have a billing report.")).toExist(),
			expectView(role("button", { name: "Add example-user" })).not.toExist(),
			expectView(text("Suspended or removed in GitHub. Reconnect it first.")).toExist(),
			expectView(role("link", { name: "Connect it to Maple" })).toHaveAttr(
				"href",
				"/sources/new?integration=github",
			),
			expectView(role("button", { name: "Back" })).toExist(),
		)
		// With no installation the step leads to the GitHub connect flow.
		scene(
			{ update: pageUpdate, view },
			given(githubListed(reading.model, [])),
			resolveTheme,
			dialogMounted,
			expectView(text("No GitHub organization is connected to Maple yet.")).toExist(),
			expectView(role("link", { name: "Connect GitHub" })).toHaveAttr(
				"href",
				"/sources/new?integration=github",
			),
		)
		// A list that could not be read says so, and can be asked for again.
		const unread = pageUpdate(
			reading.model,
			Message.CompletedLoadGithubInstallations({ result: Result.fail(toLoadFailure("unreachable")) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(unread),
			resolveTheme,
			dialogMounted,
			expectView(role("alert")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		expect(names(pageUpdate(unread, Message.ClickedAddGithub()).commands)).toEqual([
			"FetchGithubCostInstallations",
		])
	})

	test("a refused GitHub add stays in the dialog with the reason and the settings link; an accepted one closes it", () => {
		const listed = githubListed(
			pageUpdate(
				pageUpdate(entered({}, [source()]).model, Message.ClickedAddSource()).model,
				Message.ClickedAddGithub(),
			).model,
			GITHUB_INSTALLATIONS,
		)
		const adding = pageUpdate(
			listed,
			Message.ClickedAddGithubInstallation({ installationId: GITHUB_LABS }),
		)
		expect(adding.commands).toMatchObject([
			{ name: "AddGithubCostSource", args: { installationId: GITHUB_LABS } },
		])
		// A second click while the first add is in flight sends nothing more.
		expect(
			names(
				pageUpdate(
					adding.model,
					Message.ClickedAddGithubInstallation({ installationId: GITHUB_LABS }),
				).commands,
			),
		).toEqual([])

		const refused = pageUpdate(
			adding.model,
			Message.CompletedAddGithubSource({
				installationId: GITHUB_LABS,
				result: Result.fail({
					...toLoadFailure("refused"),
					message: "GitHub has not granted Maple access to billing yet.",
				}),
			}),
		).model
		expect(refused.addDialog.isOpen).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(refused),
			resolveTheme,
			dialogMounted,
			expectView(role("alert")).toContainText("GitHub has not granted Maple access to billing yet."),
			expectView(role("link", { name: "Open the GitHub App settings" })).toHaveAttr(
				"href",
				"https://github.com/organizations/example-labs/settings/installations/1000002",
			),
			expectView(role("button", { name: "Add example-labs" })).toBeEnabled(),
		)
		// Trying again takes the old reason away while GitHub is asked.
		const retrying = pageUpdate(
			refused,
			Message.ClickedAddGithubInstallation({ installationId: GITHUB_LABS }),
		)
		expect(retrying.model.githubRefusal).toBeNull()

		const added = pageUpdate(
			retrying.model,
			Message.CompletedAddGithubSource({
				installationId: GITHUB_LABS,
				result: Result.succeed(new GithubCostSourceAdded({ accountLogin: "example-labs" })),
			}),
		)
		expect(added.model.addDialog.isOpen).toBe(false)
		expect(names(added.commands)).toContain("FetchCostSources")
		expect(added.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "GitHub added",
				description: "The first sync of example-labs runs within a few minutes.",
			}),
		)
	})

	test("a GitHub source is named by its organization, bills no requests and can only be removed", () => {
		const github = source({
			id: GITHUB_SOURCE,
			provider: "github",
			connectionRef: GITHUB_ORG,
			accountId: "example-org",
			backfillDate: "2026-08-01",
			requestsThisMonth: 0,
		})
		const model = answered(entered({}, [source(), github]).model)
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("GitHub")).toExist(),
			expectView(text("example-org")).toExist(),
			expectView(text(/0 provider requests/)).not.toExist(),
			// It reads through the GitHub connection: there is no key to replace.
			expectView(role("button", { name: "Replace key" })).not.toExist(),
			expectView(role("button", { name: "Remove" })).toExist(),
		)

		const confirming = pageUpdate(model, Message.ClickedRemoveSource({ sourceId: GITHUB_SOURCE })).model
		scene(
			{ update: pageUpdate, view },
			given(confirming),
			resolveTheme,
			dialogMounted,
			expectView(text("Remove the GitHub source?")).toExist(),
			expectView(text(/stops reading the billed usage of example-org/)).toExist(),
			expectView(text(/no key is deleted/)).toExist(),
			expectView(text(/brings back the last three months/)).toExist(),
		)
		const removing = pageUpdate(confirming, Message.ClickedConfirmRemove())
		expect(removing.commands).toMatchObject([
			{ name: "RemoveGithubCostSource", args: { installationId: GITHUB_ORG } },
		])
		const removed = pageUpdate(
			removing.model,
			Message.CompletedRemoveGithubSource({
				result: Result.succeed(new GithubCostSourceRemoved({ removed: true })),
			}),
		)
		expect(removed.model.removeDialog.isOpen).toBe(false)
		expect(names(removed.commands)).toEqual(
			expect.arrayContaining([
				"FetchCostSources",
				"FetchCostTotals",
				"FetchCostTimeseries",
				"FetchCostBreakdown",
			]),
		)
		expect(removed.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "GitHub removed", description: "" }),
		)
		// Its row is gone at once, and the AWS source stays.
		scene(
			{ update: pageUpdate, view },
			given(removed.model),
			resolveTheme,
			dialogMounted,
			expectView(text("example-org")).not.toExist(),
			expectView(text("123456789012")).toExist(),
		)

		// A removal GitHub's source service could not make keeps the row and says so.
		const failed = pageUpdate(
			removing.model,
			Message.CompletedRemoveGithubSource({ result: Result.fail(toLoadFailure("unreachable")) }),
		)
		expect(failed.model.sourceWrite).toBe("Idle")
		expect(failed.outMessage).toMatchObject({ type: "error", title: "Couldn't remove the source" })
	})

	test("a view filtered to a provider compares with the period before when that provider's history reaches it", () => {
		const aws = Schema.decodeSync(CostSourcesResponse)({ sources: [source()] }).sources
		const both = Schema.decodeSync(CostSourcesResponse)({
			sources: [
				source(),
				source({
					id: "0190f2b3-0000-7000-8000-00000000c060",
					provider: "openrouter",
					backfillDate: "2026-10-13",
				}),
			],
		}).sources
		// OpenRouter keeps four weeks: the 30 days before the window are beyond its history.
		expect(previousPeriodOf(both, window, 30, {})).toBe("beyond")
		expect(previousPeriodOf(both, window, 30, { provider: ["openrouter"] })).toBe("beyond")
		expect(previousPeriodOf(both, window, 30, { provider: ["aws"] })).toBe("synced")
		expect(previousPeriodOf(aws, window, 30, {})).toBe("synced")
	})

	test("a member who may not manage integrations is offered no source action the API would refuse", () => {
		const openRouter = source({
			id: "0190f2b3-0000-7000-8000-00000000c060",
			provider: "openrouter",
			accountId: "user_2openrouterAccount",
		})
		const asMember = (model: Model) =>
			pageUpdate(model, Message.CompletedReadGrants({ grants: [] })).model
		scene(
			{ update: pageUpdate, view },
			given(asMember(answered(entered({}, [source(), openRouter]).model))),
			resolveTheme,
			// The sources still show how their sync is doing.
			expectView(text("user_2openrouterAccount")).toExist(),
			expectView(role("button", { name: "Add source" })).not.toExist(),
			expectView(role("button", { name: "Replace key" })).not.toExist(),
			expectView(role("button", { name: "Remove" })).not.toExist(),
			expectView(role("link", { name: "Manage connection" })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(asMember(entered({}, []).model)),
			resolveTheme,
			expectView(text("No cost source yet")).toExist(),
			expectView(text("Only organization admins and engineers can add a cost source.")).toExist(),
			expectView(role("button", { name: "Add a cost source" })).not.toExist(),
		)
		// Before the viewer's roles are known the page neither offers the button nor says who can add.
		scene(
			{ update: pageUpdate, view },
			given({ ...entered({}, []).model, grants: null }),
			resolveTheme,
			expectView(text("No cost source yet")).toExist(),
			expectView(text(/Only organization admins/)).not.toExist(),
			expectView(role("button", { name: "Add a cost source" })).not.toExist(),
		)
		// An engineer is offered them.
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					asMember(answered(entered({}, [openRouter]).model)),
					Message.CompletedReadGrants({ grants: Policy.grantsOf(["org:engineer"]) }),
				).model,
			),
			resolveTheme,
			expectView(role("button", { name: "Add source" })).toExist(),
			expectView(role("button", { name: "Replace key" })).toExist(),
		)
	})

	test("grouped by provider, a row reads the provider's name and filters by its id", () => {
		expect(keyLabel("provider", "openrouter")).toBe("OpenRouter")
		expect(keyLabel("provider", "aws")).toBe("AWS")
		expect(keyLabel("provider", "github")).toBe("GitHub")
		// A provider this build does not know still shows, as the rows name it.
		expect(keyLabel("provider", "somecloud")).toBe("somecloud")
		expect(requestFilters({ provider: ["openrouter"] })).toEqual({ provider: ["openrouter"] })
		// The chart's legend names the series the same way.
		expect(
			seriesLabels("provider", [
				{ key: "aws", other: false },
				{ key: "openrouter", other: false },
			]),
		).toEqual(["AWS", "OpenRouter"])
	})

	test("sources that have not synced yet say when the first sync runs, and list themselves", () => {
		const step = entered({}, [
			source({
				status: "pending",
				watermarkDate: null,
				backfillDate: null,
				historyComplete: false,
				lastSyncedAt: null,
				requestsThisMonth: 0,
			}),
		])
		expect(names(step.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(text("Waiting for the first sync")).toExist(),
			expectView(text(/The first sync runs within a few minutes/)).toExist(),
			expectView(text("123456789012")).toExist(),
			expectView(text("Waiting for first sync")).toExist(),
			expectView(text("Group by")).not.toExist(),
			// The first sync lands while the page is open: the sources can be read again from here.
			expectView(role("button", { name: "Reload" })).toExist(),
		)
		expect(names(pageUpdate(step.model, Message.ClickedReload()).commands)).toContain("FetchCostSources")
	})

	test("the wait says what each unsynced provider brings in, a failing AWS source included", () => {
		const unsynced = {
			watermarkDate: null,
			backfillDate: null,
			historyComplete: false,
			lastSyncedAt: null,
		}
		const openRouter = source({
			...unsynced,
			id: "0190f2b3-0000-7000-8000-00000000c060",
			provider: "openrouter",
			status: "pending",
		})
		const failingAws = source({
			...unsynced,
			status: "error",
			lastError: "AccessDeniedException",
			lastErrorReason: "not_ready",
		})
		scene(
			{ update: pageUpdate, view },
			given(entered({}, [openRouter]).model),
			resolveTheme,
			expectView(text(/It brings in the last four weeks, which is all OpenRouter keeps/)).toExist(),
		)
		// The AWS source failed its first pull and will bring in months when it retries.
		scene(
			{ update: pageUpdate, view },
			given(entered({}, [failingAws, openRouter]).model),
			resolveTheme,
			expectView(text("Waiting for the first sync")).toExist(),
			expectView(text(/AWS brings in this month and the last/)).toExist(),
			expectView(text(/OpenRouter brings in its last four weeks/)).toExist(),
		)
		// GitHub keeps a few months: this one and the last at once, then the two before.
		const github = source({
			...unsynced,
			id: GITHUB_SOURCE,
			provider: "github",
			accountId: "example-org",
			status: "pending",
		})
		scene(
			{ update: pageUpdate, view },
			given(entered({}, [github]).model),
			resolveTheme,
			expectView(text(/It brings in this month and the last, then the two months before/)).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(entered({}, [failingAws, github]).model),
			resolveTheme,
			expectView(text(/AWS brings in this month and the last/)).toExist(),
			expectView(
				text(/GitHub brings in this month and the last, then the two months before/),
			).toExist(),
		)
	})

	test("a synced source asks for the totals, the daily series and the breakdown of the window", () => {
		const step = entered({}, [source()])
		expect(inputOf(step.commands, "FetchCostTotals")).toEqual(window)
		expect(inputOf(step.commands, "FetchCostTimeseries")).toEqual({
			...window,
			groupBy: "cloud_service",
			limit: 8,
		})
		expect(inputOf(step.commands, "FetchCostBreakdown")).toMatchObject({
			groupBy: "cloud_service",
			sortBy: "cost",
		})
	})

	test("populated: the figures, the change as worse when cost rose, the rows and an empty key's placeholder", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated()),
			resolveTheme,
			expectView(text("$1,200.00")).toExist(),
			expectView(text("+$200.00")).toExist(),
			expectView(text("$40.00")).toExist(),
			expectView(text("against the 30 days before")).toExist(),
			expectView(
				text("The last 2 days are not final yet. The provider can still restate them."),
			).toExist(),
			expectView(text(/Lighter bars from Nov 9 are not final yet/)).toExist(),
			expectView(role("link", { name: "north-1" })).toExist(),
			expectView(text("$900.00")).toExist(),
			expectView(text("75%")).toExist(),
			expectView(text("No region")).toExist(),
			expectView(text("-$100.00")).toExist(),
			expectView(text("Synced through Nov 9")).toExist(),
			expectView(text("86 provider requests this month (USD 0.86)")).toExist(),
		)
	})

	test("a window with cost in several currencies shows one and names the others", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated({ groupBy: "region" }, totals({ currencies: ["USD", "EUR", "GBP"] }))),
			resolveTheme,
			expectView(
				text("Showing USD. This window also has cost in EUR, GBP, which is not added in."),
			).toExist(),
			expectView(text("$1,200.00")).toExist(),
		)
	})

	test("a row links to the view filtered to it; the chip removes the filter again", () => {
		const model = populated()
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(role("link", { name: "north-1" })).toHaveAttr(
				"href",
				"/cost?groupBy=region&region=%5B%22north-1%22%5D",
			),
			// The empty key filters too: its placeholder is only how it reads.
			expectView(role("link", { name: "No region" })).toHaveAttr(
				"href",
				"/cost?groupBy=region&region=%5B%22%22%5D",
			),
		)
		const filtered = routeChanged(model, { search: { groupBy: "region", region: ["north-1"] } }, context)
		// Figures, chart and table all read under the filter.
		expect(inputOf(filtered.commands, "FetchCostTimeseries")).toMatchObject({
			filters: { region: ["north-1"] },
		})
		expect(inputOf(filtered.commands, "FetchCostTotals")).toEqual({
			...window,
			filters: { region: ["north-1"] },
		})
		expect(inputOf(filtered.commands, "FetchCostBreakdown")).toMatchObject({
			filters: { region: ["north-1"] },
		})
		scene(
			{ update: pageUpdate, view },
			given(answered(filtered.model)),
			resolveTheme,
			// The filtered row has nothing left to add.
			expectView(role("link", { name: "north-1" })).not.toExist(),
			click(role("button", { name: "Remove filter: Region is north-1" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/cost?groupBy=region", isReplace: false }),
			),
		)
	})

	test("picking another grouping moves the URL, then re-reads the chart and the table, not the totals", () => {
		const model = populated({})
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			click(role("button", { name: "Usage type" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: "/cost?groupBy=usage_type", isReplace: false }),
			),
		)
		const regrouped = routeChanged(model, { search: { groupBy: "usage_type" } }, context)
		expect(names(regrouped.commands)).not.toContain("FetchCostTotals")
		expect(inputOf(regrouped.commands, "FetchCostTimeseries")).toMatchObject({
			groupBy: "usage_type",
			limit: 8,
		})
		expect(inputOf(regrouped.commands, "FetchCostBreakdown")).toMatchObject({ groupBy: "usage_type" })
	})

	test("sorting by change moves the URL, and the breakdown alone is read again in that order", () => {
		const model = populated()
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			click(role("button", { name: "Change" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/cost?groupBy=region&sort=change",
					isReplace: false,
				}),
			),
		)
		const sorted = routeChanged(model, { search: { groupBy: "region", sort: "change" } }, context)
		expect(names(sorted.commands)).toEqual(["FetchCostBreakdown"])
		expect(inputOf(sorted.commands, "FetchCostBreakdown")).toMatchObject({ sortBy: "change" })
	})

	test("reads that all fail show one error, and Try again asks for each of them", () => {
		const step = entered({}, [source()]).model
		const failure = Result.fail(toLoadFailure("api down"))
		const failed = Arr.reduce(
			[
				Message.CompletedLoadTotals({ key: step.totals.key ?? "", result: failure }),
				Message.CompletedLoadTimeseries({ key: step.timeseries.key ?? "", result: failure }),
				Message.CompletedLoadBreakdown({ key: step.breakdown.key ?? "", result: failure }),
			],
			step,
			(next, message) => pageUpdate(next, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			resolveTheme,
			expectView(text("Couldn't load cost")).toExist(),
			expectView(text("Couldn't load daily cost")).not.toExist(),
			// The sources still answer what is connected.
			expectView(text("123456789012")).toExist(),
		)
		const retried = names(pageUpdate(failed, Message.ClickedRetry()).commands)
		expect(retried).toContain("FetchCostTotals")
		expect(retried).toContain("FetchCostTimeseries")
		expect(retried).toContain("FetchCostBreakdown")
		// The sources answered: Try again leaves them alone.
		expect(retried).not.toContain("FetchCostSources")
	})

	test("a failed sources read shows the error, reads nothing more, and Try again asks for it", () => {
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model
		const failed = pageUpdate(
			resolved,
			Message.CompletedLoadSources({
				key: resolved.sources.key ?? "",
				result: Result.fail(toLoadFailure("api down")),
			}),
		)
		expect(names(failed.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			resolveTheme,
			expectView(text("Couldn't load cost")).toExist(),
			expectView(text("No cost source yet")).not.toExist(),
		)
		expect(names(pageUpdate(failed.model, Message.ClickedRetry()).commands)).toEqual(["FetchCostSources"])
	})

	test("a source whose sync fails shows the provider's error; a paused one says its history stays", () => {
		const step = entered({}, [
			source({ status: "error", lastError: "AccessDeniedException: not authorized" }),
			source({
				id: "0190f2b3-0000-7000-8000-00000000c058",
				accountId: "210987654321",
				status: "paused",
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(answered(step.model)),
			resolveTheme,
			expectView(text("Sync failing")).toExist(),
			expectView(text("AccessDeniedException: not authorized")).toExist(),
			expectView(text("This connection no longer supplies cost. Its history stays.")).toExist(),
		)
	})

	test("no change is shown against a period a source is still backfilling", () => {
		// The window starts Oct 12 and covers 30 days: the period before starts Sep 12.
		const backfilling = (backfillDate: string) =>
			answered(
				entered({ groupBy: "region" }, [
					source({ status: "syncing", historyComplete: false, backfillDate }),
				]).model,
			)
		scene(
			{ update: pageUpdate, view },
			given(backfilling("2026-10-01")),
			resolveTheme,
			expectView(text("The 30 days before are still syncing")).toExist(),
			expectView(text("+$200.00")).not.toExist(),
			expectView(text("+$300.00")).not.toExist(),
		)
		// History that reaches the start of the period before is enough, complete or not.
		scene(
			{ update: pageUpdate, view },
			given(backfilling("2026-09-01")),
			resolveTheme,
			expectView(text("+$200.00")).toExist(),
			expectView(text("The 30 days before are still syncing")).not.toExist(),
		)
	})

	test("no change is shown against a period older than the history a source has", () => {
		// The window starts Oct 12 and covers a year: the year before starts ahead of the history read.
		const model = answered(
			entered({ groupBy: "region" }, [source({ historyComplete: true, backfillDate: "2025-11-01" })])
				.model,
			totals({ days: 365 }),
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("The 365 days before start earlier than the history read")).toExist(),
			expectView(text("The 365 days before are still syncing")).not.toExist(),
			expectView(text("+$200.00")).not.toExist(),
			expectView(text("+$300.00")).not.toExist(),
		)
	})

	test("a paused source with cost and short history holds the comparison back; one that never synced does not", () => {
		const withPaused = (paused: Partial<SourceWire>) =>
			answered(
				entered({ groupBy: "region" }, [
					source(),
					source({ id: "0190f2b3-0000-7000-8000-00000000c058", status: "paused", ...paused }),
				]).model,
			)
		// The window starts Oct 12 and covers 30 days: the period before starts Sep 12.
		scene(
			{ update: pageUpdate, view },
			given(withPaused({ backfillDate: "2026-10-01", historyComplete: false })),
			resolveTheme,
			expectView(text("The 30 days before start earlier than the history read")).toExist(),
			expectView(text("+$200.00")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPaused({ backfillDate: null, watermarkDate: null, historyComplete: false })),
			resolveTheme,
			expectView(text("+$200.00")).toExist(),
		)
	})

	test("a key named like the folded tail or the empty placeholder keeps its own chart column", () => {
		const response = Schema.decodeSync(CostTimeseriesResponse)({
			days: ["2026-11-09"],
			series: [
				{ key: "Other", other: false, total: 5, points: [5] },
				{ key: "No region", other: false, total: 4, points: [4] },
				{ key: "", other: false, total: 3, points: [3] },
				{ key: "__other__", other: true, total: 2, points: [2] },
			],
			estimatedFrom: null,
			currency: "USD",
		})
		expect(chartRows(response, "region")).toEqual([
			{
				bucket: "2026-11-09T00:00:00Z",
				Other: 5,
				"No region": 4,
				"No region (empty)": 3,
				"Other (the rest)": 2,
			},
		])
		// Keys that spell the marked names too: every series still has a column of its own.
		const marked = Schema.decodeSync(CostTimeseriesResponse)({
			...Schema.encodeSync(CostTimeseriesResponse)(response),
			series: [
				...response.series,
				{ key: "Other (the rest)", other: false, total: 1, points: [1] },
				{ key: "No region (empty)", other: false, total: 1, points: [1] },
			],
		})
		expect(Rec.keys(chartRows(marked, "region")[0] ?? {})).toHaveLength(7)
	})

	test("a key named like a field of the chart row leaves the day and its open mark alone", () => {
		const response = Schema.decodeSync(CostTimeseriesResponse)({
			days: ["2026-11-09"],
			series: [
				{ key: "bucket", other: false, total: 5, points: [5] },
				{ key: "partial", other: false, total: 4, points: [4] },
			],
			// The day is still open to a restatement.
			estimatedFrom: "2026-11-09",
			currency: "USD",
		})
		expect(chartRows(response, "usage_type")).toEqual([
			{ bucket: "2026-11-09T00:00:00Z", "bucket (series)": 5, "partial (series)": 4, partial: true },
		])
	})

	test("the rows keep their currency when the totals read failed, and compare with nothing", () => {
		const step = entered({ groupBy: "region" }, [source()]).model
		const model = Arr.reduce(
			[
				Message.CompletedLoadTotals({
					key: step.totals.key ?? "",
					result: Result.fail(toLoadFailure("api down")),
				}),
				Message.CompletedLoadBreakdown({
					key: step.breakdown.key ?? "",
					result: Result.succeed(breakdown),
				}),
			],
			step,
			(next, message) => pageUpdate(next, message).model,
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("$900.00")).toExist(),
			// The totals carry the window's days: without them the period before cannot be checked.
			expectView(text("$600.00")).not.toExist(),
			expectView(text("+$300.00")).not.toExist(),
		)
	})

	test("a fraction of a cent of credit reads as zero, not as a negative zero", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated({ groupBy: "region" }, totals({ cost: -0.0004, previousCost: 0 }))),
			resolveTheme,
			expectView(text("-$0.00")).not.toExist(),
		)
	})

	test("a dimension never carries more filter values than the API accepts", () => {
		const full: Search = { region: Arr.makeBy(50, (index) => `region-${index}`) }
		// The fifty-first is not added: one more would make every read of the page a 400.
		expect(withFilter(full, { dimension: "region", value: "one-more" })).toEqual(full)
		expect(withFilter({}, { dimension: "region", value: Str.repeat(301)("a") })).toEqual({})
		// A hand-edited URL past the cap still reads: the request carries what the API takes.
		const edited: Search = { region: [...(full.region ?? []), "fifty-one", Str.repeat(301)("b")] }
		expect(requestFilters(edited)).toEqual({ region: full.region })
	})

	test("a typed range of hours is refused with a toast; one of days moves the URL", () => {
		const typed = (shorthand: string) => {
			const model = populated()
			return pageUpdate(
				{ ...model, timePicker: { ...model.timePicker, shorthand } },
				Message.GotTimePickerMessage({
					message: TimeRangePicker.Message.PressedShorthandEnter({}),
				}),
			).outMessage
		}
		expect(typed("3h")).toMatchObject({ _tag: "RequestedToast", title: "Cost is read per whole day" })
		expect(typed("4d")).toMatchObject({ _tag: "RequestedNavigation" })
	})

	test("a custom range under a day is short, a whole day and a calendar day are not", () => {
		const custom = (startTime: string, endTime: string) =>
			isUnderADay({ startTime, endTime, timePreset: undefined })
		expect(custom("2026-10-14 08:00:00", "2026-10-14 20:00:00")).toBe(true)
		expect(custom("2026-10-14 00:00:00", "2026-10-15 00:00:00")).toBe(false)
		// One day picked in the custom tab runs 00:00 to 23:59, and 22:59 long where clocks go forward.
		expect(custom("2026-10-14 00:00:00", "2026-10-14 23:59:00")).toBe(false)
		expect(custom("2026-03-29 00:00:00", "2026-03-29 22:59:00")).toBe(false)
		expect(isUnderADay({ startTime: undefined, endTime: undefined, timePreset: "today" })).toBe(false)
	})

	test("a range of hours in a hand-edited URL falls back to the default range", () => {
		expect(init({ search: { timePreset: "90m", groupBy: "region" } }, context).model.search).toEqual({
			groupBy: "region",
		})
		const hours: Search = { startTime: "2026-10-14 08:00:00", endTime: "2026-10-14 09:00:00" }
		expect(routeChanged(populated(), { search: hours }, context).model.search).toEqual({})
	})

	test("a changed time zone resolves the day window again before it reads anything", () => {
		// The presets are whole days in the reader's zone: the old window would be the wrong days.
		const moved: PageContext = { ...context, timeZone: "Pacific/Auckland" }
		expect(names(contextChanged(populated(), moved).commands)).toEqual(["ResolveCostWindow"])
	})

	test("a source held before its first pull is not called paused", () => {
		const step = entered({}, [
			source({
				status: "held",
				watermarkDate: null,
				backfillDate: null,
				lastSyncedAt: null,
				lastError: "Cloud cost is not enabled for this organization.",
				lastErrorReason: "rollout",
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(text("No cost read yet")).toExist(),
			expectView(text("The sync is on hold. The source below says why.")).toExist(),
			expectView(text("Cloud cost is not enabled for this organization.")).toExist(),
			expectView(text(/Each source below is paused/)).not.toExist(),
		)
	})

	test("a source the sync holds says why, and does not read as failing", () => {
		const step = entered({}, [
			source({
				status: "held",
				lastError: "This month's provider request budget is spent; pulls resume next month.",
				lastErrorReason: "budget",
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(answered(step.model)),
			resolveTheme,
			expectView(text("On hold")).toExist(),
			expectView(
				text("This month's provider request budget is spent; pulls resume next month."),
			).toExist(),
			expectView(text("Sync failing")).not.toExist(),
		)
	})
})
