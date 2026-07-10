# 捏黏土 (Clay)

**Play it: <https://cjnwan.github.io/clay/>** — works on phones and tablets
(iOS 16.4+ / Android Chrome 89+).

A tactile clay toy for kids, in the spirit of [mrdoob/toys](https://github.com/mrdoob/toys):
drop colorful clay balls onto a board, squish them around, and they stick together like
real playdough. Give your creation googly eyes.

Built with [three.js](https://threejs.org) (MarchingCubes metaball rendering) and
[box3d.js](https://github.com/isaac-mason/box3d.js) (rigid-body physics by way of weld
joints for the "sticky clay" behavior) — the same pairing mrdoob/toys uses.

## Play

- **Tap a color** — a ball of clay plops in. Tap the board to place one exactly there.
  Twelve colors including white, black, brown, pink, grey and cream — enough for the
  chibi figure-in-a-costume look (dark hood ball + face ball welded in front).
- **Drag from the palette** — carry a fresh ball anywhere.
- **Drag clay** — the held piece leaves physics and tracks your finger exactly
  (kinematic carry): it won't snag on things in the way, and it only sticks where you
  drop it. A welded creation swings along and moves as one piece.
- **Stack by hovering** — a carried piece auto-rises above whatever is under your
  finger and gently centers over it: drag over a tower, let go, it lands on top,
  sticks and sets. Towers as tall as the walls allow.
- **Bring pieces together slowly** — they stick.
- **Creations hold their pose** — once a build settles for half a second it "sets" like
  real clay and won't tip over, however top-heavy. Touching it softens it again.
- **Press and hold clay** — it morphs: ball → squashed pancake → rolled sausage → brick → ball.
- **● size** — cycle small / medium / large for new clay: proportions make creatures.
- **🐍 snake** — a soft chain of linked segments; lift one end and the rest dangles.
- **🤏 knead mode** — toggle it, then press and drag on clay to poke dents and carve
  grooves; going over the same spot again digs deeper. A quick press-and-pull off the
  surface raises a bump. Toggle again to go back to dragging.
- **✂️ scissors** — tap a piece to cut it in two (each 80% size, same form and color);
  snip a snake segment to sever the chain. Too-small pieces refuse the cut.
- **🖌 paint** — pick a color, then tap or stroke on clay to smear it on like pressed
  bits of colored clay: blush cheeks, spots, frosting. Dab size follows the ● size
  toggle (small dot / patch / big face-sized patch). Soft watercolor blends, saved
  and shared with the creation.
- **🎀 bow** — a bow-tie decoration alongside eyes, mouth and hat.
- **Pinch while dragging** — hold a piece with one finger, put a second finger down:
  spread/close to resize it, twist to rotate. It re-sticks to its neighbours on release.
- **🤸 flip** — while holding a piece, tap 🤸 with your other hand: it tumbles 90° about
  the axis that visibly flips it (a lying sausage stands up; tap again to lie it down).
  Combined with set-in-place, upright sausages and edge-standing pancakes actually stay.
- **Autosave & share** — your board saves automatically, and **the page URL is the share
  link**: copy it and the creation opens on any device. (Opening someone else's link
  won't overwrite your own save until you start editing.)
- **Tap a piece** — it hops. **Double-tap** — it pops off whatever it was stuck to.
- **👀 👄 🎩** — eyes, a smile, a party hat; they stick to clay facing outward.
  Dragging a decoration moves **just that piece** (it unsticks, follows your finger
  without snagging, and re-sticks where you drop it); dragging clay moves the whole
  creation.
- **🎥 clip** — records a 5-second orbit of your creation and saves it as a video
  (webm on Chrome, mp4 on Safari) — your build becomes a shareable short.
- **🧹** — hold to clear the board.

Works with mouse and touch (pointer events throughout).

## Recipes (all play-tested)

**Or just tap 🎬 in the game** — it builds one of these for you live, with step-by-step
narration, then hands the board over. Tap 🎬 again for the next recipe; touch anything
to take over mid-show.

- **Caterpillar** — drop same-color balls in a line one ball apart; they weld into a
  segmented body on landing. Eyes on the front one.
- **Flower** — one ball as the center, a ring of six balls around it, then hold each
  ring ball to flatten it into a petal. (Place balls first — discs roll like coins.)
- **Snail** — a sausage for the body, drop a ball onto its back for the shell.
- **Snowman** — stack two balls, add eyes, mouth and the hat.
- **Octopus** — stack two balls, surround with a ring of balls, morph each into a
  sausage; random orientations read as sprawling tentacles.
- **Doughnut / thumbprint cookie** — flatten a ball, then knead (🤏) the center
  repeatedly for a doughnut, or a ring of pokes for a crinkle-edge cookie.
- **Birthday cake** — two flattened tiers (large + medium), a dome on top, frosting
  dabs (🖌) around each tier, and the party hat as the candle.
- **Burger** — bun pancake, lettuce pancake, patty pancake, ball bun on top, sesame
  dabs. **Ladybug** — a red ball, purple spot dabs, two eyes.
- Tip: to attach a piece high (Mickey ears), just hold it in place for a moment —
  the build sets and it stays.

## Run

No build step, no dependencies to install — three.js r185 and box3d.js 0.0.2 (inline-WASM
build) are vendored under `vendor/` and wired up via an import map, so the page is fully
self-hosted (no CDN at runtime). Just serve the directory statically:

```sh
npx http-server -p 8917
# or any other static file server
open http://localhost:8917
```

A `window.__clay` debug handle is exposed in the console: `state()`, `spawn(x, z, color)`,
`eye(x, z)`, `step(n)`, `clear()`, `save()`, `load(json)`, `demo(i)`.

## How it works

- Each clay piece is a dynamic body in a box3d world (fixed 1/60 timestep, 4 substeps),
  scaled by one of three size factors. Morphing swaps its collision shape:
  sphere → hand-built centered disc hull → capsule → box.
  (Note: `b3CreateCylinder` produces a base-anchored hull spanning `y ∈ [0, h]`, not a
  centered one — hence the hand-built hull.)
- Rendering is a single `MarchingCubes` field with per-ball colors; each form is a set of
  metaball "sub-balls" in body-local space (1 for ball, 9 for pancake, 3 for sausage), so
  deformed pieces tumble and merge correctly.
- Snakes are chains of small spheres linked by spherical joints (excluded from cluster
  dragging so they stay floppy).
- A periodic O(n²) proximity pass welds slow-touching bodies together (`b3CreateWeldJoint`);
  decorations stick at higher approach speeds than clay. Dragging applies a velocity servo
  to the whole welded cluster; double-tap detaches with a re-stick cooldown.
- Decorations (eyes/mouth/hat) are regular meshes on small sphere bodies; on weld they are
  oriented +Z-outward and pushed just proud of the visual clay surface.
- Kneading adds negative-strength metaballs (subtractive carving) stored in body-local
  space, so dents ride along as pieces tumble. Placement matters: a dent bites visibly only
  when centered just inside the isosurface (~0.14 under it); deeper in, the field is too
  strong for the subtraction to move the surface.
- When every body is asleep the marching-cubes rebuild is skipped; large scenes rebuild
  every other frame.

## License

MIT
