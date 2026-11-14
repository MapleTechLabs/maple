import { DependencyFindingId, DependencyScanId } from "@maple/domain/dependency-scan"
import {
	type DependencyFindingsResponse,
	type DependencyFindingView,
	type DependencyScanRepositoriesResponse,
	type DependencyScanRepository,
	GitCommitSha,
	VcsRepositoryId,
} from "@maple/domain/http"
import { Array as Arr, Schema, String as Str } from "effect"

// Fixtures for the Security Center's Dependencies tab, for `/lab/security` and the page's scene
// tests. Built relative to `now` so relative times read the same.

const HOUR = 3_600_000
const DAY = 24 * HOUR

const repositoryId = Schema.decodeSync(VcsRepositoryId)
const scanId = Schema.decodeSync(DependencyScanId)
const findingId = Schema.decodeSync(DependencyFindingId)
const sha = Schema.decodeSync(GitCommitSha)

export const REPOSITORY_IDS = {
	payments: repositoryId("6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e"),
	web: repositoryId("7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
	cli: repositoryId("8b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"),
} as const

const SCAN_IDS = {
	payments: scanId("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
	web: scanId("2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"),
	cli: scanId("3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f"),
	older: scanId("4d5e6f7a-8b9c-4d0e-9f1a-3b4c5d6e7f8a"),
} as const

const SHAS = {
	payments: sha("4e1d9c2a7b3f8e6d5c4b3a2918f7e6d5c4b3a291"),
	web: sha("9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b"),
	cli: sha("c0ffee1234567890abcdef1234567890abcdef12"),
	older: sha("0123456789abcdef0123456789abcdef01234567"),
} as const

export const PAYMENTS_ID = REPOSITORY_IDS.payments

const service = (serviceName: string, commitSha: GitCommitSha, spanCount: number) => ({
	serviceName,
	environment: "production",
	commitSha,
	spanCount,
})

/** What production ran over the last day: payments-api and web are deployed, cli is not. */
const RUNNING = {
	payments: [
		service("api-gateway", SHAS.payments, 2_400_000),
		service("payments-worker", SHAS.payments, 180_000),
	],
	web: [service("web-frontend", SHAS.web, 640_000)],
} as const

const payments = (nowMs: number): DependencyScanRepository => ({
	id: REPOSITORY_IDS.payments,
	fullName: "acme/payments-api",
	htmlUrl: "https://github.com/acme/payments-api",
	runningCommits: [{ commitSha: SHAS.payments, scanStatus: "completed", services: RUNNING.payments }],
	trackedBranch: "main",
	latestScan: {
		id: SCAN_IDS.payments,
		commitSha: SHAS.payments,
		ref: "refs/heads/main",
		trigger: "push",
		status: "completed",
		lockfiles: [
			{
				path: "pnpm-lock.yaml",
				kind: "pnpm-lock",
				blobSha: "a1",
				packageCount: 1184,
				status: "parsed",
				message: null,
			},
			{
				path: "services/ledger/go.sum",
				kind: "go-sum",
				blobSha: "a2",
				packageCount: 96,
				status: "parsed",
				message: null,
			},
			{
				path: "tools/migrate/Cargo.lock",
				kind: "cargo-lock",
				blobSha: "a3",
				packageCount: 0,
				status: "failed",
				message: "Line 212: expected a [[package]] table.",
			},
		],
		packageCount: 1280,
		vulnerableCount: 5,
		error: null,
		startedAt: nowMs - 2 * HOUR - 40_000,
		finishedAt: nowMs - 2 * HOUR,
	},
})

const web = (nowMs: number): DependencyScanRepository => ({
	id: REPOSITORY_IDS.web,
	fullName: "acme/web",
	htmlUrl: "https://github.com/acme/web",
	runningCommits: [{ commitSha: SHAS.web, scanStatus: "completed", services: RUNNING.web }],
	trackedBranch: "main",
	latestScan: {
		id: SCAN_IDS.web,
		commitSha: SHAS.web,
		ref: "refs/heads/main",
		trigger: "push",
		status: "completed",
		lockfiles: [
			{
				path: "bun.lockb",
				kind: "bun-lockb",
				blobSha: "b1",
				packageCount: 0,
				status: "unsupported",
				message:
					"Binary bun.lockb is not readable. Run `bun install --save-text-lockfile` and commit bun.lock.",
			},
			{
				path: "docs/package-lock.json",
				kind: "package-lock",
				blobSha: "b2",
				packageCount: 412,
				status: "parsed",
				message: null,
			},
		],
		packageCount: 412,
		vulnerableCount: 2,
		error: null,
		startedAt: nowMs - DAY - 30_000,
		finishedAt: nowMs - DAY,
	},
})

const cli = (nowMs: number): DependencyScanRepository => ({
	id: REPOSITORY_IDS.cli,
	fullName: "acme/cli",
	htmlUrl: "https://github.com/acme/cli",
	runningCommits: [],
	trackedBranch: "release",
	latestScan: {
		id: SCAN_IDS.cli,
		commitSha: SHAS.cli,
		ref: "refs/heads/release",
		trigger: "schedule",
		status: "completed",
		lockfiles: [
			{
				path: "Cargo.lock",
				kind: "cargo-lock",
				blobSha: "c1",
				packageCount: 214,
				status: "parsed",
				message: null,
			},
		],
		packageCount: 214,
		vulnerableCount: 1,
		error: null,
		startedAt: nowMs - 3 * DAY - 20_000,
		finishedAt: nowMs - 3 * DAY,
	},
})

export const repositoriesOf = (nowMs: number): DependencyScanRepositoriesResponse => ({
	repositories: [payments(nowMs), web(nowMs), cli(nowMs)],
})

/** Connected, before the repository's first scan. */
/** The same repositories with every lockfile read, as the clean state requires. */
export const cleanRepositoriesOf = (nowMs: number): DependencyScanRepositoriesResponse => ({
	repositories: Arr.map(repositoriesOf(nowMs).repositories, (repository) =>
		repository.latestScan === null
			? repository
			: {
					...repository,
					latestScan: {
						...repository.latestScan,
						lockfiles: Arr.map(repository.latestScan.lockfiles, (lockfile) => ({
							...lockfile,
							status: "parsed" as const,
							message: null,
						})),
					},
				},
	),
})

export const neverScannedOf = (nowMs: number): DependencyScanRepositoriesResponse => ({
	repositories: [{ ...payments(nowMs), latestScan: null }],
})

export const noRepositories: DependencyScanRepositoriesResponse = { repositories: [] }

/** The payments repository scanned once more, later, as a completed Scan now would leave it. */
export const rescannedOf = (nowMs: number): DependencyScanRepositoriesResponse => {
	const [first, ...rest] = repositoriesOf(nowMs).repositories
	return first === undefined || first.latestScan === null
		? repositoriesOf(nowMs)
		: {
				repositories: [
					{
						...first,
						latestScan: {
							...first.latestScan,
							id: SCAN_IDS.older,
							commitSha: SHAS.older,
							finishedAt: nowMs,
						},
					},
					...rest,
				],
			}
}

export const FINDING_IDS = {
	axios: findingId("0a1b2c3d4e5f60718293a4b5c6d7e8f9"),
	axiosDos: findingId("70819203a4b5c6d7e8f90a1b2c3d4e5f"),
	xnet: findingId("1b2c3d4e5f60718293a4b5c6d7e8f90a"),
	vite: findingId("2c3d4e5f60718293a4b5c6d7e8f90a1b"),
	tokio: findingId("3d4e5f60718293a4b5c6d7e8f90a1b2c"),
	marked: findingId("4e5f60718293a4b5c6d7e8f90a1b2c3d"),
	lodash: findingId("5f60718293a4b5c6d7e8f90a1b2c3d4e"),
	jwt: findingId("60718293a4b5c6d7e8f90a1b2c3d4e5f"),
} as const

type FindingSeed = Pick<
	DependencyFindingView,
	| "id"
	| "repositoryId"
	| "repositoryFullName"
	| "lockfilePath"
	| "ecosystem"
	| "packageName"
	| "advisoryId"
	| "aliases"
	| "severity"
	| "summary"
	| "versions"
	| "fixedIn"
	| "relation"
>

const finding = (
	nowMs: number,
	seed: FindingSeed,
	firstSeenAgoMs: number,
	production: DependencyFindingView["production"] = [],
): DependencyFindingView => {
	const scan =
		seed.repositoryId === REPOSITORY_IDS.payments
			? "payments"
			: seed.repositoryId === REPOSITORY_IDS.web
				? "web"
				: "cli"
	return {
		...seed,
		status: "open",
		firstSeenScanId: SCAN_IDS.older,
		lastSeenScanId: SCAN_IDS[scan],
		firstSeenSha: SHAS.older,
		lastSeenSha: SHAS[scan],
		fixedScanId: null,
		fixedSha: null,
		statusReason: null,
		statusChangedBy: null,
		statusChangedAt: null,
		createdAt: nowMs - firstSeenAgoMs,
		updatedAt: nowMs - 2 * HOUR,
		production,
	}
}

const PAYMENTS = { repositoryId: REPOSITORY_IDS.payments, repositoryFullName: "acme/payments-api" } as const
const WEB = { repositoryId: REPOSITORY_IDS.web, repositoryFullName: "acme/web" } as const
const CLI = { repositoryId: REPOSITORY_IDS.cli, repositoryFullName: "acme/cli" } as const

/**
 * Worst first, as the server sorts them: one per severity, a dismissed and a fixed finding, and a
 * second axios advisory whose higher fix is the version the upgrade plan bumps to.
 */
export const findingsOf = (nowMs: number): DependencyFindingsResponse => ({
	production: { available: true, runningServices: 4, linkedServices: 3, complete: true },
	findings: [
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.axios,
				lockfilePath: "pnpm-lock.yaml",
				ecosystem: "npm",
				packageName: "axios",
				advisoryId: "GHSA-jr5f-v2jv-69x6",
				aliases: ["CVE-2025-27152"],
				severity: "critical",
				summary:
					"axios requests to absolute URLs ignore baseURL, so a crafted URL can leak credentials to another host.",
				versions: ["1.7.4"],
				fixedIn: "1.8.2",
				relation: "direct",
			},
			9 * DAY,
			RUNNING.payments,
		),
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.axiosDos,
				lockfilePath: "pnpm-lock.yaml",
				ecosystem: "npm",
				packageName: "axios",
				advisoryId: "GHSA-4hjh-wcwx-xvwj",
				aliases: ["CVE-2025-58754"],
				severity: "high",
				summary: "axios decodes data: URLs without a size limit, so one response can exhaust memory.",
				versions: ["1.7.4"],
				fixedIn: "1.12.0",
				relation: "direct",
			},
			6 * DAY,
			RUNNING.payments,
		),
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.xnet,
				lockfilePath: "services/ledger/go.sum",
				ecosystem: "Go",
				packageName: "golang.org/x/net",
				advisoryId: "GO-2025-3503",
				aliases: ["CVE-2025-22870", "GHSA-qxp5-gwg8-xv66"],
				severity: "high",
				summary: "HTTP proxy bypass using IPv6 zone IDs.",
				versions: ["0.33.0"],
				fixedIn: "0.36.0",
				relation: "transitive",
			},
			4 * DAY,
			[RUNNING.payments[1]],
		),
		finding(
			nowMs,
			{
				...PAYMENTS,
				id: FINDING_IDS.vite,
				lockfilePath: "pnpm-lock.yaml",
				ecosystem: "npm",
				packageName: "vite",
				advisoryId: "GHSA-vg6x-rcgg-rjx6",
				aliases: ["CVE-2025-24010"],
				severity: "medium",
				summary:
					"Websites were able to send any requests to the development server and read the response.",
				versions: ["5.4.10", "6.0.7"],
				fixedIn: "6.0.9",
				relation: "dev",
			},
			2 * DAY,
		),
		finding(
			nowMs,
			{
				...CLI,
				id: FINDING_IDS.tokio,
				lockfilePath: "Cargo.lock",
				ecosystem: "crates.io",
				packageName: "tokio",
				advisoryId: "RUSTSEC-2025-0023",
				aliases: ["GHSA-rr8g-9fpq-6wmg"],
				severity: "low",
				summary: "Broadcast channel calls clone in parallel, but does not require Sync.",
				versions: ["1.38.0"],
				fixedIn: "1.38.2",
				relation: "transitive",
			},
			20 * DAY,
		),
		finding(
			nowMs,
			{
				...WEB,
				id: FINDING_IDS.marked,
				lockfilePath: "docs/package-lock.json",
				ecosystem: "npm",
				packageName: "marked",
				advisoryId: "GHSA-4r62-v4vq-hr96",
				aliases: [],
				severity: "unknown",
				summary: null,
				versions: ["4.0.9"],
				fixedIn: null,
				relation: "unknown",
			},
			DAY,
		),
		{
			...finding(
				nowMs,
				{
					...WEB,
					id: FINDING_IDS.lodash,
					lockfilePath: "docs/package-lock.json",
					ecosystem: "npm",
					packageName: "lodash.template",
					advisoryId: "GHSA-35jh-r3h4-6jhm",
					aliases: ["CVE-2021-23337"],
					severity: "high",
					summary: "Command injection in lodash template.",
					versions: ["4.5.0"],
					fixedIn: null,
					relation: "dev",
				},
				30 * DAY,
			),
			status: "dismissed",
			statusReason: "Only used by the docs build, never with user input.",
			statusChangedAt: nowMs - 6 * DAY,
		},
		{
			...finding(
				nowMs,
				{
					...PAYMENTS,
					id: FINDING_IDS.jwt,
					lockfilePath: "pnpm-lock.yaml",
					ecosystem: "npm",
					packageName: "jsonwebtoken",
					advisoryId: "GHSA-8cf7-32gw-wr33",
					aliases: ["CVE-2022-23539"],
					severity: "high",
					summary: "Insecure key types can be used for signature verification.",
					versions: ["8.5.1"],
					fixedIn: "9.0.0",
					relation: "direct",
				},
				40 * DAY,
			),
			status: "fixed",
			fixedScanId: SCAN_IDS.payments,
			fixedSha: SHAS.payments,
		},
	],
})

