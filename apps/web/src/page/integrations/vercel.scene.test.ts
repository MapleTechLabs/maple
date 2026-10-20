import { OrgId } from "@maple/domain"
import {
	VercelDiscoverResponse,
	VercelDrainStatus,
	VercelIntegrationStatus,
	VercelProjectStatus,
	VercelTeam,
} from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, within, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../ui/dialog"
import * as Field from "../../ui/field"
import * as RadioGroup from "../../ui/radio-group"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const step = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => step(current, message).model, model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const view = withViewInputs(pageView, { context })()

const ACME = new VercelTeam({ id: "team_acme", slug: "acme", name: "Acme" })
const LABS = new VercelTeam({ id: "team_labs", slug: "labs", name: "Labs" })
const PROJECTS = [
	{ id: "prj_web", name: "storefront", framework: "nextjs" },
	{ id: "prj_docs", name: "docs", framework: null },
]

const drain = (status: VercelDrainStatus["status"]) =>
	new VercelDrainStatus({ id: status === "missing" ? null : `drn_${status}`, status, lastError: null })

const connected = (fields: Partial<ConstructorParameters<typeof VercelIntegrationStatus>[0]> = {}) =>
	new VercelIntegrationStatus({
		connected: true,
		team: ACME,
		projectScope: "all",
		projectIds: [],
		samplingRate: 1,
		logsEnabled: true,
		tracesEnabled: true,
		drains: { logs: drain("enabled"), traces: drain("enabled") },
		projects: PROJECTS.map(
			(project) =>
				new VercelProjectStatus({ ...project, forwarded: true, productionDeployment: null, latestDeployment: null }),
		),
		authFailed: false,
		connectedAt: 0,
		lastSuccessAt: 0,
		lastError: null,
		...fields,
	})

const NOT_CONNECTED = new VercelIntegrationStatus({
	connected: false,
	team: null,
	projectScope: "all",
	projectIds: [],
	samplingRate: 1,
	logsEnabled: true,
	tracesEnabled: true,
	drains: { logs: null, traces: null },
	projects: [],
	authFailed: false,
	connectedAt: null,
	lastSuccessAt: null,
	lastError: null,
})

const withStatus = (status: VercelIntegrationStatus) => {
	const start = init({ search: { integration: "vercel" } }, context).model
	return step(start, Message.CompletedLoadVercel({ key: start.statuses.vercel.key ?? "", result: Result.succeed(status) }))
}

const configureOf = (model: Model) => {
	const configure = model.vercelCard.configure
	if (configure === null) throw new Error("the dialog is closed")
	return configure
}

const mounted = () => Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

const typed = (value: string) => Message.GotVercelTokenMessage({ message: Field.Message.ChangedValue({ value }) })

