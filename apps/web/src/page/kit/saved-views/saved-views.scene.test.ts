import { SavedViewId, UserId } from "@maple/domain/http"
import type { SavedViewState } from "@maple/domain/saved-views"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { Array as Arr, Record as Rec, Result, Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { click, expect as expectView, given, Mount, role, scene, text, type } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { CreateView, DeleteView, FetchViews, RenameView, SetViewVisibility, UpdateViewState } from "./command"
import { activeViewOf, init, Message, type Model, OutMessage, type SavedView } from "./model"
import type { Explorer } from "./state"
import { ITEM, update, viewItem } from "./update"
import { control } from "./view"

const viewId = (suffix: string) =>
	Schema.decodeSync(SavedViewId)(`00000000-0000-4000-8000-0000000000${suffix}`)
const ANA = Schema.decodeSync(UserId)("user_ana")
const BEN = Schema.decodeSync(UserId)("user_ben")

type Search = SavedViewState["search"]

/** A stand-in explorer: its URL is its params, so two states match when their params do. */
const explorerOf = (search: Search): Explorer => ({
	surface: "logs",
	current: { search },
	hrefOf: (state) =>
		`/logs?${Arr.join(
			Arr.map(
				Rec.toEntries(state.search),
				([key, value]) => `${key}=${typeof value === "string" ? value : ""}`,
			),
			"&",
		)}`,
})

const ERRORS: Search = { severities: "ERROR", timePreset: "1h" }
const WARNINGS: Search = { severities: "WARN", timePreset: "1h" }
const CHECKOUT: Search = { services: "checkout" }

const saved = (suffix: string, name: string, search: Search, over: Partial<SavedView> = {}): SavedView => ({
	id: viewId(suffix),
	surface: "logs",
	name,
	state: { search },
	visibility: "private",
	ownerUserId: ANA,
	ownerName: null,
	isOwner: true,
	canDelete: true,
	createdAt: 0,
	updatedAt: 0,
	...over,
})

const MINE = saved("0a", "Errors", ERRORS)
const MINE_TOO = saved("0b", "Warnings", WARNINGS)
const THEIRS = saved("0c", "Checkout", CHECKOUT, {
	visibility: "org",
	ownerUserId: BEN,
	ownerName: "Ben Okafor",
	isOwner: false,
	canDelete: false,
})

const loaded = (views: ReadonlyArray<SavedView>, explorer: Explorer): Model =>
	update(
		init("views"),
		Message.CompletedFetchViews({ revision: 0, result: Result.succeed(views) }),
		explorer,
	).model

/** The menu, open, with its items addressable by value. */
const pick = (model: Model, value: string, explorer: Explorer, kind: "Item" | "Checkbox" = "Item") =>
	update(
		model,
		Message.GotMenuMessage({ message: Menu.Message.ClickedItem({ index: 0, item: { kind, value } }) }),
		explorer,
	)

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

/** What a step sends, as each Command's name and arguments. */
const sent = (commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined) =>
	Arr.map(commands ?? [], ({ name, args }) => ({ name, args }))

const sceneOf = (explorer: Explorer) => ({
	update: (model: Model, message: Message) => update(model, message, explorer),
	view: (model: Model, h: HtmlBuilder<Message>) =>
		control(h, { slotId: "views", model, explorer, toMessage: (message) => message }),
})

/** The same Model with its menu open, as a click on the button leaves it. */
const menuOpen = (model: Model): Model => ({ ...model, menu: Menu.init(model.menu.id, { isOpen: true }) })

const mounted = Mount.resolve(Menu.MountMenu, Menu.Message.CompletedMountMenu())
/** A dialog on screen, open or still leaving. */
const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

describe("saved views control", () => {
	test("with no views the menu says what a view is and offers to save one", () => {
		const explorer = explorerOf(ERRORS)
		scene(
			sceneOf(explorer),
			given(menuOpen(loaded([], explorer))),
			mounted,
			expectView(role("button", { name: "Views" })).toExist(),

			expectView(text("A view keeps this page's filters and time range under a name.")).toExist(),
			expectView(role("menuitem", { name: "Save view…" })).toExist(),
			expectView(text("Your views")).not.toExist(),
		)
	})

	test("lists the viewer's own views, then shared ones with their owner", () => {
		const explorer = explorerOf({})
		scene(
			sceneOf(explorer),
			given(menuOpen(loaded([MINE, MINE_TOO, THEIRS], explorer))),
			mounted,

			expectView(text("Your views")).toExist(),
			expectView(text("Shared")).toExist(),
			expectView(role("menuitem", { name: "Errors" })).toExist(),
			expectView(role("menuitem", { name: "Warnings" })).toExist(),
			expectView(role("menuitem", { name: /Checkout\s*Ben Okafor/ })).toExist(),
		)
	})

	test("opening the menu reads the list again, and a failed refresh keeps the views it had", () => {
		const explorer = explorerOf({})
		const opened = update(
			loaded([MINE], explorer),
			Message.GotMenuMessage({ message: Menu.Message.ClickedTrigger() }),
			explorer,
		)
		expect(names(opened.commands)).toContain(FetchViews.name)
		const failed = update(
			opened.model,
			Message.CompletedFetchViews({ revision: 0, result: Result.fail(toLoadFailure("list down")) }),
			explorer,
		).model
		expect(Arr.map(failed.views ?? [], (view) => view.name)).toEqual(["Errors"])
	})

	test("a list read sent before a save does not undo it when it answers late", () => {
		const explorer = explorerOf(WARNINGS)
		// The menu's refresh is still out when the new view is saved.
		const refreshing = update(
			loaded([MINE], explorer),
			Message.GotMenuMessage({ message: Menu.Message.ClickedTrigger() }),
			explorer,
		).model
		const created = update(
			refreshing,
			Message.CompletedCreateView({ result: Result.succeed(MINE_TOO) }),
			explorer,
		).model
		const late = update(
			created,
			Message.CompletedFetchViews({ revision: 0, result: Result.succeed([MINE]) }),
			explorer,
		).model
		expect(Arr.map(late.views ?? [], (view) => view.name)).toEqual(["Errors", "Warnings"])
		expect(late.isLoading).toBe(false)
	})

	test("a first load that fails says so and offers to try again", () => {
		const explorer = explorerOf({})
		const failed = update(
			init("views"),
			Message.CompletedFetchViews({ revision: 0, result: Result.fail(toLoadFailure("list down")) }),
			explorer,
		).model
		scene(
			sceneOf(explorer),
			given(menuOpen(failed)),
			mounted,

			expectView(text("Couldn't load views")).toExist(),
			expectView(role("menuitem", { name: "Try again" })).toExist(),
		)
		expect(names(pick(failed, ITEM.retry, explorer).commands)).toContain(FetchViews.name)
	})

	test("the button names the view the page's params are, and marks it in the list", () => {
		const explorer = explorerOf(ERRORS)
		scene(
			sceneOf(explorer),
			given(menuOpen(loaded([MINE, MINE_TOO], explorer))),
			mounted,
			expectView(role("button", { name: "Errors" })).toExist(),
			expectView(text("Edited")).not.toExist(),

			expectView(role("menuitem", { name: "Errors" })).toHaveAttr("aria-current", "true"),
			expectView(role("menuitem", { name: "Warnings" })).not.toHaveAttr("aria-current", "true"),
			// Nothing to save: the params already are the view.
			expectView(role("menuitem", { name: "Save view…" })).not.toExist(),
			expectView(role("menuitem", { name: "Update view" })).not.toExist(),
		)
	})

	test("picking a view goes to its params and makes it the page's view", () => {
		const explorer = explorerOf({})
		const picked = pick(loaded([MINE, THEIRS], explorer), viewItem(THEIRS.id), explorer)
		expect(picked.outMessage).toEqual(
			OutMessage.OpenedView({ url: "/logs?services=checkout", search: THEIRS.state.search }),
		)
		expect(picked.model.activeViewId).toBe(THEIRS.id)
	})

	test("an opened view whose params were edited reads Edited, with update and save as new", () => {
		const model = pick(loaded([MINE], explorerOf(ERRORS)), viewItem(MINE.id), explorerOf(ERRORS)).model
		// The page moved on to other params; the view stays the page's view.
		const edited = explorerOf({ ...ERRORS, timePreset: "24h" })
		expect(activeViewOf(model, edited)).toEqual({ view: MINE, isModified: true })
		scene(
			sceneOf(edited),
			given(menuOpen(model)),
			mounted,
			expectView(role("button", { name: /Errors\s*Edited/ })).toExist(),

			expectView(role("menuitem", { name: "Update view" })).toExist(),
			expectView(role("menuitem", { name: "Save as new…" })).toExist(),
			expectView(role("menuitem", { name: "Discard changes" })).toExist(),
		)
		const updating = pick(model, ITEM.update, edited)
		expect(sent(updating.commands)).toEqual([
			{
				name: UpdateViewState.name,
				args: { viewId: MINE.id, state: { search: { ...ERRORS, timePreset: "24h" } } },
			},
		])
		const discarded = pick(model, ITEM.discard, edited)
		expect(discarded.outMessage).toEqual(
			OutMessage.OpenedView({
				url: "/logs?severities=ERROR&timePreset=1h",
				search: MINE.state.search,
			}),
		)
	})

	test("an updated view is the page's params again", () => {
		const start = pick(loaded([MINE], explorerOf(ERRORS)), viewItem(MINE.id), explorerOf(ERRORS)).model
		const edited = explorerOf(WARNINGS)
		const updating = pick(start, ITEM.update, edited).model
		const updated = update(
			updating,
			Message.CompletedUpdateView({
				action: "update",
				viewId: MINE.id,
				sharedBefore: null,
				result: Result.succeed({ ...MINE, state: { search: WARNINGS } }),
			}),
			edited,
		).model
		expect(activeViewOf(updated, edited)).toMatchObject({ isModified: false })
	})

	test("someone else's view can be saved as new, never updated, renamed or deleted", () => {
		const start = pick(loaded([THEIRS], explorerOf(CHECKOUT)), viewItem(THEIRS.id), explorerOf(CHECKOUT))
		const edited = explorerOf({ services: "cart" })
		scene(
			sceneOf(edited),
			given(menuOpen(start.model)),
			mounted,

			expectView(role("menuitem", { name: "Save as new…" })).toExist(),
			expectView(role("menuitem", { name: "Update view" })).not.toExist(),
			expectView(role("menuitem", { name: "Rename…" })).not.toExist(),
			expectView(role("menuitemcheckbox", { name: "Share with organization" })).not.toExist(),
			expectView(role("menuitem", { name: "Delete…" })).not.toExist(),
		)
		expect(pick(start.model, ITEM.update, edited).commands ?? []).toEqual([])
		expect(pick(start.model, ITEM.rename, edited).model.formDialog.isOpen).toBe(false)
		expect(pick(start.model, ITEM.delete, edited).model.deleteDialog.isOpen).toBe(false)
	})

	test("an org admin can delete a shared view they do not own", () => {
		const shared = { ...THEIRS, canDelete: true }
		const explorer = explorerOf(CHECKOUT)
		scene(
			sceneOf(explorer),
			given(menuOpen(loaded([shared], explorer))),
			mounted,

			expectView(role("menuitem", { name: "Delete…" })).toExist(),
			expectView(role("menuitem", { name: "Rename…" })).not.toExist(),
		)
	})

	test("saving stores the page's params under the typed name and names the button after it", () => {
		const explorer = explorerOf(WARNINGS)
		const opened = pick(loaded([MINE], explorer), ITEM.save, explorer).model
		scene(
			sceneOf(explorer),
			given(opened),
			dialogMounted,
			expectView(role("dialog", { name: "Save view" })).toExist(),
			expectView(role("button", { name: "Save view" })).toBeDisabled(),
			type(role("textbox", { name: "Name" }), "  Warnings  "),
			click(role("checkbox", { name: "Share with organization" })),
			expectView(role("button", { name: "Save view" })).toBeEnabled(),
		)
		const typed = update(
			update(opened, Message.ChangedName({ value: "  Warnings  " }), explorer).model,
			Message.ToggledShared(),
			explorer,
		).model
		const submitted = update(typed, Message.SubmittedForm(), explorer)
		expect(sent(submitted.commands)).toEqual([
			{
				name: CreateView.name,
				args: { surface: "logs", name: "Warnings", state: { search: WARNINGS }, visibility: "org" },
			},
		])
		const created = update(
			submitted.model,
			Message.CompletedCreateView({
				result: Result.succeed({ ...MINE_TOO, visibility: "org" }),
			}),
			explorer,
		).model
		expect(created.formDialog.isOpen).toBe(false)
		expect(Arr.map(created.views ?? [], (view) => view.name)).toEqual(["Errors", "Warnings"])
		scene(
			sceneOf(explorer),
			given(created),
			dialogMounted,
			expectView(role("button", { name: "Warnings" })).toExist(),
		)
	})

	test("a name the viewer already uses keeps the dialog open with the reason", () => {
		const explorer = explorerOf(WARNINGS)
		const opened = pick(loaded([MINE], explorer), ITEM.save, explorer).model
		const submitted = update(
			update(opened, Message.ChangedName({ value: "Errors" }), explorer).model,
			Message.SubmittedForm(),
			explorer,
		).model
		const refused = update(
			submitted,
			Message.CompletedCreateView({
				result: Result.fail(toLoadFailure('You already have a view named "Errors"')),
			}),
			explorer,
		).model
		expect(refused.formDialog.isOpen).toBe(true)
		scene(
			sceneOf(explorer),
			given(refused),
			dialogMounted,
			expectView(role("alert")).toExist(),
			expectView(role("textbox", { name: "Name" })).toHaveAttr("aria-invalid", "true"),
		)
		// Typing again clears the error.
		const retyped = update(refused, Message.ChangedName({ value: "Errors 2" }), explorer).model
		expect(retyped.form.error).toBeNull()
	})

	test("a blank name is never sent", () => {
		const explorer = explorerOf(WARNINGS)
		const opened = pick(loaded([], explorer), ITEM.save, explorer).model
		const blank = update(opened, Message.ChangedName({ value: "   " }), explorer).model
		expect(update(blank, Message.SubmittedForm(), explorer).commands ?? []).toEqual([])
	})

	test("renaming opens on the current name and lands the new one in the button and the list", () => {
		const explorer = explorerOf(ERRORS)
		const opened = pick(loaded([MINE, MINE_TOO], explorer), ITEM.rename, explorer).model
		scene(
			sceneOf(explorer),
			given(opened),
			dialogMounted,
			expectView(role("dialog", { name: "Rename view" })).toExist(),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Errors"),
			// Sharing is the menu's toggle, not part of a rename.
			expectView(role("checkbox", { name: "Share with organization" })).not.toExist(),
		)
		const submitted = update(
			update(opened, Message.ChangedName({ value: "Production errors" }), explorer).model,
			Message.SubmittedForm(),
			explorer,
		)
		expect(sent(submitted.commands)).toEqual([
			{ name: RenameView.name, args: { viewId: MINE.id, name: "Production errors" } },
		])
		const renamed = update(
			submitted.model,
			Message.CompletedRenameView({ result: Result.succeed({ ...MINE, name: "Production errors" }) }),
			explorer,
		).model
		expect(Arr.map(renamed.views ?? [], (view) => view.name)).toEqual(["Production errors", "Warnings"])
		scene(
			sceneOf(explorer),
			given(renamed),
			dialogMounted,
			expectView(role("button", { name: "Production errors" })).toExist(),
		)
	})

	test("an unchanged name closes the rename dialog without a request", () => {
		const explorer = explorerOf(ERRORS)
		const opened = pick(loaded([MINE], explorer), ITEM.rename, explorer).model
		const submitted = update(opened, Message.SubmittedForm(), explorer)
		expect(names(submitted.commands)).not.toContain(RenameView.name)
		expect(submitted.model.formDialog.isOpen).toBe(false)
	})

	test("sharing toggles at once and is undone by a fresh list when the write is refused", () => {
		const explorer = explorerOf(ERRORS)
		const toggled = pick(loaded([MINE], explorer), ITEM.share, explorer, "Checkbox")
		expect(sent(toggled.commands)).toEqual([
			{ name: SetViewVisibility.name, args: { viewId: MINE.id, visibility: "org" } },
		])
		expect(activeViewOf(toggled.model, explorer)?.view.visibility).toBe("org")
		// One write at a time: a second toggle waits for the first.
		expect(pick(toggled.model, ITEM.share, explorer, "Checkbox").commands ?? []).toEqual([])

		const refused = update(
			toggled.model,
			Message.CompletedUpdateView({
				action: "share",
				viewId: MINE.id,
				sharedBefore: "private",
				result: Result.fail(toLoadFailure("no")),
			}),
			explorer,
		)
		expect(names(refused.commands)).toEqual([FetchViews.name])
		expect(refused.outMessage).toMatchObject({ type: "error", title: "Couldn't change sharing" })
		// The toggle is undone at once, not left for the refresh to correct.
		expect(activeViewOf(refused.model, explorer)?.view.visibility).toBe("private")

		// A refresh that answered while the write was out already shows the stored value:
		// the refusal restores what was there before, it does not flip the row again.
		const refreshed = update(
			toggled.model,
			Message.CompletedFetchViews({ revision: toggled.model.revision, result: Result.succeed([MINE]) }),
			explorer,
		).model
		const refusedAfterRefresh = update(
			refreshed,
			Message.CompletedUpdateView({
				action: "share",
				viewId: MINE.id,
				sharedBefore: "private",
				result: Result.fail(toLoadFailure("no")),
			}),
			explorer,
		)
		expect(activeViewOf(refusedAfterRefresh.model, explorer)?.view.visibility).toBe("private")
	})

	test("deleting asks first, then removes the view and returns the button to Views", () => {
		const explorer = explorerOf(ERRORS)
		const shared: SavedView = { ...MINE, visibility: "org" }
		const asking = pick(loaded([shared, MINE_TOO], explorer), ITEM.delete, explorer).model
		scene(
			sceneOf(explorer),
			given(asking),
			dialogMounted,
			expectView(role("alertdialog", { name: 'Delete "Errors"?' })).toExist(),
			expectView(text("It is shared, so it goes away for everyone in the organization.")).toExist(),
		)
		const confirmed = update(asking, Message.ConfirmedDelete(), explorer)
		expect(sent(confirmed.commands)).toEqual([{ name: DeleteView.name, args: { viewId: MINE.id } }])
		// A second confirm while the first is out sends nothing.
		expect(update(confirmed.model, Message.ConfirmedDelete(), explorer).commands ?? []).toEqual([])

		const deleted = update(
			confirmed.model,
			Message.CompletedDeleteView({ viewId: MINE.id, result: Result.succeed(undefined) }),
			explorer,
		).model
		expect(deleted.deleteDialog.isOpen).toBe(false)
		expect(Arr.map(deleted.views ?? [], (view) => view.name)).toEqual(["Warnings"])
		scene(
			sceneOf(explorer),
			given(deleted),
			dialogMounted,
			expectView(role("button", { name: "Views" })).toExist(),
		)
	})

	test("a refused delete keeps the dialog open with the reason and the view in the list", () => {
		const explorer = explorerOf(ERRORS)
		const confirmed = update(
			pick(loaded([MINE], explorer), ITEM.delete, explorer).model,
			Message.ConfirmedDelete(),
			explorer,
		).model
		const refused = update(
			confirmed,
			Message.CompletedDeleteView({
				viewId: MINE.id,
				result: Result.fail(toLoadFailure("Only the owner or an org admin can delete this view")),
			}),
			explorer,
		).model
		expect(refused.deleteDialog.isOpen).toBe(true)
		expect(refused.deleteError).not.toBeNull()
		expect(Arr.map(refused.views ?? [], (view) => view.name)).toEqual(["Errors"])
	})

	test("an update answered after its view was deleted does not bring the view back", () => {
		const explorer = explorerOf(ERRORS)
		const start = loaded([MINE, MINE_TOO], explorer)
		const deleted = update(
			start,
			Message.CompletedDeleteView({ viewId: MINE.id, result: Result.succeed(undefined) }),
			explorer,
		).model
		const late = update(
			deleted,
			Message.CompletedUpdateView({
				action: "update",
				viewId: MINE.id,
				sharedBefore: null,
				result: Result.succeed(MINE),
			}),
			explorer,
		).model
		expect(Arr.map(late.views ?? [], (view) => view.name)).toEqual(["Warnings"])
	})

	test("an update that completes leaves the view the person picked meanwhile", () => {
		const explorer = explorerOf(WARNINGS)
		const onOther = pick(loaded([MINE, MINE_TOO], explorer), viewItem(MINE_TOO.id), explorer).model
		const settled = update(
			onOther,
			Message.CompletedUpdateView({
				action: "update",
				viewId: MINE.id,
				sharedBefore: null,
				result: Result.succeed(MINE),
			}),
			explorer,
		).model
		expect(settled.activeViewId).toBe(MINE_TOO.id)
	})
})
