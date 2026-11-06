/** A design token (`--chart-p99`) or a literal colour. */
export type PlotColorToken = `--${string}` | (string & {})

/** The chrome colours every chart needs, resolved to literals for the current theme. */
export type PlotChromeColors = Readonly<{ border: string; background: string }>
