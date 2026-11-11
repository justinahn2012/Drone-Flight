# Neon Seoul native slice: parity spec (P4 stream H, native #6)

**Status: untested.** This package was written on the Linux export box, which has no Swift or Metal toolchain. Nothing
here has been compiled. The first job on a Mac is `sh fetch-meshopt.sh && ONETAKE_EXPORT=<export dir> swift test`.

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
3. **Signs:** signs.glb + signs.bin + signs/msdf.png. Draw the 5 batched groups and the sign tiles from an indirect
   command buffer, culled on the GPU.
4. **Life:** the LifeSim port on its own thread, a pure function of the take clock (section 2's traffic hash).
   Compute-skin the crowd from people/ (people.bin layouts in world.json `data.content.people`).
5. **Frame:** MetalFX upscaling from 0.6x. Run at 120 Hz with `ProcessInfo.thermalState` stepping the presets
   (the browser's ?perf SHARE results give the starting point).

## 5. Not covered yet
- Screens are procedural (screens.json playlists + SCREEN_FRAG), so the port needs its own shader. Parity there
  means stills, not bytes.
- Audio is synthesised (seoul-audio.js). There are no recorded beds until Justin decides (sound #1).
