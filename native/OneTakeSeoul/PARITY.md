# Neon Seoul native slice: parity spec (P4 stream H, native #6)

**Status (P6 H): compiled and passing.** First compiled on Linux with Swift 6.1.2 against main bc45fbe's CI export:
7/7 tests pass (the P4 code needed no fix; SHA-256 now has a portable path beside CryptoKit, the lightmap reader is new).
CI runs it on every push after the `test` job, against that commit's own export: `native-linux` (swift:6.1-noble) and
`native-macos` (macos-15: swift test, plus an iOS-SDK `xcodebuild` of the package). Locally:
`sh fetch-meshopt.sh && ONETAKE_EXPORT=<export dir> swift test` (`ci/merge-check.mjs` runs it when `swift` is on PATH).
There is no Metal code yet: section 4 is the order, and its step 1 is the next job on the Mac.
**Status (P8 H):** the Metal frame (MetalFrame.swift, native-macos) draws walk0 at the camera that drew the browser's
still, with section 4.1-4.2's static light (lightmap ground + wall rects, the irradiance volume elsewhere), the layer
albedos, and the browser's retro-0 grade through the fisheye; tools/parity-de.py gates its mean Delta E 2000 against
Tests/SeoulBundleTests/ref/walk0.r0.png at <= 3 (section 4.6). The CPU halves (CityLight, CityMaterials, NightGrade,
FisheyeLens) run on Linux too: 13 tests.

The slice proves one thing before any rendering work: the phone reads the web export and gets the same world. Every
check below has a JS twin in the exporter (tools/export-world.mjs, tools/export-seoul-data.mjs), which already runs
it on every CI export, so a Swift failure means the port is wrong, not the data.

## 1. Bundle (Tests: testFilesIntact)
- Input: `exports/seoul-hongdae` from CI (artifact "exports") or `node tools/export-world.mjs --level seoul-hongdae`.
- Every file in world.json `files` has the listed byte count and sha256.

