import { OrgId, UserId } from "@maple/domain"
import { V2ApiKey, V2ApiKeyWithSecret } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../page/contract"
import { Message as IntegrationsMessage } from "../page/integrations/message"
import { init as initIntegrations, update as updateIntegrations } from "../page/integrations/update"
import * as PricingCards from "../page/onboarding/pricing-cards"
import * as QuickStart from "../page/onboarding/quick-start"
import { DEFAULT_QUICK_START_STATE } from "../page/onboarding/quick-start-state"
import * as CreateDialog from "../page/settings/keys/create-dialog"
import type { ClerkSnapshot } from "../platform/clerk"
import { identityOf, isSameIdentity } from "../platform/session-identity"

// Each product event fires as a Command at the moment the user acts.

type Commands = { readonly commands?: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> }
const tracked = (result: Commands, name: string) => result.commands?.find((command) => command.name === name)?.args

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

describe("product events", () => {
	test("a successful integration callback is integration_connected with its provider", () => {
		const model = initIntegrations({ search: { integration: "github" } }, context).model
		const connected = updateIntegrations(
			model,
			IntegrationsMessage.ReceivedConnectMessage({ provider: "github", status: "success", message: null }),
			context,
		)
		expect(tracked(connected, "TrackIntegrationConnected")).toEqual({ provider: "github" })
		const failed = updateIntegrations(
			model,
			IntegrationsMessage.ReceivedConnectMessage({ provider: "github", status: "error", message: "denied" }),
			context,
		)
		expect(tracked(failed, "TrackIntegrationConnected")).toBeUndefined()
	})

	test("a created API key is api_key_created with its kind and access", () => {
		const key = Schema.decodeUnknownSync(V2ApiKey)({
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
		const secret = Schema.decodeUnknownSync(V2ApiKeyWithSecret)({ ...Schema.encodeSync(V2ApiKey)(key), secret: "s" })
		const done = (kind: "standard" | "mcp") =>
			CreateDialog.update(
				{ ...CreateDialog.init("keys"), accessMode: "restricted" },
				CreateDialog.Message.CompletedCreate({ kind, result: Result.succeed(secret) }),
			)
		expect(tracked(done("standard"), "TrackApiKeyCreated")).toEqual({ kind: "standard", access: "restricted" })
		expect(tracked(done("mcp"), "TrackApiKeyCreated")).toEqual({ kind: "mcp", access: "full" })
	})

	test("a completed quick-start step is onboarding_step_completed", () => {
		const loaded = { ...QuickStart.init("maple-onboarding-v6-org_1").model, state: DEFAULT_QUICK_START_STATE }
		const picked = QuickStart.update(loaded, QuickStart.Message.ToggledLanguage({ language: "nodejs" }))
		expect(tracked(picked, "TrackOnboardingStepCompleted")).toBeUndefined()
		const next = QuickStart.update(picked.model, QuickStart.Message.ClickedContinue({ step: "stack" }))
		expect(tracked(next, "TrackOnboardingStepCompleted")).toEqual({ step: "stack" })
	})

	test("a checkout return that times out is plan_checkout_returned, unconfirmed", () => {
		const waiting = PricingCards.initReturning(true).model
		const timedOut = PricingCards.update(waiting, PricingCards.Message.ElapsedCheckoutTimeout())
		expect(tracked(timedOut, "TrackCheckoutReturned")).toEqual({ confirmed: false })
	})
})

const snapshot = (fullName: string | null): ClerkSnapshot => ({
	maybeUserId: Option.some(UserId.make("user_ada")),
	maybeOrgId: Option.some(orgId),
	maybeUser: Option.some({ fullName, email: "ada@acme.test", imageUrl: "" }),
	maybeOrganization: Option.none(),
	memberships: [],
})

describe("session identity", () => {
	test("the signed-in user and org name the session; signed out is nobody", () => {
		expect(identityOf(snapshot("Ada Lovelace"))).toEqual({
			id: "user_ada",
			username: "Ada Lovelace",
			email: "ada@acme.test",
			groupId: "org_acme",
		})
		expect(identityOf({ ...snapshot(null), maybeUserId: Option.none() })).toBeNull()
	})

	test("identify runs again only when a primitive changed", () => {
		expect(isSameIdentity(identityOf(snapshot("Ada")), identityOf(snapshot("Ada")))).toBe(true)
		expect(isSameIdentity(identityOf(snapshot("Ada")), identityOf(snapshot("Ada L.")))).toBe(false)
	})
})
