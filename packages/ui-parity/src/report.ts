import { Array as Arr } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { ariaRole } from "./behavior.ts"
import { type CaptureResult, type CaptureVariant, captureDir } from "./capture.ts"
import { compareVariant, type VariantComparison } from "./compare.ts"
import { outDir } from "./config.ts"

/** A capture that crashed, logged errors or (with a real backend) hit unmocked endpoints is not evidence of parity. */
export const isUnhealthy = (result: CaptureResult) =>
	!result.ok || result.consoleErrors.length > 0 || (!result.nullBackend && result.unmocked.length > 0)

export interface CompareRunInput {
	readonly run: string
	readonly baselineLabel: string
	readonly candidateLabel: string
	readonly variants: ReadonlyArray<CaptureVariant>
	readonly baselineResults: ReadonlyArray<CaptureResult>
	readonly candidateResults: ReadonlyArray<CaptureResult>
	readonly tolerance?: number
	readonly strictA11y?: boolean
}

/** Diffs every variant of a run, writes summary.json, summary.md and index.html, prints the totals. */
export const compareRun = (input: CompareRunInput) => {
	const runDir = join(outDir, "runs", input.run)
	const diffDir = join(runDir, "diff")
	mkdirSync(diffDir, { recursive: true })
	const unhealthy = new Set(
		[...input.baselineResults, ...input.candidateResults]
			.filter(isUnhealthy)
			.map((result) => result.variantId),
	)
	const comparisons = input.variants.map((variant) => {
		const comparison = compareVariant({
			variantId: variant.id,
			baselineDir: captureDir(input.run, input.baselineLabel),
			candidateDir: captureDir(input.run, input.candidateLabel),
			outDir: diffDir,
			tolerance: input.tolerance ?? 0,
			strictA11y: input.strictA11y ?? false,
			ignoreBackgroundCalls: variant.scenario.path.startsWith("/lab"),
			ignoreCalls: variant.scenario.pageCalls,
		})
		return unhealthy.has(variant.id) && comparison.status !== "missing"
			? { ...comparison, status: "fail" as const }
			: comparison
	})
	const summary = buildSummary({
		run: input.run,
		baseline: input.baselineLabel,
		candidate: input.candidateLabel,
		variants: input.variants,
		comparisons,
		baselineResults: input.baselineResults,
		candidateResults: input.candidateResults,
	})
	const report = writeReport(summary, runDir)
	const { identical, pass, fail, missing } = summary.totals
	console.log(`\nidentical ${identical} · pass ${pass} · fail ${fail} · missing ${missing}`)
	console.log(`report:  ${report}\nsummary: ${join(runDir, "summary.md")}`)
	return summary
}

export interface RunSummary {
	readonly run: string
	readonly baseline: string
	readonly candidate: string
	readonly createdAt: string
	readonly totals: Record<VariantComparison["status"], number>
	readonly variants: ReadonlyArray<{
		readonly variant: {
			readonly id: string
			readonly scenario: string
			readonly title: string
			readonly area: string
			readonly viewport: string
			readonly theme: string
			readonly path: string
		}
		readonly comparison: VariantComparison
		readonly baselineCapture?: CaptureResult
		readonly candidateCapture?: CaptureResult
	}>
}

export const buildSummary = (input: {
	run: string
	baseline: string
	candidate: string
	variants: ReadonlyArray<CaptureVariant>
	comparisons: ReadonlyArray<VariantComparison>
	baselineResults: ReadonlyArray<CaptureResult>
	candidateResults: ReadonlyArray<CaptureResult>
}): RunSummary => {
	const totals = { identical: 0, pass: 0, fail: 0, missing: 0 }
	// compareRun builds `comparisons` from `variants` index for index, so zip loses nothing.
	const variants = Arr.zip(input.variants, input.comparisons).map(([variant, comparison]) => {
		totals[comparison.status]++
		return {
			variant: {
				id: variant.id,
				scenario: variant.scenario.id,
				title: variant.scenario.title,
				area: variant.scenario.area,
				viewport: variant.viewport,
				theme: variant.theme,
				path: variant.scenario.path,
			},
			comparison,
			baselineCapture: input.baselineResults.find((result) => result.variantId === variant.id),
			candidateCapture: input.candidateResults.find((result) => result.variantId === variant.id),
		}
	})
	return {
		run: input.run,
		baseline: input.baseline,
		candidate: input.candidate,
		createdAt: new Date().toISOString(),
		totals,
		variants,
	}
}

