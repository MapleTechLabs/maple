/**
 * Slug → component maps.
 *
 * These live outside `lib/features.ts` on purpose: `NavBar.ts` is a
 * `client:load` island that reads the registry, so anything the registry
 * imports ships to the browser. The registry stores string ids; this module —
 * imported only by the two Astro templates — resolves them to components.
 *
 * Astro renders a capitalised local as a component, so the templates do
 * `const Artifact = ARTIFACTS[id]` then `<Artifact />`.
 *
 * Every entry is an Astro component. The two React artifacts are wrapped in
 * thin `.astro` files under `artifacts/`, because Astro builds a hydration
 * script from the static import at the call site — a component resolved out of
 * this map has no import path and cannot take a `client:*` directive.
 */
import type { ArtifactId, HeroAsideId, SectionId } from "../../lib/page-registry"
import { LiveCostStatement } from "../live/LiveCostStatement"
import LiveAlertFiring from "../live/LiveAlertFiring.astro"
import LiveAnomaly from "../live/LiveAnomaly.astro"
import LiveBrowserSessions from "../live/LiveBrowserSessions.astro"
import LiveFunnel from "../live/LiveFunnel.astro"
import LiveK8sHeatmap from "../live/LiveK8sHeatmap.astro"
import LiveLogs from "../live/LiveLogs.astro"
import LiveMcpTranscript from "../live/LiveMcpTranscript.astro"
import LiveServiceMap from "../live/LiveServiceMap.astro"
import LiveStatusPage from "../live/LiveStatusPage.astro"
import LiveUptime from "../live/LiveUptime.astro"
import LogsVolume from "./artifacts/LogsVolume.astro"
import PrReview from "./artifacts/PrReview.astro"
import StatusPageHero from "./artifacts/StatusPageHero.astro"
import TraceExplorer from "./artifacts/TraceExplorer.astro"
import TraceWaterfallHero from "./artifacts/TraceWaterfallHero.astro"
import K8sConsole from "./sections/K8sConsole.astro"
import K8sCorrelation from "./sections/K8sCorrelation.astro"
import K8sInstall from "./sections/K8sInstall.astro"
import K8sViews from "./sections/K8sViews.astro"
import CostBudgets from "./sections/CostBudgets.astro"
import CostExplorer from "./sections/CostExplorer.astro"
import CostSources from "./sections/CostSources.astro"
import GitHubAfterMerge from "./sections/GitHubAfterMerge.astro"
import GitHubCi from "./sections/GitHubCi.astro"
import ProductEventsPaths from "./sections/ProductEventsPaths.astro"
import ProductEventsSources from "./sections/ProductEventsSources.astro"
import StatusPageFeeds from "./sections/StatusPageFeeds.astro"
import UptimeCheckTrace from "./sections/UptimeCheckTrace.astro"
import UptimeSetup from "./sections/UptimeSetup.astro"

/**
 * `satisfies`, not an annotation: it checks that every id has an entry while
 * keeping the inferred component types, so indexing these yields a renderable
 * component union rather than `unknown` — which Astro rejects as "not a valid
 * component".
 */
export const ARTIFACTS = {
	"trace-visualization": TraceExplorer,
	"browser-sessions": LiveBrowserSessions,
	"log-stream": LiveLogs,
	"logs-volume": LogsVolume,
	"service-map": LiveServiceMap,
	"mcp-transcript": LiveMcpTranscript,
	"k8s-heatmap": LiveK8sHeatmap,
	"alert-firing": LiveAlertFiring,
	funnel: LiveFunnel,
	"pr-review": PrReview,
	uptime: LiveUptime,
	anomaly: LiveAnomaly,
	"status-page": LiveStatusPage,
} satisfies Record<ArtifactId, unknown>

export const EXTRA_SECTIONS = {
	"k8s-console": K8sConsole,
	"k8s-views": K8sViews,
	"k8s-correlation": K8sCorrelation,
	"k8s-install": K8sInstall,
	"product-events-paths": ProductEventsPaths,
	"product-events-sources": ProductEventsSources,
	"github-ci": GitHubCi,
	"github-after-merge": GitHubAfterMerge,
	"uptime-check-trace": UptimeCheckTrace,
	"uptime-setup": UptimeSetup,
	"status-page-feeds": StatusPageFeeds,
	"cost-explorer": CostExplorer,
	"cost-sources": CostSources,
	"cost-budgets": CostBudgets,
} satisfies Record<SectionId, unknown>

/** The artifact as the hero shows it: the status page is shorter there than in a section. */
export const HERO_ARTIFACTS = {
	...ARTIFACTS,
	"status-page": StatusPageHero,
} satisfies Record<ArtifactId, unknown>

/** Hero pieces that are not the page's artifact. The island wrappers carry their own `client:*`. */
export const HERO_ASIDES = {
	"cost-statement": LiveCostStatement,
	"trace-waterfall": TraceWaterfallHero,
} satisfies Record<HeroAsideId, unknown>
