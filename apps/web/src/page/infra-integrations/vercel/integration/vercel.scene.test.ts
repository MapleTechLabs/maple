import * as Animation from "@foldkit/ui/animation"
import { OrgId } from "@maple/domain"
import {
	VercelDiscoverResponse,
	VercelDrainStatus,
	VercelIntegrationStatus,
	VercelProjectStatus,
	VercelTeam,
} from "@maple/domain/http"
import { Array as Arr, Option, Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	text,
	within,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as RadioGroup from "@maple/views/ui/radio-group"
import { PageOutMessage, type PageContext } from "../../../contract"
import { Message } from "../../../integrations/message"
import { VercelMessage } from "./vercel"
import type { Model } from "../../../integrations/model"
import { init, update } from "../../../integrations/update"
import { view as pageView } from "../../../integrations/view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const step = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	Arr.reduce(messages, model, (current, message) => step(current, message).model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const view = withViewInputs(pageView, { context })()

const ACME = new VercelTeam({ id: "team_acme", slug: "acme", name: "Acme" })
const LABS = new VercelTeam({ id: "team_labs", slug: "labs", name: "Labs" })
const PROJECTS = [
	{ id: "prj_web", name: "storefront", framework: "nextjs" },
	{ id: "prj_docs", name: "docs", framework: null },
]

const drain = (status: VercelDrainStatus["status"]) =>
	new VercelDrainStatus({ id: status === "missing" ? null : `drn_${status}`, status, lastError: null })

type StatusFields = ConstructorParameters<typeof VercelIntegrationStatus>[0]

const connected = ({
	drains,
	...fields
}: Partial<Omit<StatusFields, "drains">> & { readonly drains?: Partial<StatusFields["drains"]> } = {}) =>
	new VercelIntegrationStatus({
		connected: true,
		team: ACME,
		projectScope: "all",
		projectIds: [],
		samplingRate: 1,
		logsEnabled: true,
		tracesEnabled: true,
		aiGatewayEnabled: true,
		speedInsightsEnabled: false,
		webAnalyticsEnabled: false,
		auditLogEnabled: false,
		drains: {
			logs: drain("enabled"),
			traces: drain("enabled"),
			aiGateway: drain("enabled"),
			speedInsights: null,
			webAnalytics: null,
			auditLog: null,
			...drains,
		},
		projects: Arr.map(
			PROJECTS,
			(project) =>
				new VercelProjectStatus({
					...project,
					forwarded: true,
					productionDeployment: null,
					latestDeployment: null,
				}),
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
	aiGatewayEnabled: true,
	speedInsightsEnabled: false,
	webAnalyticsEnabled: false,
	auditLogEnabled: false,
	drains: {
		logs: null,
		traces: null,
		aiGateway: null,
		speedInsights: null,
		webAnalytics: null,
		auditLog: null,
	},
	projects: [],
	authFailed: false,
	connectedAt: null,
	lastSuccessAt: null,
	lastError: null,
})

const withStatus = (status: VercelIntegrationStatus) => {
	const start = init({ search: { integration: "vercel" } }, context).model
	return step(
		start,
		Message.CompletedLoadVercel({ key: start.statuses.vercel.key ?? "", result: Result.succeed(status) }),
	)
}

const configureOf = (model: Model) => {
	const configure = model.vercelCard.configure
	if (configure === null) throw new Error("the dialog is closed")
	return configure
}

const mounted = () => Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

/** A dialog opened by a click: mounted, painted and settled. */
const opened = [
	mounted(),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

const typed = (value: string) =>
	Message.GotVercelMessage({
		message: VercelMessage.GotTokenMessage({ message: Field.Message.ChangedValue({ value }) }),
	})

describe("vercel card: connecting", () => {
	test("token, team, settings, connect: each step sends once and the connection closes the dialog", () => {
		const opened = run(withStatus(NOT_CONNECTED).model, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "connect" }) }),
			typed("vc_token_0001"),
		])
		const lookedUp = step(opened, Message.GotVercelMessage({ message: VercelMessage.SubmittedToken() }))
		expect(names(lookedUp.commands)).toEqual(["DiscoverVercel"])
		expect(
			names(
				step(lookedUp.model, Message.GotVercelMessage({ message: VercelMessage.SubmittedToken() }))
					.commands,
			),
		).toEqual([])

		const teams = run(lookedUp.model, [
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam: null,
					response: new VercelDiscoverResponse({ teams: [ACME, LABS], projects: [] }),
					error: null,
				}),
			}),
		])
		scene(
			{ update: step, view },
			given(teams),
			mounted(),
			expectView(text("Which team should Maple watch?")).toExist(),
		)

		const picked = run(teams, [
			Message.GotVercelMessage({
				message: VercelMessage.GotTeamMessage({
					message: RadioGroup.Message.SelectedRadio({ value: "team_acme" }),
				}),
			}),
		])
		const forTeam = step(picked, Message.GotVercelMessage({ message: VercelMessage.SubmittedTeam() }))
		expect(names(forTeam.commands)).toEqual(["DiscoverVercel"])
		const settings = run(forTeam.model, [
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam: "team_acme",
					response: new VercelDiscoverResponse({ teams: [ACME, LABS], projects: PROJECTS }),
					error: null,
				}),
			}),
		])
		scene(
			{ update: step, view },
			given(settings),
			mounted(),
			expectView(text("Creates 3 drains on Acme right away.")).toExist(),
		)

		const sent = step(settings, Message.GotVercelMessage({ message: VercelMessage.SubmittedConnect() }))
		expect(names(sent.commands)).toEqual(["ConnectVercel"])
		expect(
			names(
				step(sent.model, Message.GotVercelMessage({ message: VercelMessage.SubmittedConnect() }))
					.commands,
			),
		).toEqual([])
		const done = step(
			sent.model,
			Message.GotVercelMessage({
				message: VercelMessage.CompletedConnect({ mode: "connect", teamName: "Acme", error: null }),
			}),
		)
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

	test("warns before connecting a team Vercel reports on Hobby", () => {
		const settingsFor = (team: VercelTeam) =>
			run(withStatus(NOT_CONNECTED).model, [
				Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "connect" }) }),
				typed("vc_token_0001"),
				Message.GotVercelMessage({
					message: VercelMessage.CompletedDiscover({
						forTeam: null,
						response: new VercelDiscoverResponse({ teams: [team], projects: PROJECTS }),
						error: null,
					}),
				}),
			])
		const hobby = new VercelTeam({ id: "team_acme", slug: "acme", name: "Acme", plan: "hobby" })
		scene(
			{ update: step, view },
			given(settingsFor(hobby)),
			mounted(),
			expectView(text("Acme is on Vercel's Hobby plan")).toExist(),
		)
		scene(
			{ update: step, view },
			given(settingsFor(ACME)),
			mounted(),
			expectView(text("Acme is on Vercel's Hobby plan")).toBeAbsent(),
		)
	})

	test("a single team skips the team step; picking projects with none picked cannot connect", () => {
		const settings = run(withStatus(NOT_CONNECTED).model, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "connect" }) }),
			typed("vc_token_0001"),
			Message.GotVercelMessage({ message: VercelMessage.SubmittedToken() }),
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam: null,
					response: new VercelDiscoverResponse({ teams: [ACME], projects: PROJECTS }),
					error: null,
				}),
			}),
			Message.GotVercelMessage({ message: VercelMessage.ChangedScope({ scope: "some" }) }),
		])
		expect(configureOf(settings).projects).toEqual(PROJECTS)
		expect(
			names(
				step(settings, Message.GotVercelMessage({ message: VercelMessage.SubmittedConnect() }))
					.commands,
			),
		).toEqual([])
		const one = run(settings, [
			Message.GotVercelMessage({ message: VercelMessage.ToggledProject({ id: "prj_web" }) }),
		])
		expect(
			names(
				step(one, Message.GotVercelMessage({ message: VercelMessage.SubmittedConnect() })).commands,
			),
		).toEqual(["ConnectVercel"])
	})

	test("Back to the team step and a new pick keeps the settings, minus projects the new team lacks", () => {
		const discovered = (forTeam: string, projects: typeof PROJECTS) =>
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam,
					response: new VercelDiscoverResponse({ teams: [ACME, LABS], projects }),
					error: null,
				}),
			})
		const pick = (value: string) =>
			Message.GotVercelMessage({
				message: VercelMessage.GotTeamMessage({
					message: RadioGroup.Message.SelectedRadio({ value }),
				}),
			})
		const tuned = run(withStatus(NOT_CONNECTED).model, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "connect" }) }),
			typed("vc_token_0001"),
			Message.GotVercelMessage({ message: VercelMessage.SubmittedToken() }),
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam: null,
					response: new VercelDiscoverResponse({ teams: [ACME, LABS], projects: [] }),
					error: null,
				}),
			}),
			pick("team_acme"),
			Message.GotVercelMessage({ message: VercelMessage.SubmittedTeam() }),
			discovered("team_acme", PROJECTS),
			Message.GotVercelMessage({ message: VercelMessage.ChangedScope({ scope: "some" }) }),
			Message.GotVercelMessage({ message: VercelMessage.ToggledProject({ id: "prj_web" }) }),
			Message.GotVercelMessage({ message: VercelMessage.ToggledProject({ id: "prj_docs" }) }),
			Message.GotVercelMessage({ message: VercelMessage.ChangedSampling({ value: "0.1" }) }),
			Message.GotVercelMessage({ message: VercelMessage.ToggledSignal({ signal: "logsEnabled" }) }),
		])
		const repicked = run(tuned, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigureBack() }),
			pick("team_labs"),
			Message.GotVercelMessage({ message: VercelMessage.SubmittedTeam() }),
			discovered("team_labs", [{ id: "prj_docs", name: "docs", framework: null }]),
		])
		expect(configureOf(repicked).draft).toEqual({
			...configureOf(tuned).draft,
			projectIds: ["prj_docs"],
		})
		expect(configureOf(repicked).draft.logsEnabled).toBe(false)
	})

	test("a refused token stays on the token step with Vercel's reason; a token seeing no team says why", () => {
		const sent = run(withStatus(NOT_CONNECTED).model, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "connect" }) }),
			typed("vc_token_0001"),
			Message.GotVercelMessage({ message: VercelMessage.SubmittedToken() }),
		])
		const refused = run(sent, [
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam: null,
					response: null,
					error: "Vercel didn't accept this token.",
				}),
			}),
		])
		expect(configureOf(refused).isLookingUp).toBe(false)
		scene(
			{ update: step, view },
			given(refused),
			mounted(),
			expectView(text("Vercel didn't accept this token.")).toExist(),
		)
		const teamless = run(sent, [
			Message.GotVercelMessage({
				message: VercelMessage.CompletedDiscover({
					forTeam: null,
					response: new VercelDiscoverResponse({ teams: [], projects: [] }),
					error: null,
				}),
			}),
		])
		expect(configureOf(teamless).error).toBe(
			"This token can't see any team. Create it with a team scope.",
		)
	})
})