export const noFindings: DependencyFindingsResponse = {
	findings: [],
	production: { available: true, runningServices: 3, linkedServices: 3, complete: true },
}

const MANY_NAMES = [
	"billing-worker",
	"ingest-gateway",
	"admin",
	"mobile-bff",
	"notifications",
	"search",
	"auth",
	"reports",
	"scheduler",
	"docs",
	"sdk-js",
	"landing",
] as const

/** The fixture's three repositories and twelve more copied from them, past what the matrix gives a column. */
export const manyRepositoriesOf = (
	nowMs: number,
): Readonly<{ repositories: DependencyScanRepositoriesResponse; findings: DependencyFindingsResponse }> => {
	const sources = repositoriesOf(nowMs).repositories
	const findings = findingsOf(nowMs)
	const copies = Arr.flatMap(MANY_NAMES, (name, index) => {
		const source = sources[index % sources.length]
		return source === undefined
			? []
			: [
					{
						source,
						repository: {
							...source,
							id: repositoryId(
								`00000000-0000-4000-8000-0000000001${Str.padStart(2, "0")(String(index))}`,
							),
							fullName: `acme/${name}`,
						},
					},
				]
	})
	return {
		repositories: { repositories: [...sources, ...Arr.map(copies, ({ repository }) => repository)] },
		findings: {
			...findings,
			findings: [
				...findings.findings,
				...Arr.flatMap(copies, ({ source, repository }, copy) =>
					Arr.map(
						Arr.filter(findings.findings, (finding) => finding.repositoryId === source.id),
						(finding, index) => ({
							...finding,
							id: findingId(
								`${Str.padStart(2, "0")(String(copy))}${Str.padStart(2, "0")(String(index))}${Str.repeat(28)("c")}`,
							),
							repositoryId: repository.id,
							repositoryFullName: repository.fullName,
						}),
					),
				),
			],
		},
	}
}

