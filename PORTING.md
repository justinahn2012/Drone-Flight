# One Take FPV: native port map (Swift + Metal)

The web build (three.js r180, flat files) remains the design lab and the **reference** that the iPhone app is tested
against. The port is a Swift + Metal renderer with the game logic rewritten in Swift, built by GitHub Actions
(XcodeGen `project.yml` → macOS runner → TestFlight). Nothing in the port depends on running JavaScript.

Regenerate the exported data after any change to the world, camera or look (each is a single command, ~1 s; Neon Seoul
is §7):

```
node tools/export-world.mjs      # world.glb, collider.glb, world.json   (--out DIR, --check = exit 1 if stale)
node tools/camera-profile.mjs    # camera.json                            (--out DIR)
node tools/test-export.mjs       # round-trip test: GLBs vs buildGeometry, determinism, camera lens table
```

The tools need:
- node ≥ 20.6, for `module.register`
- the import-map versions resolvable from the repo root: `npm i --no-save three@0.180.0 three-mesh-bvh@0.9.1` in CI. Here, the worktrees' `node_modules` symlink provides them.

The tools read module-private data (MATS, GRADES…) through a node load hook in `tools/expose.mjs`. They also lift
`buildBando`'s return literal and the main.js look line from the source, so runtime files need no tool-only exports.
If something can't be found, it is listed under `warnings`, and the test fails on any warning.

## 1. Module boundaries

| Web module (lines) | What it is | Native module | How it ports |
|---|---|---|---|
| `world-bando.js` `buildGeometry` (+ `buildSite`, `PATHS`, `MATS`, `SKIES`) | procedural site, collider, lines | **build-time only** | `tools/export-world.mjs` writes `world.glb` / `collider.glb` / `world.json`. The app never runs the generator. |
| `world-bando.js` `buildBando` (2062 total) | materials, light bake, grass, foliage, graffiti, sky, shadows | `Render/World*` | Materials = `MeshStandardMaterial` + `weatherPatch` (one program per kind: built, ground, track, bark, decal, grass, leaf, treeline) + `aLightingPatch` (adds the baked sun and sky bounce to indirect diffuse, samples the static near/far/ring sun shadow maps rendered once at load (no live shadow pass), applies the sun-occlusion mask, and fogs toward the per-azimuth horizon table with sun haze). Port the GLSL to MSL by hand. Light comes from A1's lightmaps (lm_*.png). Grass is shader-procedural (port the vertex shader). Foliage and graffiti placement still happen at load (see §6). |
| `fpvcam.js` (675) | the camera: scene RT, shutter blur + rolling shutter + jello, metering, bloom, lens + colour + grain | `Render/Camera` (MSL passes) | Same pass list; every parameter comes from `camera.json`. On Metal the blur reads the scene depth (no collider depth pass). |
| `flight.js` (341) | quad flight model, Cine assist, collision response | `Sim/Drone.swift` | 1:1 port in `Double`. Talks to the world only through the collider interface (§3). |
| `take.js` (205) | the game: lines, FLOW, bank, CUT | `Game/Take.swift` | 1:1 port. It is already free of THREE and works on plain arrays. |
| `controls.js` (270) | touch sticks, gamepad, radio mapping | `Input/` | GameController + touch overlay produce the same 5 channels (`thr, pitch, roll, yaw, climb`, −1..1), quantised as in the input log. |
| `audio.js` (189) | WebAudio motor synth, impacts | `Audio/` | `AVAudioSourceNode` synth with the same graph; CHHaptics are driven by rpm and wash. |
| `main.js` (1047) | loop, rig, replay/clips, HUD glue | `App/` | CADisplayLink + fixed tick (§3). Rig constants from `camera.json` `rig`. Clips: AVAssetWriter HEVC from an offline replay render. |
| `index.html` (406) | menus, HUD, cards | SwiftUI overlay | Same copy and states. |

Data crosses the native module boundaries only as plain values: the world (from the files below), the 5-channel input
per tick, the drone state snapshot, the Take events (`{type, name, pts, flow, total, …}`, as in take.js), and the
camera pose + motion (`pos`, `quat`, `vel`, `ang`, `vib`, `hz`, `wash`, `bump`) per rendered frame.

**Coordinates:** metres; right-handed with +Y up; the drone and camera look along −Z. Quaternions are (x, y, z, w),
which is the same layout as `simd_quatd(vector:)`. three's `Matrix4.elements` are column-major, the same as simd
`float4x4` columns. Metal's NDC z runs 0..1, so build the projection for that; reverse-Z is recommended with near
0.06 and far 3000. Texture origin: three uploads images with `flipY = true`, so v = 0 is the image bottom. Load
textures bottom-left-origin (`MTKTextureLoader.Option.origin: .bottomLeft`) or sample at `1 − v`.

