import { OrgId, UserId } from "@maple/domain"
import { V2ApiKey, V2ApiKeyWithSecret } from "@maple/domain/http/v2"
import { Array as Arr, Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { SignalPresences } from "@maple/views/data/signal-presence"
import { checkoutSlo } from "../page/alerts/shared/slo-test-fixtures"
import { httpMonitor } from "../page/kit/uptime/test-monitors"
import * as SloForm from "../page/alerts/slo-form/update"
import { Message as SloFormMessage } from "../page/alerts/slo-form/message"
import * as UptimeForm from "../page/alerts/uptime-form/update"
import { Message as UptimeFormMessage } from "../page/alerts/uptime-form/message"
import type { PageContext } from "../page/contract"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { init as initIntegrations, update as updateIntegrations } from "../page/integrations/update"
import * as PricingCards from "../page/onboarding/pricing-cards"
import * as QuickStart from "../page/onboarding/quick-start"
import { ConnectMessage } from "../page/onboarding/quick-start-connect"
import { DEFAULT_QUICK_START_STATE } from "../page/onboarding/quick-start-state"
import { loadingTeam, TeamMessage, updateTeam } from "../page/onboarding/quick-start-team"
import * as CreateDialog from "../page/settings/keys/create-dialog"
import { Message as MembersMessage } from "../page/settings/members/model"
import * as Members from "../page/settings/members/update"
import { Message as BuilderMessage } from "../page/status-pages/builder/message"
import * as Builder from "../page/status-pages/builder/update"
import { statusPage } from "../page/status-pages/shared/test-pages"
import type { ClerkSnapshot } from "../platform/clerk"
import { identityOf, isSameIdentity } from "../platform/session-identity"
import * as CheckoutReturn from "../page/kit/checkout-return"

// Each product event fires as a Command at the moment the user acts.

type Commands = { readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> }
const tracked = (result: Commands, name: string) =>
	Option.getOrUndefined(Arr.findFirst(result.commands ?? [], (command) => command.name === name))?.args
const names = (result: Commands) => Arr.map(result.commands ?? [], (command) => command.name)

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

describe("product events", () => {
	test("a successful integration callback is integration_connected with its provider", () => {
		const model = initIntegrations({ search: { integration: "github" } }, context).model
		const connected = updateIntegrations(
			model,
			IntegrationsMessage.ReceivedConnectMessage({
				provider: "github",
				status: "success",
				message: null,
			}),
			context,
		)
		expect(tracked(connected, "TrackIntegrationConnected")).toEqual({ provider: "github" })
		const failed = updateIntegrations(
			model,
			IntegrationsMessage.ReceivedConnectMessage({
				provider: "github",
				status: "error",
				message: "denied",
			}),
			context,
		)
		expect(tracked(failed, "TrackIntegrationConnected")).toBeUndefined()
	})

	test("a created API key is api_key_created with its kind and access", () => {
		const key = Schema.decodeSync(V2ApiKey)({
			id: "key_aXwpxqBkqtYwtBtmsGbR41",
			object: "api_key",
			name: "CI deploy",
			description: null,
			key_prefix: "maple_ak_0003",
			kind: "standard",
			scopes: [],
			revoked: false,
			revoked_at: null,
			last_used_at: null,
			expires_at: null,
			created_at: "2026-10-01T12:00:00.000Z",
			created_by: "user_2Nk8mXqPfR3yZ1aB4cD5eF6g",
			created_by_email: "ada@acme.test",
		})
		const secret = Schema.decodeSync(V2ApiKeyWithSecret)({
			...Schema.encodeSync(V2ApiKey)(key),
			secret: "s",
		})
		const done = (kind: "standard" | "mcp") =>
			CreateDialog.update(
				{ ...CreateDialog.init("keys"), accessMode: "restricted" },
				CreateDialog.Message.CompletedCreate({ kind, result: Result.succeed(secret) }),
			)
		expect(tracked(done("standard"), "TrackApiKeyCreated")).toEqual({
			kind: "standard",
			access: "restricted",
		})
		expect(tracked(done("mcp"), "TrackApiKeyCreated")).toEqual({ kind: "mcp", access: "full" })
	})

	test("a completed quick-start step is onboarding_step_completed", () => {
		const loaded = {
			...QuickStart.init("maple-onboarding-v6-org_1").model,
			state: DEFAULT_QUICK_START_STATE,
		}
		const picked = QuickStart.update(
			loaded,
			QuickStart.Message.ToggledLanguage({ language: "nodejs" }),
			true,
		)
		expect(tracked(picked, "TrackOnboardingStepCompleted")).toBeUndefined()
		const next = QuickStart.update(
			picked.model,
			QuickStart.Message.ClickedContinue({ step: "stack" }),
			true,
		)
		expect(tracked(next, "TrackOnboardingStepCompleted")).toEqual({ step: "stack" })
	})

	test("a checkout return that times out is plan_checkout_returned, unconfirmed", () => {
		const waiting = PricingCards.initReturning(true).model
		const timedOut = PricingCards.update(
			waiting,
			PricingCards.Message.GotCheckoutReturnMessage({
				message: CheckoutReturn.Message.ElapsedTimeout(),
			}),
		)
		expect(tracked(timedOut, "TrackCheckoutReturned")).toEqual({ confirmed: false })
	})

	test("a confirmed disconnect is integration_disconnected with its provider", () => {
		const model = initIntegrations({ search: { integration: "cloudflare" } }, context).model
		const disconnected = (failure: ReturnType<typeof toLoadFailure> | null) =>
			updateIntegrations(
				model,
				IntegrationsMessage.CompletedDisconnect({ integration: "cloudflare-multi", failure }),
				context,
			)
		expect(tracked(disconnected(null), "TrackIntegrationDisconnected")).toEqual({
			provider: "cloudflare",
		})
		expect(
			tracked(disconnected(toLoadFailure(new Error("denied"))), "TrackIntegrationDisconnected"),
		).toBeUndefined()
	})

	test("a sent invitation is member_invited with the invited role", () => {
		const model = Members.init([]).model
		const invited = (result: Result.Result<void, string>) =>
			Members.update(
				model,
				MembersMessage.CompletedInvite({ email: "grace@acme.test", role: "org:admin", result }),
			)
		expect(tracked(invited(Result.succeed(undefined)), "TrackMemberInvited")).toEqual({
			role: "org:admin",
		})
		expect(
			tracked(invited(Result.fail("Couldn't send invitation")), "TrackMemberInvited"),
		).toBeUndefined()
	})

	test("an onboarding invitation is member_invited; a rename is not", () => {
		const team = loadingTeam()
		const succeeded = (operation: "invite" | "rename") =>
			updateTeam(team, TeamMessage.SucceededTeamOperation({ operation, value: "grace@acme.test" }))
		expect(Arr.map(succeeded("invite").commands, ({ name }) => name)).toEqual([
			"TrackOnboardingMemberInvited",
		])
		expect(succeeded("rename").commands).toEqual([])
		expect(updateTeam(team, TeamMessage.FailedTeamOperation({ message: "nope" })).commands).toEqual([])
	})

	test("a created uptime monitor is uptime_monitor_created with its kind; an edit is not", () => {
		const created = UptimeForm.init({ _tag: "AlertsUptimeNew", search: {} }, context).model
		const saved = (
			model: typeof created,
			result: Parameters<typeof UptimeFormMessage.CompletedSave>[0]["result"],
		) => UptimeForm.update(model, UptimeFormMessage.CompletedSave({ result }), context)
		const monitor = httpMonitor()
		expect(tracked(saved(created, Result.succeed(monitor)), "TrackUptimeMonitorCreated")).toEqual({
			kind: monitor.kind,
		})
		expect(
			tracked(
				saved({ ...created, editingId: monitor.id }, Result.succeed(monitor)),
				"TrackUptimeMonitorCreated",
			),
		).toBeUndefined()
		expect(
			tracked(
				saved(created, Result.fail(toLoadFailure(new Error("boom")))),
				"TrackUptimeMonitorCreated",
			),
		).toBeUndefined()
	})

	test("a created SLO is slo_created; a failed save is not", () => {
		const model = SloForm.init({ _tag: "AlertsSloNew", search: {} }, context).model
		const saved = (result: Parameters<typeof SloFormMessage.CompletedSave>[0]["result"]) =>
			SloForm.update(model, SloFormMessage.CompletedSave({ result }), context)
		expect(names(saved(Result.succeed(checkoutSlo())))).toContain("TrackSloCreated")
		expect(names(saved(Result.fail(toLoadFailure(new Error("boom")))))).not.toContain("TrackSloCreated")
	})

	test("a created status page is status_page_created; a failed create is not", () => {
		const model = Builder.init({ _tag: "StatusPageNew" }, context).model
		const created = (result: Parameters<typeof BuilderMessage.CompletedCreate>[0]["result"]) =>
			Builder.update(model, BuilderMessage.CompletedCreate({ mode: "draft", result }), context)
		expect(names(created(Result.succeed(statusPage())))).toContain("TrackStatusPageCreated")
		expect(names(created(Result.fail(toLoadFailure(new Error("boom")))))).not.toContain(
			"TrackStatusPageCreated",
		)
	})

	test("the connect step seeing a first signal arrive is first_data_received, once", () => {
		const presence = (status: "present" | "absent"): SignalPresences => ({
			traces: { status, lastSeenMs: null },
			logs: { status: "absent", lastSeenMs: null },
		})
		const read = (model: QuickStart.Model, presences: SignalPresences) =>
			QuickStart.update(
				model,
				QuickStart.Message.GotConnectMessage({
					message: ConnectMessage.LoadedPresence({ result: Result.succeed(presences) }),
				}),
				true,
			)
		const start = QuickStart.init("maple-onboarding-v6-org_1").model
		const empty = read(start, presence("absent"))
		expect(tracked(empty, "TrackFirstDataReceived")).toBeUndefined()
		const arrived = read(empty.model, presence("present"))
		expect(tracked(arrived, "TrackFirstDataReceived")).toEqual({ signal: "traces" })
		expect(tracked(read(arrived.model, presence("present")), "TrackFirstDataReceived")).toBeUndefined()
		// Data already there when the step opened is not an arrival it saw.
		expect(tracked(read(start, presence("present")), "TrackFirstDataReceived")).toBeUndefined()
	})
})

const snapshot = (fullName: string | null): ClerkSnapshot => ({
	maybeUserId: Option.some(UserId.make("user_ada")),
	maybeOrgId: Option.some(orgId),
	maybeUser: Option.some({ fullName, email: "ada@acme.test", imageUrl: "" }),
	maybeOrganization: Option.none(),
	memberships: [],
	maybeRole: Option.some("org:admin"),
	maybePendingTask: Option.none(),
})

describe("session identity", () => {
	test("the signed-in user, org, role and plan name the session; signed out is nobody", () => {
		expect(identityOf(snapshot("Ada Lovelace"), "startup")).toEqual({
			id: "user_ada",
			username: "Ada Lovelace",
			email: "ada@acme.test",
			groupId: "org_acme",
			traits: { role: "org:admin", plan: "startup" },
		})
		expect(identityOf({ ...snapshot("Ada"), maybeRole: Option.none() }, null)?.traits).toEqual({})
		expect(identityOf({ ...snapshot(null), maybeUserId: Option.none() }, null)).toBeNull()
	})

	test("identify runs again only when a primitive changed, the plan and role included", () => {
		const ada = identityOf(snapshot("Ada"), null)
		expect(isSameIdentity(ada, identityOf(snapshot("Ada"), null))).toBe(true)
		expect(isSameIdentity(ada, identityOf(snapshot("Ada L."), null))).toBe(false)
		expect(isSameIdentity(ada, identityOf(snapshot("Ada"), "startup"))).toBe(false)
		expect(
			isSameIdentity(
				ada,
				identityOf({ ...snapshot("Ada"), maybeRole: Option.some("org:member") }, null),
			),
		).toBe(false)
	})
})