/** Compact, agent-readable digest: worst variants first, top regions and deltas only. */
export const renderMarkdown = (summary: RunSummary, runDir: string) => {
	const lines = [
		`# UI parity: ${summary.candidate} vs ${summary.baseline} (${summary.run})`,
		"",
		`identical ${summary.totals.identical} · pass ${summary.totals.pass} · fail ${summary.totals.fail} · missing ${summary.totals.missing}`,
		"",
	]
	const behaviorOnly = summary.variants.filter(
		({ comparison }) =>
			comparison.behavior.length > 0 &&
			(comparison.visualStatus === "identical" || comparison.visualStatus === "pass"),
	)
	const withBehavior = summary.variants.filter(({ comparison }) => comparison.behavior.length > 0)
	if (withBehavior.length)
		lines.push(
			`behavior: ${withBehavior.length} variants send different backend calls (${behaviorOnly.length} of them identical or pass on pixels).`,
			"",
		)
	const ranked = [...summary.variants].sort(
		(a, b) => b.comparison.perceptualPixels - a.comparison.perceptualPixels,
	)
	for (const { variant, comparison, baselineCapture, candidateCapture } of ranked) {
		if (comparison.status === "identical") continue
		lines.push(
			`## ${variant.id}: ${comparison.status.toUpperCase()} (${comparison.mismatchPercent}% / ${comparison.perceptualPixels}px)`,
		)
		lines.push(`${variant.title} · \`${variant.path}\``)
		for (const [side, capture] of [
			[summary.baseline, baselineCapture],
			[summary.candidate, candidateCapture],
		] as const) {
			if (capture?.error) lines.push(`- ${side} capture error: ${capture.error}`)
			for (const line of capture?.consoleErrors.slice(0, 3) ?? [])
				lines.push(`- ${side} console: ${line}`)
			if (capture?.unmocked.length)
				lines.push(
					`- ${side} unmocked: ${capture.unmocked.slice(0, 8).join(", ")}${capture.unmocked.length > 8 ? " ..." : ""}`,
				)
		}
		if (comparison.sizeMismatch) lines.push(`- page size differs`)
		for (const line of comparison.behavior.slice(0, 10)) lines.push(`- ${line}`)
		if (comparison.behavior.length > 10)
			lines.push(`- ...${comparison.behavior.length - 10} more call differences`)
		lines.push(
			`- images: ${relative(runDir, join(runDir, summary.baseline, `${variant.id}.png`))}, ${summary.candidate}/${variant.id}.png, diff/${comparison.diffImage}`,
		)
		for (const region of comparison.regions.slice(0, 5)) {
			lines.push(
				`- region ${region.x},${region.y} ${region.width}×${region.height} (${region.pixels}px): ${region.nodes.join(", ") || "no structural match"}`,
			)
		}
		// Root causes first: identical style changes are grouped ("font-weight 600 → 500 on 9 text runs"),
		// then elements that only moved (usually knock-on effects of the above).
		const styleGroups = new Map<string, string[]>()
		for (const delta of comparison.deltas) {
			if (!delta.styles.length) continue
			const signature = delta.styles
				.map((style) => `${style.prop}: ${style.baseline} → ${style.candidate}`)
				.join("; ")
			styleGroups.set(signature, [...(styleGroups.get(signature) ?? []), delta.label])
		}
		for (const [signature, labels] of [...styleGroups]
			.sort((a, b) => b[1].length - a[1].length)
			.slice(0, 10)) {
			lines.push(
				`  - {${signature}} on ${labels.length}: ${labels.slice(0, 6).join(" | ")}${labels.length > 6 ? " ..." : ""}`,
			)
		}
		const moves = comparison.deltas
			.filter((delta) => !delta.styles.length)
			.sort(
				(a, b) =>
					Math.abs(b.moved.dx) +
					Math.abs(b.moved.dy) +
					Math.abs(b.moved.dw) +
					Math.abs(b.moved.dh) -
					(Math.abs(a.moved.dx) +
						Math.abs(a.moved.dy) +
						Math.abs(a.moved.dw) +
						Math.abs(a.moved.dh)),
			)
		for (const delta of moves.slice(0, 8)) {
			const move = Object.entries(delta.moved)
				.filter(([, v]) => Math.abs(v) > 0.5)
				.map(([k, v]) => `${k}=${v}`)
				.join(" ")
			lines.push(`  - moved: ${delta.label} [${move}]`)
		}
		if (moves.length > 8) lines.push(`  - ...${moves.length - 8} more moved elements`)
		if (comparison.missingInCandidate.length)
			lines.push(
				`  - missing in ${summary.candidate}: ${comparison.missingInCandidate
					.slice(0, 10)
					.map((node) => node.label)
					.join(" | ")}`,
			)
		if (comparison.extraInCandidate.length)
			lines.push(
				`  - extra in ${summary.candidate}: ${comparison.extraInCandidate
					.slice(0, 10)
					.map((node) => node.label)
					.join(" | ")}`,
			)
		lines.push("")
	}
	lines.push(...renderA11y(summary))
	return lines.join("\n")
}

