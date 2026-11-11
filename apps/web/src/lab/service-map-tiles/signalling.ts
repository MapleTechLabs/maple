import { Array as Arr } from "effect"
import type { Block } from "./rails"

// How trains keep out of each other's way. Track that more than one line uses is divided into
// sections, and a section holds one train at a time. A train drives up to the signal before the
// first section on its way and waits there until every section between it and its destination
// is free, then takes them all at once and gives each back as its last wagon leaves it. A
// waiting train stands on its own line and holds nothing, so two trains can never each be
// waiting for track the other is on. A train is only as long as will stand clear of shared
// track at both its stations, so a parked train is never in another's way either.

/** One line and the train that works it. */
export interface Line {
	/** Station to station, in world units. */
	readonly length: number
	readonly wagons: number
	/** Top speed, world units per second. */
	readonly speed: number
	readonly blocks: ReadonlyArray<Block>
	/** How far apart the wagons ride; `COUPLING` unless the drawn wagons are another length. */
	readonly coupling?: number
}

/** Standing at home, running out, standing at the far station, backing home. */
export type Phase = "home" | "out" | "far" | "back"

export interface Train {
	readonly line: Line
	/** Where the engine's middle is, in units from its home station. */
	along: number
	speed: number
	phase: Phase
	/** Seconds left to stand at a station. */
	rest: number
	/** Waiting at a signal, or at a platform, for the line ahead. */
	isWaiting: boolean
	/** The sections ahead are its own until it arrives. */
	hasRoad: boolean
}

/** How far behind its engine, or the wagon in front, a wagon rides. */
export const COUPLING = 0.66
/** From an engine's middle to its front. */
const NOSE = 0.31
/** How far short of a buffer or a signal a train stops. */
const AIR = 0.25
/** Seconds a train stands at each station. */
export const STAND = 1.6
/** How far before its signal a train asks for the road, so a clear run never has to slow. */
const SIGHT = 1.4

/** From the engine's middle back to the end of its last wagon. */
export const tailOf = (line: Line): number => line.wagons * (line.coupling ?? COUPLING) + 0.27

/** Where the engine stands at home: its last wagon just clear of the buffer. */
export const homeOf = (line: Line): number => tailOf(line) + 0.1

/** Where the engine stands at the far station: its nose short of the buffer. */
export const farOf = (line: Line): number => line.length - NOSE - 0.11

const sectionsOf = (line: Line): ReadonlyArray<string> =>
	Arr.dedupe(Arr.map(line.blocks, (block) => block.section))

/** Where a train with no road yet must stop: short of the first section it meets going out, or
 * of the last one going back. */
const signalStop = (line: Line, direction: 1 | -1): number => {
	if (line.blocks.length === 0) return direction === 1 ? farOf(line) : homeOf(line)
	const first = Math.min(...Arr.map(line.blocks, (block) => block.from))
	const last = Math.max(...Arr.map(line.blocks, (block) => block.to))
	return direction === 1
		? Math.min(farOf(line), Math.max(homeOf(line), first - NOSE - AIR))
		: Math.max(homeOf(line), Math.min(farOf(line), last + tailOf(line) + AIR))
}

/** A signal beside a line: how far along it stands, which side of the track, and what it guards. */
export interface Signal {
	readonly along: number
	/** 1 stands to the right of a train running out, -1 to the right of one backing home. */
	readonly side: 1 | -1
	readonly guards: ReadonlyArray<string>
}

/** One signal each way, at the edge of the line's shared track. A line with none needs none. */
export const signalsOf = (line: Line): ReadonlyArray<Signal> => {
	if (line.blocks.length === 0) return []
	const first = Math.min(...Arr.map(line.blocks, (block) => block.from))
	const last = Math.max(...Arr.map(line.blocks, (block) => block.to))
	const guards = sectionsOf(line)
	return [
		{ along: Math.max(0.3, first - 0.3), side: 1, guards },
		{ along: Math.min(line.length - 0.3, last + 0.3), side: -1, guards },
	]
}

/** The most wagons a train on `line` can pull and still stand clear of shared track at both its
 * stations, signal gap included. Below zero, not even an engine on its own can. */
export const roomFor = (line: Line): number => {
	if (line.blocks.length === 0) return line.wagons
	const first = Math.min(...Arr.map(line.blocks, (block) => block.from))
	const last = Math.max(...Arr.map(line.blocks, (block) => block.to))
	// At home the nose must stop short of the first block; at the far station the tail must
	// have left the last one.
	const tail = Math.min(first - NOSE - AIR - 0.1, line.length - NOSE - 0.11 - AIR - last)
	return Math.min(line.wagons, Math.floor((tail - 0.27) / (line.coupling ?? COUPLING) + 1e-9))
}