## 2. Data formats

**world.glb** (glTF 2.0 binary, from tools/glb.mjs). It is deterministic and passes the Khronos validator with
0 errors and 0 warnings.
- One node and one single-primitive mesh per render mesh, in canonical order. First the merged site meshes, sorted by
  material key (`brick rust silo slab wall`), then `terrain`, `far` and `path`. Round 5: merged meshes the game never
  draws (the legacy `bark` trunks, kept by buildGeometry for the collider/bake) are left out and listed in `notDrawn`.
- **Attributes:** `POSITION`, `NORMAL`, `TEXCOORD_0` (`uv`, planar world metres; divide by `MATS[mat].tile`) and
  `_AY` (`aY` = the bottom and top world height of the element, for weathering). `path` also has `COLOR_0`, where
  alpha is the edge fade.
- Lightmap UVs (A1) appear as the next `TEXCOORD_n`. Sets are numbered contiguously, as glTF requires.
- Every primitive's `extras.attributes` maps each glTF semantic back to its three.js name (e.g. `{"_AY":"aY", "TEXCOORD_1":"uv2"}`).
- Indices are u16 where they fit, otherwise u32.
- **Materials:** one per MATS key. `baseColorFactor` = MATS `albedo` (linear) and `roughnessFactor` = `rough`.
  `extras` carries the whole MATS entry: Poly Haven id, tile, colour multiplier, weathering `w`, `roughMin`, and the
  texture URLs.

**collider.glb.** The exact collision mesh, which is double-sided. It is one primitive with position plus a u32
index, in three-mesh-bvh triangle order. `extras.ranges` gives the vertex range of each source:
- `solid`: structures and trunks. This is also the skim/proximity-score set (`world.skimBvh`).
- `terrain`
- `far`
- `proxies`: treeline crown proxies (collision only)

A triangle belongs to the range that holds its first vertex. Build your own BVH; the order isn't meaningful.

**world.json** (`format: onetake.world/1`):
- `hash`: `world`, `render`, `collider`, per-mesh
- `files`: bytes and sha256 per file
- `meshes[]`: name, kind, material, counts, attribute map, bounds, hash
- `collider`: counts, bounds, ranges, per-range triangle counts
- spawn and start points:
  - `spawn {pos, yaw}`
  - `takeStart`
  - `startPoints`, `funnels` (stream C; null until present)
  - `bounds` (leaving it respawns), `envelope` (soft flight limits)
- `lines[]`: take.js gates (`c, n, u, w, h, pts, pre[], within, two`)
- `skies`: SKIES plus the HDR URL
- `materials`: MATS plus URLs
- `paths`: dirt-track polylines
- `site`: footprints, chimney, decal hints
- `instances.treelineCrown`: layout `x y z rotY w h d tint`; prototype veg.json types A/B `lods[3]` (the rule and the
  scale formula are in the entry)
- `instances.tree`: layout `x y z h r` (the spots; the drawn trees are `instances.veg`)
- `instances.veg` (round 5, contract C11): `geo.vegInstances()` as a flat table: `types`, `layout` (`type` index, then
  every numeric field of the entries in order: `matrix0..15` column-major, `tint0..2`, `ao`, ...), `byType`,
  `prototypes` (veg.json H / crown / lods per type) and `data`. Until world-bando.js has `vegInstances` it says
  `status: "pending"` and the plants are listed in `runtimeOnly`.
