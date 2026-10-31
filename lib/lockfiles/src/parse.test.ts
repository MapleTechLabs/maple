import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { isIgnoredLockfilePath, lockfileKindOf, parseLockfile, type ParsedLockfile } from "./index.ts"

const parse = (path: string, content: string, manifests?: Record<string, string>): Promise<ParsedLockfile> =>
	Effect.runPromise(
		parseLockfile({
			path,
			content,
			manifests: manifests === undefined ? undefined : new Map(Object.entries(manifests)),
		}),
	)

const failure = (path: string, content: string) =>
	Effect.runPromise(Effect.flip(parseLockfile({ path, content })))

const summary = (parsed: ParsedLockfile): ReadonlyArray<string> =>
	parsed.packages.map((p) => `${p.name}@${p.version}:${p.relation}`)

describe("lockfileKindOf / isIgnoredLockfilePath", () => {
	it.each([
		["package-lock.json", "package-lock"],
		["apps/web/npm-shrinkwrap.json", "package-lock"],
		["pnpm-lock.yaml", "pnpm-lock"],
		["a/yarn.lock", "yarn-v1"],
		["bun.lock", "bun-lock"],
		["bun.lockb", "bun-lockb"],
		["svc/go.mod", "go-mod"],
		["go.sum", "go-sum"],
		["crates/x/Cargo.lock", "cargo-lock"],
		["package.json", undefined],
		["cargo.lock", undefined],
		["yarn.lock.bak", undefined],
	])("%s is %s", (path, kind) => {
		expect(lockfileKindOf(path)).toBe(kind)
	})

	it.each([
		["node_modules/x/package-lock.json", true],
		["a/vendor/go.mod", true],
		["pkg/testdata/go.sum", true],
		["test/fixtures/yarn.lock", true],
		["src/__fixtures__/bun.lock", true],
		[".git/x/Cargo.lock", true],
		["apps/web/package-lock.json", false],
		["vendored/go.mod", false],
	])("%s ignored: %s", (path, ignored) => {
		expect(isIgnoredLockfilePath(path)).toBe(ignored)
	})
})

describe("unsupported and malformed input", () => {
	it("rejects bun.lockb with the text-lockfile instruction", async () => {
		const error = await failure("bun.lockb", "\u0000binary")
		expect(error._tag).toBe("@maple/lockfiles/LockfileUnsupportedError")
		expect(error.message).toContain("bun install --save-text-lockfile")
	})

	it("rejects files that are not lockfiles", async () => {
		expect((await failure("requirements.txt", "flask==1.0"))._tag).toBe(
			"@maple/lockfiles/LockfileUnsupportedError",
		)
	})

	it.each([
		["package-lock.json", "{ not json"],
		["package-lock.json", '{"packages": {"node_modules/a": {"version": 1}}}'],
		["pnpm-lock.yaml", "packages: [unclosed"],
		["pnpm-lock.yaml", "just: a map"],
		["yarn.lock", '__metadata:\n  version: 8\n"a@npm:1": [\n'],
		["yarn.lock", 'lodash@^4:\n  resolved "x"\n'],
		["bun.lock", '{"lockfileVersion": 1, "packages": {'],
		["go.mod", "module x\nrequire (\n\tgithub.com/a/b\n)\n"],
		["go.mod", "this is not go.mod\n"],
		["go.mod", "module x\nrequire (\n"],
		["go.sum", "github.com/a/b v1.0.0\n"],
		["Cargo.lock", '[[package]]\nname = "a"\nversion = '],
		["Cargo.lock", '[[package]]\nversion = "1.0.0"\n'],
	])("%s: %j fails with LockfileParseError", async (path, content) => {
		const error = await failure(path, content)
		expect(error._tag).toBe("@maple/lockfiles/LockfileParseError")
		expect(error.path).toBe(path)
	})
})

