# Isometric service map

The service map is a factory drawn in isometric line art: every service is a
machine, every call a belt. It serves both the lab and the live service map.

## Projection

A locked 2:1 isometric orthographic camera (45° azimuth, about 30° elevation).
The projection is part of the drawing, so the camera pans and zooms but never
orbits. Left drag and one-finger drag pan; scroll and pinch zoom.

## Drawing

- Unlit materials. Each solid bakes three face tones into vertex colors (roof
  lightest, the two visible walls stepped down), then gets ink edges on top.
  No lights, shadows, tone mapping or sky.
- Faces use polygon offset so ink never flickers into paper.
- Paper `#f0f2ec` with a faint dot grid; ink `#2f4a3b`; kraft parcels with tape.
  Dark mode inverts to ink paper with sage lines, keeping the same drawing.
- Dimmed parts fade toward the paper colour instead of using transparency.

## Machines

Machines are 2×2 crate modules (0.8 units each) with seams drawn per module.
In Atlas, request volume adds storeys (1 to 4); Cascade uses two storeys.

- Services: crate stack with a window per module, a louvred vent, drainpipe,
  roof skylights, an air handler with antenna, and a chimney.
- Databases: octagonal tank with storey bands, a ladder on the camera-facing
  facet, a railed roof platform, and an outlet pipe with a valve wheel.
- Queues and workers: loading dock with a roller bed, hazard kerb, steps, a
  gantry crane with hook, and taped parcels on a pallet.
- Edge / Cloudflare: gateway arch with vented posts, marker lights, road
  markings, a striped barrier arm and a radar dish.
- External: pitched-roof shed with a window, stovepipe, satellite dish and
  crates by the door.

Health is the painted door or hatch: teal healthy, hazard elevated, brick
degraded. Service marks hang on the front wall. Selection paints the pad hazard.

## Belts

Routes are Manhattan belts on the ground plane with small rounded elbows.
Narrow belts carry calls, wide belts touch a queue. Rails, rungs and the deck
are one line draw and one mesh per belt. Errors tint the rails. Parcels are
instanced cubes moved on the GPU (`factory-motion.ts`); count follows call
rate and period follows route length and latency. Reduced motion and the pause
control stop them.

## Zones

Atlas namespaces are low plinths; Cascade tiers are terraces that rise with
dependency depth. HTML labels stay the accessible way to inspect every node.

## Whimsy style

A toolbar toggle switches between Drafted (above), Whimsy and Maple. Whimsy keeps the
same geometry, projection and health doors, and changes only the dressing:

- Storybook pastels on warm cream, drawn in plum ink. Each machine kind has its
  own body tint (peach services, sky tanks, butter docks, lilac gateways, mint
  sheds). Zones are soft grass green.
- Parcels are gift-wrapped in pastel paper with white ribbons.
- Chimneys puff smoke, tanks carry pinwheels, services fly pennants, gateways
  hang bunting, doors get candy-striped awnings, sheds get flower boxes.
- Faceted lollipop and blossom trees mark zone corners. Box clouds drift along
  the far horizon, behind the map, so they never cover a machine.
- All decorative motion follows the traffic toggle and reduced motion. Nothing
  pulses.

## Maple style

An autumn sugar-bush in Maple's own colours: parchment paper, bark-brown ink,
moss on soil for zones, and maple red, gold, rust and Maple amber for accents.
Dark mode is a blue-green night forest with warm lantern glow.

- Services are timber cabins: stone footing, shutters, lit windows, a porch
  with a shingled canopy and lantern, a stone chimney with smoke.
- Databases are sugaring vats with iron hoops, a shingled roof, a steam vent,
  and a tap with a sap bucket.
- Queues stack firewood beside a chopping stump and a log sled.
- Gateways are open timber gates: four posts, a header board carrying the
  health plates and badge, a cedar-shake roof and a leaf garland.
- External services are log cabins with notched corners and a stone chimney.
- Belts are plank boardwalks (narrow calls read as flumes) carrying wooden
  crates and sap buckets. Labels are wooden signs and hanging tags with their
  own `sign`/`signInk` colours so they read in both themes.
- The forest (`maple-scenery*.tsx`) is one merged drawing: maples, birches,
  pines, undergrowth, a creek with a footbridge, a fence, a deer, a fox and
  songbirds. It stays 0.9+ units outside every zone and thins toward its outer
  edge. Leaves fall and drift; dark mode adds steady fireflies. All motion
  stops with the traffic toggle, and nothing pulses or blinks.

### Maple shows live state

- Smoke follows request volume: none at 0 rps, a lazy wisp when nearly idle,
  up to five quick puffs for the busiest services.
- Elevated error rate: a worker with a wrench stands at the machine. Degraded:
  windows and lantern go dark, smoke turns sooty, a red flag goes up and cabin
  windows are boarded. The health door colour stays the primary signal.
- Busy docks get a woodcutter carrying a log.
- Selection: a rope border on lantern posts around the pad; the selected
  service's belts turn amber and everything else fades to a pencil sketch.
- Failing belts show split planks in the error colour.
- Cascade terraces are dry-stone walls with timber steps between levels.
- Forest life: ducks paddle the creek, birds glide behind the map, a campfire
  smokes in the back-left clearing, and the deer turns its head.

### No box

The Maple world follows the zones, not their bounding box. A distance field to
the union of zone rectangles plus seeded noise drives planting
(`maple-scenery-field.tsx`, `maple-scenery-plan.tsx`): groves hug some zones,
meadow bays open by others, and trees thin into the paper past an irregular
meadow edge. Planting fills the gaps between zones while keeping 0.75 units
from every belt sample and 0.35 outside every zone; plans rebuild only when
zone or belt geometry changes. Atlas zones are wobbly moss mats with grass
along the edge; the creek meanders along the meadow and widens into a pond.

### Landforms and individuality

The meadow is lopsided: seeded lobes and bays, a rocky outcrop on the far side
(irregular steps, a stone face toward the clearing, a lookout bench), a lake
with reeds, lily pads and a dock feeding the creek, low grassy mounds, dirt
footpaths and creek stepping stones (`maple-scenery-land.tsx`). Belts over the
meadow sit on worn-earth trails, and a few long boardwalks get a covered span
or a lantern post. Each machine is seeded by its node id: roof and shutter
colour, chimney side, porch or stone steps, side windows, vat hoops, gate sign
shape, and one or two yard props (vegetable patch, woodpile, rain barrel,
bench, mailbox, washing line, pumpkins, cart).