/**
 * ARIA snapshot differences, grouped by role across the run. Report-only unless `--strict-a11y`,
 * so existing deltas can be triaged before they gate anything.
 */
const renderA11y = (summary: RunSummary) => {
	const affected = summary.variants.filter(
		({ comparison }) => comparison.a11y.missing.length + comparison.a11y.extra.length > 0,
	)
	if (!affected.length) return ["## a11y deltas", "", "None.", ""]
	const groups = new Map<string, { variants: Set<string>; lines: Map<string, number> }>()
	for (const { variant, comparison } of affected) {
		for (const [change, list] of [
			[`missing in ${summary.candidate}`, comparison.a11y.missing],
			[`extra in ${summary.candidate}`, comparison.a11y.extra],
		] as const) {
			for (const line of list) {
				const key = `${change}: ${ariaRole(line)}`
				const group = groups.get(key) ?? { variants: new Set(), lines: new Map() }
				group.variants.add(variant.id)
				group.lines.set(line, (group.lines.get(line) ?? 0) + 1)
				groups.set(key, group)
			}
		}
	}
	const lines = [
		"## a11y deltas",
		"",
		`${affected.length} variants differ in their ARIA tree. Groups by role, most widespread first:`,
		"",
	]
	for (const [key, group] of [...groups]
		.sort((a, b) => b[1].variants.size - a[1].variants.size)
		.slice(0, 25)) {
		const examples = [...group.lines]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([line, count]) => `\`${line.slice(0, 80)}\` ×${count}`)
		lines.push(`- ${key} in ${group.variants.size} variants: ${examples.join(", ")}`)
	}
	lines.push("", "Per variant (missing / extra lines):", "")
	for (const { variant, comparison } of affected)
		lines.push(`- ${variant.id}: -${comparison.a11y.missing.length} / +${comparison.a11y.extra.length}`)
	lines.push("")
	return lines
}

export const writeReport = (summary: RunSummary, runDir: string) => {
	writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2))
	writeFileSync(join(runDir, "summary.md"), renderMarkdown(summary, runDir))
	writeFileSync(join(runDir, "index.html"), renderHtml(summary))
	return join(runDir, "index.html")
}

