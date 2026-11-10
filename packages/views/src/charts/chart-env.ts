import { Schema } from "effect"
import { ChartRuntime } from "./chart-runtime"
import { ThemeColors } from "./theme-colors"

// What a page with charts keeps beside its data: the chart library's load state and the theme
// colours its canvases draw with. A page spreads these into its Model, Message and `update`.

/** The Model fields: `chartRuntime` starts `Loading`, `themeColors` starts `null`. */
export const ChartEnvFields = {
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
}

/** The Messages `LoadChartRuntime` answers with. */
export const ChartRuntimeMessages = {
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
}

/** `ChartRuntimeMessages` plus the colours `ResolveThemeColors` reads. */
export const ChartEnvMessages = {
	...ChartRuntimeMessages,
	ResolvedThemeColors: { colors: ThemeColors },
}

type RuntimeHost = Readonly<{ chartRuntime: ChartRuntime | null }>
type EnvHost = RuntimeHost & Readonly<{ themeColors: ThemeColors | null }>

/** The `update` handlers for `ChartRuntimeMessages`. */
export const chartRuntimeHandlers = <M extends RuntimeHost>(model: M) => ({
	CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: ChartRuntime.Ready() } }),
	FailedLoadChartRuntime: ({ reason }: Readonly<{ reason: string }>) => ({
		model: { ...model, chartRuntime: ChartRuntime.Failed({ reason }) },
	}),
})

/** The `update` handlers for `ChartEnvMessages`. */
export const chartEnvHandlers = <M extends EnvHost>(model: M) => ({
	...chartRuntimeHandlers(model),
	ResolvedThemeColors: ({ colors }: Readonly<{ colors: ThemeColors }>) => ({
		model: { ...model, themeColors: colors },
	}),
})
