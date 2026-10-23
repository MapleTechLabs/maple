import { describe, expect, it } from "vitest"
import {
	configFilesToRead,
	executionModeLine,
	executionProfile,
	MAX_CONFIG_READS,
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

	it("reads the shallowest config files first and caps how many", () => {
		const tree = Object.fromEntries(
			Array.from({ length: MAX_CONFIG_READS + 10 }, (_, i) => [`packages/p${i}/.npmrc`, ""]),
		)
		const toRead = configFilesToRead([...Object.keys(tree), ".npmrc"])
		expect([toRead.length, toRead[0]]).toEqual([MAX_CONFIG_READS, ".npmrc"])
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
