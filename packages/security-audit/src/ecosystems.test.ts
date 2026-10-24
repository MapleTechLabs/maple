import { describe, expect, it } from "vitest"
import {
	configFilesToRead,
	executionModeLine,
	executionProfile,
	MAX_REGISTRY_CONFIG_READS,
	scanDependencies,
} from "./ecosystems"

/** A fixture tree: tracked path to content. Only config files' content is ever read. */
const scan = (tree: Record<string, string>) => {
	const paths = Object.keys(tree)
	const configs = new Map(configFilesToRead(paths).map((path) => [path, tree[path] ?? ""]))
	return scanDependencies(paths, configs)
}

describe("scanDependencies, ecosystems", () => {
	it("detects each ecosystem from its manifests and lockfiles, anywhere in the tree", () => {
		expect(
			scan({
				"package.json": "{}",
				"bun.lock": "",
				"services/ml/pyproject.toml":
					'[project]\nname = "ml"\n[project.urls]\nHomepage = "https://ml.acme.dev"',
				"services/ml/requirements-dev.txt": "pytest==8.0.0",
				"tools/cli/go.mod": "module acme.dev/cli\n\ngo 1.23",
				"crates/core/Cargo.toml":
					'[package]\nname = "core"\nrepository = "https://code.acme.dev/core"',
				"android/build.gradle.kts": 'plugins { id("com.android.application") }',
				"README.md": "",
			}),
		).toEqual({ ecosystems: ["node", "python", "go", "rust", "jvm"], privateDependencies: [] })
	})

	it("detects nothing in a tree without a build manifest", () => {
		expect(scan({ "main.sh": "", "docs/index.md": "" })).toEqual({
			ecosystems: [],
			privateDependencies: [],
		})
	})
})

