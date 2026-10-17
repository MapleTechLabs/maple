import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright"
import { buildTarget } from "./build.ts"
import {
	BROWSER_LAUNCH_OPTIONS,
	type CaptureResult,
	type CaptureVariant,
	captureDir,
	captureTarget,
	expandVariants,
} from "./capture.ts"
import { codegenFile } from "./codegen.ts"
import { type AuthMode, isTargetName, PORT_BASE, targets, type TargetName } from "./config.ts"
import { routeCoverage } from "./coverage.ts"
import type { FixtureBackend } from "./contract.ts"
import { compareRun } from "./report.ts"
import { clerkIdentityFor, installClerkStub } from "./runtime/clerk-stub.ts"
import { installSelfHostedSession, selfHostedTokenFor } from "./runtime/session.ts"
import { selfcheck } from "./selfcheck.ts"
import { buildExists, loadBuild, serveStatic, startBackendIfPresent } from "./serve.ts"

const usage = `ui-parity: compare the legacy React UI (apps/web) against the Foldkit UI (apps/web-foldkit)

  PARITY_PORT_BASE=4900 offsets every port (default 4790) so worktrees can run in parallel.
  <build> is a target (legacy | legacy-head | foldkit) or a name given to build --out.

  parity build <target> [--ref <git-ref>] [--auth self_hosted|clerk] [--out <name>]
  parity serve [--dataset default]              fixture backend + every built target, for browsing
  parity run [--filter x] [--baseline legacy] [--candidate foldkit] [--run name] [--tolerance N] [--strict-a11y]
                                                capture both builds, diff, write the report
  parity compare --run name [--baseline legacy] [--candidate foldkit] [--strict-a11y]
                                                re-diff an existing run's captures (no recapture)
  parity selfcheck [--filter x] [--target legacy]  capture one build twice; anything not identical is flaky
  parity capture <build> [--filter x] [--run name] capture one build (screenshots, snapshots, reference DOM)
  parity codegen <file.html> [--line N] [--name viewName]  reference markup to Foldkit view code
  parity list [--filter x]                      list scenario variants
  parity coverage                               legacy routes and the scenarios that cover them
`

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		ref: { type: "string" },
		auth: { type: "string", default: "self_hosted" },
		out: { type: "string" },
		filter: { type: "string" },
		baseline: { type: "string", default: "legacy" },
		candidate: { type: "string", default: "foldkit" },
		target: { type: "string", default: "legacy" },
		run: { type: "string" },
		dataset: { type: "string", default: "default" },
		tolerance: { type: "string", default: "0" },
		"strict-a11y": { type: "boolean", default: false },
		line: { type: "string" },
		name: { type: "string" },
	},
})

const fail = (message: string): never => {
	console.error(message)
	process.exit(2)
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)

const authModeOf = (value: string | undefined): AuthMode =>
	value === "clerk"
		? "clerk"
		: value === "self_hosted" || value === undefined
			? "self_hosted"
			: fail(`--auth must be self_hosted or clerk`)

const requireBuild = (name: string) => {
	if (!buildExists(name))
		fail(
			`No build "${name}". Run: bun run parity build ${isTargetName(name) ? name : `<target> --out ${name}`}`,
		)
	loadBuild(name)
	return name
}

/** Drops variants whose `Scenario.targets` leave out a build this command captures. */
const forBuilds = (variants: ReadonlyArray<CaptureVariant>, builds: ReadonlyArray<string>) => {
	const captured = [...new Set(builds.map((name) => loadBuild(name).stamp.target))]
	const kept = variants.filter(({ scenario }) => {
		const only = scenario.targets
		return only === undefined || captured.every((target) => only.includes(target))
	})
	if (kept.length < variants.length)
		console.log(
			`[parity] skipping ${variants.length - kept.length} variants not built for ${captured.join(", ")} (Scenario.targets)`,
		)
	return kept
}

/**
 * Clerk datasets capture the `--auth clerk` flavor of a build. A missing flavor is built here from
 * the self-hosted build's stamp (same target, same pinned ref; working-tree targets from the tree as it is now).
 */
const ensureAuthFlavors = async (
	builds: ReadonlyArray<string>,
	variants: ReadonlyArray<CaptureVariant>,
	backend: FixtureBackend | null,
) => {
	const clerkDatasets = new Set(backend?.datasets.filter((d) => d.auth === "clerk").map((d) => d.name))
	if (
		!variants.some(
			({ scenario }) => scenario.dataset !== undefined && clerkDatasets.has(scenario.dataset),
		)
	)
		return
	for (const name of new Set(builds)) {
		if (buildExists(name, "clerk")) continue
		const { stamp } = loadBuild(name)
		console.log(
			`[parity] "${name}" has no clerk flavor; building it (bun run parity build ${stamp.target} --auth clerk)`,
		)
		await buildTarget(stamp.target, { authMode: "clerk", out: name, ref: stamp.ref ?? undefined })
	}
}

const exitWith = (summary: ReturnType<typeof compareRun>) => {
	process.exitCode = summary.totals.fail + summary.totals.missing > 0 ? 1 : 0
}

const command = positionals[0]

