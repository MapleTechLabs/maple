import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { UpsertDigestSubscriptionRequest } from "./http/digest.ts"
import { UpdateOnboardingStateRequest } from "./http/onboarding.ts"
import { UpdateScrapeTargetRequest } from "./http/scrape-targets.ts"
import { CreateApiKeyRequest } from "./http/api-keys.ts"

const dec = <A>(s: Schema.Schema<A>, v: unknown) => {
  try { return { ok: true as const, val: Schema.decodeUnknownSync(s as any)(v) } }
  catch (e) { return { ok: false as const, err: String(e).split("\n")[0] } }
}

describe("optionalKey corrected smoke", () => {
  it("all-optional class decodes empty {} (onboarding)", () => {
    const r = dec(UpdateOnboardingStateRequest, {})
    console.log("onboarding {}:", JSON.stringify(r))
    expect(r.ok).toBe(true)
  })
  it("onboarding partial", () => {
    expect(dec(UpdateOnboardingStateRequest, { markOnboardingComplete: true }).ok).toBe(true)
  })
  it("scrape update empty {}", () => {
    const r = dec(UpdateScrapeTargetRequest, {})
    console.log("scrape {}:", JSON.stringify(r))
    expect(r.ok).toBe(true)
  })
  it("digest with required email only", () => {
    const r = dec(UpsertDigestSubscriptionRequest, { email: "a@b.com" })
    console.log("digest {email}:", JSON.stringify(r))
    expect(r.ok).toBe(true)
  })
  it("api-key minimal", () => {
    expect(dec(CreateApiKeyRequest, { name: "ci" }).ok).toBe(true)
  })
})