describe("vercel card: connected", () => {
	test("a connected team reads only its status and shows what each drain sends", () => {
		const entered = withStatus(connected())
		expect(names(entered.commands)).toEqual([])
		scene(
			{ update: step, view },
			given(entered.model),
			expectView(text("What Maple receives")).toExist(),
			expectView(text("Connected")).toExist(),
			expectView(within(role("row", { name: /Logs/ }), text("live"))).toExist(),
			expectView(within(role("row", { name: /Speed Insights/ }), text("off"))).toExist(),
			expectView(
				within(role("row", { name: /Audit log/ }), text(/Security audit log, org admins only/)),
			).toExist(),
			expectView(role("link", { name: "storefront" })).toHaveAttr("href", "/infra/vercel/prj_web"),
			expectView(role("link", { name: /Open Vercel dashboard/ })).toHaveAttr("href", "/infra/vercel"),
		)
	})

	test("an errored drain shows Vercel's error in its row and the header counts it", () => {
		const model = withStatus(
			connected({
				drains: {
					traces: new VercelDrainStatus({
						id: "drn_traces",
						status: "errored",
						lastError: "401 Unauthorized",
					}),
				},
			}),
		).model
		scene(
			{ update: step, view },
			given(model),
			expectView(within(role("row", { name: /Traces/ }), text("errored: 401 Unauthorized"))).toExist(),
			expectView(text("Connected · 1 drain needs attention")).toExist(),
		)
	})

	test("Configure and Edit scope open the settings dialog", () => {
		for (const name of ["Configure", "Edit scope"])
			scene(
				{ update: step, view },
				given(withStatus(connected()).model),
				click(role("button", { name })),
				...opened,
				expectView(text("Configure Acme")).toExist(),
			)
	})

	test("projects outside a picked scope read as not forwarded and do not link", () => {
		const model = withStatus(
			connected({
				projectScope: "some",
				projectIds: ["prj_web"],
				projects: [
					new VercelProjectStatus({
						...PROJECTS[0]!,
						forwarded: true,
						productionDeployment: null,
						latestDeployment: null,
					}),
					new VercelProjectStatus({
						...PROJECTS[1]!,
						forwarded: false,
						productionDeployment: null,
						latestDeployment: null,
					}),
				],
			}),
		).model
		scene(
			{ update: step, view },
			given(model),
			expectView(text("Selected · 1 of 2")).toExist(),
			expectView(text("not forwarded")).toExist(),
			expectView(role("link", { name: "docs" })).toBeAbsent(),
		)
	})

	test("a drain deleted on Vercel offers a re-apply, which sends an empty settings save once", () => {
		const model = withStatus(
			connected({
				drains: { logs: drain("missing"), traces: drain("enabled"), aiGateway: drain("enabled") },
			}),
		).model
		scene(
			{ update: step, view },
			given(model),
			expectView(text("The logs drain was deleted on Vercel")).toExist(),
			expectView(role("button", { name: "Re-apply drains" })).toExist(),
		)
		const sent = step(model, Message.GotVercelMessage({ message: VercelMessage.ClickedReapply() }))
		expect(names(sent.commands)).toEqual(["SaveVercelSettings"])
		expect(
			names(
				step(sent.model, Message.GotVercelMessage({ message: VercelMessage.ClickedReapply() }))
					.commands,
			),
		).toEqual([])
		const done = step(
			sent.model,
			Message.GotVercelMessage({
				message: VercelMessage.CompletedSave({ isReapply: true, error: null }),
			}),
		)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Drains re-applied on Vercel",
				description: "",
			}),
		)
	})

	test("a rejected token asks for a new one, saved for the same team", () => {
		const model = withStatus(connected({ authFailed: true })).model
		scene(
			{ update: step, view },
			given(model),
			expectView(text("Token rejected")).toExist(),
			expectView(text("Vercel rejected the saved token")).toExist(),
			expectView(role("button", { name: "Paste a new token" })).toExist(),
			click(role("button", { name: "Replace token" })),
			...opened,
			expectView(text("New token for Acme")).toExist(),
		)
		const typedIn = run(model, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "token" }) }),
			typed("vc_token_0002"),
		])
		expect(configureOf(typedIn).target).toBe("token")
		expect(
			names(
				step(typedIn, Message.GotVercelMessage({ message: VercelMessage.SubmittedToken() })).commands,
			),
		).toEqual(["ConnectVercel"])
	})

	test("the disconnect confirmation names only the drains Maple installed", () => {
		const model = run(
			withStatus(
				connected({
					tracesEnabled: false,
					drains: { logs: drain("enabled"), traces: null, aiGateway: drain("enabled") },
				}),
			).model,
			[Message.ClickedDisconnect()],
		)
		const dialog = role("alertdialog")
		scene(
			{ update: step, view },
			given(model),
			mounted(),
			expectView(within(dialog, text("Maple logs"))).toExist(),
			expectView(within(dialog, text("Maple AI Gateway"))).toExist(),
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
				description:
					"Maple couldn't delete them. In the team's drain settings, delete every drain whose name starts with Maple.",
			}),
		)
	})
})