/** A train for `line`, standing at home with `rest` seconds to go. It sheds wagons until it
 * stands clear of shared track at both stations. `null` when not even an engine can, or when
 * the line is too short to run on. */
export const makeTrain = (line: Line, rest: number): Train | null => {
	const wagons = roomFor(line)
	const fitted: Line = { ...line, wagons }
	return wagons < 0 || farOf(fitted) - homeOf(fitted) <= 0.2
		? null
		: {
				line: fitted,
				along: homeOf(fitted),
				speed: 0,
				phase: "home",
				rest,
				isWaiting: false,
				hasRoad: false,
			}
}

/** The train's wagons, counted back from the engine. An engine that had to shed them all has none. */
export const wagonsOf = (train: Train): ReadonlyArray<number> =>
	train.line.wagons < 1 ? [] : Arr.range(1, train.line.wagons)

/** Whether the train is carrying: loaded at home, emptied halfway through its stand at the far station. */
export const isLoaded = (train: Train): boolean =>
	train.phase === "home" || train.phase === "out" || (train.phase === "far" && train.rest > STAND / 2)

export interface SignalBox {
	readonly trains: ReadonlyArray<Train>
	/** Whether `section` has a train in it, or one with the road through it. */
	readonly isOccupied: (section: string) => boolean
	/** Moves every train on by `step` seconds. `pace` is how fast train `index` may go as a share
	 * of its top speed (0 holds it where it is); `mayLeave` says whether it may leave home. */
	readonly step: (
		step: number,
		pace: (index: number) => number,
		mayLeave: (index: number) => boolean,
	) => void
}

export const makeSignalBox = (trains: ReadonlyArray<Train>): SignalBox => {
	const holders = new Map<string, Train>()
	/** Trains asking for the road, first come first served. */
	const queue: Array<Train> = []
	const release = (train: Train, section: string) => {
		if (holders.get(section) === train) holders.delete(section)
	}
	const arrive = (train: Train, phase: "home" | "far") => {
		Arr.forEach(sectionsOf(train.line), (section) => release(train, section))
		train.phase = phase
		train.rest = STAND
		train.speed = 0
		train.hasRoad = false
		train.isWaiting = false
	}
	const run = (train: Train, direction: 1 | -1, step: number, pace: number) => {
		const { line } = train
		const goal = direction === 1 ? farOf(line) : homeOf(line)
		const free = train.hasRoad || line.blocks.length === 0
		const stop = signalStop(line, direction)
		// A train never backs up to its signal: one already past it stops where it is.
		const limit = free
			? goal
			: direction === 1
				? Math.max(train.along, stop)
				: Math.min(train.along, stop)
		const left = Math.max(0, (limit - train.along) * direction)
		if (!free && left < SIGHT && !queue.includes(train)) queue.push(train)
		const top = line.speed * pace
		// Brake so as to stop on the mark, with a crawl to finish on.
		const wanted = left <= 0 ? 0 : Math.min(top, Math.max(0.06, Math.sqrt(2 * top * 1.5 * left)))
		train.speed = wanted > train.speed ? Math.min(wanted, train.speed + top * 1.2 * step) : wanted
		const moved = Math.min(left, train.speed * step)
		train.along += direction * moved
		train.isWaiting = !free && left - moved <= 1e-3
		if (train.hasRoad)
			Arr.forEach(sectionsOf(line), (section) => {
				const own = Arr.filter(line.blocks, (block) => block.section === section)
				const passed =
					direction === 1
						? train.along - tailOf(line) > Math.max(...Arr.map(own, (block) => block.to))
						: train.along + NOSE < Math.min(...Arr.map(own, (block) => block.from))
				if (passed) release(train, section)
			})
		if (free && left - moved <= 1e-3) arrive(train, direction === 1 ? "far" : "home")
	}
	return {
		trains,
		isOccupied: (section) => holders.has(section),
		step: (step, pace, mayLeave) => {
			Arr.forEach(trains, (train, index) => {
				const speed = pace(index)
				if (speed <= 0) return
				if (train.phase === "home" || train.phase === "far") {
					train.rest = Math.max(0, train.rest - step)
					if (train.rest > 0 || (train.phase === "home" && !mayLeave(index))) return
					train.phase = train.phase === "home" ? "out" : "back"
				}
				run(train, train.phase === "out" ? 1 : -1, step, speed)
			})
			// The road goes to whoever asked first and can have all of it.
			Arr.forEach([...queue], (train) => {
				const wanted = sectionsOf(train.line)
				if (Arr.some(wanted, (section) => holders.has(section))) return
				Arr.forEach(wanted, (section) => holders.set(section, train))
				train.hasRoad = true
				train.isWaiting = false
				queue.splice(queue.indexOf(train), 1)
			})
		},
	}
}