const renderHtml = (summary: RunSummary) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>UI Parity Report</title>
<style>
:root { --bg:#fafafa; --panel:#fff; --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --accent:#6938ef; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0b0d; --panel:#16161a; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#0b0b0d; --panel:#16161a; --fg:#f4f4f5; --muted:#a1a1aa; --line:#27272a; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
header { position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:12px 16px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { font-size:14px; margin:0 8px 0 0; }
.pill { display:inline-flex; gap:6px; align-items:center; padding:2px 8px; border-radius:999px; border:1px solid var(--line); font-variant-numeric: tabular-nums; }
.dot { width:8px; height:8px; border-radius:50%; }
.identical .dot, .dot.identical { background:var(--ok); } .pass .dot, .dot.pass { background:#65a30d; } .fail .dot, .dot.fail { background:var(--bad); } .missing .dot, .dot.missing { background:var(--warn); }
button, select, input { font:inherit; color:inherit; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
.layout { display:grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 53px); }
nav { border-right:1px solid var(--line); overflow:auto; max-height: calc(100vh - 53px); position:sticky; top:53px; }
nav a { display:flex; justify-content:space-between; gap:8px; padding:7px 12px; color:inherit; text-decoration:none; border-bottom:1px solid var(--line); }
nav a[aria-current="true"] { background:color-mix(in oklab, var(--accent) 12%, transparent); }
nav small { color:var(--muted); font-variant-numeric: tabular-nums; }
main { padding:16px; min-width:0; }
.meta { color:var(--muted); margin:4px 0 12px; }
.modes { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; align-items:center; }
.stage { position:relative; display:inline-block; max-width:100%; border:1px solid var(--line); background:repeating-conic-gradient(#8881 0% 25%, transparent 0% 50%) 0 / 16px 16px; }
.stage img { display:block; max-width:100%; height:auto; }
.stage .top { position:absolute; inset:0; }
.stage .top img { width:100%; }
.side { display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:12px; }
.side figure { margin:0; } .side figcaption { color:var(--muted); margin-bottom:4px; }
.region { position:absolute; border:2px solid var(--bad); background:color-mix(in oklab, var(--bad) 10%, transparent); pointer-events:auto; cursor:pointer; }
.region:hover, .region.active { border-color:var(--accent); }
table { border-collapse:collapse; width:100%; margin-top:16px; font-size:12px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; }
code { font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
tr.hl { background:color-mix(in oklab, var(--accent) 12%, transparent); }
.errors { color:var(--bad); }
@media (max-width: 800px) { .layout { grid-template-columns: 1fr; } nav { position:static; max-height:240px; } }
</style>
</head>
<body>
<header>
  <h1>UI parity · ${summary.candidate} vs ${summary.baseline}</h1>
  <span class="pill identical"><span class="dot"></span>identical ${summary.totals.identical}</span>
  <span class="pill pass"><span class="dot"></span>pass ${summary.totals.pass}</span>
  <span class="pill fail"><span class="dot"></span>fail ${summary.totals.fail}</span>
  <span class="pill missing"><span class="dot"></span>missing ${summary.totals.missing}</span>
  <select id="filter" aria-label="Filter"><option value="">all</option><option value="fail">fail</option><option value="pass">pass</option><option value="identical">identical</option><option value="missing">missing</option></select>
  <span class="meta" style="margin:0">${summary.run} · ${summary.createdAt}</span>
</header>
<div class="layout">
  <nav id="list"></nav>
  <main id="detail"></main>
</div>
<script>
const summary = ${JSON.stringify(summary).replace(/</g, "\\u003c")};
const B = summary.baseline, C = summary.candidate;
const list = document.getElementById("list"), detail = document.getElementById("detail"), filter = document.getElementById("filter");
let mode = localStorageGet("mode") || "swipe", current = null, blinkTimer = null;
function localStorageGet(k){ try { return localStorage.getItem("parity:"+k) } catch { return null } }
function localStorageSet(k,v){ try { localStorage.setItem("parity:"+k,v) } catch {} }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ranked = [...summary.variants].sort((a,b) => b.comparison.perceptualPixels - a.comparison.perceptualPixels);
function renderList(){
  const f = filter.value;
  list.innerHTML = ranked.filter(v => !f || v.comparison.status === f).map(v =>
    '<a href="#'+v.variant.id+'" aria-current="'+(current===v.variant.id)+'"><span><span class="dot '+v.comparison.status+'" style="display:inline-block;margin-right:6px"></span>'+esc(v.variant.id)+'</span><small>'+v.comparison.mismatchPercent+'%</small></a>').join("");
}
function img(target, id){ return target + "/" + id + ".png"; }
function regionsOverlay(c){
  if (!c.width) return "";
  return c.regions.map((r,i) => '<div class="region" data-i="'+i+'" title="'+r.pixels+'px" style="left:'+(r.x/c.width*100)+'%;top:'+(r.y/c.height*100)+'%;width:'+(r.width/c.width*100)+'%;height:'+(r.height/c.height*100)+'%"></div>').join("");
}
function stage(v){
  const id = v.variant.id, c = v.comparison;
  clearInterval(blinkTimer);
  if (mode === "side") return '<div class="side"><figure><figcaption>'+B+'</figcaption><img src="'+img(B,id)+'"></figure><figure><figcaption>'+C+'</figcaption><img src="'+img(C,id)+'"></figure><figure><figcaption>diff</figcaption><img src="diff/'+c.diffImage+'"></figure></div>';
  if (mode === "diff") return '<div class="stage"><img src="diff/'+c.diffImage+'">'+regionsOverlay(c)+'</div>';
  if (mode === "swipe") return '<input type="range" id="swipe" min="0" max="100" value="50" aria-label="Swipe position" style="width:320px"><div class="stage"><img src="'+img(B,id)+'"><div class="top" id="top" style="clip-path:inset(0 0 0 50%)"><img src="'+img(C,id)+'"></div>'+regionsOverlay(c)+'</div>';
  if (mode === "onion") return '<input type="range" id="onion" min="0" max="100" value="50" aria-label="Candidate opacity" style="width:320px"><div class="stage"><img src="'+img(B,id)+'"><div class="top" id="top" style="opacity:.5"><img src="'+img(C,id)+'"></div>'+regionsOverlay(c)+'</div>';
  if (mode === "blink") { setTimeout(() => { const top = document.getElementById("top"); blinkTimer = setInterval(() => { if (top) top.style.visibility = top.style.visibility === "hidden" ? "visible" : "hidden"; }, 450); }); return '<div class="stage"><img src="'+img(B,id)+'"><div class="top" id="top"><img src="'+img(C,id)+'"></div>'+regionsOverlay(c)+'</div>'; }
}
function deltasTable(c){
  const rows = c.deltas.map(d => {
    const mv = Object.entries(d.moved).filter(([,x]) => Math.abs(x) > 0.5).map(([k,x]) => k+"="+x).join(" ");
    const st = d.styles.map(s => "<code>"+esc(s.prop)+"</code> "+esc(s.baseline)+" → <b>"+esc(s.candidate)+"</b>").join("<br>");
    return '<tr data-key="'+esc(d.key)+'"><td>'+d.kind+'</td><td>'+esc(d.label)+'<br><code>'+esc(d.path.candidate)+'</code></td><td>'+mv+'</td><td>'+st+'</td></tr>';
  });
  const miss = c.missingInCandidate.map(n => '<tr data-key="missing '+esc(n.key)+'"><td>missing</td><td>'+esc(n.label)+'</td><td>'+n.rect.x+','+n.rect.y+'</td><td><code>'+esc(n.path)+'</code></td></tr>');
  const extra = c.extraInCandidate.map(n => '<tr data-key="extra '+esc(n.key)+'"><td>extra</td><td>'+esc(n.label)+'</td><td>'+n.rect.x+','+n.rect.y+'</td><td><code>'+esc(n.path)+'</code></td></tr>');
  if (!rows.length && !miss.length && !extra.length) return "<p class='meta'>No structural differences.</p>";
  return '<table><thead><tr><th>kind</th><th>element</th><th>moved</th><th>styles ('+B+' → '+C+')</th></tr></thead><tbody>'+rows.join("")+miss.join("")+extra.join("")+'</tbody></table>';
}
function renderDetail(id){
  const v = summary.variants.find(x => x.variant.id === id) || ranked[0];
  if (!v) { detail.innerHTML = "<p>No variants.</p>"; return; }
  current = v.variant.id; renderList();
  const c = v.comparison;
  const errs = [v.baselineCapture, v.candidateCapture].flatMap((cap, i) => cap ? [cap.error && ((i?C:B)+": "+cap.error), ...(cap.consoleErrors||[]).slice(0,3).map(e => (i?C:B)+" console: "+e), ...(cap.unmocked||[]).slice(0,5).map(e => (i?C:B)+" unmocked: "+e)].filter(Boolean) : []).concat((c.behavior||[]).slice(0,10));
  const a11y = c.a11y && (c.a11y.missing.length || c.a11y.extra.length) ? '<details class="meta"><summary>a11y deltas: -'+c.a11y.missing.length+' / +'+c.a11y.extra.length+'</summary><pre>'+c.a11y.missing.map(l => "- "+esc(l)).concat(c.a11y.extra.map(l => "+ "+esc(l))).join("\\n")+'</pre></details>' : "";
  detail.innerHTML =
    '<h2 style="margin:0;font-size:16px">'+esc(v.variant.title)+'</h2>'+
    '<div class="meta"><span class="dot '+c.status+'" style="display:inline-block"></span> '+c.status+' · '+c.perceptualPixels+'px perceptual · '+c.strictPixels+'px strict · '+c.mismatchPercent+'% · '+v.variant.viewport+' · '+v.variant.theme+' · <code>'+esc(v.variant.path)+'</code>'+(c.sizeMismatch?' · <b>size differs</b>':'')+'</div>'+
    (errs.length ? '<div class="errors">'+errs.map(esc).join("<br>")+'</div>' : '')+a11y+
    '<div class="modes">'+["swipe","onion","blink","side","diff"].map(m => '<button data-mode="'+m+'" aria-pressed="'+(m===mode)+'">'+m+'</button>').join("")+'<span class="meta" style="margin:0">keys: 1-5 modes · j/k next/prev</span></div>'+
    stage(v) + deltasTable(c);
  const swipe = document.getElementById("swipe"), onion = document.getElementById("onion"), top = document.getElementById("top");
  if (swipe) swipe.oninput = () => top.style.clipPath = "inset(0 0 0 "+swipe.value+"%)";
  if (onion) onion.oninput = () => top.style.opacity = onion.value/100;
  detail.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { mode = b.dataset.mode; localStorageSet("mode", mode); renderDetail(current); });
  detail.querySelectorAll(".region").forEach(el => el.onclick = () => {
    detail.querySelectorAll(".region").forEach(r => r.classList.remove("active")); el.classList.add("active");
    const keys = new Set(c.regions[+el.dataset.i].nodes);
    detail.querySelectorAll("tr[data-key]").forEach(tr => tr.classList.toggle("hl", keys.has(tr.dataset.key)));
    const first = detail.querySelector("tr.hl"); if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}
filter.onchange = renderList;
window.onhashchange = () => renderDetail(decodeURIComponent(location.hash.slice(1)));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const modes = ["swipe","onion","blink","side","diff"];
  if (e.key >= "1" && e.key <= "5") { mode = modes[+e.key-1]; localStorageSet("mode", mode); renderDetail(current); }
  if (e.key === "j" || e.key === "k") { const i = ranked.findIndex(v => v.variant.id === current); const n = ranked[Math.max(0, Math.min(ranked.length-1, i + (e.key === "j" ? 1 : -1)))]; location.hash = n.variant.id; }
});
renderDetail(decodeURIComponent(location.hash.slice(1)));
</script>
</body>
</html>`