describe("npm lockfile details", () => {
	it("package-lock v3: scoped and nested names, link entries skipped, aliases use the real name", async () => {
		const lock = {
			lockfileVersion: 3,
			packages: {
				"": { dependencies: { "@types/node": "^20", alias: "npm:left-pad@1.3.0" } },
				"node_modules/@types/node": { version: "20.1.0" },
				"node_modules/@types/node/node_modules/undici-types": { version: "5.26.5" },
				"node_modules/alias": { name: "left-pad", version: "1.3.0" },
				"node_modules/local": { resolved: "packages/local", link: true },
			},
		}
		expect(summary(await parse("package-lock.json", JSON.stringify(lock)))).toEqual([
			"@types/node@20.1.0:direct",
			"left-pad@1.3.0:direct",
			"undici-types@5.26.5:transitive",
		])
	})

	it("pnpm: v5 and v6 keys with peer suffixes and scopes", async () => {
		const v5 = [
			"lockfileVersion: 5.4",
			"dependencies:",
			"  '@emotion/react': 11.0.0_react@18.2.0",
			"packages:",
			"  /@emotion/react/11.0.0_react@18.2.0:",
			"    dev: false",
			"  /string_decoder/1.1.1:",
			"    dev: true",
			"  /react/18.2.0: {}",
		].join("\n")
		expect(summary(await parse("pnpm-lock.yaml", v5))).toEqual([
			"@emotion/react@11.0.0:direct",
			"react@18.2.0:transitive",
			"string_decoder@1.1.1:dev",
		])
		const v6 = [
			"lockfileVersion: '6.0'",
			"devDependencies:",
			"  '@testing-library/react':",
			"    specifier: ^14",
			"    version: 14.0.0(react-dom@18.2.0)(react@18.2.0)",
			"packages:",
			"  /@testing-library/react@14.0.0(react-dom@18.2.0)(react@18.2.0):",
			"    dev: true",
		].join("\n")
		expect(summary(await parse("pnpm-lock.yaml", v6))).toEqual(["@testing-library/react@14.0.0:dev"])
	})

	it("pnpm v9: snapshots peer suffixes collapse onto the package", async () => {
		const v9 = [
			"lockfileVersion: '9.0'",
			"importers:",
			"  .:",
			"    dependencies:",
			"      '@tanstack/react-query':",
			"        specifier: ^5",
			"        version: 5.0.0(react@18.2.0)",
			"      local:",
			"        specifier: link:../local",
			"        version: link:../local",
			"packages:",
			"  '@tanstack/react-query@5.0.0':",
			"    resolution: {integrity: sha512-x}",
			"  react@18.2.0:",
			"    resolution: {integrity: sha512-y}",
			"snapshots:",
			"  '@tanstack/react-query@5.0.0(react@18.2.0)':",
			"    dependencies:",
			"      react: 18.2.0",
			"  react@18.2.0: {}",
		].join("\n")
		expect(summary(await parse("pnpm-lock.yaml", v9))).toEqual([
			"@tanstack/react-query@5.0.0:direct",
			"react@18.2.0:transitive",
		])
	})

	it("yarn v1: scoped multi-specifier headers, aliases and git entries", async () => {
		const lock = [
			"# yarn lockfile v1",
			"",
			'"@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":',
			'  version "7.12.13"',
			'  resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz"',
			"",
			'"pad@npm:left-pad@1.3.0":',
			'  version "1.3.0"',
			"",
			'"mylib@github:me/mylib#abc":',
			'  version "0.1.0"',
		].join("\n")
		const parsed = await parse("yarn.lock", lock, {
			"package.json": JSON.stringify({
				devDependencies: { "@babel/code-frame": "^7.10.4" },
				dependencies: { pad: "npm:left-pad@1.3.0" },
			}),
		})
		expect(summary(parsed)).toEqual(["@babel/code-frame@7.12.13:dev", "left-pad@1.3.0:direct"])
		expect(parsed.warnings).toEqual(["skipped 1 non-registry packages (git, tarball or local)"])
	})

	it("yarn berry: patch entries resolve to the underlying npm version, workspaces are skipped", async () => {
		const lock = [
			"__metadata:",
			"  version: 8",
			'"resolve@npm:^1.20.0":',
			"  version: 1.22.8",
			'  resolution: "resolve@npm:1.22.8"',
			'"resolve@patch:resolve@npm%3A^1.20.0#optional!builtin<compat/resolve>":',
			"  version: 1.22.8",
			'  resolution: "resolve@patch:resolve@npm%3A1.22.8#optional!builtin<compat/resolve>::version=1.22.8&hash=c3c19d"',
			'"@scope/pkg@npm:2.0.0":',
			"  version: 2.0.0",
			'  resolution: "@scope/pkg@npm:2.0.0"',
			'"app@workspace:.":',
			"  version: 0.0.0-use.local",
			'  resolution: "app@workspace:."',
		].join("\n")
		const parsed = await parse("yarn.lock", lock, {
			"package.json": JSON.stringify({ name: "app", dependencies: { resolve: "^1.20.0" } }),
		})
		expect(parsed.kind).toBe("yarn-berry")
		expect(summary(parsed)).toEqual(["@scope/pkg@2.0.0:transitive", "resolve@1.22.8:direct"])
		expect(parsed.warnings).toEqual([])
	})

	it("bun.lock: JSONC trailing commas outside strings, comma-bracket text inside strings kept", async () => {
		const lock = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "dependencies": { "@scope/a": "^1", }, }, },
  "packages": {
    "@scope/a": ["@scope/a@1.0.0", "", { "dependencies": { "b": "2" } }, "sha512-,]"],
    "@scope/a/b": ["b@2.0.0", "", {}, "sha512-y"],
    "c": ["c@github:me/c#abc", {}],
  },
}`
		const parsed = await parse("bun.lock", lock)
		expect(summary(parsed)).toEqual(["@scope/a@1.0.0:direct", "b@2.0.0:transitive"])
		expect(parsed.warnings).toEqual(["skipped 1 non-registry packages (git, tarball or local)"])
	})

	it("deduplicates by name and version, keeping the strongest relation", async () => {
		const lock = {
			lockfileVersion: 3,
			packages: {
				"": { dependencies: { ms: "2.1.3" } },
				"packages/a": { devDependencies: { ms: "2.1.3" } },
				"node_modules/ms": { version: "2.1.3" },
				"node_modules/debug/node_modules/ms": { version: "2.1.3", dev: true },
				"node_modules/x/node_modules/ms": { version: "2.0.0", dev: true },
			},
		}
		expect(summary(await parse("package-lock.json", JSON.stringify(lock)))).toEqual([
			"ms@2.0.0:dev",
			"ms@2.1.3:direct",
		])
	})
})

describe("package-lock v1 aliases", () => {
	it("reports an npm: alias under the real package name and version", async () => {
		const lock = {
			lockfileVersion: 1,
			dependencies: {
				"lodash-old": { version: "npm:lodash@4.17.15" },
				"@scope/alias": { version: "npm:@babel/core@7.0.0", dev: true },
			},
		}
		const manifest = JSON.stringify({ dependencies: { "lodash-old": "npm:lodash@4.17.15" } })
		expect(
			summary(await parse("package-lock.json", JSON.stringify(lock), { "package.json": manifest })),
		).toEqual(expect.arrayContaining(["lodash@4.17.15:direct", "@babel/core@7.0.0:dev"]))
	})
})

describe("go.mod replace precedence", () => {
	it("lets a version-specific replace win over a wildcard written before it", async () => {
		const mod = [
			"module example.com/app",
			"go 1.22",
			"require example.com/x v1.0.0",
			"replace example.com/x => example.com/y v2.0.0",
			"replace example.com/x v1.0.0 => example.com/z v3.0.0",
		].join("\n")
		expect(summary(await parse("go.mod", mod))).toEqual(["example.com/z@v3.0.0:direct"])
	})
})

describe("Go and Cargo details", () => {
	it("go.mod: single-line requires, local replacements dropped, versioned replacements scoped", async () => {
		const mod = [
			"module example.com/app",
			"",
			"go 1.22",
			"toolchain go1.22.1",
			"",
			"require github.com/a/b v1.2.3",
			"require (",
			'\t"github.com/c/d" v0.0.0-20191109021931-daa7c04131f5 // indirect',
			"\tgithub.com/e/f v2.0.0+incompatible",
			"\tgithub.com/local/x v1.0.0",
			"\tgithub.com/g/h v1.1.0 // indirect; pinned",
			")",
			"exclude github.com/a/b v1.2.2",
			"replace github.com/local/x => ../x",
			"replace (",
			"\tgithub.com/g/h v1.0.0 => github.com/g/h v1.0.1",
			"\tgithub.com/e/f => github.com/fork/f v2.1.0+incompatible",
			")",
			"retract v0.1.0",
		].join("\n")
		const parsed = await parse("go.mod", mod)
		expect(summary(parsed)).toEqual([
			"github.com/a/b@v1.2.3:direct",
			"github.com/c/d@v0.0.0-20191109021931-daa7c04131f5:transitive",
			"github.com/fork/f@v2.1.0+incompatible:direct",
			"github.com/g/h@v1.1.0:transitive",
		])
		expect(parsed.warnings).toEqual(["github.com/local/x is replaced by a local directory"])
		expect(parsed.packages.every((p) => p.ecosystem === "Go")).toBe(true)
	})

	it("go.sum: keeps module zip lines only", async () => {
		const sum = [
			"github.com/a/b v1.2.3 h1:abc=",
			"github.com/a/b v1.2.3/go.mod h1:def=",
			"github.com/c/d v0.1.0/go.mod h1:ghi=",
		].join("\n")
		expect(summary(await parse("go.sum", sum))).toEqual(["github.com/a/b@v1.2.3:unknown"])
	})

	it("Cargo.lock: v1 style versioned member deps, git and path packages skipped", async () => {
		const lock = [
			"[[package]]",
			'name = "app"',
			'version = "0.1.0"',
			'dependencies = ["serde 1.0.100 (registry+https://github.com/rust-lang/crates.io-index)", "mine", "local"]',
			"",
			"[[package]]",
			'name = "serde"',
			'version = "1.0.100"',
			'source = "registry+https://github.com/rust-lang/crates.io-index"',
			"",
			"[[package]]",
			'name = "serde"',
			'version = "0.9.0"',
			'source = "sparse+https://index.crates.io/"',
			"",
			"[[package]]",
			'name = "mine"',
			'version = "0.2.0"',
			'source = "git+https://github.com/me/mine#abc"',
			"",
			"[[package]]",
			'name = "local"',
			'version = "0.1.0"',
		].join("\n")
		const parsed = await parse("Cargo.lock", lock)
		expect(summary(parsed)).toEqual(["serde@0.9.0:transitive", "serde@1.0.100:direct"])
		expect(parsed.warnings).toEqual(["skipped 1 git or path packages"])
	})
})
