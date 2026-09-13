import * as React from "react"

/**
 * The IANA zone every plot under the provider prints its clock in.
 *
 * The app owns the preference (an atom over localStorage); the plot layer only
 * needs the resolved zone name, so it reaches the charts through a context
 * rather than a prop on each of them — a dashboard tile, an infra chart, and a
 * lab spike would otherwise all have to thread the same string. `undefined`
 * means "the browser's zone", which is what every `toLocale*` call does with
 * no `timeZone` option, so a plot mounted outside the provider (tests, the
 * component gallery) keeps rendering unchanged.
 */
const PlotTimeZoneContext = React.createContext<string | undefined>(undefined)

export function PlotTimeZoneProvider({
	timeZone,
	children,
}: {
	timeZone: string | undefined
	children: React.ReactNode
}) {
	return <PlotTimeZoneContext.Provider value={timeZone}>{children}</PlotTimeZoneContext.Provider>
}

/** The zone plots print in, or `undefined` for the browser's. */
export function usePlotTimeZone(): string | undefined {
	return React.useContext(PlotTimeZoneContext)
}