type CatalogAdvisory = Readonly<{
	id: string
	severity: DependencyFindingView["severity"]
	fixedIn: string | null
	summary: string
}>

type CatalogPackage = Readonly<{
	ecosystem: DependencyFindingView["ecosystem"]
	name: string
	version: string
	lockfile: string
	/** How many repositories in a hundred carry it. */
	spread: number
	advisories: ReadonlyArray<CatalogAdvisory>
}>

const advisory = (
	id: string,
	severity: CatalogAdvisory["severity"],
	fixedIn: string | null,
	summary = "A crafted input reaches an unsafe code path.",
): CatalogAdvisory => ({ id, severity, fixedIn, summary })

const NPM = "pnpm-lock.yaml"
const CATALOG: ReadonlyArray<CatalogPackage> = [
	{
		ecosystem: "npm",
		name: "axios",
		version: "1.7.4",
		lockfile: NPM,
		spread: 55,
		advisories: [
			advisory("GHSA-jr5f-v2jv-69x6", "critical", "1.8.2"),
			advisory("GHSA-4hjh-wcwx-xvwj", "high", "1.12.0"),
		],
	},
	{
		ecosystem: "npm",
		name: "undici",
		version: "6.19.2",
		lockfile: NPM,
		spread: 48,
		advisories: [
			advisory("GHSA-c76h-2ccp-4975", "critical", "6.21.1"),
			advisory("GHSA-m4v8-wqvr-p9f7", "high", "6.21.1"),
			advisory("GHSA-3787-6prv-h9w3", "medium", "6.11.1"),
		],
	},
	{
		ecosystem: "npm",
		name: "vite",
		version: "5.4.2",
		lockfile: NPM,
		spread: 62,
		advisories: [
			advisory("GHSA-x574-m823-4x7w", "medium", "5.4.12"),
			advisory("GHSA-vg6x-rcgg-rjx6", "medium", "5.4.12"),
			advisory("GHSA-356w-63v5-8wf4", "low", "5.4.15"),
		],
	},
	{
		ecosystem: "npm",
		name: "esbuild",
		version: "0.21.5",
		lockfile: NPM,
		spread: 58,
		advisories: [advisory("GHSA-67mh-4wv8-2f99", "medium", "0.25.0")],
	},
	{
		ecosystem: "npm",
		name: "cross-spawn",
		version: "7.0.3",
		lockfile: NPM,
		spread: 70,
		advisories: [advisory("GHSA-3xgq-45jj-v275", "high", "7.0.5")],
	},
	{
		ecosystem: "npm",
		name: "path-to-regexp",
		version: "0.1.7",
		lockfile: NPM,
		spread: 30,
		advisories: [
			advisory("GHSA-9wv6-86v2-598j", "high", "0.1.10"),
			advisory("GHSA-rhx6-c78j-4q9w", "high", null),
		],
	},
	{
		ecosystem: "npm",
		name: "next",
		version: "14.1.0",
		lockfile: NPM,
		spread: 14,
		advisories: [
			advisory("GHSA-f82v-jwr5-mffw", "critical", "14.2.25"),
			advisory("GHSA-7gfc-8cq8-jh5f", "high", "14.2.15"),
		],
	},
	{
		ecosystem: "npm",
		name: "jsonwebtoken",
		version: "8.5.1",
		lockfile: NPM,
		spread: 12,
		advisories: [
			advisory("GHSA-27h2-hvpr-p74q", "high", "9.0.0"),
			advisory("GHSA-8cf7-32gw-wr33", "medium", "9.0.0"),
		],
	},
	{
		ecosystem: "npm",
		name: "ws",
		version: "8.16.0",
		lockfile: NPM,
		spread: 33,
		advisories: [advisory("GHSA-3h5v-q93c-6h6q", "high", "8.17.1")],
	},
	{
		ecosystem: "npm",
		name: "braces",
		version: "3.0.2",
		lockfile: NPM,
		spread: 66,
		advisories: [advisory("GHSA-grv7-fg5c-xmjg", "high", "3.0.3")],
	},
	{
		ecosystem: "npm",
		name: "micromatch",
		version: "4.0.5",
		lockfile: NPM,
		spread: 60,
		advisories: [advisory("GHSA-952p-6rrq-rcjv", "medium", "4.0.8")],
	},
	{
		ecosystem: "npm",
		name: "tar",
		version: "6.1.11",
		lockfile: NPM,
		spread: 28,
		advisories: [advisory("GHSA-f5x3-32g6-xq36", "medium", "6.2.1")],
	},
	{
		ecosystem: "npm",
		name: "semver",
		version: "7.5.1",
		lockfile: NPM,
		spread: 40,
		advisories: [advisory("GHSA-c2qf-rxjj-qqgw", "medium", "7.5.2")],
	},
	{
		ecosystem: "npm",
		name: "follow-redirects",
		version: "1.15.4",
		lockfile: NPM,
		spread: 42,
		advisories: [advisory("GHSA-cxjh-pqwp-8mfp", "medium", "1.15.6")],
	},
	{
		ecosystem: "npm",
		name: "marked",
		version: "4.0.9",
		lockfile: NPM,
		spread: 9,
		advisories: [advisory("GHSA-4r62-v4vq-hr96", "unknown", null)],
	},
	{
		ecosystem: "npm",
		name: "lodash.template",
		version: "4.5.0",
		lockfile: NPM,
		spread: 11,
		advisories: [advisory("GHSA-35jh-r3h4-6jhm", "high", null)],
	},
	{
		ecosystem: "npm",
		name: "body-parser",
		version: "1.20.2",
		lockfile: NPM,
		spread: 25,
		advisories: [advisory("GHSA-qwcr-r2fm-qrc7", "high", "1.20.3")],
	},
	{
		ecosystem: "npm",
		name: "express",
		version: "4.18.2",
		lockfile: NPM,
		spread: 24,
		advisories: [
			advisory("GHSA-qw6h-vgh9-j6wx", "low", "4.20.0"),
			advisory("GHSA-rv95-896h-c2vc", "medium", "4.19.2"),
		],
	},
	{
		ecosystem: "npm",
		name: "nanoid",
		version: "3.3.7",
		lockfile: NPM,
		spread: 36,
		advisories: [advisory("GHSA-mwcw-c2x4-8c55", "medium", "3.3.8")],
	},
	{
		ecosystem: "npm",
		name: "postcss",
		version: "8.4.24",
		lockfile: NPM,
		spread: 50,
		advisories: [advisory("GHSA-7fh5-64p2-3v2j", "medium", "8.4.31")],
	},
	{
		ecosystem: "Go",
		name: "golang.org/x/net",
		version: "0.33.0",
		lockfile: "go.sum",
		spread: 80,
		advisories: [
			advisory("GHSA-vvgc-356p-c3xw", "high", "0.36.0"),
			advisory("GHSA-qxp5-gwg8-xv66", "medium", "0.36.0"),
		],
	},
	{
		ecosystem: "Go",
		name: "golang.org/x/crypto",
		version: "0.30.0",
		lockfile: "go.sum",
		spread: 70,
		advisories: [
			advisory("GHSA-v778-237x-gjrc", "critical", "0.31.0"),
			advisory("GHSA-hcg3-q754-cr77", "high", "0.35.0"),
		],
	},
	{
		ecosystem: "Go",
		name: "google.golang.org/grpc",
		version: "1.58.2",
		lockfile: "go.sum",
		spread: 45,
		advisories: [advisory("GHSA-m425-mq94-257g", "high", "1.58.3")],
	},
	{
		ecosystem: "Go",
		name: "github.com/golang-jwt/jwt/v4",
		version: "4.5.0",
		lockfile: "go.sum",
		spread: 25,
		advisories: [advisory("GHSA-mh63-6h87-95cp", "high", "4.5.2")],
	},
	{
		ecosystem: "Go",
		name: "github.com/docker/docker",
		version: "24.0.7",
		lockfile: "go.sum",
		spread: 15,
		advisories: [advisory("GHSA-v23v-6jw2-98fq", "critical", null)],
	},
	{
		ecosystem: "crates.io",
		name: "tokio",
		version: "1.38.0",
		lockfile: "Cargo.lock",
		spread: 70,
		advisories: [advisory("RUSTSEC-2025-0023", "low", "1.38.2")],
	},
	{
		ecosystem: "crates.io",
		name: "rustls",
		version: "0.23.10",
		lockfile: "Cargo.lock",
		spread: 55,
		advisories: [advisory("RUSTSEC-2024-0399", "critical", "0.23.18")],
	},
	{
		ecosystem: "crates.io",
		name: "openssl",
		version: "0.10.64",
		lockfile: "Cargo.lock",
		spread: 35,
		advisories: [
			advisory("RUSTSEC-2025-0004", "high", "0.10.70"),
			advisory("RUSTSEC-2024-0357", "medium", "0.10.66"),
		],
	},
	{
		ecosystem: "crates.io",
		name: "hyper",
		version: "0.14.27",
		lockfile: "Cargo.lock",
		spread: 40,
		advisories: [advisory("RUSTSEC-2024-0042", "medium", "0.14.28")],
	},
	{
		ecosystem: "crates.io",
		name: "time",
		version: "0.1.45",
		lockfile: "Cargo.lock",
		spread: 20,
		advisories: [advisory("RUSTSEC-2020-0071", "medium", null)],
	},
]