- `groundMasks` (round 5): `groundmask.png` (R grass density, G apron, B terrain AO, A grass height/2 m) and
  `groundmask2.png` (R track distance/8 m, G dry, B flowers, A lush), 512² over x0 −165, z0 −150, 320 m; PNG row j is
  z = z0 + (j + 0.5)·0.625, i.e. load top-left origin. B is 1 with the committed lightmaps (it is the per-vertex
  bake's terrain AO only on that fallback).
- `grass`: the per-quality blade tiers (`GQS`) and the base cell; with the masks that is all the shader needs.
- `materials[k].texMean`: the mean linear colour of the diffuse map (TEX_MEAN, tools/texmean.py).
- `coverage`: which export entry covers each class of mesh the game draws (applied to the live scene by CI).
- `lightmap`: A1's lm.json when present
- `runtimeOnly`: what is still generated at load (grass, graffiti placement, the light fallback)
- `files`: also `groundmask*.png` and the vegetation assets copied unchanged (`veg.json`, `veg.bin`, `veg_atlas.jpg`,
  `veg_atlas_a.png`, `veg_bark_*.jpg`; veg.json `meshes[name]` gives attribute and index ranges into veg.bin)
- `warnings`: must be empty

Hash `mm3x2/1` (geohash.js at the root; tools/geohash.mjs re-exports it):
- Two MurmurHash3-x86_32 body lanes over a uint32 word stream, seeds `0x9747b28c` and `0x2f0f5d1b`.
- Floats are hashed as their bit patterns; integers as their value.
- Each mesh hashes as: name, vertex count, then each attribute in sorted name order (name, itemSize, data), then the index.
- It is about 40 lines to reimplement in Swift (golden test G1).

**camera.json** (`format: onetake.camera/1`):
- `looks.{sunny, overcast, ldr}` = the camera exactly as the game sets it up: `FPVCamera` defaults → `GRADES` → the
  main.js look line for that sky → applySettings defaults. Each entry gives `look` (every key fpvcam reads),
  `projection` (near/far), `lens1080p`, and `profile` (D's `fpv.profile()`, contract C5, when present).
- `grades`, `lenses` (thetaS, k, ca), `shutters`.
- `lensSolve` (method, constants 1.16 rad corner cap and 1.035 margin, and a table at 1920×1080, 2868×1320,
  1320×2868, 1080×1920, 1080×1080 for every lens).
- `jello` (ratio, axis, model), `exposure`, `bloom`, `depthEncoding` (contract C2).
- `rig`: mount offset, uptilt per craft/mode, stabilisation taus.
- `quality`, `defaults`, `pipeline`.

**Lightmaps (stream A1):** `lm_sunny.png`, `lm_overcast.png` (RGBM/RGBE) and `lm.json` (geometry hash, sky ids,
rotY, scale), sampled with the lightmap TEXCOORD. They are valid only while the lm.json hash matches the geometry.
**Integration:** A1 should compute that hash with `geohash.js`, so that `lm.json` and `world.json` agree.

**Input log (stream E, inputlog.js):**
- header: seed, world hash, craft, mode, tick rate, start snapshot
- 5 × Int16 channels per 1/240 s tick
- a full `Drone.snapshot()` every 240 ticks
- size: about 144 KB/min

The header's world hash is `world.json` `hash.collider` (round 4): `mm3x2/1` over the collider mesh exactly as
collider.glb stores it (`setHash('collider', [['collider', colGeo]])`, positions + index in three-mesh-bvh order). Open
air (no collider) is `setHash('collider', [])`. Funnels and the envelope are not hashed: they come from `world.json`,
and changing them means re-recording. A log replays only on the collider it was recorded on;
`node tests/replay.mjs --record` re-records the scripted logs. A browser log is re-recorded in the game
(`__onetake.flight.lastLog.toBytes()`).

**graffiti.png** (round 4): the 2048×4096 graffiti atlas (4×16 cells of 512×256; cell k's type is `GTYPE(k)`; piece,
throw, tags, buff), RGBA8 with straight alpha and sRGB, rows top-down. `world.json` `textures.graffiti` describes it.
The game draws the same pixels at load with `raster2d.js`, a pure-JS Canvas2D subset with Hershey stroke fonts and
no system fonts, so the port ships the PNG. Placement (the decal grids) is still runtime-only. Round 5: the drawing
code is `graffiti.js` (no three.js); the browser runs it in `graffiti-worker.js` and uploads the result in 16 strips.

**Golden dumps (stream D, `fpv.renderGolden()`):** per-stage float outputs of the camera passes for fixed inputs.

## 3. Determinism contract

The simulation (flight + take) is a pure function of (world, seed, start snapshot, tick inputs). Stream E lands this
in round 3; check the names after merge.
1. **Fixed tick 1/240 s.** It uses an accumulator, reads the controls once per tick, and interpolates the render by
   `acc / tick`. The render rate never reaches the physics. Before this change, 30 Hz vs 60 Hz drifted 73 cm in 10 s.
2. **Seeded RNG** (`rng.js`, the same generator as world-bando's `rng()`): a 32-bit state, `s += 0x6D2B79F5`, then
   the `imul`/xorshift mix, output / 2³². `gauss()` = Box–Muller over two draws, both > 0. In Swift, implement it with
   `UInt32` wrapping ops (`&+`, `&*`, `>>`). The RNG state is part of the snapshot.
3. **Collider interface only.** The sim calls `raycast(o, d, max) → {t, n}` and `closest(p, max) → {p, d}`, with the
   distance guard inside the implementation. Proximity (`lastDist`) is computed inside `step`. take.js skim uses the
   solid range.
4. **Double precision.** JS numbers are IEEE doubles, so the Swift sim uses `Double`/`SIMD3<Double>`. Collider vertices
   are float32 and are promoted to double for the maths, exactly as JS reads a `Float32Array`.
   - Keep the operation order.
   - Don't use FMA-style helpers.
   - libm last-ulp differences (sin, exp, atan2…) are tolerated. The model is stable: a 1e-9 m nudge grows to
     ≤ 1.1e-6 m in 10 s, so a 1 mm tolerance has about 3 orders of headroom.
5. **Take updates on ticks** and emits the same event sequence; points are integers.
6. **Snapshot / restore** covers every integrator field plus the RNG. Clips, ghosts and Game Center challenges
   re-simulate from logs, not from pose buffers.

## 4. Golden-test plan

| # | Test | Reference | Pass | Runs | From |
|---|---|---|---|---|---|
| G0 | export round-trip + determinism | `buildGeometry()` | bit-exact arrays, counts, bounds and hashes; byte-identical re-export (`node tools/test-export.mjs`) | node, every commit | now |
| G1 | Swift loads world.glb / collider.glb | world.json | counts, bounds and `mm3x2/1` hashes equal | XCTest, CPU only | M1 |
| G2 | lens solve | camera.json `lensSolve.table` | \|Δ\| ≤ 1e-9 | XCTest | M1 |
| G3 | flight replay | committed input logs (E) | position within 1 mm and attitude within 1e-4 rad at every 240-tick snapshot; same crash tick | XCTest | M1 |
| G4 | take replay | same logs, `tests/<log>.take.json` (round 5: committed, asserted by `tests/replay.mjs`) | identical events (type, name, pts, flow, total; floats ±1e-6) | XCTest | M1 |
| G5 | camera passes | `fpv.renderGolden()` dumps | per stage, max abs error ≤ 2e-3 linear (≤ 1 LSB at the 8-bit output), grain off | Metal device | M1–M2 |
| G6 | reference frames | web smoke shots (spawn, silo, hall, chimney, takestart), exposure locked | SSIM and luma percentiles (p5/p50/p95) within thresholds set from the first M1 frames | Metal device | M2 |
| G7 | Seoul parity (P2) | `tests/seoul/walking.otil` + `.take.json`, `tests/seoul/parity.json` | G3/G4 on the Seoul collider; traffic `hash` bit-exact and vehicle boxes within 1e-9 m at t = 0, 5, 37.5, 90 s (`node tests/seoul-parity.mjs`) | XCTest | M1 |

- **G1–G4** are pure CPU and run on the CI macOS runner.
- **G5–G6** need a Metal GPU. M0 checks whether the CI runner provides one; otherwise they run on a device (a
  self-hosted Mac or a TestFlight test build).
- **CI order:** the web job (below) → its `exports` artifact → G0 → the Xcode build → G1–G6.

### Exports and CI (round 4)
**Decision: exports are not committed.** `.github/workflows/ci.yml` builds them on every push into `exports/`
(git-ignored) and uploads them as the run's `exports` artifact, kept 30 days: world.glb, collider.glb, world.json,
camera.json and graffiti.png. Reasons:
- They add 8 MB per geometry change to a repo that Justin syncs from his phone.
- They go stale whenever a stream merges, and a CI artifact always matches its commit.
- They stay out of the deployed site root.

The Swift build takes them from the artifact of the commit it builds, or regenerates them with
`node tools/export-world.mjs --out exports && node tools/camera-profile.mjs --out exports`.
`--check` is for a local `--out` directory only.

The web job runs on ubuntu with node 22, in about 1–2 minutes (10-minute cap):
- `node --check` on .mjs copies of the runtime modules
- `tests/replay.mjs --strict` (a stale scripted log fails, a stale browser log warns; round 5: each scripted log's
  Take events must equal `tests/<log>.take.json`. The Take is ticked after every `drone.step` with main.js
  `sticksActive()` on the logged inputs, no touches, `thrRef` = the first tick's throttle. After an intentional
  take.js change: `node tests/replay.mjs --record-take`)
- `tools/test-lightmap.mjs` (a stale lightmap fails, from r4/A-bakefix)
- `tests/take.mjs` at 60 and 240 Hz, when present (C4)
- `tests/stress-lite.mjs` (0 pass-throughs)
- `tools/test-export.mjs` (round 5: masks, veg.* copies, `instances.veg` once C11 lands, TEX_MEAN complete)
- the export

A second job, **browser** (round 5), runs `tests/browser.mjs`: Playwright's Chromium on SwiftShader loads the game
with `?perf`, fails on any page/console/shader/request error, runs the four perf segments, applies world.json
`coverage` to the live scene (tests/coverage.js: a drawn mesh with no export entry fails, so does a world.glb mesh the
game doesn't draw) and compares three stills (spawn, hall, chimney) with `tests/golden.json` (luma p50 ±8, p95 ±10).
Screenshots and perf/coverage JSON are the `browser` artifact. After an intentional look change:
`node tests/browser.mjs --update` and commit tests/golden.json.

three and three-mesh-bvh come from `ci/package.json`, pinned to the import map; keep the two in step. The file sits in
`ci/` so the site root has no package.json, because Cloudflare Pages would npm-install on every deploy. CI links
`ci/node_modules` to `node_modules`. To run locally: `npm ci --prefix ci && ln -s ci/node_modules node_modules`.

**`?perf`** (perf.js) puts real frame times from the phone next to these numbers. Round 5: four segments (cruise;
skim at 1.5 m over the meadow; a 120°/s carve; hover 2 m outside the biggest crown in reach) at render scale 1.0 and
1.2, 120 timed frames each, every frame synced by a 1-px readPixels; per segment p50/p90, cpu and gpu ≈ total − cpu.
Then a 3-minute soak cycling the segments at 1.0, reporting first-30-s and last-30-s p50/p90 and the throttle ratio
(QUICK skips the soak). Suggested `QUALITY.auto.max` = the largest scale whose worst segment p90 ≤ 14.2 ms.

## 5. Milestones

| | Scope | Exit |
|---|---|---|
| **M0** (1–2 wk) | XcodeGen project, Actions → TestFlight, a Metal view at 60 Hz (CADisplayLink), GameController + touch → the 5 channels, haptics | TestFlight install from the phone; CI builds and runs XCTest |
| **M1** (4–6 wk) | GLB world + collider BVH, the fpvcam passes in MSL, the Swift sim + Take | G1–G5 green; the take plays end to end |
| **M2** (4 wk) | MetalFX temporal upscaling (before the blur), blur from scene depth, MSAA, histogram AE, thermal governor, audio, clips (AVAssetWriter HEVC, 8–16 shutter sub-frames offline) | G6 within thresholds; p90 ≤ 11–12 ms at 60 Hz on an A18 Pro-class phone; thermal fallback (MetalFX input res first, then RT) verified |
| **M3** | Blender Cycles lightmaps baked in CI (replacing the node baker), mesh-shader grass, a scanned site via Background Assets | — |
| **M4** | RT sun shadows, Game Center (per-line boards, ghosts from input logs), a frame-interpolation trial | — |

Ship 60 Hz, with 120 Hz as an option: the look is 30p with a 1/60 s shutter. iOS GameController can't see USB
EdgeTX radios; use Bluetooth / ELRS backpack, and model input as raw channels.

## 6. Open web-side items (still to do after round 3)

- Move foliage (trees, thickets, shrubs, saplings) and graffiti placement out of `buildBando` into data. They need BVH
  probes but no textures, so export-world can then write their instances and the port stops re-deriving them.
- Have `buildBando` load `world.glb` + `lm_*.png` when the hash matches (faster load), with today's build as the
  fallback.
- Bake the atlases (graffiti.png, leaf cluster), the ground mask and the 1k JPGs to KTX2/ASTC. The leaf / grass
  canvas atlases (V1/V2) still use Canvas2D; raster2d.js can draw them the same way.
- Dump the expanded GLSL of every world and camera program next to `renderGolden()`, so the MSL port has exact
  sources.

## 7. Neon Seoul (Hongdae, P2 stream H)

```
node tools/export-world.mjs --level seoul-hongdae --out exports/seoul-hongdae [--check] [--strict]   # everything below, ~15 s
node tools/export-seoul-data.mjs --out DIR       # the data files only (same code path)
node tools/export-seoul-data.mjs --textures      # seoul/tex/textures.json vs SEOUL_MATS + sha256
node tests/seoul-parity.mjs [--strict|--record]  # G7
```
`--check` compares every output byte for byte with DIR (CI exports, then re-checks in a second process). `--strict` fails on
any `warnings` entry. A partner stream's exporter that doesn't exist yet is a `notes` entry (its shim is used), not a warning.
Default seed 11 = the game's (`buildSeoul` `opts.seed ?? 11`).

**Geometry entry (C, native #1).** export-world calls `world-seoul.js` `buildGeometry({seed, level, headless})` and expects
`{merged, colGeo, colRanges, emitters, lines, funnels, startPoints, takeStart, spawn, bounds, envelope, materials, layout,
facts, setPieces?}` (spawn / bounds / envelope exactly as `buildSeoul`'s world). Until C exports it, `LEVEL_SHIMS` in
tools/export-world.mjs makes the same calls `buildSeoul` makes (layout.json, lines.json, `buildSeoulGeometry`, `boxOf`).

**Files in exports/seoul-hongdae** (all listed with bytes + sha256 in world.json `files`):
- `world.glb` (one mesh per material key, sorted; attributes POSITION, NORMAL, TEXCOORD_0 = planar world metres, `_AEM` = aEm,
  the per-vertex emitted radiance of glass / shop / lamp in scene units), `collider.glb` (`extras.ranges`: vertex range per
  material key, a triangle belongs to the range of its first vertex; skim = every range but walk / road / plaza).
- `world.json` (`format onetake.world/1`, as §2 plus): `source.entry` (buildGeometry or the shim), `layout` summary, `facts`,
  `materials[k].textures[map] = {url, ktx2}`, `data` (one entry per file below with counts and source), `textures`,
  `runtimeOnly`, `coverage` + `coverageObjects`, `coverageNode` (the rules applied to the headless scene), `notes`, `warnings`.
- `emitters.json` (`onetake.emitters/1`): every L3 record the game lights with (4,946 at t = 0: geometry stores + street
  lights, signs, screens, vehicles), struct-of-arrays so each column decodes as one Swift array: `id[i]`, `kinds[kind[i]]`,
  `sources[source[i]]`, `pos[3i..]`, `normal[3i..]`, `w`, `h`, `rgb[3i..]` (linear, luma 1), `nits` (cd/m2, mean over the
  rect), `animated` (1 = per frame: screens from screens.json, vehicles from life.json), `lot`, sparse `flicker` / `extra`.
  In nits on purpose: EDR on Metal keeps sign cores at 600-2000 nits instead of clipping (radiance = rgb x nits x NITS).
- `signs.json` (`onetake.signs/1`): B's `exportData()`, else the generator's spec table (type, style, lot, floor, lit, colour
  category / hue / rgb, face nits, flicker, name, `frame` = facade basis, `geo` = placement) + constants; `signs.glb` = the
  static sign geometry (housing, lit, off, neon, scrollers; `COLOR_0` = face nits, `_FLK` = flicker hz / depth / phase).
  [P3] B's exportData writes `faces` (one per sign face, one record per line); world.json `data.signs.count` = faces. Glyphs
  come from B's MSDF atlas (`signs/msdf.png` + `signs/msdf.json`, below).
- `screens.json` (`onetake.screens/1`): per screen pos / normal / w / h, LED grid `res` and `pitch`, `scanHz`, peak `nits`,
  refresh-band and moire constants, and the playlist (`prog`, `t0`, `dur`, palette (linear), text rows, seed). **SCREEN_FRAG**
  (source in `shaders`) is a function of: the playlist segment at `lt0 = fract((t + phase) / len) * len` (t = take clock),
  `uProg` (PROG ids), `uC0..2`, `uRow` (text texture rows), the LED grid (`uRes`; SMD dots up close, moire at mid range
  weighted by `uMoire`), louvre angle falloff, rolling refresh bands (`uBandDepth`, `uBandN = scanHz x 0.011`, `uBandRate`),
  `uBlack`, and `uCut` (the first 1/30 s of a segment). The emitter colour follows `programMean` (source included).
- `light.json` (`onetake.light/1`): [P3] D's live controller, `world.parts.light.exportData()` after a headless `attach()`
  (the model of `exportParams()`, `grid` {x0, z0, cell, gw, gh, K, Kd, Nd, window, eMin}, plus binary tables, see §8); before
  P3 the shim: NITS (0.1 scene units per cd/m2), SOURCE_TYPES, NIGHT_SKY, the
  grid (`cell` 4 m, K / Kd per quality, LPR, LW, E_MIN), the binning / range / shading rules, `emitterRadiance` source, and
  the GLSL heads (CITY_HEAD, WET_HEAD). On Metal: compute-clustered lights with no K cap.
- `life.json` (`onetake.life/1`): G's `exportData()`, else LIFE, VEH, PAINT, the signal functions, the seed, the lane graph
  (streets, nodes, crossings, lanes with stops / bus stops / successors) and the parity vectors.
- `dressing.json`: E's `exportData()`: set pieces, emitters, holes, cables, labels (the label atlas cells), lamps,
  obstacles, materials (wall-clock `facts.ms` / `msParts` stripped).
- `look.json`: the night look as main.js applies it (FPVCamera → setHDR(true) → setLook('night') → levels.json `grade`).
- `layout.json`, `lines.json`: the inputs, copied as is.
- `tex/*.ktx2` + `tex/textures.json` (native #4): the Poly Haven maps SEOUL_MATS uses, vendored in `seoul/tex/` (CC0):
  diffuse Basis ETC1S (sRGB), normal maps UASTC + zstd (linear), mipmapped, **rows pre-flipped** so sampling at uv with no
  flip equals three's TextureLoader (flipY) on the JPG; transcode to ASTC 4x4 on device. 8.5 MB for 18 maps (the JPGs were
  10.5 MB, fetched at runtime); GPU ~1.4 MB per map instead of 5.6. Re-encode after C adds a map:
  `KTX2_NODE_MODULES=... node tools/export-seoul-data.mjs --vendor-textures` (until then a `notes` entry and the JPG URL;
  a vendored file whose sha256 differs from textures.json is a warning, so `--strict` fails).
  Browser side (C / D): `KTX2Loader` (three/addons, transcoder from the same CDN path as three) with
  `setTranscoderPath(.../examples/jsm/libs/basis/)` and `detectSupport(renderer)`, `seoul/tex/<id>_<map>.ktx2`, the JPG
  URL as the fallback.

**Partner exporters** (the shims step aside as soon as these exist): a module export `exportData(layout, ctx)` (or the
same method on its named / default object), ctx = `{layout, seed, nitScale, NIT, quality, headless: true, world, emitters}`.
Return the file's object (`light.json`, `life.json`), or for B `{signs, screens}` (or `{'signs.json', 'screens.json'}`),
plus optional `files: {name: Uint8Array | {data, width, height} RGBA | object}` (an MSDF atlas, say). B may also return
`signs.geometryMeshes: {name: BufferGeometry}` for signs.glb.

**Coverage** (world.json `coverage`, tests/coverage.js; node: export-world, browser: `tests/browser.mjs --level`): every
Mesh, Points and Line in the live Seoul scene must match a rule: `city` (world.glb rows), `signs`, `screens`, `crowd`,
`traffic`, `life-props`, `headlight-pools`, `sky`, `steam`, `airlight` [P3], `dressing` (any object under a group named
`seoul-dressing*` or `seoul.dressing*`). A new mesh class needs a rule plus its data first, or CI fails. [P3] `city` also
matches D's culling cells (seoul-light.js `splitCells`): a mesh whose `userData.seoulKey` (or `exportKey`) names a world.glb
row and whose box lies inside the row's; the cells of a row must draw all of its triangles (`partialExports` fails).

**Parity (G7).** `tests/seoul/walking.otil`: an autopilot flies WALKING STREET along the street's centreline in Cine,
recorded on the Seoul collider (header.world = world.json `hash.collider`); `walking.take.json` = its Take events (start,
line). `tests/seoul/parity.json`: `LifeSim(layout, {seed: 11})` at t = 0, 5, 37.5, 90: `hash()` (bit-exact) and 12
vehicle boxes (1e-9 m: `TrafficSim.pose` still uses `Math.sin` for the scooter weave). After an intentional change to the
Seoul geometry, lines.json, flight.js, take.js or seoul-life.js: `node tests/seoul-parity.mjs --record` and commit
tests/seoul/. Once F1's movers land (`world.movers`), the log should be re-recorded with traffic in the world.

**CI** (`.github/workflows/ci.yml`): the test job adds test-seoul, seoul-life, seoul-signs, `seoul-parity --strict`, and
the Seoul export (`--strict`, then `--check --strict` in a second process); `exports/seoul-hongdae` rides in the `exports`
artifact. The `browser-seoul` job loads `?level=seoul-hongdae&perf` in SwiftShader: no errors, the level's ?perf segments
(perf-levels.js: walk, canyon, club, high, each with `upd` = world.update() alone), coverage, three stills vs
tests/golden-seoul-hongdae.json (`--update` writes it). [P3: see §8 for what CI runs now.]

**What Metal buys this level** (panel native #6): EDR sign cores at 1000+ nits (emitters.json is already in nits); MetalFX
temporal upscaling from ~0.6x against cable and window-grid shimmer; in-tile MSAA resolve (~0.8 ms); ICB culling of the
340 lots; compute-clustered lights with no K cap and RT shadow rays for the brightest emitters; ASTC (206 → ~70 MB);
120 Hz ProMotion with `thermalState` feeding the governor; LifeSim on its own thread (it is pure and deterministic).

## 8. Phase 3 (stream H): CI, light tables, atlases, snapshot v4

**CI is green on main and stays honest** (`.github/workflows/ci.yml`, four jobs):
- `test` (~4 min on a runner): syntax, replay, lightmaps, take, stress-lite, test-export, test-seoul, test-facades, seoul-life,
  movers, seoul-signs, seoul-light, seoul-dressing, camera-night, seoul-ui, `seoul-parity --strict`, the bando export, the
  Seoul export `--strict` then `--check --strict`. Every step runs even after one fails (`if: !cancelled()`).
- `audio`: tests/seoul-audio.mjs (node-web-audio-api 1.0.4 from ci/package.json; it links libasound, installed if missing).
- `browser`: bando in SwiftShader, stills vs tests/golden.json.
- `browser-seoul` (90-min cap): Seoul in SwiftShader, coverage, stills vs tests/golden-seoul-hongdae.json, then the camera gate.

**Known failures** (`ci/known-failures.json`, `ci/run.mjs`): a suite with a failure that is already on main runs through
`node ci/run.mjs <suite> [args]`. It passes only when every FAIL line it prints matches an entry for that suite (each names
an owner and becomes a `::warning::`), and nothing crashed. A fixed entry prints a notice: delete it. At P3 start: G1's
crowd densities, F2's lineNames, and camgate's [colour] rows, club90's floor and the AE EV (A, with D).

**Goldens without a 50-minute run.** Every browser run writes `stills.json` (p5 / p50 / p95 / clip per shot, EV, seconds)
into its artifact. After an intended look change, download the artifact of that commit and
`node tests/browser.mjs [--level seoul-hongdae] --golden-from <artifact>/stills.json`, then commit the golden. Seeded from
main bfe39b1's CI run (bando from its log; Seoul re-measured from its JPEGs, which reproduces the in-page numbers exactly).

**Camera gate in CI (colour #6).** For a level in `CAMGATE` (Seoul), each still is also saved lossless:
`camgate/<shot>.png` at the shipped grade and `camgate/<shot>.r0.png` one frame later at retro 0, with `readEv()` for each.
`tools/camgate.py --stills DIR --evs stills.json` gates the exposure rows (clip, blob, EV, ground, sky) and the colour rows:
neutral fill R-G <= +10 and |B-G| <= 8 at retro 0; lit warm surfaces' median saturation <= 0.55; warm share 45-65 %; white
area 2-5 % on sign frames. FAIL lines are tagged `[exposure]` / `[colour]`. Locally it still takes seoulsnap stills + log.

**Light tables (native #2).** light.json keeps the JSON model; the GPU tables are little-endian binaries:
- `light/records.bin`: RGBA32UI, 2 texels per static light (`record` in light.json), width 2 x LW.
- `light/grid.bin`: RGBA16UI, per 4 m XZ cell the K strongest static ids (0xFFFF = none), K/4 texels per cell.
- `light/volume.bin`: RGBA16F, A block then B block, `[cz][cx][layer][4]` at `volume.heights`; E(n) = A.rgb max(0, 1 + B.n).
- `light/height.bin`: R32F roof heights at `res` m (occlusion of light paths).
Rebuilt per frame (not exported): the dynamic window (animated screens, vehicles) and the light curves.

**Atlases and fonts (native #2):** `signs/msdf.png` (2048^2 MSDF, linear, y down) + `signs/msdf.json` (8 faces, 10 numbers
per glyph); `interiors.png` (C's 1024 x 1280 room/poster atlas, sRGB rgb + linear alpha, PNG row 0 = v 0) +
`interiors.json` (ATLAS, ROOM, FRONT, mean luminance per tile); `fonts/*.woff2` (screen / scroller text, painted at load) and
`dressing/E-Sans.woff2` (E's labels: the cells are dressing.json `labels`). All OFL; licences copied alongside.

**LifeSim off the main thread (native #5, perf #3).** `seoul-life-worker.js` (the shell) runs G1's `LifeSim` unchanged in a
module worker; `seoul-life-client.js` (`LifeWorker`) is the main-thread side. Per frame: `request(t, cam)` (never blocks; a
busy worker keeps only the newest request), `latest()` returns the finished frame (crowd X, Z, YAW, PH, WALK, POSE, VIS and
8 floats per vehicle: x, z, hx, hz, hidden, brake, hazard, type), `release(f)` sends its buffers back with the next request:
transferred both ways, one allocation in 60 frames. The worker's output equals the inline sim bit for bit
(tests/life-worker.mjs, in CI) because the sim is a pure function of the take clock; the colliders stay on the main thread's
own LifeSim, so take parity never waits on a worker. Browser workers have no import map: the client resolves 'three' with
`import.meta.resolve` and the worker imports seoul-life.js with that URL patched in, until G1 splits the sim into a
three-free module. Wiring (G1, seoul-life.js `build`): create it when `ctx.lifeWorker`, then in `update()` request
`clock + W + dt` and fill the tiers from `latest()` instead of `crowd.evaluate`; the tier packing can follow into the
worker once it is a pure function. On Metal: the same sim on its own thread.

**Snapshot v4** (flight.js `SNAP_VERSION` 4, `Drone.snapshot()`): v3 plus
- `tick`: step() calls since reset(); the movers' clock is t = tick / 240 s, so a re-sim from any snapshot asks
  `world.movers.hit(p, r, t)` the same questions. Restore it exactly (UInt64 in Swift).
- `moverN` (contacts so far: a pedestrian is SCRAPE + HEADS! in take.js), `moverKind` ('vehicle' | 'pedestrian' | null),
  `moverImpact` (m/s), `crashBy` (the vehicle type that crashed the quad, or null), `mvId` / `mvT` (the last mover touched
  and its tick: a contact counts again when the body changes or after MV_GAP ticks).
Older snapshots restore with tick 0 and no contact. A port's movers must be a pure function of (t, p, r): life.json's
parity vectors pin the traffic.

