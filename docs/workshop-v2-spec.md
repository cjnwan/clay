# Workshop v2 spec (multi-piece atelier)

Synthesized from a 2-design + judge review (2026-07-10). Owner request: workshop becomes the
primary creation mode — make pieces one by one, keep several, assemble them, redesign the
panel, support shapes / sculpting / beautification.

## Panel (bottom, 4 rows)

```
R0 块架   (●chip)(●chip)… [＋]     ≤6 pieces, live 3D thumbnails (RenderTarget→dataURL)
R1 颜色   12 swatches (semantics unchanged)
R2 内容   switches with tab:
   形状: 圆滚滚 高豆子 鼓肚子 球 蛋 扁饼 香肠 方砖
   雕刻: 👉戳坑 🫧鼓包 ⭕大小(3档) ↩️撤销      ← no mirror toggle, no separate groove btn
   装扮: 🎩👀👄●👂✋🩹(⭐later)
R3 底行   [⬅] ┃形┃雕┃装┃(segmented, theme colors 蓝/橙/粉) [↻] [✓]
```

Default tab = 形状 (inert). Theme color tints content row + brush ring. R1 dims 40% in sculpt tab.

## Gestures (dispatch by raycast hit, not screen area)

- All tabs: blank drag = turntable; chip drag-out = assembly placement (highest priority);
  second finger while placing = pinch size (+ twist = spin for pieces); two-finger pinch when
  idle = current piece k (0.6–1.6).
- 形状: canvas is inert (body hit = turntable). Buttons swap shape (clears sculpt, refits hood).
- 雕刻: ray tests CURRENT BODY MESH ONLY (no parts/hood/sub-pieces); hit = sculpt stroke,
  miss = turntable; parts not pickable in this tab.
- 装扮: exactly today's behavior; hitting an attached sub-piece = pick up to re-place.

## Sculpt

- Data: piece.sculptOps = ops, op = ball list [x,y,z,±1,r] (piece-local, base y=0).
- Tap = one ±ball (dent center sunk ~0.53r, bump raised ~0.66r); drag = sample every ~0.12–0.18
  surface distance → translucent beads preview, ONE res-88 rebake on release (no live rebake in
  v1; res-64 throttled preview is stage-5 gray release).
- Auto mirror |x|>0.1 (no toggle). Brush tiers r = 0.2/0.3/0.42 via ⭕ cycle.
- Undo = fixed ↩️ button, pops one op + rebake. Cap ~30 ops/piece.
- After every rebake: hood re-cut against new geometry (never "poke → hat gone");
  parts re-projected along -ln onto new surface (TODO).
- Shape switch clears sculpt.

## Multi-piece (stage 3)

- workshop.pieces[] ; Piece = { shape, colorIndex, k, sculptOps, parts[], attach:null|{parentId,lp,ln,k,spin} }
- Free pieces live ONLY as R0 chips (44–52px, live thumbnails); turntable shows current root +
  attached subtree. Tap chip = swap onto turntable (0.3s fly). [＋] = new ball piece, auto-switch
  to 形状 tab. Cap 6 pieces total. Chip long-press 700ms holdfill = delete (attached pieces
  must be detached first).

## Assembly (stage 4)

- Drag chip into canvas → whole piece (body+its parts) becomes ghost, placement engine reused
  (entry.kind 'part'|'piece'); targets = root body + attached sub-piece bodies (+hood);
  piece +Y aligns to ln, sink = min template ball r × 0.15; midline soft snap; second finger:
  pinch = attach k (0.45–2), twist = spin about ln.
- NO auto mirror twin for pieces (hand-made = unique; want two arms → make two).
- Tree attach: parts belong to their own piece (detaching an arm keeps its hand-parts).
  Direction: only shelf piece → turntable assembly (acyclic by construction).
- Detach: pick up attached piece, drag off all surfaces → flies back to shelf as chip (NEVER
  deleted). Chip dragged out but released on nothing → back to shelf.

## Done / save (stage 4)

- ✓ = whole turntable assembly → one kind:'figure' board toy. Compound collider: every template
  ball of every piece transformed through attach chain × k, sorted by radius, capped at 16,
  single-sphere fallback. Shelf pieces stay in wsKeep ("还有 N 块泥留在工坊哦" hint); next chip
  auto-plops onto turntable after ✓.
- Save v2 (URL-hash `w` ≅ board figData): { v:2, cur, pieces:[{s,c,k,sc:[[x,y,z,±1,r]…round2],
  ps:[…], at:{p,lp,ln,k,spin}|null}] }. Old single-figure format (t/c/ps/s) migrates to one piece.

## Stages (each independently shippable)

1. Panel rebuild (tabs, no R0) + shape tab + retire 换身体 button.  ← DONE (3bfa2cb)
2. Sculpt tab wired (engine already landed: beads, mirror, per-op undo, brush tiers).  ← DONE (3bfa2cb)
3. pieces[] + R0 chip shelf + thumbnails + v2 save + migration.  ← DONE (79e9396)
4. Assembly (chip drag-on, spin, tree attach, detach-to-shelf) + compound-collider Done.  ← DONE (79e9396)
   Deviations from spec: ✓ Done still EXITS to the board (keeps the payoff moment of the toy
   landing; shelf persists in wsKeep either way, next enter auto-promotes a shelf piece).
   Parts may be placed on ANY piece of the assembly (re-host while sliding); sculpt = root only.
   Piece-k idle pinch (0.6–1.6) not implemented; attach-k pinch during placement covers sizing.
5. Gray-release polish: live low-res sculpt preview, ⭐ stamp part, part-row paging, kid tests
   (mis-sculpt rate, chip long-press, rolling stability, URL length), part re-projection.

## Known risks

- Continuous rebake perf on low-end phones (v1 avoids: beads + single bake on release).
- Deep negative balls can punch through the mesh (clamp sink ≤ 0.4r-ish; caps bound it).
- URL hash growth: round(2) + 30 ops/piece + 6 pieces hard caps; warn when exceeding.
- Compound collider count vs box3d stability: cap 16, radius-sorted, single-sphere fallback.
