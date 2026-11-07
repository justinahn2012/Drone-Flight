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
| `world-bando.js` `buildBando` (2062 total) | materials, light bake, grass, foliage, graffiti, sky, shadows | `Render/World*` | Materials = `MeshStandardMaterial` + `weatherPatch` (one program per kind: built, ground, track, bark, decal, grass, leaf, treeline) + `aLightingPatch` (adds the baked sun and sky bounce to indirect diffuse, blends the live shadow map into the far one, applies the sun-occlusion mask and adds sun haze to the fog). Port the GLSL to MSL by hand. Light comes from A1's lightmaps (lm_*.png). Grass is shader-procedural (port the vertex shader). Foliage and graffiti placement still happen at load (see §6). |
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
  material key (`bark brick rust silo slab wall`), then `terrain`, `far` and `path`.
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
- `instances.treelineCrown`: layout `x y z rotY sx sy sz tint`, M = T·Ry·S
- `instances.tree`: layout `x y z h r`
- `lightmap`: A1's lm.json when present
- `runtimeOnly`: what is still generated at load
- `warnings`: must be empty

Hash `mm3x2/1` (tools/geohash.mjs):
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
**Integration:** A1 should compute that hash with `tools/geohash.mjs`, so that `lm.json` and `world.json` agree.

**Input log (stream E, inputlog.js):**
- header: seed, world hash, craft, mode, tick rate, start snapshot
- 5 × Int16 channels per 1/240 s tick
- a full `Drone.snapshot()` every 240 ticks
- size: about 144 KB/min

The header's world hash should be `world.json` `hash.world`. A log replays only on the geometry it was recorded on.

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
| G4 | take replay | same logs, web event list | identical events (type, name, pts, flow, total) | XCTest | M1 |
| G5 | camera passes | `fpv.renderGolden()` dumps | per stage, max abs error ≤ 2e-3 linear (≤ 1 LSB at the 8-bit output), grain off | Metal device | M1–M2 |
| G6 | reference frames | web smoke shots (spawn, silo, hall, chimney, takestart), exposure locked | SSIM and luma percentiles (p5/p50/p95) within thresholds set from the first M1 frames | Metal device | M2 |

- **G1–G4** are pure CPU and run on the CI macOS runner.
- **G5–G6** need a Metal GPU. M0 checks whether the CI runner provides one; otherwise they run on a device (a
  self-hosted Mac or a TestFlight test build).
- **CI order:** `node tools/export-world.mjs --check` (fails if the committed export is stale) → G0 → the Xcode build
  → G1–G6.

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
- Bake the canvas atlases (graffiti, leaf cluster), the ground mask and the 1k JPGs to KTX2/ASTC.
- Dump the expanded GLSL of every world and camera program next to `renderGolden()`, so the MSL port has exact
  sources.
