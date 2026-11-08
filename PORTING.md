# One Take FPV: native port map (Swift + Metal)

The web build (three.js r180, flat files) remains the design lab and the **reference** that the iPhone app is tested
against. The port is a Swift + Metal renderer with the game logic rewritten in Swift, built by GitHub Actions
(XcodeGen `project.yml` → macOS runner → TestFlight). Nothing in the port depends on running JavaScript.

Regenerate the exported data after any change to the world, camera or look (each is a single command, ~1 s):

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
