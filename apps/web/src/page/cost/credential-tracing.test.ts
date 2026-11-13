import { MapleFoldkit } from "@maple-dev/effect-sdk/foldkit"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { afterAll, describe, expect, test } from "vitest"
import { AddPlanetScaleCostSource, FetchPlanetScaleCostStatus, RemovePlanetScaleCostSource } from "./command"
import { CREDENTIAL_SOURCES } from "./credential-sources"
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

describe("cost source commands in telemetry", () => {
	test("the tracer exports a top-level argument named like an id, which is why none may hold a credential", () => {
		const args = tracedArgs({ name: "Probe", args: { tokenId: "tokenid9a8b7c", token: SECRET } })
		expect(args["maple.foldkit.arg.tokenId"]).toBe("tokenid9a8b7c")
		expect(args["maple.foldkit.arg.token"]).toBe("[redacted]")
	})

	test.each(CredentialProvider.literals)("saving a %s credential exports no part of it", (provider) => {
		const args = tracedArgs(CREDENTIAL_SOURCES[provider].save(SECRET))
		// The tracer did handle the command: its span names the message that sent it.
		expect(args["maple.foldkit.message"]).toBe("SubmittedCredential")
		expect(Arr.filter(exported(args), (value) => Str.includes(SECRET)(value))).toEqual([])
	})

	test.each(CredentialProvider.literals)("removing a %s source carries no argument", (provider) => {
		expect(Rec.keys(tracedArgs(CREDENTIAL_SOURCES[provider].delete()))).toEqual(["maple.foldkit.message"])
	})

	test("no PlanetScale command carries a credential: its source reads through the connection", () => {
		const commands: ReadonlyArray<Traced> = [
			FetchPlanetScaleCostStatus({ key: "status-read-key" }),
			AddPlanetScaleCostSource({ organization: "acme-organization" }),
			RemovePlanetScaleCostSource(),
		]
		// All they hold is a read's key and the organization's name, which is on the page anyway.
		expect(Arr.map(commands, (command) => Rec.keys(command.args ?? {}))).toEqual([
			["key"],
			["organization"],
			[],
		])
		// Neither is named like an id, so the tracer exports neither.
		expect(
			Arr.filter(
				Arr.flatMap(commands, (command) => exported(tracedArgs(command))),
				(value) => Str.includes("acme-organization")(value) || Str.includes("status-read-key")(value),
			),
		).toEqual([])
	})
})
