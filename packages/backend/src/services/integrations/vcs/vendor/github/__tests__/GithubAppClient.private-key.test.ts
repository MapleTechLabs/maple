import { generateKeyPairSync, verify } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pemToPkcs8 } from "../GithubAppClient"

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
		expect(await signsVerifiably(pkcs1.replace(/\n/g, " "))).toBe(true)
	})

	it("imports a PKCS#8 key unchanged", async () => {
		expect(await signsVerifiably(pkcs8)).toBe(true)
	})
})
