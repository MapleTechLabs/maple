import { describe, expect, it } from "vitest"
import { isChatConnectorEnabled, organizationFeatureFlagsFrom } from "./organization-feature-flags"

describe("organizationFeatureFlagsFrom", () => {
	it("decodes every organization rollout flag", () => {
		expect(
			organizationFeatureFlagsFrom({
				aiautotriage: true,
				unrelated_metadata: "preserved by Clerk, ignored here",
			}),
		).toEqual({ aiAutoTriage: true, releases: false, prReview: false })
	})

	// `webanalytics` and `agent_tracing` were rollout flags until their pages
	// shipped to everyone. Orgs still carry the key in Clerk metadata, and a retired flag must decode
	// as an ignored extra rather than failing the whole struct — which would take
	// the live flags down with it and fail closed for the orgs that have them on.
	it("ignores a retired flag still present in metadata", () => {
		expect(
			organizationFeatureFlagsFrom({ aiautotriage: true, webanalytics: true, agent_tracing: true }),
		).toEqual({
			aiAutoTriage: true,
			releases: false,
			prReview: false,
		})
	})

	it("disables a missing or malformed flag", () => {
		expect(organizationFeatureFlagsFrom({})).toEqual({
			aiAutoTriage: false,
			releases: false,
			prReview: false,
		})
		// The string "true" is the shape a hand-edited Clerk dashboard field
		// produces, and it must not read as enabled.
		expect(organizationFeatureFlagsFrom({ aiautotriage: "true", releases: "true" })).toEqual({
			aiAutoTriage: false,
			releases: false,
			prReview: false,
		})
	})

	it("reads the pull request review rollout from its own key", () => {
		expect(organizationFeatureFlagsFrom({ prreview: true }).prReview).toBe(true)
		expect(organizationFeatureFlagsFrom({ prreview: "true" }).prReview).toBe(false)
	})

	it("fails closed when public metadata is unavailable", () => {
		expect(organizationFeatureFlagsFrom(undefined)).toEqual({
			aiAutoTriage: false,
			releases: false,
			prReview: false,
		})
	})
})

describe("isChatConnectorEnabled", () => {
	it("enables a connector from its own key alone", () => {
		expect(isChatConnectorEnabled({ testchat_bot: true }, "testchat")).toBe(true)
		// Hand-typed in the Clerk dashboard, so a string counts — unlike a rollout flag.
		expect(isChatConnectorEnabled({ testchat_bot: "yes" }, "testchat")).toBe(true)
		expect(isChatConnectorEnabled({ otherchat_bot: true }, "testchat")).toBe(false)
	})

	it("hides the connector for missing, false or unavailable metadata", () => {
		expect(isChatConnectorEnabled({}, "testchat")).toBe(false)
		expect(isChatConnectorEnabled({ testchat_bot: false }, "testchat")).toBe(false)
		expect(isChatConnectorEnabled(undefined, "testchat")).toBe(false)
	})
})