## 2. Bit-exact (must match exactly)
| What | How | Reference |
|---|---|---|
| GeoHash `mm3x2/1` | testGeoHashVectors | geohash.js; vectors in the test |
| Collider triangles | decode collider.glb (INDICES codec, float32 positions), expand in index order | world.json `collider.soupHash` |
| Traffic | LifeSim port: hash after advanceTo(t) at t = 0, 5, 37.5, 90 | life.json `parity.vectors[].hash` |
| Flight + Take | replay tests/*.otil at 240 Hz | tests/seoul/parity.json (tests/seoul-parity.mjs) |
| Packed streams | meshopt_decodeVertexBuffer of each `data.packed` file | `decodedBytes`; lossless |
| Night lightmap | NightLM: NLM2 header, key == light.json `lightmap.key` (a stale key throws), gunzip, un-plane | `lightmap.texelHash` (testNightLightmap) |
| SHA-256 | CryptoKit (Apple) and the portable FIPS 180-4 path agree on the standard vectors | testSHA256Vectors |
| signs.bin columns | decode per column (i32 / f32; fixed point x `scale`) | the JSON values (exact) |

The collider is the contract for collision parity. Keep its triangle order (three-mesh-bvh order) when building the
Swift BVH, and keep each triangle's vertex order. Ties between equal hit distances then resolve the same way.

## 3. Bounded (lossy by design, and stated in world.json `meshes[].glb`)
- world.glb / signs.glb positions: EXP filter, 20-bit mantissa. Error is at most 2^-19 relative (<= 1 mm at 500 m).
  Bounds must sit within 2 mm of `meshes[].bounds` (testWorldMeshesDecode).
- Normals: oct 12-bit in short4 snorm, within 0.25 deg. UVs (world metres): 18-bit mantissa. Other floats: 20-bit.
- Triangle counts equal `meshes[].triangles`; vertex counts equal `meshes[].glb.vertices`.

## 4. The Metal slice, in order (each step gated by the one before)
1. **Static city:** world.glb, upload the stored formats as is (float3, short4 snorm, uint index) and draw the 13
   meshes. Materials come from world.json `materials` and the KTX2 maps (tex/; transcode Basis to ASTC 4x4). Match the
   browser's stills, retro 0 grade, at the CI poses (tests/golden-seoul-hongdae.json) within the golden tolerances.
2. **Light:** emitters.json + light.json. Records, grid and volume come from light/*.bin; the lightmap comes from
   light/night-lm.bin: the browser's own file (NLM2 header, gzip of 4 row-delta byte planes of RGB9E5 texels; upload
   as MTLPixelFormatRGB9E5Float). Use it only when its header key equals light.json `lightmap.key`. Use clustered lights in compute with no K cap.
   EDR output keeps sign cores above 1000 nits.
   **Light-record lobes** (the record's type field; light.json `lobes`): 0 lambert, 1 street, 2 beam, and **3 pack**
   (P6, stream D: wall packs light a pool and a wall scallop instead of P5's even sheet). `pack`: c = -D.y 0.9397 +
   dot(D.xz, forward.xz) 0.342; 0 for c <= 0.42, else (0.3 + 0.7 c^2) smoothstep(0.42, 0.58, c); intensity = lumens /
   2.222485 sr x the lobe. Swift reference: Sources/SeoulBundle/Lobes.swift (testWallPackLobe, vectors from the JS).
   The Metal light loop must branch on all four ids, or wall packs go dark on the phone.
   **Height rules** (P7 H): a mesh with world.json `meshes[].visibility` draws only while the eye's world Y >=
   `cameraYMin`. Today that is E's `dr_roof` (roof planters, pipes, solar panels behind the 0.9 m parapets):
   cameraYMin = dressing.json `facts.roofHideY` (6.6 m) minus build()'s 0.25 m margin. Swift: Visibility.swift
   (`heightRules()`, `drawn(_:cameraY:)`; testHeightRules checks the rule against dressing.json and the mesh bounds).
3. **Signs:** signs.glb + signs.bin + signs/msdf.png. Draw the 5 batched groups and the sign tiles from an indirect
   command buffer, culled on the GPU.
4. **Life:** [P7 H] the opening cities are bundled: life/traffic-snapshots.json holds TrafficSim.snapshot() at take
   clock 0 (sim 75 s, LIFE.warm) and every 10 s to 240 s (LIFE.warmMax), for the game's own net and seed. The port
   restores one and steps on (restore(80 s) + 600 steps == the 90 s snapshot, checked by the exporter; Swift:
   testTrafficSnapshots checks steps, lane indices and counts).
    the LifeSim port on its own thread, a pure function of the take clock (section 2's traffic hash).
   Compute-skin the crowd from people/ (people.bin layouts in world.json `data.content.people`). The thread follows
   the browser worker's protocol (P5, seoul-life-worker.js): warm to take clock + 75 s before the first frame; a far
   target fast-forwards in slices of at most 40 ms and is retargeted by a newer request (only the newest is answered);
   a rewind restores the newest traffic snapshot at or before it (every 600 ticks up to tick 36000, then every 3600).
   The crowd evaluate is stateful by design (units past 60 m every 3rd frame, past 110 m or behind the camera every
   6th, keyed on a frame counter): the thread takes the render loop's counter with each request, so it thins the same
   units on the same frames as the inline sim (tests/life-worker.mjs: identical tier counts after frame 1).
   **Crowd buffer (spec, P5 native #4):** per drawn person 3 x half4 = 24 bytes, one buffer per tier, one upload per
   tier per frame:
   - `h0` = (x - camX, y - camY, z - camZ, yaw): camera-relative metres (half: <= 1.6 cm inside 32 m, <= 6 cm at 128 m;
     the far tier ends at 170 m), yaw in radians;
   - `h1` = (gait phase 0..1, walk amount 0..1, pose index, height scale);
   - `h2` = (head yaw, head pitch, id >> 11, id & 2047): the person id split so both halves are exact integers.
   Everything constant per person (top, bottom, hair, skin, fill, wear colours, accessory bits, seed) is a static
   table indexed by id (6 x RGBA8 sRGB + u32), written once. Object-blur velocity = (h0 now - h0 last frame +
   camera delta) / dt, from the previous frame's buffer. The browser still uploads 10 float vec4 attributes per drawn
   person (156 bytes; seoul-life.js makeHumanMat, G1): adopting this layout there is the open half of panel4 perf #2.
   **Depth:** the traffic is in the depth pass (seoul-depth.js: each vehicle type's instances, depth-only); the crowd
   is not (its skinning would double the depth pass's triangles).
   **[P8 H] Walls, materials, volume, grade (done, MetalFrameTests):** the wall rects come from light/records.bin
   (RGBA32UI, 512 wide; rows uCityLMR.x = the edge table, 2 texels per edge: [x0, z0, ux, uz] and [rect u, v, signed
   length, height] as floats; uCityLMR.y = the 1 m raster, 2 edge ids per cell); the city takes E x albedo / pi with
   albedo = world.json `materials[layers[aLay]].albedo` x COLOR_0. Where the lightmap has no texel, the volume:
   light/volume.bin A then B, RGBA16F [cz][cx][layer], uploaded x = cx, y = cz, z = layer, E = A max(0, 1 + B.n).
   The grade (Grade.swift) is fpvcam.js FINAL_FS + NIGHT at retro 0 without its screen-space lobes; exposure is the
   browser's AE EV (stills.json `ev0`), the lens its solved fisheye (stills.json `cam.lens`).
   **Still to port, in this order:** the records' direct lobes 0-3 and the emitters (cityLights), the sky and SKY_AIR,
   the signs (step 3), KTX2 -> ASTC maps, the people (step 4), then the bloom / halo lobes of the grade.
5. **Frame:** MetalFX upscaling from 0.6x. Run at 120 Hz with `ProcessInfo.thermalState` stepping the presets
   (the browser's ?perf SHARE results give the starting point).

6. **[P8 H] The parity gate:** tools/parity-de.py, mean Delta E 2000 over the pixels Metal drew <= 3 against the
   browser's still of the same camera (CI: native-macos, through ci/run.mjs; the gap is ratcheted in
   ci/known-failures.json until the steps above land). Re-take Tests/SeoulBundleTests/ref (walk0.r0.png + walk0.json)
   from one CI browser-seoul artifact whenever the goldens are re-recorded.

## 5. Not covered yet
- Screens are procedural (screens.json playlists + SCREEN_FRAG), so the port needs its own shader. Parity there
  means stills, not bytes.
- Audio is synthesised (seoul-audio.js). There are no recorded beds until Justin decides (sound #1).