switch (command) {
	case "build": {
		const name = positionals[1] ?? ""
		if (!isTargetName(name)) fail(usage)
		else await buildTarget(name, { ref: values.ref, authMode: authModeOf(values.auth), out: values.out })
		break
	}

	case "list": {
		for (const variant of expandVariants(values.filter))
			console.log(
				`${variant.id.padEnd(56)} ${variant.scenario.dataset ?? "-"}  ${variant.scenario.path}`,
			)
		break
	}

	case "coverage": {
		const routes = routeCoverage()
		for (const { route, scenarios } of routes)
			console.log(`${scenarios.length ? "✓" : "✗"} ${route.padEnd(56)} ${scenarios.join(", ")}`)
		console.log(
			`\n${routes.filter((entry) => entry.scenarios.length).length}/${routes.length} routes covered (/lab excluded)`,
		)
		break
	}

	case "codegen": {
		const file = positionals[1]
		if (!file) fail(usage)
		else
			console.log(
				codegenFile(file, { line: values.line ? Number(values.line) : undefined, name: values.name }),
			)
		break
	}

	case "capture": {
		const build = requireBuild(positionals[1] ?? "legacy")
		const run = values.run ?? `${timestamp()}-capture-${build}`
		const backend = await startBackendIfPresent()
		const variants = forBuilds(expandVariants(values.filter), [build])
		await ensureAuthFlavors([build], variants, backend)
		const results = await captureTarget({ build, run, variants, backend })
		await backend?.close()
		console.log(
			`\n${results.filter((result) => result.ok).length}/${results.length} captured -> ${captureDir(run, build)}`,
		)
		break
	}

	case "run": {
		const baseline = requireBuild(values.baseline)
		const candidate = requireBuild(values.candidate)
		const run = values.run ?? `${timestamp()}-${candidate}-vs-${baseline}`
		const variants = forBuilds(expandVariants(values.filter), [baseline, candidate])
		const backend = await startBackendIfPresent()
		await ensureAuthFlavors([baseline, candidate], variants, backend)
		const browser = await chromium.launch(BROWSER_LAUNCH_OPTIONS)
		// Same-build comparisons (legacy vs legacy) need distinct folders.
		const candidateLabel = baseline === candidate ? `${candidate}-b` : candidate
		const baselineResults = await captureTarget({ build: baseline, run, variants, backend, browser })
		const candidateResults = await captureTarget({
			build: candidate,
			label: candidateLabel,
			run,
			variants,
			backend,
			browser,
		})
		await browser.close()
		await backend?.close()
		exitWith(
			compareRun({
				run,
				baselineLabel: baseline,
				candidateLabel,
				variants,
				baselineResults,
				candidateResults,
				tolerance: Number(values.tolerance),
				strictA11y: values["strict-a11y"],
			}),
		)
		break
	}

	case "compare": {
		const run = values.run ?? fail(usage)
		const baselineLabel = values.baseline
		const candidateLabel =
			values.baseline === values.candidate ? `${values.candidate}-b` : values.candidate
		const readResults = (label: string): CaptureResult[] =>
			JSON.parse(readFileSync(join(captureDir(run, label), "_results.json"), "utf8"))
		const baselineResults = readResults(baselineLabel)
		const captured = new Set(baselineResults.map((result) => result.variantId))
		exitWith(
			compareRun({
				run,
				baselineLabel,
				candidateLabel,
				variants: expandVariants(values.filter).filter((variant) => captured.has(variant.id)),
				baselineResults,
				candidateResults: readResults(candidateLabel),
				tolerance: Number(values.tolerance),
				strictA11y: values["strict-a11y"],
			}),
		)
		break
	}

	case "selfcheck": {
		const build = requireBuild(values.target)
		const run = values.run ?? `${timestamp()}-selfcheck-${build}`
		const variants = forBuilds(expandVariants(values.filter), [build])
		const backend = await startBackendIfPresent()
		await ensureAuthFlavors([build], variants, backend)
		const result = await selfcheck({ build, run, variants, backend })
		await backend?.close()
		process.exitCode = result.deterministic && result.healthy ? 0 : 1
		break
	}

	case "serve": {
		const backend = await startBackendIfPresent()
		const dataset = backend?.datasets.find((entry) => entry.name === values.dataset)
		const authMode: AuthMode = dataset?.auth ?? "self_hosted"
		const headScript =
			authMode === "clerk"
				? `<script>(${installClerkStub.toString()})(${JSON.stringify(dataset ? clerkIdentityFor(dataset) : null)})</script>`
				: `<script>(${installSelfHostedSession.toString()})(${JSON.stringify(dataset ? selfHostedTokenFor(dataset) : null)})</script>`
		const names = Object.keys(targets).filter(isTargetName)
		const available: TargetName[] = names.filter((name) => buildExists(name, authMode))
		const servers = available.map((name) =>
			serveStatic(loadBuild(name, authMode), targets[name].port, headScript),
		)
		console.log(
			`fixture backend  ${backend?.apiOrigin ?? "(none: src/backend missing)"}  dataset ${values.dataset}, port base ${PORT_BASE}`,
		)
		for (const name of available) console.log(`${name.padEnd(16)} http://localhost:${targets[name].port}`)
		console.log("Ctrl+C to stop. The clock is not frozen here, so relative times can differ.")
		process.on("SIGINT", async () => {
			for (const server of servers) server.stop(true)
			await backend?.close()
			process.exit(0)
		})
		await new Promise(() => {})
		break
	}

	default:
		console.log(usage)
}
