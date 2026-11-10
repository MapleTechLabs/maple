import { generateKeyPairSync, verify } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pemToPkcs8, RS256, signJwt } from "./jwt"
import { Effect, String as Str } from "effect"

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

const signsVerifiably = async (pem: string) => {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(pem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	)
	const data = Buffer.from("header.payload")
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data)
	return verify("sha256", data, publicKey, Buffer.from(signature))
}

describe("pemToPkcs8", () => {
	it("imports the PKCS#1 key GitHub downloads", async () => {
		expect(await signsVerifiably(pkcs1)).toBe(true)
	})

	it("imports a PKCS#1 key whose newlines were flattened to spaces", async () => {
		expect(await signsVerifiably(Str.replace(/\n/g, " ")(pkcs1))).toBe(true)
	})

	it("imports a PKCS#8 key unchanged", async () => {
		expect(await signsVerifiably(pkcs8)).toBe(true)
	})
})

describe("signJwt", () => {
	it("mints an RS256 compact JWS the public key verifies", async () => {
		const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pkcs1), RS256, false, ["sign"])
		const token = await Effect.runPromise(signJwt(key, RS256, { alg: "RS256" }, { sub: "maple" }))
		const [header = "", payload = "", signature = ""] = Str.split(".")(token)
		expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({ sub: "maple" })
		const data = Buffer.from(`${header}.${payload}`)
		expect(verify("sha256", data, publicKey, Buffer.from(signature, "base64url"))).toBe(true)
	})
})