const WORDS = [
	"api",
	"web",
	"worker",
	"gateway",
	"billing",
	"auth",
	"search",
	"admin",
	"notifications",
	"ingest",
	"reports",
	"scheduler",
	"sdk",
	"docs",
	"mobile",
	"edge",
	"ledger",
	"payments",
	"export",
	"sync",
] as const

/** A small deterministic generator, so the lab draws the same org every time. */
const seeded = (seed: number) => {
	let state = seed * 2654435761 + 1
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648
		return state / 2147483648
	}
}

/**
 * A large org: `count` repositories (npm, Go or Rust, a third of them running in production) and
 * the advisories their lockfiles carry, a few thousand findings. For stress-testing the tab.
 */
export const largeOrgOf = (
	nowMs: number,
	count: number,
): Readonly<{ repositories: DependencyScanRepositoriesResponse; findings: DependencyFindingsResponse }> => {
	const sources = repositoriesOf(nowMs).repositories
	const template = findingsOf(nowMs).findings[0]
	const ecosystems = ["npm", "npm", "npm", "Go", "crates.io"] as const
	const repositories = Array.from({ length: count }, (_, index) => {
		const random = seeded(index + 1)
		const source = sources[index % sources.length]
		const word = WORDS[Math.floor(random() * WORDS.length)] ?? "service"
		return {
			index,
			random,
			ecosystem: ecosystems[Math.floor(random() * ecosystems.length)] ?? "npm",
			isRunning: random() < 0.35,
			repository:
				source === undefined
					? null
					: {
							...source,
							id: repositoryId(
								`a0000000-0000-4000-8000-${Str.padStart(12, "0")(index.toString(16))}`,
							),
							fullName: `acme/${word}-${index}`,
						},
		}
	})
	let next = 0
	const findings = Arr.flatMap(repositories, ({ random, ecosystem, isRunning, repository }) =>
		repository === null || template === undefined
			? []
			: Arr.flatMap(
					Arr.filter(
						CATALOG,
						(entry) => entry.ecosystem === ecosystem && random() * 100 < entry.spread,
					),
					(entry: CatalogPackage) =>
						Arr.map(entry.advisories, (item) => {
							const roll = random()
							next += 1
							return {
								...template,
								id: findingId(Str.padStart(32, "0")(next.toString(16))),
								repositoryId: repository.id,
								repositoryFullName: repository.fullName,
								lockfilePath: entry.lockfile,
								ecosystem: entry.ecosystem,
								packageName: entry.name,
								advisoryId: item.id,
								aliases: [],
								severity: item.severity,
								summary: item.summary,
								versions: [entry.version],
								fixedIn: item.fixedIn,
								relation: roll < 0.4 ? ("direct" as const) : ("transitive" as const),
								status:
									roll < 0.06
										? ("dismissed" as const)
										: roll < 0.1
											? ("fixed" as const)
											: ("open" as const),
								production: isRunning ? template.production : [],
							}
						}),
				),
	)
	return {
		repositories: {
			repositories: Arr.flatMap(repositories, ({ repository }) =>
				repository === null ? [] : [repository],
			),
		},
		findings: { ...findingsOf(nowMs), findings },
	}
}
