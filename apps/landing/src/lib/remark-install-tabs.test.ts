import { describe, expect, it } from "vitest"
import { installVariants } from "./remark-install-tabs.mjs"

const variants = (source: string) =>
	Object.fromEntries(installVariants(source)?.variants.map((v) => [v.id, v.value]) ?? [])

describe("installVariants", () => {
	it("converts npm installs with versions and scoped packages", () => {
		expect(variants("npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node")).toEqual({
			npm: "npm install ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node",
			pnpm: "pnpm add ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node",
			bun: "bun add ai@^7.0.106 @ai-sdk/otel @opentelemetry/sdk-node",
		})
	})

	it("maps dev and global flags", () => {
		expect(variants("npm i --save-dev typescript")).toMatchObject({
			pnpm: "pnpm add -D typescript",
			bun: "bun add --dev typescript",
		})
		expect(variants("npm install -D vitest")).toMatchObject({ pnpm: "pnpm add -D vitest", bun: "bun add --dev vitest" })
		expect(variants("npm install -g @maple-dev/cli")).toMatchObject({
			pnpm: "pnpm add -g @maple-dev/cli",
			bun: "bun add -g @maple-dev/cli",
		})
	})

	it("uses install when no package is named", () => {
		expect(variants("npm install")).toMatchObject({ pnpm: "pnpm install", bun: "bun install" })
	})

	it("keeps line continuations and comments", () => {
		expect(variants("# deps\nnpm install @vercel/otel \\\n  @opentelemetry/api")).toMatchObject({
			pnpm: "# deps\npnpm add @vercel/otel \\\n  @opentelemetry/api",
		})
	})

	it("converts pip installs, keeping quoting, extras and specifiers", () => {
		const source = 'pip install "pydantic-ai-slim[openai]>=2.51" \\\n  \'strands-agents[otel]\' -U'
		expect(variants(source)).toEqual({
			pip: source,
			uv: 'uv add "pydantic-ai-slim[openai]>=2.51" \\\n  \'strands-agents[otel]\' -U',
		})
		expect(installVariants("pip install x")?.storageKey).not.toBe(installVariants("npm install x")?.storageKey)
	})

	it("leaves mixed blocks alone", () => {
		expect(installVariants('npm install x\nexport FOO="bar"')).toBeUndefined()
		expect(installVariants("npm install x && npm run build")).toBeUndefined()
		expect(installVariants("npm install x\npip install y")).toBeUndefined()
		expect(installVariants("npx create-thing")).toBeUndefined()
		expect(installVariants("# only a comment")).toBeUndefined()
	})
})