describe("vercel card: connecting", () => {
	test("token, team, settings, connect: each step sends once and the connection closes the dialog", () => {
		const opened = run(withStatus(NOT_CONNECTED).model, [
			Message.ClickedVercelConfigure({ target: "connect" }),
			typed("vc_token_0001"),
		])
		const lookedUp = step(opened, Message.SubmittedVercelToken())
		expect(names(lookedUp.commands)).toEqual(["DiscoverVercel"])
		expect(names(step(lookedUp.model, Message.SubmittedVercelToken()).commands)).toEqual([])

		const teams = run(lookedUp.model, [
			Message.CompletedVercelDiscover({
				forTeam: null,
				response: new VercelDiscoverResponse({ teams: [ACME, LABS], projects: [] }),
				error: null,
			}),
		])
		scene({ update: step, view }, given(teams), mounted(), expectView(text("Which team should Maple watch?")).toExist())

		const picked = run(teams, [
			Message.GotVercelTeamMessage({ message: RadioGroup.Message.SelectedRadio({ value: "team_acme" }) }),
		])
		const forTeam = step(picked, Message.SubmittedVercelTeam())
		expect(names(forTeam.commands)).toEqual(["DiscoverVercel"])
		const settings = run(forTeam.model, [
			Message.CompletedVercelDiscover({
				forTeam: "team_acme",
				response: new VercelDiscoverResponse({ teams: [ACME, LABS], projects: PROJECTS }),
				error: null,
			}),
		])
		scene({ update: step, view }, given(settings), mounted(), expectView(text("Creates 2 drains on Acme right away.")).toExist())

		const sent = step(settings, Message.SubmittedVercelConnect())
		expect(names(sent.commands)).toEqual(["ConnectVercel"])
		expect(names(step(sent.model, Message.SubmittedVercelConnect()).commands)).toEqual([])
		const done = step(sent.model, Message.CompletedVercelConnect({ mode: "connect", teamName: "Acme", error: null }))
		expect(done.model.vercelCard.configure).toBeNull()
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Connected Acme",
				description: "Vercel starts delivering within a minute.",
			}),
		)
		expect(names(done.commands)).toEqual(["LoadIntegrationsVercelStatus"])
	})

	test("a single team skips the team step; picking projects with none picked cannot connect", () => {
		const settings = run(withStatus(NOT_CONNECTED).model, [
			Message.ClickedVercelConfigure({ target: "connect" }),
			typed("vc_token_0001"),
			Message.SubmittedVercelToken(),
			Message.CompletedVercelDiscover({
				forTeam: null,
				response: new VercelDiscoverResponse({ teams: [ACME], projects: PROJECTS }),
				error: null,
			}),
			Message.ChangedVercelScope({ scope: "some" }),
		])
		expect(configureOf(settings).projects).toEqual(PROJECTS)
		expect(names(step(settings, Message.SubmittedVercelConnect()).commands)).toEqual([])
		const one = run(settings, [Message.ToggledVercelProject({ id: "prj_web" })])
		expect(names(step(one, Message.SubmittedVercelConnect()).commands)).toEqual(["ConnectVercel"])
	})

	test("a refused token stays on the token step with Vercel's reason; a token seeing no team says why", () => {
		const sent = run(withStatus(NOT_CONNECTED).model, [
			Message.ClickedVercelConfigure({ target: "connect" }),
			typed("vc_token_0001"),
			Message.SubmittedVercelToken(),
		])
		const refused = run(sent, [
			Message.CompletedVercelDiscover({ forTeam: null, response: null, error: "Vercel didn't accept this token." }),
		])
		expect(configureOf(refused).isLookingUp).toBe(false)
		scene({ update: step, view }, given(refused), mounted(), expectView(text("Vercel didn't accept this token.")).toExist())
		const teamless = run(sent, [
			Message.CompletedVercelDiscover({
				forTeam: null,
				response: new VercelDiscoverResponse({ teams: [], projects: [] }),
				error: null,
			}),
		])
		expect(configureOf(teamless).error).toBe("This token can't see any team. Create it with a team scope.")
	})
})

