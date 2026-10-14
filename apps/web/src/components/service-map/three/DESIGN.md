# Maple service map

The 3D service map is an autumn sugar-bush drawn in isometric line art: every
service is a machine, every call a belt. The same scene serves the live service
map and the lab (`/lab/service-map-3d`).

## Projection

A locked 2:1 isometric orthographic camera (45° azimuth, about 30° elevation).
The projection is part of the drawing, so the camera pans and zooms but never
orbits. Left drag and one-finger drag pan; scroll and pinch zoom. A press that
moves more than `DRAG_TOLERANCE` is a pan, never a select. The camera frames the
zones plus a 2.5 unit meadow margin.

## Drawing

- Unlit materials. Each solid bakes three face tones into vertex colors (roof
  lightest, the two visible walls stepped down), then gets ink edges on top.
  No lights, shadows, tone mapping or sky.
- Faces use polygon offset so ink never flickers into paper.
- Light: parchment paper, bark-brown ink, moss-on-soil zones, and maple red,
  gold, rust and Maple amber accents. Dark is a night scene, not an inversion:
  dark ink, lit mid-tone faces, lighter belt decks and warm lit windows
  (`night` on the palette).
- Dimmed parts fade toward the paper colour instead of using transparency.
- Geometry is built once per mount and components are keyed on the inputs it
  comes from, so live metrics remount rather than leak GPU buffers.

## Machines

Machines are 2×2 modules (0.8 units each). In Atlas, request volume adds storeys
(1 to 4); Cascade uses two storeys.

- Services are timber cabins: stone footing, shutters, lit windows, a porch
  with a shingled canopy and lantern, a stone chimney with smoke.
- Databases are sugaring vats with iron hoops, a shingled roof, a steam vent,
  and a tap with a sap bucket.
- Queues stack firewood beside a chopping stump and a log sled.
- Gateways are open timber gates: four posts, a header board carrying the
  health plates and badge, a cedar-shake roof and a leaf garland.
- External services are log cabins with notched corners and a stone chimney.

Each machine is seeded by its node id: roof and shutter colour, chimney side,
porch or stone steps, side windows, vat hoops, gate sign shape, and one or two
yard props (vegetable patch, woodpile, rain barrel, bench, mailbox, washing
line, pumpkins, cart).

## Live state

- Health is the painted door, hatch or header plate: teal healthy, amber
  elevated, brick degraded.
- Smoke follows request volume: none at 0 rps, a lazy wisp when nearly idle,
  up to five quick puffs for the busiest services.
- Elevated error rate: a worker with a wrench stands at the machine. Degraded:
  windows and lantern go dark, smoke turns sooty, a red flag goes up and cabin
  windows are boarded.
- Busy docks get a woodcutter carrying a log.
- Selection: a rope border on lantern posts around the pad; the selected
  service's belts turn amber and everything else fades to a pencil sketch.

## Belts

Routes are Manhattan belts on the ground plane with small rounded elbows,
drawn as plank boardwalks (narrow calls read as flumes) over worn-earth trails.
Failing belts show split planks in the error colour; a few long boardwalks get
a covered span or a lantern post. Cargo is instanced and moved on the GPU
(`factory-motion.ts`): 3 to 44 pieces per belt by length and call rate, a mix
of slatted crates, sap buckets and literal logs. Period follows route length and
latency. Reduced motion and the pause control stop all motion; nothing pulses
or blinks.

## Zones and labels

Atlas zones are wobbly moss mats with grass along the edge; Cascade tiers are
dry-stone terraces with timber steps between levels. HTML labels are wooden
signs and hanging tags with their own `sign`/`signInk` colours, and stay the
accessible way to inspect every node.

## Forest

The world follows the zones, not their bounding box. A distance field to the
union of zone rectangles plus seeded noise drives the meadow outline and
planting (`maple-scenery-field.tsx`, `maple-scenery-plan.tsx`): groves hug some
zones, meadow bays open by others, and trees thin into the paper past an
irregular edge. Clearances: small planting (grass, bushes, rocks, saplings)
keeps 0.35 outside every zone and 0.75 from every belt sample; full trees need
0.9 from zones and 1.1 from belts; landforms keep 0.9 from zones and 0.75 from
belts. Plans rebuild only when zone or belt geometry changes.

The meadow is lopsided, with a rocky outcrop on the far side, a lake with reeds,
lily pads and a dock feeding a meandering creek, low mounds, footpaths, a
campfire and a fence (`maple-scenery-land.tsx`). The forest is one merged
drawing: maples, birches, pines, undergrowth, a deer, a fox, songbirds, ducks
on the lake and birds gliding behind the map. Leaves fall and drift; dark mode
adds steady fireflies.
