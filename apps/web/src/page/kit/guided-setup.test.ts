import { Array as Arr, Option } from "effect"
import { describe, expect, test } from "vitest"
import { type FrameworkId, sdkSnippets } from "../../components/quick-start/sdk-snippets"
import { NO_KEYS, promptKey, serverKey, type SetupKeys, setupBlocks } from "./guided-setup"

const KEYS = { privateKey: "maple_sk_secret", publicKey: "maple_pk_public" }

const codeOf = (framework: FrameworkId, keys: SetupKeys = KEYS): string =>
	Arr.join(
		Arr.map(setupBlocks(framework, keys), (block) => block.code),
		"\n",
	)

const installOf = (framework: FrameworkId): string => {
	const install = Option.getOrThrow(
		Arr.findFirst(sdkSnippets, (entry) => entry.language === framework),
	).install
	return typeof install === "string" ? install : Arr.join(install.packages, " ")
}

describe("setup snippets", () => {
	test("the browser setup is the browser SDK with the public key, never the private one", () => {
		const code = codeOf("browser")
		expect(code).toContain("MapleBrowser.init")
		expect(code).toContain('ingestKey: "maple_pk_public"')
		expect(code).not.toContain("maple_sk_secret")
		expect(code).not.toContain("@vercel/otel")
	})

	test("server setups keep the private key in the environment, out of the source file", () => {
		for (const framework of [
			"nodejs",
			"nextjs",
			"python",
			"go",
			"java",
			"dotnet",
			"ruby",
			"rust",
		] as const) {
			const [env, source] = setupBlocks(framework, KEYS)
			expect(env?.code).toContain("maple_sk_secret")
			expect(source?.code).not.toContain("maple_sk_secret")
		}
	})

	test("runtimes with an agent trace every request instead of sending one test span", () => {
		expect(codeOf("nodejs")).toContain("--require @opentelemetry/auto-instrumentations-node/register")
		expect(codeOf("python")).toContain("opentelemetry-instrument python app.py")
		expect(codeOf("go")).toContain("otelhttp.NewHandler")
		expect(codeOf("java")).toContain("-javaagent:opentelemetry-javaagent.jar")
		for (const framework of ["nodejs", "python", "go"] as const)
			expect(codeOf(framework)).not.toContain("hello-maple")
	})

	test("Python sends over HTTP, matching the exporter package it installs", () => {
		expect(installOf("python")).toContain("opentelemetry-exporter-otlp-proto-http")
		expect(codeOf("python")).toContain('OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"')
	})

	test("the Node install has the package the run command loads", () => {
		expect(codeOf("nodejs")).toContain("--require @opentelemetry/auto-instrumentations-node/register")
		expect(installOf("nodejs")).toContain("@opentelemetry/auto-instrumentations-node")
	})

	test("SDKs whose default exporter is gRPC are told to send over HTTP", () => {
		for (const framework of ["python", "dotnet"] as const)
			expect(codeOf(framework)).toContain('OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"')
	})

	test("the Rust crates are pinned to versions built for each other", () => {
		expect(installOf("rust")).toContain("opentelemetry@0.31")
		expect(installOf("rust")).toContain("tracing-opentelemetry@0.32")
	})

	test("the coding-agent prompt carries the key the picked stack's setup uses", () => {
		expect(promptKey("browser", KEYS)).toBe("maple_pk_public")
		expect(promptKey("python", KEYS)).toBe("maple_sk_secret")
	})

	test("Ruby gets a Rails initializer, not a pointer to opentelemetry.io", () => {
		expect(installOf("ruby")).toContain("bundle add opentelemetry-sdk")
		expect(codeOf("ruby")).toContain("OpenTelemetry::SDK.configure(&:use_all)")
	})

	test("someone who can read only the public key gets it in server setups too", () => {
		const memberKeys = { privateKey: null, publicKey: "maple_pk_public" }
		expect(codeOf("python", memberKeys)).toContain("Authorization=Bearer maple_pk_public")
		expect(serverKey(memberKeys)).toBe("maple_pk_public")
		expect(serverKey(KEYS)).toBe("maple_sk_secret")
	})

	test("without a key the setup shows a placeholder, never another key", () => {
		expect(codeOf("nodejs", NO_KEYS)).toContain("Authorization=Bearer <your-ingest-key>")
		expect(codeOf("browser", { privateKey: "maple_sk_secret", publicKey: null })).toContain(
			'ingestKey: "<your-ingest-key>"',
		)
	})
})
