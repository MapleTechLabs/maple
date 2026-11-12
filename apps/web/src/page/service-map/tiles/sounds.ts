import { Array as Arr } from "effect"
import { seeded } from "./solid"

// The map's small noises, synthesized: no audio files. Every sound answers a click, so the
// context opens inside the gesture, as the duck's quack does.

export interface Sounds {
	/** A steam whistle: two toots. */
	readonly whistle: () => void
	/** `times` quick chirps: birds taking fright. */
	readonly chirp: (times: number) => void
	/** A church bell, struck once. */
	readonly bell: () => void
	/** A stone in the water. */
	readonly splash: () => void
	/** A lighthouse's horn. */
	readonly horn: () => void
	/** A cart's bell. */
	readonly ding: () => void
	readonly close: () => void
}

/** How loud the whole map is: these are asides, not alerts. */
const VOLUME = 0.22

interface Voice {
	readonly audio: AudioContext
	readonly out: GainNode
}

/** Opened on the first sound, closed with the scene. */
interface Voicebox {
	voice: Voice | null
}

/** The jitter in the hiss and the chirps: any stream of numbers will do. */
const jitter = seeded("sounds")

/** A tone from `start` to `end` seconds on the context's clock, swelling in and dying away. */
const tone = (
	{ audio, out }: Voice,
	wave: OscillatorType,
	pitch: ReadonlyArray<readonly [number, number]>,
	start: number,
	end: number,
	level: number,
	attack = 0.015,
) => {
	const source = audio.createOscillator()
	source.type = wave
	Arr.forEach(pitch, ([at, hertz], index) => {
		if (index === 0) source.frequency.setValueAtTime(hertz, start + at)
		else source.frequency.exponentialRampToValueAtTime(hertz, start + at)
	})
	const envelope = audio.createGain()
	envelope.gain.setValueAtTime(0.0001, start)
	envelope.gain.exponentialRampToValueAtTime(level, start + attack)
	envelope.gain.exponentialRampToValueAtTime(0.0001, end)
	source.connect(envelope).connect(out)
	source.start(start)
	source.stop(end + 0.02)
}

/** A burst of hiss through a band that slides from `from` to `to` hertz. */
const hiss = (
	{ audio, out }: Voice,
	start: number,
	length: number,
	from: number,
	to: number,
	level: number,
) => {
	const frames = Math.ceil(audio.sampleRate * length)
	const buffer = audio.createBuffer(1, frames, audio.sampleRate)
	const samples = buffer.getChannelData(0)
	for (let index = 0; index < frames; index++) samples[index] = jitter() * 2 - 1
	const source = audio.createBufferSource()
	source.buffer = buffer
	const band = audio.createBiquadFilter()
	band.type = "bandpass"
	band.Q.value = 1.2
	band.frequency.setValueAtTime(from, start)
	band.frequency.exponentialRampToValueAtTime(to, start + length)
	const envelope = audio.createGain()
	envelope.gain.setValueAtTime(level, start)
	envelope.gain.exponentialRampToValueAtTime(0.0001, start + length)
	source.connect(band).connect(envelope).connect(out)
	source.start(start)
}

/** `muted` is read on every sound, so the toggle needs no rebuild. */
export const makeSounds = (muted: () => boolean): Sounds => {
	const state: Voicebox = { voice: null }
	/** Runs `play` with the voice and the context's time, unless the map is muted. */
	const sound = (play: (voice: Voice, now: number) => void) => () => {
		if (muted()) return
		const voice = state.voice ?? open()
		state.voice = voice
		play(voice, voice.audio.currentTime)
	}
	const open = (): Voice => {
		const audio = new AudioContext()
		const out = audio.createGain()
		out.gain.value = VOLUME
		out.connect(audio.destination)
		return { audio, out }
	}
	const chirps = (times: number) =>
		sound((voice, now) =>
			Arr.forEach(Arr.range(0, Math.max(0, times - 1)), (index) => {
				const at = now + index * 0.11 + jitter() * 0.03
				const pitch = 2600 + jitter() * 900
				tone(
					voice,
					"sine",
					[
						[0, pitch],
						[0.04, pitch * 1.5],
						[0.09, pitch * 1.1],
					],
					at,
					at + 0.1,
					0.5,
					0.008,
				)
			}),
		)
	return {
		whistle: sound((voice, now) =>
			Arr.forEach(
				[
					[0, 0.2],
					[0.28, 0.5],
				] as const,
				([at, length]) => {
					// Three pipes a little out of tune with each other, and the hiss of the steam.
					Arr.forEach([523, 659, 784], (hertz) =>
						tone(
							voice,
							"triangle",
							[
								[0, hertz * 0.97],
								[0.05, hertz],
							],
							now + at,
							now + at + length,
							0.35,
							0.03,
						),
					)
					hiss(voice, now + at, length, 3000, 2200, 0.12)
				},
			),
		),
		chirp: (times) => chirps(times)(),
		bell: sound((voice, now) =>
			// A struck bell is a low hum under partials that are not whole multiples of it.
			Arr.forEach(
				[
					[1, 0.6, 2.2],
					[2, 0.4, 1.6],
					[2.76, 0.28, 1.1],
					[5.4, 0.14, 0.6],
				] as const,
				([ratio, level, length]) =>
					tone(voice, "sine", [[0, 523 * ratio]], now, now + length, level, 0.004),
			),
		),
		splash: sound((voice, now) => {
			hiss(voice, now, 0.35, 1400, 300, 0.7)
			tone(
				voice,
				"sine",
				[
					[0, 420],
					[0.12, 140],
				],
				now,
				now + 0.16,
				0.5,
				0.005,
			)
		}),
		horn: sound((voice, now) =>
			Arr.forEach([147, 220], (hertz) =>
				tone(voice, "sawtooth", [[0, hertz]], now, now + 1.1, 0.22, 0.12),
			),
		),
		ding: sound((voice, now) =>
			Arr.forEach(
				[
					[1568, 0.5],
					[3136, 0.2],
				] as const,
				([hertz, level]) => tone(voice, "sine", [[0, hertz]], now, now + 0.45, level, 0.003),
			),
		),
		close: () => {
			void state.voice?.audio.close()
			state.voice = null
		},
	}
}