describe("scanDependencies, private dependencies", () => {
	it("flags a private npm registry and its credentials, not the public one", () => {
		expect(
			scan({
				"package.json": "{}",
				".npmrc":
					"registry=https://registry.npmjs.org/\n@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NPM_TOKEN}",
			}).privateDependencies,
		).toEqual([".npmrc: private source npm.pkg.github.com", ".npmrc: registry credentials"])
	})

	it("flags a private Python index in pip.conf, requirements and pyproject, but not project URLs", () => {
		expect(
			scan({
				"pip.conf": "[global]\nindex-url = https://pypi.acme.internal/simple",
				"requirements.txt":
					"--extra-index-url https://pypi.org/simple\nacme-auth @ git+ssh://git@github.com/acme/auth.git\nrequests==2.32.0",
				"pyproject.toml":
					'[project.urls]\nHomepage = "https://acme.dev"\n[[tool.uv.index]]\nname = "acme"\nurl = "https://artifacts.acme.dev/pypi/simple"',
			}).privateDependencies,
		).toEqual([
			"pip.conf: private source pypi.acme.internal",
			"pyproject.toml: private source artifacts.acme.dev",
			"requirements.txt: git dependency over SSH",
		])
	})

	it("flags private submodules and Go replace directives to local modules", () => {
		expect(
			scan({
				"go.mod":
					"module github.com/acme/api\n\nreplace github.com/acme/shared => ../shared\nreplace golang.org/x/net => golang.org/x/net v0.30.0",
				".gitmodules":
					'[submodule "vendor/secrets"]\n\tpath = vendor/secrets\n\turl = git@github.com:acme/secrets.git',
			}).privateDependencies,
		).toEqual([
			".gitmodules: git submodule git@github.com:acme/secrets.git over SSH, not checked out",
			"go.mod: replace directive to the local module ../shared",
		])
	})

	it("flags private Maven, Gradle and Cargo sources, not Maven Central or a POM's own URLs", () => {
		expect(
			scan({
				"pom.xml":
					'<project xmlns="http://maven.apache.org/POM/4.0.0"><url>https://acme.dev</url><repositories><repository><url>https://repo.maven.apache.org/maven2</url></repository><repository><url>https://nexus.acme.internal/repository/maven</url></repository></repositories></project>',
				".mvn/settings.xml":
					"<settings><servers><server><id>nexus</id></server></servers></settings>",
				"build.gradle":
					'repositories {\n  mavenCentral()\n  maven { url "https://artifactory.acme.dev/libs" }\n}',
				"Cargo.toml": '[dependencies]\ninternal = { git = "https://git.acme.dev/internal.git" }',
				".cargo/config.toml": '[registries.acme]\nindex = "sparse+https://cargo.acme.dev/index/"',
			}).privateDependencies,
		).toEqual([
			"Cargo.toml: private source git.acme.dev",
			"build.gradle: private source artifactory.acme.dev",
			"pom.xml: private source nexus.acme.internal",
			".cargo/config.toml: private source cargo.acme.dev",
			".mvn/settings.xml: repository credentials",
		])
	})

	it("flags package.json git dependencies over SSH, not a github: shorthand or its metadata URLs", () => {
		expect(
			scan({
				"package.json": JSON.stringify({
					homepage: "https://acme.internal/docs",
					repository: { url: "git+ssh://git@github.com/acme/web.git" },
					bugs: { url: "git@github.com:acme/web/issues" },
					dependencies: {
						react: "^19.0.0",
						"@acme/ui": "git+ssh://git@github.com/acme/ui.git#v2",
						"@acme/auth": "github:acme/auth#main",
						"@acme/flags": "git@gitlab.acme.dev:web/flags.git",
					},
					devDependencies: { "@acme/lint": "git+ssh://git@git.acme.dev/lint.git" },
				}),
			}).privateDependencies,
		).toEqual([
			"package.json: git dependency @acme/ui (git+ssh://git@github.com/acme/ui.git#v2)",
			"package.json: git dependency @acme/flags (git@gitlab.acme.dev:web/flags.git)",
			"package.json: git dependency @acme/lint (git+ssh://git@git.acme.dev/lint.git)",
		])
	})

	it("flags nothing in a package.json that is not valid JSON", () => {
		expect(scan({ "package.json": '{"dependencies": {"a": "git@x:y.git"' }).privateDependencies).toEqual(
			[],
		)
	})

	it("flags submodules on a private host or over SSH, not public HTTPS ones", () => {
		expect(
			scan({
				".gitmodules": [
					'[submodule "lib"]\n\turl = https://github.com/acme/lib',
					'[submodule "docs"]\n\turl = git://gitlab.com/acme/docs.git',
					'[submodule "infra"]\n\turl = https://git.acme.dev/infra.git',
					'[submodule "keys"]\n\turl = ssh://git@github.com/acme/keys.git',
				].join("\n"),
			}).privateDependencies,
		).toEqual([
			".gitmodules: git submodule https://git.acme.dev/infra.git, not checked out",
			".gitmodules: git submodule ssh://git@github.com/acme/keys.git over SSH, not checked out",
		])
	})

	it("flags GOPRIVATE and GONOSUMDB set in the repository's own config and CI", () => {
		expect(
			scan({
				"go.mod": "module github.com/acme/api\n// replace github.com/acme/old => ../old\n",
				".envrc": "export GOPRIVATE=github.com/acme/*",
				".github/workflows/ci.yml": "env:\n  GONOSUMDB: go.acme.dev\n",
			}).privateDependencies,
		).toEqual([
			".envrc: GOPRIVATE set to github.com/acme/*",
			".github/workflows/ci.yml: GONOSUMDB set to go.acme.dev",
		])
	})

	it("ignores commented requirements lines and the well-known public Python indexes", () => {
		expect(
			scan({
				"requirements.txt": [
					"# --index-url https://pypi.acme.internal/simple",
					"--extra-index-url https://download.pytorch.org/whl/cu121",
					"--index-url https://pypi.org/simple  # the default",
					"torch==2.5.0",
					"# acme-auth @ git+ssh://git@github.com/acme/auth.git",
				].join("\n"),
			}).privateDependencies,
		).toEqual([])
	})

	it("reads the shallowest registry configs first and caps how many", () => {
		const tree = Object.fromEntries(
			Array.from({ length: MAX_REGISTRY_CONFIG_READS + 10 }, (_, i) => [`packages/p${i}/.npmrc`, ""]),
		)
		const toRead = configFilesToRead([...Object.keys(tree), ".npmrc"])
		expect([toRead.length, toRead[0]]).toEqual([MAX_REGISTRY_CONFIG_READS, ".npmrc"])
	})

	it("never lets a monorepo's package.json files crowd out a nested .npmrc", () => {
		const tree: Record<string, string> = Object.fromEntries(
			Array.from({ length: 80 }, (_, i) => [`apps/a${i}/package.json`, "{}"]),
		)
		const nested = "packages/deep/billing/client/.npmrc"
		const signals = scan({
			...tree,
			"package.json": "{}",
			[nested]: "@acme:registry=https://npm.pkg.github.com",
		}).privateDependencies
		expect(signals).toEqual([`${nested}: private source npm.pkg.github.com`])
	})
})

