import { MapleFoldkit } from "@maple-dev/effect-sdk/foldkit"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { afterAll, describe, expect, test } from "vitest"
import { CREDENTIAL_SOURCES, credentialSourceOf } from "./credential-sources"
import { CredentialProvider } from "./providers"

// The web tracer puts every Command's args on its span as `maple.foldkit.arg.<key>`. Its default
// policy, which the app runs on, exports an argument whose name ends in `Id` and redacts the rest.
// A cost credential must not reach telemetry by either road.

const maple = MapleFoldkit.make({
	serviceName: "cost-credential-test",
	endpoint: "http://ingest.invalid",
	autoFlushInterval: false,
	replay: { enabled: false },
	emitSessionMeta: false,
	captureGlobalErrors: false,
})
afterAll(() => maple.dispose())

interface Traced {
	readonly name: string
	readonly args?: Readonly<Record<string, unknown>> | undefined
}

/** The span attributes the tracer gives `command`, as the app's update returning it would get them. */
const tracedArgs = (command: Traced): Readonly<Record<string, unknown>> => {
	const app = maple.instrument({
		update: (model: Readonly<Record<string, never>>, _message: { readonly _tag: string }) => ({
			model,
			commands: [command],
		}),
	})
	return app.update({}, { _tag: "SubmittedCredential" }).commands[0]?.args ?? {}
}

/** Every exported value as text, lists flattened. */
const exported = (args: Readonly<Record<string, unknown>>): ReadonlyArray<string> =>
	Arr.flatMap(Rec.values(args), (value) => (Arr.isArray(value) ? Arr.map(value, String) : [String(value)]))

const SECRET = "secret-0f1e2d3c4b5a"
const IDENTIFIERS = ["acme-organization", "tokenid9a8b7c"]

describe("cost credential commands in telemetry", () => {
	test("the tracer exports a top-level argument named like an id, which is why none may hold a credential", () => {
		const args = tracedArgs({ name: "Probe", args: { tokenId: "tokenid9a8b7c", token: SECRET } })
		expect(args["maple.foldkit.arg.tokenId"]).toBe("tokenid9a8b7c")
		expect(args["maple.foldkit.arg.token"]).toBe("[redacted]")
	})

	test.each(CredentialProvider.literals)(
		"saving a %s credential exports no part of it: not the secret, not a field typed before it",
		(provider) => {
			const args = tracedArgs(credentialSourceOf(provider).save(SECRET, IDENTIFIERS))
			// The tracer did handle the command: its span names the message that sent it.
			expect(args["maple.foldkit.message"]).toBe("SubmittedCredential")
			const leaked = Arr.filter([SECRET, ...IDENTIFIERS], (value) =>
				Arr.some(exported(args), (text) => Str.includes(value)(text)),
			)
			expect(leaked).toEqual([])
		},
	)

	test("PlanetScale's three values travel as one object, which the tracer never exports", () => {
		const command = CREDENTIAL_SOURCES.planetscale.save(SECRET, IDENTIFIERS)
		// What the command sends on is all there, under names that are no id to the tracer.
		expect(command.args).toEqual({
			credential: {
				organization: "acme-organization",
				tokenIdentifier: "tokenid9a8b7c",
				token: SECRET,
			},
		})
		expect(Rec.keys(tracedArgs(command))).toEqual(["maple.foldkit.message"])
	})

	test.each(CredentialProvider.literals)("removing a %s source carries no argument", (provider) => {
		expect(Rec.keys(tracedArgs(credentialSourceOf(provider).delete()))).toEqual(["maple.foldkit.message"])
	})
})