describe("vercel card: configure", () => {
	const configured = (status: VercelIntegrationStatus) =>
		run(withStatus(status).model, [
			Message.GotVercelMessage({ message: VercelMessage.ClickedConfigure({ target: "configure" }) }),
		])

	test("a change that forwards less asks first; confirming saves only what changed", () => {
		const draft = run(configured(connected()), [
			Message.GotVercelMessage({ message: VercelMessage.ToggledSignal({ signal: "tracesEnabled" }) }),
		])
		const asked = step(draft, Message.GotVercelMessage({ message: VercelMessage.ClickedSave() }))
		expect(names(asked.commands)).not.toContain("SaveVercelSettings")
		expect(configureOf(asked.model).confirm.isOpen).toBe(true)
		const saved = step(asked.model, Message.GotVercelMessage({ message: VercelMessage.ConfirmedSave() }))
		expect(
			Option.getOrUndefined(
				Arr.findFirst(saved.commands ?? [], ({ name }) => name === "SaveVercelSettings"),
			)?.args,
		).toEqual(expect.objectContaining({ request: expect.objectContaining({ tracesEnabled: false }) }))
		const done = step(
			saved.model,
			Message.GotVercelMessage({
				message: VercelMessage.CompletedSave({ isReapply: false, error: null }),
			}),
		)
		expect(done.model.vercelCard.configure).toBeNull()
		expect(names(done.commands)).toEqual(["LoadIntegrationsVercelStatus"])
	})

	test("turning AI Gateway off asks first, then saves only that switch", () => {
		const opened = configured(connected())
		scene(
			{ update: step, view },
			given(opened),
			mounted(),
			expectView(
				text(
					"Model usage and cost from Vercel AI Gateway: every request with its model, tokens and cost.",
				),
			).toExist(),
		)
		const asked = step(
			run(opened, [
				Message.GotVercelMessage({
					message: VercelMessage.ToggledSignal({ signal: "aiGatewayEnabled" }),
				}),
			]),
			Message.GotVercelMessage({ message: VercelMessage.ClickedSave() }),
		)
		expect(configureOf(asked.model).confirm.isOpen).toBe(true)
		const saved = step(asked.model, Message.GotVercelMessage({ message: VercelMessage.ConfirmedSave() }))
		expect(
			Option.getOrUndefined(
				Arr.findFirst(saved.commands ?? [], ({ name }) => name === "SaveVercelSettings"),
			)?.args,
		).toEqual(expect.objectContaining({ request: { aiGatewayEnabled: false } }))
	})

	test("turning on the audit log names where its events show and its plan, and saves only that switch at once", () => {
		const opened = configured(connected())
		scene(
			{ update: step, view },
			given(opened),
			mounted(),
			expectView(
				text(/Shown in the Security audit log to org admins\. Enterprise plan only\./),
			).toExist(),
		)
		const sent = step(
			run(opened, [
				Message.GotVercelMessage({
					message: VercelMessage.ToggledSignal({ signal: "auditLogEnabled" }),
				}),
			]),
			Message.GotVercelMessage({ message: VercelMessage.ClickedSave() }),
		)
		expect(
			Option.getOrUndefined(
				Arr.findFirst(sent.commands ?? [], ({ name }) => name === "SaveVercelSettings"),
			)?.args,
		).toEqual(expect.objectContaining({ request: { auditLogEnabled: true } }))
	})

	test("a change that forwards more applies at once; a refusal stays in the dialog", () => {
		const draft = run(configured(connected({ samplingRate: 0.5 })), [
			Message.GotVercelMessage({ message: VercelMessage.ChangedSampling({ value: "1" }) }),
		])
		const sent = step(draft, Message.GotVercelMessage({ message: VercelMessage.ClickedSave() }))
		expect(names(sent.commands)).toEqual(["SaveVercelSettings"])
		const refused = step(
			sent.model,
			Message.GotVercelMessage({
				message: VercelMessage.CompletedSave({ isReapply: false, error: "Vercel said no." }),
			}),
		)
		expect(configureOf(refused.model).error).toBe("Vercel said no.")
		expect(configureOf(refused.model).isSaving).toBe(false)
	})

	test("nothing changed, nothing to save", () => {
		expect(
			names(
				step(
					configured(connected()),
					Message.GotVercelMessage({ message: VercelMessage.ClickedSave() }),
				).commands,
			),
		).toEqual([])
	})
})
