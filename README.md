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
- **Drag from the palette** — carry a fresh ball anywhere.
- **Drag clay** — move it; a welded creation moves as one piece.
- **Bring pieces together slowly** — they stick.
- **Press and hold clay** — it morphs: ball → squashed pancake → rolled sausage → ball.
- **🤏 knead mode** — toggle it, then press and drag on clay to poke dents and carve
  grooves; going over the same spot again digs deeper. Toggle again to go back to dragging.
- **Tap a piece** — it hops. **Double-tap** — it pops off whatever it was stuck to.
- **👀 👄 🎩** — eyes, a smile, a party hat; they stick to clay facing outward.
- **🧹** — hold to clear the board.

Works with mouse and touch (pointer events throughout).

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
`eye(x, z)`, `step(n)`, `clear()`.

## How it works

- Each clay piece is a dynamic body in a box3d world (fixed 1/60 timestep, 4 substeps).
  Morphing swaps its collision shape: sphere → hand-built centered disc hull → capsule.
  (Note: `b3CreateCylinder` produces a base-anchored hull spanning `y ∈ [0, h]`, not a
  centered one — hence the hand-built hull.)
- Rendering is a single `MarchingCubes` field with per-ball colors; each form is a set of
  metaball "sub-balls" in body-local space (1 for ball, 9 for pancake, 3 for sausage), so
  deformed pieces tumble and merge correctly.
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