describe("scanDependencies, hostile config text", () => {
	it("reads repeated unclosed tags and long whitespace runs in linear time", () => {
		const started = performance.now()
		const result = scan({
			"pom.xml": `${"<mirror>".repeat(50_000)}<repository><url>https://nexus.acme.internal/m2</url></repository>`,
			"requirements.txt": `pytest${" ".repeat(100_000)}x\n--index-url https://pypi.acme.internal/simple # mirror`,
		})
		expect([performance.now() - started < 1_000, result.privateDependencies]).toEqual([
			true,
			[
				"pom.xml: private source nexus.acme.internal",
				"requirements.txt: private source pypi.acme.internal",
			],
		])
	})
})

describe("scanDependencies, commented-out config", () => {
	it("ignores private sources that only appear in comments", () => {
		expect(
			scan({
				"pom.xml":
					"<project><!-- <repositories><repository><url>https://nexus.acme.internal/m2</url></repository></repositories> --></project>",
				"build.gradle": '// maven { url "https://nexus.acme.internal/libs" }',
				Makefile: "# GOPRIVATE: go.acme.dev\nbuild:\n\tgo build ./...",
			}).privateDependencies,
		).toEqual([])
	})

	it("still reads the live config around a comment", () => {
		expect(
			scan({
				"pom.xml":
					"<project><!-- old --><repositories><repository><url>https://nexus.acme.internal/m2</url></repository></repositories></project>",
				Makefile: "# private modules\nexport GOPRIVATE=go.acme.dev",
			}).privateDependencies,
		).toEqual(["pom.xml: private source nexus.acme.internal", "Makefile: GOPRIVATE set to go.acme.dev"])
	})
})

describe("executionProfile", () => {
	it("is source-only today, naming the ecosystems without a sandbox and the private dependencies", () => {
		const profile = executionProfile({
			ecosystems: ["node", "go"],
			privateDependencies: [".npmrc: private source npm.pkg.github.com"],
		})
		expect([profile.mode, executionModeLine(profile)]).toEqual([
			"source_only",
			"Source-only review: no execution sandbox for Node.js, Go yet; private dependencies detected, which cannot be installed without credentials (.npmrc: private source npm.pkg.github.com)",
		])
	})

	it("is executable once every ecosystem has a sandbox and nothing is private", () => {
		const node = (ecosystem: string) => ecosystem === "node"
		expect([
			executionProfile({ ecosystems: ["node"], privateDependencies: [] }, node).mode,
			executionProfile({ ecosystems: ["node", "go"], privateDependencies: [] }, node).reasons,
		]).toEqual(["executable", ["no execution sandbox for Go yet"]])
	})
})