describe("vercel card: connected", () => {
	test("a healthy team reads the last 24 hours once and shows its drains", () => {
		const entered = withStatus(connected())
		expect(names(entered.commands)).toEqual(["LoadVercelProjects", "LoadVercelTimeseries", "LoadVercelGateway"])
		scene(
			{ update: step, view },
			given(entered.model),
			expectView(text("Drains on Vercel")).toExist(),
			expectView(text("Connected")).toExist(),
		)
		const again = step(
			entered.model,
			Message.CompletedLoadVercel({ key: entered.model.statuses.vercel.key ?? "", result: Result.succeed(connected()) }),
		)
		expect(names(again.commands)).toEqual([])
	})

	test("a drain deleted on Vercel offers a re-apply, which sends an empty settings save once", () => {
		const model = withStatus(connected({ drains: { logs: drain("missing"), traces: drain("enabled") } })).model
		scene(
			{ update: step, view },
			given(model),
			expectView(text("The logs drain was deleted on Vercel")).toExist(),
			expectView(role("button", { name: "Re-apply drains" })).toExist(),
		)
		const sent = step(model, Message.ClickedVercelReapply())
		expect(names(sent.commands)).toEqual(["SaveVercelSettings"])
		expect(names(step(sent.model, Message.ClickedVercelReapply()).commands)).toEqual([])
		const done = step(sent.model, Message.CompletedVercelSave({ isReapply: true, error: null }))
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Drains re-applied on Vercel", description: "" }),
		)
	})

	test("a rejected token asks for a new one, saved for the same team", () => {
		const model = withStatus(connected({ authFailed: true })).model
		scene(
			{ update: step, view },
			given(model),
			expectView(text("Vercel rejected the saved token")).toExist(),
			expectView(role("button", { name: "Paste a new token" })).toExist(),
		)
		const typedIn = run(model, [Message.ClickedVercelConfigure({ target: "token" }), typed("vc_token_0002")])
		expect(configureOf(typedIn).target).toBe("token")
		expect(names(step(typedIn, Message.SubmittedVercelToken()).commands)).toEqual(["ConnectVercel"])
	})

	test("the disconnect confirmation names only the drains Maple installed", () => {
		const model = run(withStatus(connected({ tracesEnabled: false, drains: { logs: drain("enabled"), traces: null } })).model, [
			Message.ClickedDisconnect(),
		])
		const dialog = role("alertdialog")
		scene(
			{ update: step, view },
			given(model),
			mounted(),
			expectView(within(dialog, text("Maple logs"))).toExist(),
			expectView(within(dialog, text("Maple traces"))).toBeAbsent(),
		)
		const done = step(
			step(model, Message.ConfirmedDisconnect()).model,
			Message.CompletedDisconnect({ integration: "vercel-drains-left", failure: null }),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "warning",
				title: "Remove the drains on Vercel",
				description: "Maple couldn't delete them. Delete Maple logs and Maple traces in the team's drain settings.",
			}),
		)
	})
})

describe("vercel card: configure", () => {
	const configured = (status: VercelIntegrationStatus) =>
		run(withStatus(status).model, [Message.ClickedVercelConfigure({ target: "configure" })])

	test("a change that forwards less asks first; confirming saves only what changed", () => {
		const draft = run(configured(connected()), [Message.ToggledVercelSignal({ signal: "tracesEnabled" })])
		const asked = step(draft, Message.ClickedVercelSave())
		expect(names(asked.commands)).not.toContain("SaveVercelSettings")
		expect(configureOf(asked.model).confirm.isOpen).toBe(true)
		const saved = step(asked.model, Message.ConfirmedVercelSave())
		expect(saved.commands?.find(({ name }) => name === "SaveVercelSettings")?.args).toEqual(
			expect.objectContaining({ request: expect.objectContaining({ tracesEnabled: false }) }),
		)
		const done = step(saved.model, Message.CompletedVercelSave({ isReapply: false, error: null }))
		expect(done.model.vercelCard.configure).toBeNull()
		expect(names(done.commands)).toEqual(["LoadIntegrationsVercelStatus"])
	})

	test("a change that forwards more applies at once; a refusal stays in the dialog", () => {
		const draft = run(configured(connected({ samplingRate: 0.5 })), [Message.ChangedVercelSampling({ value: "1" })])
		const sent = step(draft, Message.ClickedVercelSave())
		expect(names(sent.commands)).toEqual(["SaveVercelSettings"])
		const refused = step(sent.model, Message.CompletedVercelSave({ isReapply: false, error: "Vercel said no." }))
		expect(configureOf(refused.model).error).toBe("Vercel said no.")
		expect(configureOf(refused.model).isSaving).toBe(false)
	})

	test("nothing changed, nothing to save", () => {
		expect(names(step(configured(connected()), Message.ClickedVercelSave()).commands)).toEqual([])
	})
})
