/**
 * The key api signs device access tokens and App Attest challenges with (DPoP device
 * credentials for the mobile widgets). Only api verifies them, so there is no JWKS to publish.
 * It lives in alchemy state, one per stage; renaming the resource rotates it, which invalidates
 * every outstanding device token (devices simply fetch a new one with their next proof).
 */
import * as Alchemy from "alchemy"
import type * as Output from "alchemy/Output"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"

/** The env api reads the key from (`packages/backend/src/platform/Env.ts`). */
export interface MapleDeviceTokenEnv {
	readonly MAPLE_DEVICE_TOKEN_SIGNING_KEY: Output.Output<Redacted.Redacted<string>>
}

export const createMapleDeviceTokenKey = () =>
	Effect.gen(function* () {
		const key = yield* Alchemy.KeyPair("device-token-signing-key", {
			algorithm: "ec",
			namedCurve: "P-256",
		})
		const env: MapleDeviceTokenEnv = { MAPLE_DEVICE_TOKEN_SIGNING_KEY: key.privateKey }
		return env
	})
