// world-bando.js — an open abandoned industrial site ("bando") built for FPV:
// open grass field, silo battery on a column table with a head house and an open stair shaft,
// a hollow 50 m brick chimney (dive in, exit at the base), a 3-storey concrete frame hall with holes,
// a conveyor gallery you can fly inside, a workshop ruin, a pipe rack, a beam bridge and a tank.
// Realism comes from CC0 photo-scanned materials + a real sky photo for light (Poly Haven),
// sun shadows, baked sky-visibility occlusion, procedural weathering and graffiti.
// Collision = the same geometry (exact), through a BVH.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { GCOLS, GROWS, GCELLS, GTYPE, GRAFFITI_SEED, graffitiCells, graffitiPixels } from './graffiti.js';
export { graffitiCells, graffitiPixels };   // [P5] drawn in graffiti.js (tools/export-world.mjs: graffiti.png)
// [S0] the shared engine (materials, light bake, lightmaps, shadows, sky, geometry helpers) lives in world-core.js;
// this module is the bando site: its plan, lines, materials table, graffiti, ground mask, grass, vegetation and build.
import { PH, SKIES, skySunDir, skyEnvI, LIVE_SHADOW, SUN_MAPS, rng, yieldUI, planarUV, setAY, cylGeo, indexify, Site, wallWithHoles, tubeGeo, ringGeo, subRng, Y_UP, flatTex, flatNorm, GRASS_HASH, GRASS_LIGHTS, VEG_GLSL, VEG_CARD_VS, VEG_LEAF_LIGHTS, glslWeather, wpFrag, makeWeatherPatch, depthC2Mat, depthC2Opaque, aoCurve, LP, skyVisibility, siteBake, lightUniforms, aoUniforms, lightmapUV2, GeoHash, lmFetchJSON, lmMatch, lmLoad, lmEnable, renderSunMap, blankSunMap, renderRingShadow, skyShadowUniforms, applySky, loadSky } from './world-core.js';
export { SKIES, skySunDir, skyEnvI, LIVE_SHADOW, SUN_MAPS, LMUV, lightmapUV2, geometryHash, lmMatch, equirectDir, equirectTexel, applySky, loadSky } from './world-core.js';   // [S0] unchanged API for tools/ and tests/
// [B] surfaces. CC0 Poly Haven sets at 1k; `maps` = which maps are worth downloading.
// color = linear multiplier on the diffuse map (measured texture means, see report); w = weathering
// [streaks, base damp, up-facing grime, moss]; wx = [streak columns per m, cylinder radius (0 = planar walls),
// soot strength, soot depth from the element top in m]; roughMin = roughness floor (kills the glossy blue sky rim).
// albedo = linear mean RGB of the final shaded material (texture x color x mean weathering): the light bake reads it.
// Concrete is warm-neutral (R/G 1.03, B/G 0.915): the camera white balance supplies the warmth, not the albedo.
const MATS = {
  silo: { id: 'concrete_layers_02', tile: 3.0, maps: ['diff', 'nor_gl'], color: [1.523, 1.555, 1.576], rough: 0.95, roughMin: 0.86, w: [0.85, 0.34, 0.5, 0.35], wx: [0.28, 4.2, 0, 8], albedo: [0.300, 0.290, 0.265] },
  wall: { id: 'concrete_wall_006', tile: 3.0, maps: ['diff', 'nor_gl'], color: [2.885, 3.642, 4.584], rough: 0.95, roughMin: 0.86, w: [0.45, 0.36, 0.55, 0.3], albedo: [0.290, 0.2815, 0.2576] },
  slab: { id: 'concrete_floor_02', tile: 4.0, maps: ['diff', 'nor_gl'], color: [1.663, 1.939, 2.788], rough: 0.95, roughMin: 0.88, w: [0.35, 0.3, 0.6, 0.45], albedo: [0.280, 0.272, 0.249] },
  // chimney coping (art r3 #4): the same brick under a lime wash, x1.5 and toward neutral; radial headers (polar UVs)
  coping: { id: 'factory_brick', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.54, 1.8, 2.67], rough: 0.92, roughMin: 0.82, w: [0.3, 0.0, 0.3, 0.15], albedo: [0.352, 0.261, 0.243] },
  // brick: less pink (art #7), streakier, the top 8 m sooted (x0.55 at the rim)
  brick: { id: 'factory_brick', tile: 2.2, maps: ['diff', 'nor_gl'], color: [1.08, 1.0, 1.55], rough: 0.9, roughMin: 0.8, w: [0.6, 0.3, 0.4, 0.2], wx: [1.7, 0, 0.45, 8], albedo: [0.247, 0.145, 0.141] },
  rust: { id: 'rust_coarse_01', tile: 2.0, maps: ['diff'], color: [2.05, 3.2, 6.53], rough: 0.82, roughMin: 0.7, w: [0.25, 0.2, 0.35, 0.1], albedo: [0.245, 0.128, 0.089] },
  // ground and track: greener, darker, less chromatic (decision 3 / graphics #2: reference ground L39 C6)
  ground: { id: 'grass_ground', tile: 4.0, maps: ['diff'], color: [1.05, 1.3, 2.0], rough: 1, kind: 'ground', albedo: [0.128, 0.128, 0.068] },
  bark: { id: 'bark_brown_02', tile: 1.5, maps: [], color: [1.1, 1.1, 1.1], rough: 0.95, kind: 'bark', albedo: [0.136, 0.111, 0.066] },
  path: { id: 'grass_path_2', tile: 3.5, maps: ['diff'], color: [0.31, 0.345, 0.48], rough: 1, kind: 'track', albedo: [0.124, 0.121, 0.113] },   // [G5] neutral dirt (WP_FRAG.track)
  // not merged-geometry materials: the paved apron is sampled inside the ground shader; grass and leaves are atlases
  apron: { id: 'asphalt_02', tile: 5.0, maps: ['diff', 'nor_gl'], color: [1.75, 1.72, 1.72], kind: 'aux', albedo: [0.176, 0.170, 0.152], radius: 9 },   // radius: mean paved reach around footprints (5-12 m)
  // [V2] grass is geometric blades now (shader colour, no texture download); the albedo is the blades' mean (the bake)
  grass: { model: 'grass_medium_01', tile: 1, maps: [], kind: 'aux', albedo: [0.112, 0.109, 0.052] },
  // [V2] straw meadow seen from above: the dry patches of the ground shader (detail only, normalised to unit mean)
  meadow: { id: 'withered_grass', tile: 2.6, maps: ['diff'], kind: 'aux', albedo: [0.185, 0.152, 0.082] },
  leaf: { model: 'tree_small_02', tile: 1, maps: [], color: [1.4, 1.3, 1.5], kind: 'aux', albedo: [0.099, 0.124, 0.035] },
};
// [B] treeline crowns get low-poly collision proxies (15.6k tris, appended after the terrain in the collider).
// They cost ~7% of A's light-bake time (terrain-edge rays hit them); false = fly-through treeline, cheaper bake.
const RING_COLLIDE = true;
// [V1/T5] per type (A tree_small_02, B island_tree_01, J jacaranda_tree, S island_tree_02 shrub, V facade creeper): crown
// ellipsoid, height, lowest leaf and trunk + thick-limb skeleton [x0,y0,z0,r0, x1,y1,z1,r1] in model units (bake: T5's bake5.mjs, from veg.json).
const VEG_SKEL = {"A":{"crown":{"c":[0.2,3.454,0.459],"r":[0.978,0.989,1.703]},"H":4.557,"leafLo":1.496,"segs":[[0,0.1,0,0.078,0.146,1.3,0.151,0.068],[0.146,1.3,0.151,0.068,0.57,2.3,-0.06,0.039],[0.146,1.3,0.151,0.068,0.166,1.7,0.318,0.064],[0.166,1.7,0.318,0.064,0.115,1.9,0.421,0.074],[0.115,1.9,0.421,0.074,-0.006,2.5,0.74,0.081],[0.115,1.9,0.421,0.074,0.01,2.7,-0.025,0.034],[0.115,1.9,0.421,0.074,0.288,2.1,0.401,0.021],[0.57,2.3,-0.06,0.039,0.598,2.7,-0.289,0.024],[0.598,2.7,-0.289,0.024,0.645,2.9,-0.344,0.046]]},"B":{"crown":{"c":[0.299,2.751,-0.213],"r":[1.577,1.463,1.71]},"H":5.027,"leafLo":0.664,"segs":[[0,0.1,0,0.289,-0.117,0.5,-0.185,0.221],[-0.117,0.5,-0.185,0.221,-0.141,0.7,-0.227,0.23],[-0.141,0.7,-0.227,0.23,-0.124,0.9,-0.236,0.222],[-0.124,0.9,-0.236,0.222,-0.235,1.3,0.1,0.173],[-0.124,0.9,-0.236,0.222,-0.011,1.1,-0.519,0.162],[-0.011,1.1,-0.519,0.162,-0.052,1.3,-0.599,0.137],[-0.052,1.3,-0.599,0.137,-0.029,1.5,-0.682,0.154],[-0.235,1.3,0.1,0.173,-0.222,1.5,0.327,0.143],[-0.235,1.3,0.1,0.173,-0.578,1.7,-0.423,0.083],[-0.222,1.5,0.327,0.143,-0.101,1.9,0.586,0.174],[-0.029,1.5,-0.682,0.154,-0.016,1.7,-0.861,0.217],[-0.029,1.5,-0.682,0.154,0.052,1.7,-0.435,0.046],[-0.016,1.7,-0.861,0.217,-0.165,1.9,-0.8,0.106],[-0.578,1.7,-0.423,0.083,-0.477,1.9,-0.34,0.041],[-0.101,1.9,0.586,0.174,-0.258,2.3,0.968,0.144],[-0.165,1.9,-0.8,0.106,-0.266,2.1,-0.807,0.169],[-0.101,1.9,0.586,0.174,0.234,2.1,0.454,0.082],[-0.266,2.1,-0.807,0.169,-0.412,2.3,-0.981,0.016],[-0.258,2.3,0.968,0.144,-0.293,2.5,0.862,0.079],[-0.293,2.5,0.862,0.079,-0.312,2.7,0.931,0.086],[-0.312,2.7,0.931,0.086,-0.284,2.9,1.093,0.102],[-0.284,2.9,1.093,0.102,-0.452,3.1,1.152,0.04]]},"S":{"crown":{"c":[0.058,2.242,1.216],"r":[1.534,0.662,1.65]},"H":3.407,"leafLo":1.279,"segs":[]},"J":{"crown":{"c":[1.114,11.905,0.905],"r":[9.794,6.166,7.605]},"H":19.469,"leafLo":2.377,"segs":[[0.566,0.1,2.101,0.342,0.598,0.3,1.12,0.883],[0.598,0.3,1.12,0.883,0.608,0.5,1.143,0.658],[0.608,0.5,1.143,0.658,0.785,1.1,1.029,0.568],[0.785,1.1,1.029,0.568,0.362,1.3,0.753,0.375],[0.785,1.1,1.029,0.568,1.294,1.3,1.267,0.387],[1.294,1.3,1.267,0.387,1.655,2.1,1.308,0.375],[0.362,1.3,0.753,0.375,0.366,2.1,0.639,0.347],[0.366,2.1,0.639,0.347,0.233,3.3,0.524,0.461],[1.655,2.1,1.308,0.375,2.078,3.1,1.337,0.493],[2.078,3.1,1.337,0.493,1.666,3.3,1.597,0.326],[2.078,3.1,1.337,0.493,2.782,3.3,1.178,0.324],[0.233,3.3,0.524,0.461,0.128,3.5,0.625,0.476],[0.233,3.3,0.524,0.461,0.232,3.5,0.006,0.122],[1.666,3.3,1.597,0.326,1.688,3.7,1.831,0.34],[2.782,3.3,1.178,0.324,3.469,4.1,1.14,0.326],[0.128,3.5,0.625,0.476,0.501,3.7,0.505,0.271],[0.128,3.5,0.625,0.476,-0.409,3.7,0.818,0.305],[0.232,3.5,0.006,0.122,-0.009,3.9,-0.399,0.127],[0.501,3.7,0.505,0.271,0.592,4.5,0.397,0.277],[-0.409,3.7,0.818,0.305,-1.063,4.5,1.097,0.292],[1.688,3.7,1.831,0.34,2.056,4.7,2.443,0.321],[-0.009,3.9,-0.399,0.127,-0.604,4.3,-0.954,0.116],[-0.009,3.9,-0.399,0.127,0.12,4.1,-0.687,0.078],[3.469,4.1,1.14,0.326,3.619,4.3,1.283,0.292],[3.469,4.1,1.14,0.326,3.568,4.3,0.743,0.117],[3.619,4.3,1.283,0.292,3.941,4.5,1.37,0.334],[-0.604,4.3,-0.954,0.116,-1.03,5.1,-1.774,0.123],[3.568,4.3,0.743,0.117,3.688,4.7,0.446,0.116],[0.592,4.5,0.397,0.277,0.728,5.3,0.243,0.263],[-1.063,4.5,1.097,0.292,-1.244,4.7,1.155,0.29],[3.941,4.5,1.37,0.334,3.767,4.7,1.402,0.234],[3.688,4.7,0.446,0.116,3.955,4.9,0.128,0.26],[-1.244,4.7,1.155,0.29,-1.546,4.9,1.369,0.329],[2.056,4.7,2.443,0.321,2.012,5.3,2.791,0.347],[3.767,4.7,1.402,0.234,4.039,5.5,1.495,0.26],[-1.546,4.9,1.369,0.329,-1.546,5.1,1.276,0.257],[3.955,4.9,0.128,0.26,3.892,5.1,0.22,0.097],[-1.546,5.1,1.276,0.257,-1.838,5.5,1.284,0.296],[3.892,5.1,0.22,0.097,3.945,5.3,0.093,0.103],[-1.03,5.1,-1.774,0.123,-0.853,5.5,-1.77,0.03],[2.012,5.3,2.791,0.347,2.067,5.5,2.782,0.307],[0.728,5.3,0.243,0.263,0.816,6.1,0.212,0.268],[3.945,5.3,0.093,0.103,4.09,5.9,-0.632,0.109],[-1.838,5.5,1.284,0.296,-2.196,5.7,1.411,0.37],[4.039,5.5,1.495,0.26,4.146,5.7,1.281,0.24],[2.067,5.5,2.782,0.307,2.253,6.5,3.041,0.334],[4.146,5.7,1.281,0.24,4.39,6.5,1.007,0.224],[-2.196,5.7,1.411,0.37,-2.355,5.9,1.249,0.337],[4.09,5.9,-0.632,0.109,4.049,6.1,-0.834,0.059],[-2.355,5.9,1.249,0.337,-2.656,6.3,1.118,0.131],[0.816,6.1,0.212,0.268,0.788,7.3,-0.152,0.43],[2.253,6.5,3.041,0.334,2.556,6.7,3.172,0.176],[4.39,6.5,1.007,0.224,4.577,6.9,0.895,0.307],[2.253,6.5,3.041,0.334,1.965,6.7,2.903,0.233],[2.556,6.7,3.172,0.176,2.649,6.9,3.221,0.186],[1.965,6.7,2.903,0.233,1.723,7.5,3.037,0.31],[4.577,6.9,0.895,0.307,5.376,7.7,1.146,0.237],[4.577,6.9,0.895,0.307,4.613,7.1,0.489,0.118],[4.577,6.9,0.895,0.307,4.225,7.1,0.893,0.067],[2.649,6.9,3.221,0.186,2.779,7.1,3.021,0.073],[2.649,6.9,3.221,0.186,3.044,7.7,3.776,0.148],[4.613,7.1,0.489,0.118,4.757,7.3,0.326,0.121],[4.225,7.1,0.893,0.067,4.178,7.9,0.968,0.067],[2.779,7.1,3.021,0.073,3.019,7.5,2.915,0.094],[0.788,7.3,-0.152,0.43,0.236,7.5,0.023,0.266],[0.788,7.3,-0.152,0.43,1.103,7.5,0.088,0.234],[0.788,7.3,-0.152,0.43,0.895,7.5,-0.701,0.155],[4.757,7.3,0.326,0.121,5.471,7.9,-0.046,0.053],[0.236,7.5,0.023,0.266,-0.092,8.3,-0.204,0.121],[1.103,7.5,0.088,0.234,1.832,8.5,-0.131,0.181],[0.895,7.5,-0.701,0.155,0.929,8.3,-1.269,0.209],[1.723,7.5,3.037,0.31,1.603,7.9,3.218,0.359],[5.376,7.7,1.146,0.237,5.56,7.9,1.225,0.277],[1.603,7.9,3.218,0.359,1.273,8.1,3.554,0.165],[4.178,7.9,0.968,0.067,4.217,8.1,0.94,0.031],[1.603,7.9,3.218,0.359,1.861,8.1,2.957,0.196],[5.56,7.9,1.225,0.277,5.521,8.1,1.114,0.168],[1.273,8.1,3.554,0.165,1.147,8.5,3.655,0.176],[5.521,8.1,1.114,0.168,5.647,8.3,1.14,0.168],[1.861,8.1,2.957,0.196,1.85,8.5,3.001,0.197],[0.929,8.3,-1.269,0.209,1.251,8.5,-1.279,0.082],[0.929,8.3,-1.269,0.209,0.667,8.9,-1.927,0.211],[1.251,8.5,-1.279,0.082,1.403,8.7,-1.392,0.025],[1.147,8.5,3.655,0.176,1.06,8.7,3.383,0.08],[1.147,8.5,3.655,0.176,1.076,8.7,3.86,0.122],[1.85,8.5,3.001,0.197,2.028,9.3,3.248,0.189],[1.076,8.7,3.86,0.122,1.024,8.9,3.955,0.096],[1.06,8.7,3.383,0.08,0.945,8.9,3.309,0.081],[0.667,8.9,-1.927,0.211,0.68,9.1,-1.984,0.163],[0.68,9.1,-1.984,0.163,0.772,9.3,-1.923,0.027],[2.028,9.3,3.248,0.189,2.121,10.3,3.484,0.216]]},"V":{"crown":{"c":[0,2.48,0.15],"r":[0.65,1.8,0.2]},"H":4,"leafLo":0,"segs":[]}};
const texURL = (m, map) => m.model ? `${PH}/Models/jpg/1k/${m.model}/${m.model}_${map}_1k.jpg` : `${PH}/Textures/jpg/1k/${m.id}/${m.id}_${map}_1k.jpg`;

// ---------------------------------------------------------------- the site plan
const GROUND = 0;
function terrainHeight(x, z) {
  const d = Math.max(Math.abs(x + 5) - 95, Math.abs(z - 10) - 85, 0);    // flat working yard, rolling field beyond
  const n = Math.sin(x * 0.021) * Math.cos(z * 0.017) * 1.2 + Math.sin(x * 0.053 + z * 0.041) * 0.45 + Math.sin(z * 0.11 - x * 0.07) * 0.15;
  const ramp = Math.min(1, d / 40);
  return GROUND + n * ramp + Math.min(d, 180) * 0.012 * ramp - 0.05 * (1 - ramp);
}

// ---- layout. -z is north (silos, chimney), +z south (the hall, the spawn). The site is shaped around its named
// lines (see buildLines): chimney door -> pipe rack -> hall window is one straight line, the stair shaft is open
// top to bottom, the silo row has one 1.6 m gap lined up with the stair tower's openings.
// gaps 1.0 / 1.6 / 1.0 m. top = roof slab of the open north row; rim = its parapet (top at top + recess)
const SILO = { x: [-48.3, -38.9, -28.9, -19.5], z: [-22, -6], r: 4.2, table: 5.2, top: 32, rim: { band: 0.4, lip: 0.12, wall: 0.3, recess: 0.3 } };
const TOWER = { x: -33.9, z: -14, w: 4.4, T: 0.3 };
const SHAFT = { x0: TOWER.x - 2.05, x1: TOWER.x + 2.05, z0: TOWER.z - 2.05, z1: TOWER.z + 2.05 };   // inner faces
const HEAD = { x0: -54, x1: -14, z0: -17.8, z1: 0 };    // head house over the south row: the north row's caps stay open
// in line with the north row: mouth beside the caps. base: plinth top; cop / corb: coping and corbel course heights
const CHIM = { x: -8, z: -22, h: 50, rb: 3.4, rt: 2.0, th: 0.35, base: 0.5, cop: 0.45, corb: 0.25 };
const HALL = { x0: 6, x1: 70, z0: 14, z1: 36, fh: 5, levels: 3, cols: 11, rows: 5 };
const GAL = { A: [-14.3, 33.4, -6.5], B: [12.5, 15.35, 24.5], W: 3.0, H: 2.6 };
const STACK = [HALL.x0 + 1.5 * (HALL.x1 - HALL.x0) / (HALL.cols - 1), HALL.z0 + 0.5 * (HALL.z1 - HALL.z0) / (HALL.rows - 1)];   // the hall's stacked holes (FORCE 0:1:0 / 1:1:0 / 2:1:0): axis x, z
const ENTRY = [13.9, 14];       // hall window (north facade, bay 1) the chimney door + rack aim through, threading the columns
const DOOR = (() => { const x = ENTRY[0] - CHIM.x, z = ENTRY[1] - CHIM.z, l = Math.hypot(x, z); return [x / l, z / l]; })();
const RACK = { K: [CHIM.x + DOOR[0] * 6, CHIM.z + DOOR[1] * 6], H: [ENTRY[0] - DOOR[0] * 2.5, ENTRY[1] - DOOR[1] * 2.5] };
// bays the lines need, whatever the RNG says. Slab key `L:i:j` (slab over storey L; 2 = roof); facade key `fL:z0|z1:i`
const FORCE = {
  '0:1:0': 'hole', '1:1:0': 'hole', '2:1:0': 'slot',                              // TRIPLE POP / DROP behind the entry window
  '2:0:1': 'solid', '2:1:1': 'solid', '2:0:2': 'solid', '2:1:2': 'solid',          // the roof the gallery lands on
  'f0:z0:1': 'open', 'f0:z0:3': 'open', 'f0:z1:3': 'open',                         // rack entry; STRAIGHT THROUGH
};

// a horizontal slab (x0..x1, z0..z1, bottom y, thickness t) with rectangular holes [{x0, x1, z0, z1}]
function slabWithHoles(S, mat, x0, x1, z0, z1, y, t, holes) {
  const xs = new Set([x0, x1]); holes.forEach((h) => { xs.add(Math.max(x0, Math.min(x1, h.x0))); xs.add(Math.max(x0, Math.min(x1, h.x1))); });
  const cuts = [...xs].sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1]; if (b - a < 0.01) continue;
    const mid = (a + b) / 2; let zs = [[z0, z1]];
    for (const h of holes) {
      if (h.x0 > mid || h.x1 < mid) continue;
      zs = zs.flatMap(([p, q]) => (h.z1 <= p || h.z0 >= q ? [[p, q]] : [[p, Math.max(p, h.z0)], [Math.min(q, h.z1), q]].filter(([u, v]) => v - u > 0.01)));
    }
    for (const [p, q] of zs) S.box(mat, mid, y, (p + q) / 2, b - a, t, q - p);
  }
}
// a parapet / coping run along x or z: 1.5-6 m pieces, tops knocked down 0-0.6 m, ~10% of it missing
function brokenRun(S, R, mat, ax, az, bx, bz, y, H, T) {
  const alongX = Math.abs(bx - ax) >= Math.abs(bz - az), L = alongX ? bx - ax : bz - az;
  let s = 0;
  while (s < L - 0.05) {
    const len = Math.min(L - s, 1.5 + R() * 4.5), r = R();
    if (r < 0.1 && s > 0 && L - s > 2.5) { s += 0.6 + R() * 1.0; continue; }
    const h = Math.max(0.25, H - (r < 0.55 ? R() * 0.6 : 0)), c = s + len / 2;
    if (alongX) S.box(mat, ax + c, y, az, len, h, T); else S.box(mat, ax, y, az + c, T, h, len);
    s += len;
  }
}
// a placement matrix whose local +x runs along d (right-handed, local +y as close to world up as it can be)
function alongM(d, px, py, pz) {
  const side = new THREE.Vector3().crossVectors(d, Y_UP).normalize(), up = new THREE.Vector3().crossVectors(side, d);
  return new THREE.Matrix4().makeBasis(d, up, side).setPosition(px, py, pz);
}
// 3.5 cm rebar sticking out of a broken slab edge (a->b) into the hole (inward nx, nz), drooping
function rebar(S, R, ax, az, bx, bz, y, nx, nz, count, maxLen) {
  for (let k = 0; k < count; k++) {
    const t = 0.08 + R() * 0.84, px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
    const len = 0.22 + R() * (maxLen - 0.22), droop = 0.12 + R() * 0.7, yaw = (R() - 0.5) * 0.6, c = Math.cos(yaw), s = Math.sin(yaw);
    const d = new THREE.Vector3((nx * c - nz * s) * Math.cos(droop), -Math.sin(droop), (nx * s + nz * c) * Math.cos(droop));
    const g = new THREE.CylinderGeometry(0.02, 0.02, len + 0.15, 3, 1, true);   // 8 verts: cheap to bake
    g.translate(0, (len + 0.15) / 2, 0); g.applyQuaternion(_rq.setFromUnitVectors(Y_UP, d)); g.translate(px - nx * 0.15, y + (R() - 0.5) * 0.14, pz - nz * 0.15);
    S.add('rust', g);
  }
}
const _rq = new THREE.Quaternion();
// a long member with few vertices along it (beams in shadow need no 3 m bake resolution)
function lowBox(S, mat, cx, y0, cz, sx, sy, sz) {
  const g = new THREE.BoxGeometry(sx, sy, sz, Math.max(1, Math.round(sx / 6.5)), 1, Math.max(1, Math.round(sz / 6.5)));
  planarUV(g, { x: cx * 0.37, y: y0 + sy / 2, z: cz * 0.53 }); g.translate(cx, y0 + sy / 2, cz); S.add(mat, g);
}
// a hinged slab fragment hanging from a hole edge
function hangingChunk(S, R, ax, az, bx, bz, y, nx, nz) {
  const t = 0.25 + R() * 0.5, px = ax + (bx - ax) * t, pz = az + (bz - az) * t, tilt = 0.4 + R() * 0.5, depth = 0.5 + R() * 0.5;
  const d = new THREE.Vector3(nx * Math.cos(tilt), -Math.sin(tilt), nz * Math.cos(tilt));
  S.beam('slab', alongM(d, px, y, pz), -0.05, depth, 0, 0, 0.26, 0.8 + R() * 0.8);
}
// [G5] a sharp broken slab chunk (graphics #3, round-3 #5: the jittered icosahedra read as smooth lumps): a 4-7 sided
// irregular plate, 0.15-0.4 x its size thick, flat faces and hard edges, lying flat or tipped up against its pile;
// a few keep a stub of rebar. y = the surface it lies on.
function slabChunk(S, R, s, x, y, z) {
  const n = 4 + Math.floor(R() * 4), el = 0.75 + R() * 0.6, pts = [];
  for (let i = 0; i < n; i++) { const a = ((i + 0.15 + R() * 0.7) / n) * Math.PI * 2, r = s * (0.55 + R() * 0.5); pts.push(new THREE.Vector2(Math.cos(a) * r * el, Math.sin(a) * r / el)); }
  const t = s * (0.15 + R() * 0.25), g0 = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: t, bevelEnabled: false, curveSegments: 1 });
  const g = g0; g.clearGroups(); g.deleteAttribute('uv'); g.computeVertexNormals();   // non-indexed: flat faces, hard edges
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.rotateX(-Math.PI / 2); g.translate(0, -t / 2, 0);
  const tip = R() < 0.35 ? 0.25 + R() * 0.55 : R() * 0.12;                   // a third tipped up on their neighbours
  g.rotateZ(tip * (R() < 0.5 ? -1 : 1)); g.rotateX((R() - 0.5) * 0.2); g.rotateY(R() * 6.283);
  g.computeBoundingBox(); g.translate(x, y - g.boundingBox.min.y - 0.02 - R() * 0.03, z);
  planarUV(g, { x: x * 0.31, y: 0, z: z * 0.47 });
  S.add('slab', g);
  if (s > 0.35 && R() < 0.2) {                                              // a rebar stub out of a broken edge
    const a = R() * 6.283, d = new THREE.Vector3(Math.cos(a), 0.1 + R() * 0.5, Math.sin(a)).normalize(), len = 0.2 + R() * 0.45;
    const rb = new THREE.CylinderGeometry(0.016, 0.016, len, 3, 1, true); rb.translate(0, len / 2, 0); rb.applyQuaternion(_rq.setFromUnitVectors(Y_UP, d));
    rb.translate(x + Math.cos(a) * s * 0.5, y + t * 0.6, z + Math.sin(a) * s * 0.5); S.add('rust', rb);
  }
}
function rubblePile(S, R, cx, cy, cz, rad, n) {
  for (let k = 0; k < n; k++) {
    // sizes skewed small; the pile heaps toward its middle (chunks there sit on the ones below)
    const s = 0.14 + Math.pow(R(), 1.8) * 0.5, u = R() + R() - 1, v = R() + R() - 1, x = cx + u * rad, z = cz + v * rad;
    slabChunk(S, R, s, x, cy + Math.max(0, 0.22 - Math.hypot(u, v) * 0.3) * (k / n), z);
  }
}
// a steep industrial flight (waist slab + treads) from (a, y0) to (b, y1) in a band wd wide
function stairFlight(S, [ax, az], y0, [bx, bz], y1, wd) {
  const dx = bx - ax, dz = bz - az, run = Math.hypot(dx, dz), rise = y1 - y0, L = Math.hypot(run, rise);
  S.beam('slab', alongM(new THREE.Vector3(dx / L, rise / L, dz / L), ax, y0, az), 0, L, -0.1, 0, 0.14, wd);
  const n = Math.max(3, Math.round(rise / 0.6)), tl = (run / n) * 1.25;
  for (let i = 1; i < n; i++) { const t = i / n; S.box('slab', ax + dx * t, y0 + rise * t - 0.04, az + dz * t, dx ? tl : wd, 0.06, dz ? tl : wd); }
}

function buildSite(seed = 7) {
  const S = new Site(MATS);
  const rSpot = subRng(seed, 'spots'), rBay = subRng(seed, 'hall-bays'), rFac = subRng(seed, 'hall-facade'), rRub = subRng(seed, 'rubble'),
    rBlk = subRng(seed, 'blocks'), rDet = subRng(seed, 'detail');
  // ---- silo battery: 2 rows x 4 silos on a column table, stair tower between the rows, head house over the south row
  const { r: sr, table: tableTop, top: siloTop } = SILO;
  const inTower = (x, z, m) => Math.abs(x - TOWER.x) < TOWER.w / 2 + m && Math.abs(z - TOWER.z) < TOWER.w / 2 + m;
  S.footprints.push({ x0: -54.5, x1: -13.5, z0: -28.5, z1: 0.5 });
  slabWithHoles(S, 'slab', -54.5, -13.5, -28.5, 0.5, 4.6, 0.6, [SHAFT]);        // table slab, open over the stair shaft
  for (let x = -53; x <= -15.1; x += 4.75) for (let z = -27; z <= -0.9; z += 5.2) {
    if (inTower(x, z, 0.55)) continue;                                          // these stood inside the tower's walls
    S.box('wall', x, 0, z, 0.75, 4.6, 0.75);
    if (rSpot() < 0.12) S.spot(x, 1.6, z + 0.38, 0, 1, 0.75, 1.4);
  }
  // downstand beams under the table on the column lines (split around the stair shaft)
  for (let z = -27; z <= -0.9; z += 5.2) lowBox(S, 'wall', -34, 4.1, z, 40.6, 0.5, 0.4);
  for (let x = -53; x <= -15.1; x += 4.75) {
    if (Math.abs(x - TOWER.x) < TOWER.w / 2) { lowBox(S, 'wall', x, 4.1, -22.35, 0.4, 0.5, 11.9); lowBox(S, 'wall', x, 4.1, -5.65, 0.4, 0.5, 11.9); }
    else lowBox(S, 'wall', x, 4.1, -14, 0.4, 0.5, 28.6);
  }
  // north row (open beside the chimney mouth): the shell ends in a 0.4 m parapet band (0.3 m wall + a 0.12 m lip)
  // with the roof slab recessed 0.3 m inside it, so the tops read as thick concrete, not open tubes with lids
  const { band, lip, wall, recess } = SILO.rim;
  for (const x of SILO.x) for (const z of SILO.z) {
    const open = z <= HEAD.z0, y1 = open ? siloTop - (band - recess) : siloTop;   // south row: capped by the head-house floor
    const g = cylGeo(sr, sr, y1 - tableTop, 44, true); g.translate(x, (y1 + tableTop) / 2, z); S.add('silo', g);
    if (!open) continue;
    const rim = ringGeo(sr - wall, sr + lip, y1, y1 + band, 44); rim.translate(x, 0, z); S.add('silo', rim);
    const cap = new THREE.CircleGeometry(sr - wall, 44); cap.rotateX(-Math.PI / 2); planarUV(cap, { x, y: 0, z }); cap.translate(x, siloTop, z); S.add('slab', cap);
    S.box('slab', x + (rDet() - 0.5) * 3, siloTop, z - 1.2 - rDet() * 1.5, 1.1, 0.35, 1.1, rDet() * 1.5);   // filling hatch
  }
  // stair tower between the rows: open shaft top to bottom, ring landings, steep flights, an opening each storey
  {
    const { x: tx, z: tz, w, T } = TOWER, top = siloTop + 0.4 + 5.4;              // up to the head-house roof
    S.footprints.push({ x0: tx - 2.5, x1: tx + 2.5, z0: tz - 2.5, z1: tz + 2.5 });
    const holes = []; for (let y = 1.2; y < top - 2; y += 4) holes.push({ x0: 1.0, x1: 3.4, y0: y, y1: y + 2.6 });
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz - w / 2, w, top, T, holes.filter((_, i) => i % 2 === 0));                          // north
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz + w / 2, w, top, T, holes);                                                         // south
    wallWithHoles(S, 'wall', tx - w / 2, 0, tz - w / 2, w, top, T, holes.filter((_, i) => i % 2 === 1 || i === 0), -Math.PI / 2);  // west
    wallWithHoles(S, 'wall', tx + w / 2, 0, tz - w / 2, w, top, T, holes, -Math.PI / 2);                                           // east
    const inner = w - 2 * T, ring = 0.65, e = inner / 2 - ring / 2, run = inner / 2 - ring;
    for (let y = 4; y < top - 1; y += 4) {
      S.box('slab', tx, y, tz - e, inner, 0.22, ring); S.box('slab', tx, y, tz + e, inner, 0.22, ring);
      S.box('slab', tx - e, y, tz, ring, 0.22, inner - 2 * ring); S.box('slab', tx + e, y, tz, ring, 0.22, inner - 2 * ring);
    }
    // flights in the side bands only: the 2.5 m well and the north-south openings stay clear. Ground flight on the
    // south band keeps the east and west ground doors open.
    for (let k = 0; k < 9; k++) {
      const y0 = k ? 4 * k + 0.22 : 0, y1 = 4 * k + 4;
      if (k === 0) stairFlight(S, [tx + run, tz + e], y0, [tx - run, tz + e], y1, ring - 0.04);
      else if (k % 2) stairFlight(S, [tx - e, tz + run], y0, [tx - e, tz - run], y1, ring - 0.04);
      else stairFlight(S, [tx + e, tz - run], y0, [tx + e, tz + run], y1, ring - 0.04);
    }
    S.spot(tx - w / 2 - 0.2, 10.5, tz, -1, 0, 3.6, 1.6);
  }
  // head house: floor over the south row (open over the shaft), ribbon windows, gallery door in the east end, roof
  {
    const { x0, x1, z0, z1 } = HEAD, y = siloTop, H = 5.4, L = x1 - x0, D = z1 - z0;
    slabWithHoles(S, 'slab', x0, x1, z0, z1, y, 0.4, [SHAFT]);
    const band = (zz) => { const holes = []; for (let x = 2; x < L - 3; x += 4) holes.push({ x0: x, x1: x + 3.0, y0: 1.0, y1: 3.6 }); wallWithHoles(S, 'wall', x0, y + 0.4, zz, L, H, 0.3, holes); };
    band(z0); band(z1);
    const endHoles = []; for (let z = 2; z < D - 3; z += 4.5) endHoles.push({ x0: z, x1: z + 3.2, y0: 1.0, y1: 3.6 });
    wallWithHoles(S, 'wall', x0, y + 0.4, z0, D, H, 0.3, endHoles, -Math.PI / 2);
    const gz = GAL.A[2] - z0;
    wallWithHoles(S, 'wall', x1, y + 0.4, z0, D, H, 0.3, [{ x0: 2, x1: 5.2, y0: 1.0, y1: 3.6 }, { x0: gz - 1.7, x1: gz + 1.7, y0: 0.7, y1: 3.9 }, { x0: D - 3.4, x1: D - 1.2, y0: 1.0, y1: 3.6 }], -Math.PI / 2);
    const ry = y + 5.8, slotX = -29.0;                                          // roof: open over the shaft, plus a slot across
    slabWithHoles(S, 'slab', x0, x1, z0, z1, ry, 0.35, [SHAFT, { x0: SHAFT.x1, x1: slotX, z0, z1 }]);
    for (const zz of [z0 + 0.125, z1 - 0.125]) { brokenRun(S, rDet, 'wall', x0, zz, SHAFT.x1, zz, ry + 0.35, 0.7, 0.25); brokenRun(S, rDet, 'wall', slotX, zz, x1, zz, ry + 0.35, 0.7, 0.25); }
    for (const xx of [x0 + 0.125, x1 - 0.125]) brokenRun(S, rDet, 'wall', xx, z0 + 0.25, xx, z1 - 0.25, ry + 0.35, 0.7, 0.25);
  }

  // ---- chimney: hollow, tapered, brick; the door faces the rack and the hall window.
  // The brick tube stands on the 0.5 m plinth (not buried in it: buried vertices lit the inside) and has its own
  // floor box; a corbelled brick course and a pale 0.9 m concrete coping make the rim read from the take start.
  // Rows are 0.5 m up to 4 m and 1 m up to 8 m, so the light pool from the door has vertices to land on.
  {
    const { x: cx, z: cz, h, rb, rt, th, base, cop, corb } = CHIM, aD = Math.atan2(DOOR[0], DOOR[1]);
    const off = (a) => Math.abs(Math.atan2(Math.sin(a - aD), Math.cos(a - aD)));
    const Ro = (y) => rb + (rt - rb) * (y / h);                                     // outer radius at world height y
    const yTop = h - cop - corb, hT = yTop - base;                                   // brick tube: base .. yTop
    const ys = []; for (let y = 0; y < 4; y += 0.5) ys.push(y); for (let y = 4; y < 8; y += 1) ys.push(y);
    const n2 = Math.max(1, Math.round((hT - 8) / 2)); for (let k = 0; k <= n2; k++) ys.push(8 + (hT - 8) * (k / n2));
    const g = tubeGeo(Ro(base), Ro(yTop), hT, th, 40, ys, (a, y) => y < 3.9 && off(a) < 0.42);     // door: 4 m tall
    g.translate(cx, base, cz); S.add('brick', g);
    const rIn = rt - th;                                                             // the mouth stays 1.65 m (the drop-in catch)
    const cb = ringGeo(rIn, Ro(yTop) + 0.12, yTop, yTop + corb, 40); cb.translate(cx, 0, cz); S.add('brick', cb);
    // coping: a 0.45 m lime-washed brick cap, 0.12 m proud (was a 0.9 m concrete collar 0.3 m proud: "a mushroom cap")
    const cp = ringGeo(rIn, rt + 0.12, h - cop, h, 40, MATS.coping.tile); cp.translate(cx, 0, cz); S.add('coping', cp);
    S.box('slab', cx, 0, cz, 8.5, base, 8.5);
    // inner floor: a 40-sided disc of r 3.07 (the bore is ~3.04 at the base), so no plinth top shows round its edge
    // (the old 4.2 m square left the plinth's sunlit lightmap texels visible inside: a ring of bright notches)
    { const n = 40, R = 3.07, y = base + 0.03, pos = [cx, y, cz], nor = [0, 1, 0], uv = [cx, cz], idx = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, x = cx + Math.sin(a) * R, z = cz + Math.cos(a) * R; pos.push(x, y, z); nor.push(0, 1, 0); uv.push(x, z); }
      for (let i = 0; i < n; i++) idx.push(0, 1 + i, 1 + ((i + 1) % n));
      const fl = new THREE.BufferGeometry();
      fl.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); fl.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      fl.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); fl.setIndex(idx); setAY(fl, base, y); S.add('slab', fl); }
    S.footprints.push({ x0: cx - 4.5, x1: cx + 4.5, z0: cz - 4.5, z1: cz + 4.5 });
    const sa = aD + 1.05; S.spot(cx + Math.sin(sa) * 3.45, 1.6, cz + Math.cos(sa) * 3.45, Math.sin(sa), Math.cos(sa), 2.0, 1.3);
  }

  // ---- factory hall: 64 x 22 m, three storeys of 5 m, column grid, holes, ribbon windows, roof slots
  {
    const { x0, x1, z0, z1, fh, levels, cols, rows } = HALL;
    const dx = (x1 - x0) / (cols - 1), dz = (z1 - z0) / (rows - 1);
    S.footprints.push({ x0: x0 - 1, x1: x1 + 1, z0: z0 - 1, z1: z1 + 1 });
    // ground slab split at the facades (inner slab + 4 skirts): no floor triangle spans inside and outside, so the
    // sunlit apron's vertices no longer light the hall floor (lighting r2 #4: near-window floor 3.4x -> 0.42x)
    { const e = 0.125, o = 0.6, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      S.box('slab', cx, 0, cz, x1 - x0 - 2 * e, 0.18, z1 - z0 - 2 * e);
      S.box('slab', cx, 0, z0 - (o - e) / 2, x1 - x0 + 2 * o, 0.18, o + e); S.box('slab', cx, 0, z1 + (o - e) / 2, x1 - x0 + 2 * o, 0.18, o + e);
      S.box('slab', x0 - (o - e) / 2, 0, cz, o + e, 0.18, z1 - z0 - 2 * e); S.box('slab', x1 + (o - e) / 2, 0, cz, o + e, 0.18, z1 - z0 - 2 * e); }
    const holes = [], kindOf = {};
    for (let L = 0; L < levels; L++) {
      const yb = L * fh, slabY = (L + 1) * fh - 0.35, cy0 = L ? yb - 0.15 : 0.18;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        if (L === 0 && j === 2 && (i === 0 || i === cols - 1)) continue;           // no column in the gable doors
        S.box('wall', x0 + i * dx, cy0, z0 + j * dz, 0.6, slabY - cy0, 0.6);
      }
      // slab bays: some missing (holes), the roof gets narrow slots instead; FORCE keeps the lines' bays
      for (let i = 0; i < cols - 1; i++) for (let j = 0; j < rows - 1; j++) {
        const cxb = x0 + (i + 0.5) * dx, czb = z0 + (j + 0.5) * dz, roof = L === levels - 1, r = rBay(), f = FORCE[`${L}:${i}:${j}`];
        const kind = f || (roof ? (r < 0.22 ? 'slot' : 'solid') : r < 0.13 ? 'hole' : 'solid');
        kindOf[`${L}:${i}:${j}`] = kind;
        if (kind === 'hole') { holes.push({ L, i, j, x0: cxb - dx / 2, x1: cxb + dx / 2, z0: czb - dz / 2, z1: czb + dz / 2, y: slabY, line: !!f }); continue; }
        if (kind === 'slot') {
          const slot = f ? 2.0 : 1.25, hw = (dx - slot) / 2;
          S.box('slab', cxb - dx / 2 + hw / 2, slabY, czb, hw, 0.35, dz); S.box('slab', cxb + dx / 2 - hw / 2, slabY, czb, hw, 0.35, dz);
          if (!f) for (const sgn of [-1, 1]) rebar(S, rDet, cxb + sgn * slot / 2, czb - dz / 2, cxb + sgn * slot / 2, czb + dz / 2, slabY + 0.17, -sgn, 0, 1, 0.35);
          continue;
        }
        S.box('slab', cxb, slabY, czb, dx, 0.35, dz);
      }
      // downstand beams on the interior column lines
      for (let i = 1; i < cols - 1; i++) lowBox(S, 'wall', x0 + i * dx, slabY - 0.55, (z0 + z1) / 2, 0.4, 0.55, z1 - z0 - 0.3);
      for (let j = 1; j < rows - 1; j++) lowBox(S, 'wall', (x0 + x1) / 2, slabY - 0.55, z0 + j * dz, x1 - x0 - 0.3, 0.55, 0.4);
      // long facades: spandrel (per bay, some sills broken) + lintel band, open ribbon windows; some bays bricked or with mullions
      for (const [zz, nz, side] of [[z0, -1, 'z0'], [z1, 1, 'z1']]) {
        const ys = yb + (L ? 0 : 0.18);
        for (let i = 0; i < cols - 1; i++) {
          const bx = x0 + (i + 0.5) * dx, a = rDet(), b = rDet(), c = rDet();
          if (a < 0.16) {                                                          // a chunk knocked out of the sill
            const nw = 0.8 + b * 1.4, nx = bx + (c - 0.5) * (dx - nw - 1.2), lw = nx - nw / 2 - (bx - dx / 2), rw = bx + dx / 2 - (nx + nw / 2);
            S.box('wall', bx - dx / 2 + lw / 2, ys, zz, lw, 1.0, 0.25); S.box('wall', bx + dx / 2 - rw / 2, ys, zz, rw, 1.0, 0.25);
            S.box('wall', nx, ys, zz, nw, 0.3 + b * 0.3, 0.25);
          } else S.box('wall', bx, ys, zz, dx, a < 0.4 ? 1.0 - (a - 0.16) * 1.1 : 1.0, 0.25);
        }
        S.box('wall', (x0 + x1) / 2, yb + 3.9, zz, x1 - x0, fh - 3.9 - 0.35, 0.25);
        for (let i = 0; i < cols - 1; i++) {
          const bx = x0 + (i + 0.5) * dx, r1 = rFac(), r2 = rFac(), r3 = rFac(), open = FORCE[`f${L}:${side}:${i}`] === 'open';
          if (!open && r1 < 0.12) S.box('wall', bx, yb + 0.5, zz, dx - 0.6, 3.4, 0.22);              // bricked-up bay
          else if (!open && r2 < 0.42) {
            for (let k = 1; k < 4; k++) S.box('rust', bx - dx / 2 + k * (dx / 4), yb + 1.0, zz, 0.09, 2.9, 0.09);
            S.box('rust', bx, yb + 2.45, zz, dx - 0.6, 0.08, 0.09);
          }
          if (L === 0 && r3 < 0.45) S.spot(bx, 0.55, zz + nz * 0.15, 0, nz, dx * 0.8, 0.85);
        }
      }
      // gable ends: wall with windows, ground floor gets a big door
      for (const [xx, nx] of [[x0, -1], [x1, 1]]) {
        const gh = [];
        for (let j = 0; j < rows - 1; j++) gh.push({ x0: j * dz + 1.0, x1: (j + 1) * dz - 1.0, y0: 1.0, y1: 3.8 });
        if (L === 0) gh.push({ x0: dz * 1.4, x1: dz * 2.6, y0: 0, y1: 4.4 });
        wallWithHoles(S, 'wall', xx, yb + (L ? 0 : 0.18), z0, z1 - z0, fh - 0.35 - (L ? 0 : 0.18), 0.3, gh, -Math.PI / 2);
        if (L === 0) S.spot(xx + nx * 0.2, 0.68, z0 + dz * 0.6, nx, 0, 3.5, 0.9);
      }
      // interior partitions with doorways (between the column rows, not on them)
      if (L < 2) {
        const px = x0 + dx * (3 + L * 4), py = L ? yb : yb + 0.18;
        wallWithHoles(S, 'wall', px, py, z0 + 0.3, z1 - z0 - 0.6, slabY - py, 0.25, [{ x0: 6.0, x1: 8.5, y0: 0, y1: 3.2 }, { x0: 13, x1: 15.5, y0: 0, y1: 3.2 }], -Math.PI / 2);
        S.spot(px + 0.2, 1.5, z0 + 11.05, 1, 0, 3.2, 1.4);
      }
    }
    // broken parapet all round
    brokenRun(S, rDet, 'wall', x0, z0, x1, z0, levels * fh, 0.9, 0.25); brokenRun(S, rDet, 'wall', x0, z1, x1, z1, levels * fh, 0.9, 0.25);
    brokenRun(S, rDet, 'wall', x0, z0 + 0.125, x0, z1 - 0.125, levels * fh, 0.7, 0.25); brokenRun(S, rDet, 'wall', x1, z0 + 0.125, x1, z1 - 0.125, levels * fh, 0.7, 0.25);
    // the holes: rebar along the broken edges, a hanging fragment now and then, rubble on the first floor below
    const piled = new Set();
    for (const h of holes) {
      const y = h.y + 0.17, len = h.line ? 0.45 : 0.7, n = h.line ? 1 : 2;
      rebar(S, rDet, h.x0, h.z0, h.x1, h.z0, y, 0, 1, n, len); rebar(S, rDet, h.x0, h.z1, h.x1, h.z1, y, 0, -1, n, len);
      rebar(S, rDet, h.x0, h.z0, h.x0, h.z1, y, 1, 0, n, len); rebar(S, rDet, h.x1, h.z0, h.x1, h.z1, y, -1, 0, n, len);
      if (!h.line && rDet() < 0.6) { const e = Math.floor(rDet() * 4), E = [[h.x0, h.z0, h.x1, h.z0, 0, 1], [h.x0, h.z1, h.x1, h.z1, 0, -1], [h.x0, h.z0, h.x0, h.z1, 1, 0], [h.x1, h.z0, h.x1, h.z1, -1, 0]][e]; hangingChunk(S, rDet, ...E.slice(0, 4), y, E[4], E[5]); }
      let L = h.L - 1; while (L >= 0 && kindOf[`${L}:${h.i}:${h.j}`] === 'hole') L--;
      const key = `${L}:${h.i}:${h.j}`; if (piled.has(key)) continue; piled.add(key);
      rubblePile(S, rRub, (h.x0 + h.x1) / 2, L < 0 ? 0.18 : (L + 1) * fh, (h.z0 + h.z1) / 2, 1.5, L < 0 ? 14 : 9);
    }
    // loose slab chunks on the ground floor
    for (let k = 0; k < 10; k++) { const s = 0.4 + rRub() * 0.9; S.box('slab', x0 + 3 + rRub() * (x1 - x0 - 6), 0.18, z0 + 2 + rRub() * (z1 - z0 - 4), s * 1.6, s * 0.6, s, rRub() * 3); }
    for (let k = 0; k < 30; k++) slabChunk(S, rRub, 0.12 + Math.pow(rRub(), 2) * 0.4, x0 + 2 + rRub() * (x1 - x0 - 4), 0.18, z0 + 1.5 + rRub() * (z1 - z0 - 3));   // [G5] spall
  }

  // ---- conveyor gallery: sloped hollow tube from the head house east end down to the hall roof
  {
    const A = new THREE.Vector3(...GAL.A), B = new THREE.Vector3(...GAL.B);
    const dir = B.clone().sub(A); const L = dir.length(); dir.normalize();
    const zA = new THREE.Vector3().crossVectors(dir, Y_UP).normalize();
    const yA = new THREE.Vector3().crossVectors(zA, dir).normalize();
    const M = new THREE.Matrix4().makeBasis(dir, yA, zA).setPosition(A);
    const { W, H } = GAL;
    S.beam('slab', M, 0, L, 0.1, 0, 0.22, W);              // floor
    S.beam('wall', M, 0, L, H, 0, 0.22, W);                // roof
    for (let x = 0; x < L; x += 4) {                       // side walls in panels with window gaps
      const seg = Math.min(2.6, L - x);
      S.beam('wall', M, x, seg, H / 2 + 0.05, -W / 2, H, 0.18);
      S.beam('wall', M, x, seg, H / 2 + 0.05, W / 2, H, 0.18);
    }
    for (const t of [0.35, 0.68]) {                        // support towers
      const P = A.clone().lerp(B, t);
      for (const [ox, oz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) S.box('rust', P.x + ox, 0, P.z + oz, 0.32, P.y - 0.2, 0.32);
      for (let y = 4; y < P.y - 1; y += 5) { S.box('rust', P.x, y, P.z - 1.4, 3.1, 0.25, 0.25); S.box('rust', P.x, y, P.z + 1.4, 3.1, 0.25, 0.25); S.box('rust', P.x - 1.4, y, P.z, 0.25, 0.25, 3.1); S.box('rust', P.x + 1.4, y, P.z, 0.25, 0.25, 3.1); }
      S.footprints.push({ x0: P.x - 2, x1: P.x + 2, z0: P.z - 2, z1: P.z + 2 });
    }
  }

  // ---- workshop ruin: 2 storeys, windows, doorways in line on both long walls, half the roof gone
  {
    const x0 = -64, z0 = 40, Lx = 22, Lz = 13, fh = 4.2, T = 0.35;
    S.footprints.push({ x0: x0 - 1, x1: x0 + Lx + 1, z0: z0 - 1, z1: z0 + Lz + 1 });
    for (let L = 0; L < 2; L++) {
      const yb = L * fh;
      const hx = []; for (let x = 1.5; x < Lx - 2; x += 3.4) hx.push({ x0: x, x1: x + 1.5, y0: 1.0, y1: 2.8 });
      if (L === 0) hx.push({ x0: 9.4, x1: 11.8, y0: 0, y1: 3.0 });
      wallWithHoles(S, 'wall', x0, yb, z0 + Lz, Lx, fh, T, hx);
      wallWithHoles(S, 'wall', x0, yb, z0, Lx, fh, T, hx.filter((_, i) => i % 2 === 0));
      const hz = [{ x0: 2, x1: 3.6, y0: 1.0, y1: 2.8 }, { x0: 6.2, x1: 7.8, y0: L ? 1.0 : 0, y1: 2.9 }, { x0: 9.6, x1: 11.2, y0: 1.0, y1: 2.8 }];
      wallWithHoles(S, 'wall', x0, yb, z0, Lz, fh, T, hz, -Math.PI / 2);
      wallWithHoles(S, 'wall', x0 + Lx, yb, z0, Lz, fh, T, hz, -Math.PI / 2);
      if (L === 0) { S.spot(x0 + 5, 1.4, z0 + Lz + 0.2, 0, 1, 3.4, 1.5); S.spot(x0 + 16, 1.2, z0 - 0.2, 0, -1, 3.0, 1.3); }
    }
    S.box('slab', x0 + 6, fh - 0.3, z0 + Lz / 2, 12, 0.3, Lz);                 // first floor, partial
    S.box('slab', x0 + 18.5, fh - 0.3, z0 + Lz / 2, 7, 0.3, Lz * 0.45);
    S.box('slab', x0 + 5.5, 2 * fh, z0 + Lz / 2, 11, 0.3, Lz + 0.4);         // half a roof
    rubblePile(S, rRub, x0 + 17.5, 0, z0 + 3.0, 1.5, 18);                     // under the missing roof, clear of the doors
    brokenRun(S, rDet, 'wall', x0 + 0.2, z0 + Lz, x0 + Lx - 0.2, z0 + Lz, 2 * fh, 0.5, T);
  }

  // ---- pipe rack: from the chimney door to the hall's entry window, on the same straight line
  {
    const A = new THREE.Vector3(RACK.H[0], 0, RACK.H[1]), B = new THREE.Vector3(RACK.K[0], 0, RACK.K[1]);
    const dir = B.clone().sub(A); const L = dir.length(); dir.normalize();
    const n = Math.max(3, Math.round(L / 6.5)), yaw = Math.atan2(-dir.z, dir.x);
    for (let k = 0; k <= n; k++) {
      const P = A.clone().lerp(B, k / n);
      S.box('rust', P.x - Math.sin(yaw) * 1.6, 0, P.z - Math.cos(yaw) * 1.6, 0.35, 7, 0.35);
      S.box('rust', P.x + Math.sin(yaw) * 1.6, 0, P.z + Math.cos(yaw) * 1.6, 0.35, 7, 0.35);
      S.box('rust', P.x, 7, P.z, 0.3, 0.3, 3.6, yaw);
    }
    for (const [off, r, y] of [[-0.9, 0.38, 7.7], [0.1, 0.28, 7.6], [0.95, 0.45, 7.8]]) {
      const g = cylGeo(r, r, L, 16, false); g.rotateZ(Math.PI / 2); g.rotateY(yaw);
      g.translate((A.x + B.x) / 2 + Math.sin(yaw) * off, y, (A.z + B.z) / 2 + Math.cos(yaw) * off); S.add('rust', g);
    }
  }

  // ---- beam bridge: two pylons and a narrow concrete beam to fly along
  {
    S.box('wall', -82, 0, 18, 2.4, 12, 2.4); S.box('wall', -82, 0, -18, 2.4, 12, 2.4);
    S.box('slab', -82, 12, 0, 0.9, 0.7, 38.4);
    S.spot(-80.6, 2, 18, 1, 0, 2.0, 1.4);
    S.footprints.push({ x0: -84, x1: -80, z0: -20, z1: 20 });
  }
  // ---- rusty tank
  {
    const g = cylGeo(5.5, 5.5, 8, 36, false); g.translate(-78, 4, -48); S.add('rust', g);
    S.footprints.push({ x0: -84, x1: -72, z0: -54, z1: -42 });
  }
  // ---- scattered concrete blocks and fallen slabs (off the buildings and the tracks)
  for (let k = 0; k < 40; k++) {
    const x = -90 + rBlk() * 180, z = -60 + rBlk() * 140, s = 0.6 + rBlk() * 1.4, rot = rBlk() * 3;
    if (S.footprints.some((f) => x > f.x0 - 2 && x < f.x1 + 2 && z > f.z0 - 2 && z < f.z1 + 2) || distToPaths(x, z) < 3.5) continue;
    S.box('slab', x, terrainHeight(x, z) - 0.1, z, s * 1.8, s * 0.7, s, rot);
  }
  // [G5] spall: broken slab chunks along the foot of the hall, the silo table and the workshop (graphics #3), off the
  // tracks and clear of every low gate (doors, the rack): they collide, and a skim through a door must stay clean
  {
    const gates = []; for (const l of buildLines()) for (const G of [l, ...(l.pre || [])]) if (G.c && G.h && G.c[1] - G.h / 2 < 1.2) gates.push(G.c);
    const feet = [[HALL.x0, HALL.x1, HALL.z0, HALL.z1, 60], [-54.5, -13.5, -28.5, 0.5, 34], [-64, -42, 40, 53, 22]];
    for (const [fx0, fx1, fz0, fz1, n] of feet) {
      const per = 2 * (fx1 - fx0 + fz1 - fz0);
      for (let k = 0; k < n; k++) {
        let u = rRub() * per, x, z; const off = 0.75 + Math.pow(rRub(), 1.5) * 2.3, s = 0.12 + Math.pow(rRub(), 2.2) * 0.45;
        if (u < fx1 - fx0) { x = fx0 + u; z = fz0 - off; } else if ((u -= fx1 - fx0) < fz1 - fz0) { x = fx1 + off; z = fz0 + u; }
        else if ((u -= fz1 - fz0) < fx1 - fx0) { x = fx1 - u; z = fz1 + off; } else { u -= fx1 - fx0; x = fx0 - off; z = fz1 - u; }
        if (distToPaths(x, z) < 3 || gates.some((c) => Math.hypot(c[0] - x, c[2] - z) < 6)) continue;
        if (S.footprints.some((f) => x > f.x0 + 0.6 && x < f.x1 - 0.6 && z > f.z0 + 0.6 && z < f.z1 - 0.6)) continue;
        slabChunk(S, rRub, s, x, terrainHeight(x, z), z);
      }
    }
  }
  S.chimney = CHIM;
  S.lines = buildLines();
  // START AT points (pause menu) {name, pos, yaw}; yaw: forward = (-sin, 0, -cos). The take retries from the first.
  // Chimney: hovering 2.5 m over the mouth on its axis, nose on the door bearing: hold the dive and you drop in (DROP IN
  // ~1.1 s), push forward at the bottom and you're out of the door, under the rack and through the hall window.
  const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
  S.startPoints = [
    // hint (take.readyHint, UX r3 #3): what the UI says while the take is ready here, until `line` has been flown `until`
  // times; next: the line take.nextHint points at from here
    { name: 'Chimney', pos: [CHIM.x, CHIM.h + 2.5, CHIM.z], yaw: yawTo(DOOR[0], DOOR[1]), hint: { text: '▼ HOLD LEFT STICK · DROP IN', line: 'DROP IN', until: 3, next: 'CHIMNEY DIVE' } },
    // inside the hall under the first hole of the stack (design r3: first beat 7.4 s from the old spot by the rack),
    // nose towards the gallery foot: climb through TRIPLE POP, U-turn over the roof, up the gallery
    { name: 'Hall', pos: [STACK[0], 2.4, STACK[1]], yaw: yawTo(21 - STACK[0], 28 - STACK[1]), hint: { text: '▲ HOLD LEFT STICK UP · TRIPLE POP', line: 'TRIPLE POP', until: 3, next: 'TRIPLE POP' } },
    // inside the head house, facing the stair tower's east opening: INTO THE TOWER, STAIRWELL DIVE, UNDER THE TABLE
    { name: 'Head house', pos: [-20, SILO.top + 2.6, TOWER.z], yaw: yawTo(-1, 0) },
    // north of the north row, lined up on the 1.6 m gaps: THE SMALL GAP, THREAD THE NEEDLE
    { name: 'Silos', pos: [TOWER.x, 10.5, -36], yaw: yawTo(0, 1) },
  ];
  S.takeStart = { pos: S.startPoints[0].pos.slice(), yaw: S.startPoints[0].yaw };
  // vertical lines the Cine dive assist steers onto (stream E's flight.js): axis c [x, z]; a dive is captured within r
  // of the axis from top - 0.5 up to top + 8 (chimney: its rim; stairwell: the head-house floor, so a dive entering
  // the tower from the head house is caught) and let go below `bottom` (chimney: 4 m, free to turn out of the door).
  // rIn = clear radius at the top (the mouth / the well between the landings). take.js: no touchdown CUT within r below top.
  // dir (C9): 'down' = a dive assist (above). 'up' = a climb assist, the mirror image: `bottom` is the opening (the
  // underside of the first hole a climb goes through), a held climb is captured within r of the axis below it, steered
  // onto the axis and let go above `top` (over the last opening); rIn = clear radius of the tightest opening (the hall
  // roof slot is 2.0 m across x). Read without dir (round-3 flight.js) the 'up' entry is a dive assist down the same
  // stack from over the roof slot (TRIPLE DROP), which is harmless. take.js: no CUT within r below `top` of a 'down' funnel.
  // E4 captures a held climb from `reach` (default 8 m) below `bottom` to 0.5 m above it, and lets go at `top`.
  S.funnels = [
    { name: 'chimney', dir: 'down', c: [CHIM.x, CHIM.z], top: CHIM.h, bottom: 4, r: 3.5, rIn: CHIM.rt - CHIM.th },
    { name: 'stairwell', dir: 'down', c: [TOWER.x, TOWER.z], top: SILO.top + 0.4, bottom: 2, r: 3.0, rIn: (TOWER.w - 2 * TOWER.T) / 2 - 0.65 },
    // r 3.0 (UX r4: climbs starting 2.4 m off the axis while drifting missed at r 2.5)
    { name: 'hall stack', dir: 'up', c: [STACK[0], STACK[1]], bottom: HALL.fh - 0.35, top: 3 * HALL.fh + 0.5, r: 3.0, rIn: 1.0 },
  ];
  return S;
}

// ---- named lines: invisible portals, each {name, caption (*accent* word), pts, c, n, w, h} (+ u: width axis, two: either way,
// pre: gates that must have been crossed (same way) within `within` s). A segment of flight crossing the rectangle
// along +n scores. Two entries with the same name are one line (both directions / both portals).
// micro: true = a 500-pt beat that fills a dead stretch of the signature line (it scores and adds FLOW like a line;
// the UI may caption it smaller and leave it out of the LINES count).
// Carves have no gate: {name, caption, pts, micro, c (zone centre, for hints), carve} where carve is
//   {kind:'orbit', axes:[[x, z]...], r0, r1, in0, in1, y0, y1, sweep}: sweep rad around one axis, between in (the wall)
//     and r from it (both linear from y0 to y1)
//   {kind:'turn', box:[x0, x1, y0, y1, z0, z1], sweep}: the flight path turns sweep rad inside the box
function buildLines() {
  const lines = [], g = (c, n, w, h, u) => ({ c, n, w, h, u }), neg = (G) => ({ ...G, n: G.n.map((v) => -v) });
  const add = (name, caption, pts, main, extra = {}) => lines.push({ name, caption, pts, ...main, ...extra });
  const [dx, dz] = DOOR, perp = [dz, 0, -dx];
  // chimney: DROP IN at the mouth (3 m below the rim), CHIMNEY DIVE out of the door (0.5-4.5 m, on the plinth)
  const mouth = g([CHIM.x, CHIM.h - 3, CHIM.z], [0, -1, 0], 2.4, 2.4, [1, 0, 0]);
  const door = g([CHIM.x + dx * (CHIM.rb + 0.15), CHIM.base + 2.0, CHIM.z + dz * (CHIM.rb + 0.15)], [dx, 0, dz], 3.0, 3.9, perp);
  add('DROP IN', 'DROP *IN*!', 500, mouth, { micro: true });
  // half way down the flue in time (design r4 #4: DROP IN -> CHIMNEY DIVE was 5-7 s with no beat; at y 26 it came 1.8 s
  // after DROP IN and 3.9 s before the door, at y 20 it splits 2.3 / 3.4 s); 3.6 m square, inside the 5.0 m bore at y 20
  // and clear of the outside of the wall (2.85 m radius there)
  add('HALFWAY', '*HALFWAY*!', 500, g([CHIM.x, 20, CHIM.z], [0, -1, 0], 3.6, 3.6, [1, 0, 0]), { micro: true });
  add('CHIMNEY DIVE', 'CHIMNEY *DIVE*!', 3000, door, { pre: [mouth], within: 16 });
  // under the pipe rack, end to end
  const rk = g([RACK.K[0] + dx * 0.3, 3.4, RACK.K[1] + dz * 0.3], [dx, 0, dz], 2.9, 6.6, perp);
  const rh = g([RACK.H[0] - dx * 0.3, 3.4, RACK.H[1] - dz * 0.3], [dx, 0, dz], 2.9, 6.6, perp);
  add('UNDER THE RACK', 'UNDER THE *RACK*!', 1500, rh, { pre: [rk], within: 7 });
  add('UNDER THE RACK', 'UNDER THE *RACK*!', 1500, neg(rk), { pre: [neg(rh)], within: 7 });
  // the hall stack: first-floor hole -> second-floor hole -> roof slot
  const { x0, z0, fh } = HALL, hdx = (HALL.x1 - x0) / (HALL.cols - 1), hdz = (HALL.z1 - z0) / (HALL.rows - 1);
  const sx = x0 + 1.5 * hdx, sz = z0 + 0.5 * hdz;
  const l1 = g([sx, fh - 0.18, sz], [0, 1, 0], hdx - 0.6, hdz - 0.6, [1, 0, 0]), slot = g([sx, 3 * fh - 0.18, sz], [0, 1, 0], 2.0, hdz, [1, 0, 0]);
  // via (take.nextHint): from outside, the arrow goes to the rack's entry window first (inside the hall: the hole)
  add('TRIPLE POP', 'TRIPLE *POP*!', 2500, slot, { pre: [l1], within: 5, via: [{ p: [ENTRY[0], 2.5, ENTRY[1] - 3], unless: [HALL.x0, HALL.x1, 0, 3 * fh + 0.5, z0, HALL.z1] }] });
  add('TRIPLE DROP', 'TRIPLE *DROP*!', 2500, neg(l1), { pre: [neg(slot)], within: 5 });
  // conveyor gallery, mouth to mouth
  {
    const A = new THREE.Vector3(...GAL.A), B = new THREE.Vector3(...GAL.B), dir = B.clone().sub(A), L = dir.length(); dir.normalize();
    const zA = new THREE.Vector3().crossVectors(dir, Y_UP).normalize(), yA = new THREE.Vector3().crossVectors(zA, dir).normalize();
    const at = (s, sg) => g(A.clone().addScaledVector(dir, s).addScaledVector(yA, 1.35).toArray(), dir.clone().multiplyScalar(sg).toArray(), 2.8, 2.2, zA.toArray());
    // the bottom mouth on the way up (design r4 #4: ROOF U-TURN -> GALLERY CLIMB was 6.6-8.8 s): GALLERY CLIMB's own
    // pre-gate, so in a clip the two share one caption (take.js sameT0: GALLERY CLIMB's replaces it)
    add('BRIDGE ENTRY', 'BRIDGE *ENTRY*!', 500, at(L - 1.5, -1), { micro: true });
    add('GALLERY CLIMB', 'UP THE *GALLERY*!', 2000, at(1.5, -1), { pre: [at(L - 1.5, -1)], within: 9 });
    add('GALLERY DROP', 'DOWN THE *GALLERY*!', 1500, at(L - 1.5, 1), { pre: [at(1.5, 1)], within: 9 });
  }
  // the hall roof between the slot and the gallery foot: swing round into the gallery (150 deg of track over the roof)
  add('ROOF U-TURN', 'ROOF *U-TURN*!', 500, { c: [(x0 + HALL.x1) / 2, 3 * fh + 1, (z0 + HALL.z1) / 2] },
    { micro: true, carve: { kind: 'turn', box: [x0 - 1, HALL.x1 + 1, 3 * fh - 0.4, 3 * fh + 6, z0 - 1, HALL.z1 + 1], sweep: 2.62 } });
  // the stair tower's head-house storey opening (east wall, y 33.2-35.8), on the way in to the stairwell
  add('INTO THE TOWER', 'INTO THE *TOWER*!', 500, g([TOWER.x + TOWER.w / 2, 34.5, TOWER.z], [-1, 0, 0], 2.3, 2.5, [0, 0, 1]), { micro: true });
  // stair shaft: head-house floor -> under the table
  const sw = SHAFT.x1 - SHAFT.x0;
  add('STAIRWELL DIVE', 'STAIRWELL *DIVE*!', 3000, g([TOWER.x, 4.9, TOWER.z], [0, -1, 0], sw, sw, [1, 0, 0]), { pre: [g([TOWER.x, SILO.top + 0.2, TOWER.z], [0, -1, 0], sw, sw, [1, 0, 0])], within: 9,
    // via: from outside, over the head-house roof's hole above the shaft (inside the head house: straight to the shaft)
    via: [{ p: [TOWER.x, SILO.top + 8.3, TOWER.z], unless: [HEAD.x0, HEAD.x1, SILO.top - 0.5, SILO.top + 5.8, HEAD.z0, HEAD.z1] }] });
  // under the silo table, edge to edge (or out of the tower's ground doors)
  const tE = g([-13.6, 2.35, -14], [1, 0, 0], 29, 4.3, [0, 0, 1]), tW = g([-54.4, 2.35, -14], [1, 0, 0], 29, 4.3, [0, 0, 1]);
  const twE = g([TOWER.x + TOWER.w / 2 + 0.2, 2.5, TOWER.z], [1, 0, 0], 2.4, 2.6, [0, 0, 1]), twW = g([TOWER.x - TOWER.w / 2 - 0.2, 2.5, TOWER.z], [-1, 0, 0], 2.4, 2.6, [0, 0, 1]);
  add('UNDER THE TABLE', 'UNDER THE *TABLE*!', 1500, tE, { pre: [tW, twE], within: 7 });
  add('UNDER THE TABLE', 'UNDER THE *TABLE*!', 1500, neg(tW), { pre: [neg(tE), twW], within: 7 });
  // the 1.6 m gap between silos 2 and 3, in either row; both rows in one go threads the tower between them
  const gx = (SILO.x[1] + SILO.x[2]) / 2, gw = SILO.x[2] - SILO.x[1] - 2 * SILO.r;
  const gap = (z) => g([gx, (SILO.table + SILO.top) / 2, z], [0, 0, 1], gw, SILO.top - SILO.table, [1, 0, 0]);
  add('THE SMALL GAP', 'THE SMALL *GAP*.', 2500, gap(SILO.z[0]), { two: true });
  add('THE SMALL GAP', 'THE SMALL *GAP*.', 2500, gap(SILO.z[1]), { two: true });
  add('THREAD THE NEEDLE', 'THREAD THE *NEEDLE*!', 3000, gap(SILO.z[1]), { pre: [gap(SILO.z[0])], within: 4 });
  add('THREAD THE NEEDLE', 'THREAD THE *NEEDLE*!', 3000, neg(gap(SILO.z[0])), { pre: [neg(gap(SILO.z[1]))], within: 4 });
  // carves: half way round one north-row silo within ~2 m of its wall (the end silos, or out of a gap), or 150 deg round
  // the chimney within ~3.5 m (the finale link from the table to the gaps)
  const sTop = SILO.top + SILO.rim.recess;
  add('SILO CARVE', 'SILO *CARVE*!', 500, { c: [(SILO.x[0] + SILO.x[3]) / 2, (SILO.table + sTop) / 2, SILO.z[0]] },
    { micro: true, carve: { kind: 'orbit', axes: SILO.x.map((x) => [x, SILO.z[0]]), r0: SILO.r + 2, r1: SILO.r + 2, in0: SILO.r, in1: SILO.r, y0: SILO.table, y1: sTop + 2, sweep: Math.PI } });
  add('CHIMNEY CARVE', 'CHIMNEY *CARVE*!', 500, { c: [CHIM.x, 12, CHIM.z] },
    { micro: true, carve: { kind: 'orbit', axes: [[CHIM.x, CHIM.z]], r0: CHIM.rb + 5.0, r1: CHIM.rt + 5.0, in0: CHIM.rb, in1: CHIM.rt, y0: CHIM.base, y1: CHIM.h + 1, sweep: 2.27 } });
  // along the north row's north faces, across silo 4's face to the 1.0 m gap between silos 3 and 4 (either way), within
  // 3.6 m of the faces: the beat between CHIMNEY CARVE and THE SMALL GAP (design r3 #2: that stretch was 8-9 s, no beat)
  { const fz = SILO.z[0] - SILO.r, xg = (SILO.x[2] + SILO.x[3]) / 2, xe = SILO.x[3] + 2.5;
    const nr = (x, s) => g([x, (SILO.table + SILO.top) / 2, fz - 1.8], [s, 0, 0], 3.6, SILO.top - SILO.table, [0, 0, 1]);
    add('NORTH ROW', 'THE NORTH *ROW*!', 500, nr(xg, -1), { micro: true, pre: [nr(xe, -1)], within: 5 });
    add('NORTH ROW', 'THE NORTH *ROW*!', 500, nr(xe, 1), { micro: true, pre: [nr(xg, 1)], within: 5 }); }
  // the hall's ground floor, gable door to gable door
  const gd = (x) => g([x, 2.3, z0 + 2 * hdz], [1, 0, 0], hdz * 1.2, 4.2, [0, 0, 1]);
  add('HALL RUN', 'HALL *RUN*!', 2000, gd(HALL.x1), { pre: [gd(x0)], within: 12 });
  add('HALL RUN', 'HALL *RUN*!', 2000, neg(gd(x0)), { pre: [neg(gd(HALL.x1))], within: 12 });
  // across the hall through the two open bays at the end of the track from the spawn
  const win = (z) => g([x0 + 3.5 * hdx, 2.55, z], [0, 0, -1], hdx - 0.6, 2.7, [1, 0, 0]);
  // first: the line the first-flight toast names ("follow the track into the hall's open bay"), hinted until any is flown
  add('STRAIGHT THROUGH', 'STRAIGHT *THROUGH*!', 1000, win(z0), { pre: [win(HALL.z1)], within: 4, first: true });
  add('STRAIGHT THROUGH', 'STRAIGHT *THROUGH*!', 1000, neg(win(HALL.z1)), { pre: [neg(win(z0))], within: 4 });
  // the workshop's two doors are in line
  const wd = (z) => g([-53.4, 1.5, z], [0, 0, 1], 2.4, 3.0, [1, 0, 0]);
  add('THROUGH THE WORKSHOP', 'IN AND *OUT*!', 1500, wd(53), { pre: [wd(40)], within: 4 });
  add('THROUGH THE WORKSHOP', 'IN AND *OUT*!', 1500, neg(wd(40)), { pre: [neg(wd(53))], within: 4 });
  return lines;
}

const PATHS = [
  [[0, 160], [0, 95], [6, 60], [18, 42], [30, 38]],
  [[6, 60], [-14, 30], [-30, 6], [-34, 2]],
  [[-14, 30], [-40, 40], [-52, 54]],
  [[6, 60], [-1, 38], [-1, 12], RACK.H, RACK.K],                // past the gallery tower, along the rack to the chimney door
  [[-30, 6], [-60, 0], [-80, -8], [-84, -30], [-78, -40]],
];
function distToPaths(x, z) {
  let best = Infinity;
  for (const p of PATHS) for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1];
    const vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    best = Math.min(best, Math.hypot(x - ax - t * vx, z - az - t * vz));
  }
  return best;
}
// [P5] mean linear colour of each Poly Haven diffuse map (distance fades / normalisation), precomputed by
// tools/texmean.py (32 x 32 box filter in sRGB, then linear: what the old load-time canvas measured), so the load
// runs no Canvas2D (native #5) and world.json carries the same numbers. Keyed by texture id: a new or renamed map
// misses, export-world warns and test-export fails until its line is added here.
export const TEX_MEAN = {
  'asphalt_02': [0.1037, 0.1022, 0.0902],
  'bark_brown_02': [0.1183, 0.0966, 0.0568],
  'concrete_floor_02': [0.1894, 0.1587, 0.1058],
  'concrete_floor_worn_001': [0.0931, 0.0941, 0.0889],
  'concrete_layers_02': [0.2064, 0.1957, 0.1762],
  'concrete_wall_006': [0.1074, 0.0826, 0.0608],
  'dirty_concrete': [0.2509, 0.2292, 0.189],
  'factory_brick': [0.2428, 0.1526, 0.0944],
  'forrest_ground_01': [0.2831, 0.2427, 0.1113],
  'grass_ground': [0.1561, 0.118, 0.0481],
  'grass_path_2': [0.2726, 0.2224, 0.1281],
  'rust_coarse_01': [0.1277, 0.0427, 0.0146],
  'rusty_metal_02': [0.4117, 0.2829, 0.1216],
  'withered_grass': [0.4159, 0.2947, 0.1934],
};
// mean of MATS[key]'s diffuse map (null without one). A map missing from TEX_MEAN is measured from the loaded image
// once (the old canvas path) with a warning, so a stale table never breaks the look.
function texMean(key, t = null) {
  const id = MATS[key]?.id, m = id && TEX_MEAN[id];
  if (m) return m;
  if (!t?.image || typeof document === 'undefined') return null;
  console.warn(`[P5] TEX_MEAN has no entry for "${id}" (MATS.${key}): measuring at load; run python3 tools/texmean.py`);
  try {
    const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(t.image, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data, s = [0, 0, 0], lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += lin(d[i + k]);
    return s.map((v) => v / 1024);
  } catch (e) { return null; }
}

// [P5] graffiti atlas off the main thread (perf #1): graffiti-worker.js draws it (graffiti.js, ~1.1 s on a phone core)
// while buildBando builds and bakes; the pixels come back as a transferred buffer and upload in 16 texSubImage2D strips
// of 2048 x 256 (2 MB each, one per task) into storage allocated up front, mips generated once with the last strip.
// No 33 MB texImage2D, no main-thread drawing, no CPU copy kept. Without module workers (or if the worker fails) it
// falls back to the round-4 path: ~12 ms main-thread slices, one upload at the end. Until the pixels land the decals
// sample three's empty texture. Rows bottom-up = the old flipY CanvasTexture's uv.
function graffitiWorker() {
  if (typeof Worker === 'undefined') return Promise.resolve(null);
  return new Promise((res) => {
    let w;
    try { w = new Worker(new URL('./graffiti-worker.js', import.meta.url), { type: 'module' }); } catch (e) { res(null); return; }
    const done = (v) => { res(v); try { w.terminate(); } catch (e) {} };
    w.onmessage = (e) => done(e.data && e.data.data ? e.data : null);
    w.onerror = (e) => { console.warn('[P5] graffiti worker failed, drawing on the main thread:', e.message || e); done(null); };
    w.postMessage({ seed: GRAFFITI_SEED, flip: true });
  });
}
function graffitiAtlas(renderer, workerP) {
  const W = GCOLS * 512, H = GROWS * 256, t0 = performance.now();
  const t = new THREE.DataTexture(null, W, H, THREE.RGBAFormat); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.userData.graffiti = { path: 'pending' };
  const strips = async (data, ms) => {
    t.image = { data: null, width: W, height: H }; t.source.dataReady = false; t.needsUpdate = true;
    renderer.initTexture(t);                         // texStorage2D: every mip level allocated, nothing uploaded
    const strip = new THREE.DataTexture(null, W, 256, THREE.RGBAFormat), at = new THREE.Vector2(), tu = performance.now();
    let worst = 0;
    for (let r = 0; r < GROWS; r++) {
      strip.image.data = data.subarray(r * W * 256 * 4, (r + 1) * W * 256 * 4);
      t.generateMipmaps = r === GROWS - 1;           // three regenerates mips after a level-0 copy: only after the last
      const a = performance.now();
      renderer.copyTextureToTexture(strip, t, null, at.set(0, r * 256));
      worst = Math.max(worst, performance.now() - a);
      if (r < GROWS - 1) await yieldUI();
    }
    t.generateMipmaps = true; strip.image.data = null;
    t.userData.graffiti = { path: 'worker', drawMs: ms, readyMs: Math.round(performance.now() - t0), uploadMs: Math.round(performance.now() - tu), worstStripMs: +worst.toFixed(1) };
  };
  const mainThread = () => {
    const data = new Uint8Array(W * H * 4), gen = graffitiCells(rng(GRAFFITI_SEED), data, true);
    t.image = { data, width: W, height: H };
    t.onUpdate = () => { t.image.data = null; t.onUpdate = null; };   // uploaded: drop the 33 MB CPU copy
    const slice = () => {
      for (const end = performance.now() + 12; performance.now() < end;) if (gen.next().done) { t.needsUpdate = true; t.userData.graffiti = { path: 'main', readyMs: Math.round(performance.now() - t0) }; return; }
      setTimeout(slice, 0);
    };
    setTimeout(slice, 0);
  };
  t.userData.ready = (workerP || Promise.resolve(null)).then((r) => (r ? strips(r.data, r.ms) : mainThread()))
    .catch((e) => { console.warn('[P5] graffiti upload failed, main-thread path:', e.message || e); mainThread(); });
  return t;
}
// [B] ground mask over the yard terrain tile (0.625 m texels): R grass density, G paved apron/road,
// B terrain AO (baked), A grass height. Replaces the per-vertex footprint/path loops of the grass shader.
// [V2] second mask (same texels), shared by the ground, the track and the blades so they agree: R distance to the
// nearest track centreline (m / 8; a distance field interpolates linearly, so the ruts and the centre strip are
// resolved far below a texel), G dry (straw) patch field, B wildflower patches, A lush (damp, dark green) field.
// R density no longer carries the track: the track profile (bare ruts, short centre strip, ragged verges) is applied
// per tuft in the grass vertex shader and per pixel in the ground / track shaders, all from that distance.
const MASK = { N: 512, x0: -165, z0: -150, size: 320 };
function buildGroundMask(site, terr) {
  const { N, x0, z0, size } = MASK, d = new Uint8Array(N * N * 4), d2 = new Uint8Array(N * N * 4), sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const fh = (i, j) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  // path segments with bounding boxes: only distances below ~7 m matter
  const segs = []; for (const p of PATHS) for (let k = 0; k < p.length - 1; k++) { const [ax, az] = p[k], [bx, bz] = p[k + 1]; segs.push([ax, az, bx - ax, bz - az, Math.min(ax, bx) - 7, Math.max(ax, bx) + 7, Math.min(az, bz) - 7, Math.max(az, bz) + 7, (bx - ax) ** 2 + (bz - az) ** 2]); }
  const pathD = (x, z) => {
    let best = 49;
    for (const [ax, az, vx, vz, xa, xb, za, zb, l2] of segs) {
      if (x < xa || x > xb || z < za || z > zb) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2)), dx = x - ax - t * vx, dz = z - az - t * vz, q = dx * dx + dz * dz; if (q < best) best = q;
    }
    return Math.sqrt(best);
  };
  const vno = (x, z) => { const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    return (fh(i, j) * (1 - u) + fh(i + 1, j) * u) * (1 - v) + (fh(i, j + 1) * (1 - u) + fh(i + 1, j + 1) * u) * v; };
  const tao = terr.attributes.ao, TS = 128;
  const aoAt = (x, z) => {
    if (!tao) return 1;
    const fx = Math.min(TS - 1e-3, Math.max(0, (x + 165) / 2.5)), fz = Math.min(TS - 1e-3, Math.max(0, (z + 150) / 2.5)), i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const a = (ii, jj) => tao.getX(jj * (TS + 1) + ii);
    return (a(i, j) * (1 - u) + a(i + 1, j) * u) * (1 - v) + (a(i, j + 1) * (1 - u) + a(i + 1, j + 1) * u) * v;
  };
  const fps = site.footprints;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + (i + 0.5) * size / N, z = z0 + (j + 0.5) * size / N, o = (j * N + i) * 4;
    let sd = Infinity;
    for (const f of fps) { const dx = Math.max(f.x0 - x, x - f.x1), dz = Math.max(f.z0 - z, z - f.z1); const e = dx > 0 || dz > 0 ? Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dz, 0) ** 2) : Math.max(dx, dz); if (e < sd) sd = e; }
    const yard = Math.max(Math.abs(x + 5) - 95, Math.abs(z - 10) - 85), paved = 1 - sm(-14, 0, yard);
    const n1 = vno(x * 0.05, z * 0.05), n2 = vno(x * 0.17 + 3, z * 0.17 + 7), dP = pathD(x, z);
    const apW = 5 + 7 * n1;
    let ap = sd < 0 ? 1 : 1 - sm(apW - 2, apW + 2, sd + (n2 - 0.5) * 4);
    ap = Math.max(ap, (1 - sm(2.0, 3.6, dP + (n2 - 0.5) * 1.4 - vno(x * 0.03 + 11, z * 0.03) * 1.2)) * paved);
    const n3 = vno(x * 0.45 + 1, z * 0.45 + 2);
    let dens = (0.42 + 0.58 * vno(x * 0.09 + 5, z * 0.09)) * (1 - 0.8 * sm(0.7, 0.88, vno(x * 0.035 + 17, z * 0.035 + 3)));
    dens *= sm(0.0, 1.2, sd) * (1 - 0.88 * sm(0.25, 0.75, ap));
    let ht = 0.45 + 0.8 * vno(x * 0.06 + 9, z * 0.06 + 1) + 0.35 * n3 + 0.5 * (1 - sm(0, 5, sd));
    ht *= 1 - 0.45 * sm(0.3, 0.8, ap);
    d[o] = dens * 255; d[o + 1] = ap * 255; d[o + 2] = Math.min(1, aoAt(x, z)) * 255; d[o + 3] = Math.min(1, ht / 2) * 255;
    // [V2] straw patches ~30-60 m with ragged 8 m edges (decision 3: straw a minority, ~30 % of the field); flowers in
    // a few 10-20 m drifts; lush dark green in damp hollows and at the foot of the walls
    const dry = sm(0.47, 0.72, vno(x * 0.021 + 31, z * 0.021 + 7) * 0.7 + vno(x * 0.11 + 3, z * 0.11 + 9) * 0.3);
    const flw = sm(0.62, 0.84, vno(x * 0.055 + 51, z * 0.055 + 13));
    const lush = Math.min(1, sm(0.52, 0.8, vno(x * 0.045 + 71, z * 0.045 + 29)) + 0.6 * (1 - sm(0.5, 5, sd))) * (1 - dry);
    d2[o] = Math.min(1, dP / 8) * 255; d2[o + 1] = dry * 255; d2[o + 2] = flw * 255; d2[o + 3] = lush * 255;
  }
  const mkT = (a) => { const t = new THREE.DataTexture(a, N, N, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };
  return { t: mkT(d), t2: mkT(d2), d, d2 };
}
// [G5] contract C7: grass height (m) over the ground at x, z, 0 where nothing stands (the CPU side of the blades: the
// mask texel as the VS samples it, the same track profile, the 0.5-1.5 m clumps). main.js turns it into prop strikes.
// Formula after sound r4 §3: dens < 0.08 -> 0, else (0.3 + 0.62 a) x mix(0.42, 1, smoothstep(1.4, 5, trackDist)) x 0.75
function grassAtFn({ d, d2 }) {
  const { N, x0, z0, size } = MASK;
  return (x, z) => {
    const i = Math.floor((x - x0) / size * N), j = Math.floor((z - z0) / size * N);
    if (i < 0 || j < 0 || i >= N || j >= N) return 0;
    const o = (j * N + i) * 4, a = d[o + 3] / 255, dP = (d2[o] / 255) * 8, { clump, brk } = grassFields(x, z);
    const strip = 1 - smooth1(0.26, 0.44, dP), rut = 1 - smooth1(0.16, 0.36, Math.abs(dP - 0.8)), verge = smooth1(1.45, 2.6, dP);
    const dens = (d[o] / 255) * Math.max(verge, 0.55 * strip * brk) * (1 - rut) * clump;
    if (dens < 0.08) return 0;
    return (0.3 + 0.62 * a) * (0.42 + 0.58 * smooth1(1.4, 5, dP)) * (1 - 0.5 * strip) * (0.82 + 0.3 * smooth1(0.5, 1.5, clump)) * 0.75;
  };
}
const fract1 = (x) => x - Math.floor(x);
const gh1 = (x, y) => { let a = fract1(x * 0.1031), b = fract1(y * 0.1031), c = fract1(x * 0.1031); const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33); a += d; b += d; c += d; return fract1((a + b) * c); };
const gvn1 = (x, y) => { const i = Math.floor(x), j = Math.floor(y); let u = x - i, v = y - j; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const a = gh1(i, j), b = gh1(i + 1, j), c = gh1(i, j + 1), d = gh1(i + 1, j + 1); return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v; };
const smooth1 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// CPU twin of gClump / gBreak (GRASS_HASH)
export function grassFields(x, z) {
  return { clump: 0.2 + 1.6 * smooth1(0.3, 0.7, gvn1(x * 0.9 + 3.7, z * 0.9 + 1.3) * 0.62 + gvn1(x * 1.9 + 7.1, z * 1.9 + 3.3) * 0.38),
    brk: smooth1(0.4, 0.6, gvn1(x * 0.55 + 13 + 0.7 * gvn1(x * 1.4, z * 1.4), z * 0.55 + 5 + 0.7 * gvn1(x * 1.4 + 4, z * 1.4 + 4))) };
}
// [V1] the vegetation files (flat, next to this module); null when any is missing (the world then has no plants)
async function vegLoad() {
  try {
    const u = (f) => new URL(f, import.meta.url).href;
    const [man, bin] = await Promise.all([fetch(u('veg.json')).then((r) => { if (!r.ok) throw new Error('veg.json ' + r.status); return r.json(); }),
      fetch(u('veg.bin')).then((r) => { if (!r.ok) throw new Error('veg.bin ' + r.status); return r.arrayBuffer(); })]);
    const tl = new THREE.TextureLoader();
    const tex = (f, srgb, aniso = 4) => new Promise((res, rej) => tl.load(u(f), (t) => {
      t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter; t.anisotropy = aniso; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; res(t);
    }, undefined, () => rej(new Error(f))));
    // [T5] perf #4: leaf colour (jpg) and alpha (png) packed into ONE RGBA texture (alpha in A): one 2048x3072 upload
    // instead of two RGBA atlases. Decoded without colour management, so the bytes stay exactly as baked.
    const pix = async (f) => {
      const r = await fetch(u(f)); if (!r.ok) throw new Error(f + ' ' + r.status);
      const bm = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bm.width, bm.height) : Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height });
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height); bm.close?.(); return d;
    };
    const [rgb, alp, ba, bb, bs, bj] = await Promise.all([pix(man.atlas.file), pix(man.atlas.alpha), tex('veg_bark_a.jpg', true, 8), tex('veg_bark_b.jpg', true, 8), tex('veg_bark_s.jpg', true, 8), tex('veg_bark_j.jpg', true, 8)]);
    const px = rgb.data; for (let i = 3, a = alp.data; i < px.length; i += 4) px[i] = a[i - 3];
    const atlas = new THREE.DataTexture(px, rgb.width, rgb.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    Object.assign(atlas, { flipY: false, colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 4, premultiplyAlpha: false });
    atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping; atlas.needsUpdate = true;
    for (const t of [ba, bb, bs, bj]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return { man, bin, atlas, bark: { A: ba, B: bb, S: bs, J: bj } };
  } catch (e) { console.warn('[V1] vegetation load failed:', e.message); return null; }
}
// what tools/bakelm.mjs needs from module scope: the bake's albedo rules (same as bakeLight's) and constants
// [L5] ground bounce albedo for the bake (see lmBakeInputs.groundBounce)
const BOUNCE_GROUND = (a) => a.map((v, i) => 0.5 * v + 0.5 * [0.13, 0.13, 0.11][i]);
// [L5] chimney portals: the mouth (a disc of the bore radius at the brick top) and the door (a vertical rectangle across
// the door's chord: off(a) < 0.42 rad, the 0.5 m rows below 3.9 m of the tube = y base .. base + 4). n points into the bore's open side (unused by the sampler: |cos|).
function chimneyPortals() {
  const { x, z, h, rb, rt, th, base, cop, corb } = CHIM, yTop = h - cop - corb, Ro = (y) => rb + (rt - rb) * (y / h);
  const rMouth = Ro(yTop) - th, aD = Math.atan2(DOOR[0], DOOR[1]), rD = (Ro(base) - th) * Math.cos(0.42), hw = (Ro(base) - th) * Math.sin(0.42);
  const sel = { x, z, r: Ro(base) - th + 0.05, y0: base - 0.1, y1: yTop + 0.01 };
  const dx = Math.sin(aD), dz = Math.cos(aD), y0 = base + 0.03, y1 = base + 4;
  return [
    { kind: 'disc', c: [x, yTop, z], n: [0, 1, 0], r: rMouth, sel },
    { kind: 'rect', c: [x + dx * rD, (y0 + y1) / 2, z + dz * rD], n: [dx, 0, dz], ex: [dz * hw, 0, -dx * hw], ey: [0, (y1 - y0) / 2, 0], sel },
  ];
}
export function lmBakeInputs(geo) {
  const fps = geo.site.footprints || [], ap = MATS.apron?.albedo, rad = MATS.apron?.radius ?? 9, gA = groundAlbedo(), pA = albedoOf('path');
  return {
    albedo: Object.fromEntries(Object.keys(geo.merged).map((k) => [k, albedoOf(k)])), ground: gA, leaf: MATS.leaf?.albedo ?? [0.1, 0.12, 0.04],
    terrainAlbedo: (x, z) => (ap && fps.some((f) => Math.max(f.x0 - x, 0, x - f.x1) ** 2 + Math.max(f.z0 - z, 0, z - f.z1) ** 2 < rad * rad) ? ap : distToPaths(x, z) < 2.6 ? pA : gA),
    envI: 0.85, envIOf: (def) => skyEnvI(def), aoExp: 1.15, PH,   // [A4] envI per sky = 0.85 bgI (envI: the round-3 base)
    // [L5] lighting #2 / colour #2: the grass ground's BOUNCE albedo, 50 % toward neutral [0.13, 0.13, 0.11]. About half
    // the indirect light on shaded verticals is ground bounce; at the meadow's olive it cancelled the sky's blue (silo
    // shade R/B 0.97, ref 0.79). Real meadow bounce is greyer than its albedo (blade shadowing, thatch, soil). Used for
    // the grass terrain texels, the far field and the below-horizon env table; the ground still renders at its albedo.
    groundBounce: BOUNCE_GROUND(gA),
    // [L5] lighting #1: portals the bake importance-samples for texels inside the chimney (its mouth disc and its door),
    // where 32-256 cosine rays found the 2-5 % aperture 0-2 times (0.5-1 m blotches after the denoise). sel: which
    // texels use them (inside the bore: horizontal distance to the axis < r, base - 0.1 < y < top).
    portals: chimneyPortals(),
  };
}
// [A4] contract C10: vegetation proxies for the bake (V1, optional): geo.vegProxies or geo.site.vegProxies, each a
// BufferGeometry (world space; userData.occ / opacity / albedo) or { position, index?, occ?, opacity?, albedo? }.
// Normalised to { position: Float32Array, index: Uint32Array, occ, opacity, albedo }; [] when there are none.
export function vegProxyList(geo) {
  const raw = geo?.vegProxies || geo?.site?.vegProxies || [], out = [], leaf = MATS.leaf?.albedo ?? [0.1, 0.12, 0.04];
  const src = Array.isArray(raw) ? raw : [raw];   // V1 hands one {geometry, occ, opacity, albedo}
  for (const e of src) {
    const g = e?.isBufferGeometry ? e : e?.geometry?.isBufferGeometry ? e.geometry : null, m = e?.isBufferGeometry ? e.userData || {} : e || {};
    const pos = g ? g.attributes.position?.array : e?.position; if (!pos || pos.length < 9) continue;
    const ix = g ? g.index?.array : e.index, n = pos.length / 3;
    const index = ix ? Uint32Array.from(ix) : Uint32Array.from({ length: n - (n % 3) }, (_, i) => i);
    out.push({ position: Float32Array.from(pos), index, occ: m.occ ?? 0.6, opacity: Math.min(1, Math.max(0, m.opacity ?? 1)), albedo: m.albedo || leaf });
  }
  return out;
}
export function vegProxyHash(geo) {
  const L = vegProxyList(geo); if (!L.length) return null;
  const h = new GeoHash().str('vegProxies'); h.word(L.length);
  for (const v of L) h.array(v.position).array(v.index).str(`${v.occ}:${v.opacity}:${v.albedo.join(',')}`);
  return h.hex();
}
// [A4] what lmMatch does not gate (the runtime keeps a lightmap whose geometry matches; a per-vertex re-bake would cost
// ~10 s on a phone) but tools/test-lightmap.mjs fails on: the sky light it was baked with (envI, sunRatio, bgI, decision 2)
// and the vegetation proxies (C10). Returns a list of reasons; [] = fresh.
export function lmFresh(j, geo) {
  const why = [];
  for (const [k, def] of Object.entries(SKIES)) {
    const l = j?.skies?.[k]?.light; if (!l) { why.push(`${k}: no baked light`); continue; }
    if (Math.abs((l.envI ?? 0.85) - skyEnvI(def)) > 1e-3) why.push(`${k}: baked with envI ${l.envI ?? 0.85}, sky wants ${skyEnvI(def)}`);
    if (l.sunRatio !== undefined && l.sunRatio !== (def.sunRatio || 0)) why.push(`${k}: baked with sunRatio ${l.sunRatio}, SKIES has ${def.sunRatio}`);
  }
  const vh = vegProxyHash(geo); if ((j?.vegHash ?? null) !== vh) why.push(`vegetation proxies ${j?.vegHash ?? 'none'} baked, ${vh ?? 'none'} now`);
  return why;
}


// pure geometry + collision (no DOM): shared by the game and the headless physics tests
// R drives the decorative extras (trees, foliage, textures); the site layout has its own seeded streams (seed)
export function buildGeometry(R = rng(7), seed = 7) {
  const site = buildSite(seed);

  // terrain: detailed yard + coarse far field
  const tSize = 320, tSeg = 128;
  const terr = new THREE.PlaneGeometry(tSize, tSize, tSeg, tSeg); terr.rotateX(-Math.PI / 2); terr.translate(-5, 0, 10);
  { const p = terr.attributes.position, uv = terr.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, terrainHeight(x, z)); uv.setXY(i, x, z); } terr.computeVertexNormals(); }
  const far = new THREE.PlaneGeometry(6000, 6000, 60, 60); far.rotateX(-Math.PI / 2);
  { const p = far.attributes.position, uv = far.attributes.uv; for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); const d = Math.hypot(x + 5, z - 10); p.setY(i, d < 150 ? -1.4 : terrainHeight(x, z) - 0.4 + Math.min(1, (d - 150) / 400) * (Math.sin(x * 0.004) * Math.cos(z * 0.005) * 9 + Math.sin(x * 0.011 + z * 0.007) * 3)); uv.setXY(i, x, z); } far.computeVertexNormals(); }
  // dirt tracks as soft-edged ribbons on the ground
  const pathPos = [], pathUV = [], pathCol = [], pathIdx = [];
  for (const pl of PATHS) {
    const pts = []; for (let i = 0; i < pl.length - 1; i++) { const [ax, az] = pl[i], [bx, bz] = pl[i + 1]; const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 2); for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]); }
    pts.push(pl[pl.length - 1]);
    const base = pathPos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i], [x2, z2] = pts[Math.min(i + 1, pts.length - 1)], [x1, z1] = pts[Math.max(i - 1, 0)];
      let tx = x2 - x1, tz = z2 - z1; const tl2 = Math.hypot(tx, tz) || 1; tx /= tl2; tz /= tl2;
      const w = 2.2 + Math.sin(i * 0.7) * 0.4;
      for (const [s, a] of [[-w - 1.4, 0], [-w, 1], [w, 1], [w + 1.4, 0]]) { const px = x - tz * s, pz = z + tx * s; pathPos.push(px, terrainHeight(px, pz) + 0.03, pz); pathUV.push(px, pz); pathCol.push(1, 1, 1, a); }
      if (i < pts.length - 1) for (let c = 0; c < 3; c++) { const a = base + i * 4 + c, b = a + 4; pathIdx.push(a, b, a + 1, a + 1, b, b + 1); }
    }
  }
  const pathG = new THREE.BufferGeometry();
  pathG.setAttribute('position', new THREE.Float32BufferAttribute(pathPos, 3)); pathG.setAttribute('uv', new THREE.Float32BufferAttribute(pathUV, 2));
  pathG.setAttribute('color', new THREE.Float32BufferAttribute(pathCol, 4)); pathG.setIndex(pathIdx); pathG.computeVertexNormals();

  // [B] trees: thickets hugging the buildings plus lone field trees. Own RNG streams (positions TR as in round 2,
  // shapes TS), so layout edits elsewhere don't reshuffle them. Each tree: a trunk in two segments with a 0.3-0.8 m
  // lean (collides), 3-5 tapered 5-sided branches from 0.35-0.6 h on the trunk out to the limb centres (render only),
  // and the limbs themselves, which buildBando fills with 7-11 small leaf balls each.
  const TR = rng(1101), TS = rng(1102), treeSpots = [];
  const clearOf = (x, z, m) => !site.footprints.some((f) => x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m);
  const okTree = (x, z) => clearOf(x, z, 2.5) && distToPaths(x, z) > 4.5 && Math.hypot(x, z - 120) > 14 && !treeSpots.some((t) => Math.hypot(t.x - x, t.z - z) < 2.4 + t.h * 0.12);
  const limbGeo = (a, b, r0, r1, seg, hseg, y0, y1) => {
    const d = new THREE.Vector3().subVectors(b, a), L = d.length(), g = cylGeo(r1, r0, L, seg, true, hseg);
    g.translate(0, L / 2, 0); g.applyQuaternion(_rq.setFromUnitVectors(Y_UP, d.normalize())); g.translate(a.x, a.y, a.z); setAY(g, y0, y1); return g;
  };
  const addTree = (x, z, h) => {
    const y = terrainHeight(x, z), r = 0.09 + h * 0.02, la = TS() * 6.283, lean = 0.3 + TS() * 0.5, lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
    const B0 = new THREE.Vector3(x, y - 0.1, z), B1 = new THREE.Vector3(x + lx * 0.3, y + h * 0.4, z + lz * 0.3), B2 = new THREE.Vector3(x + lx, y + h * 0.8, z + lz);
    const onTrunk = (f) => (f <= 0.4 ? B0.clone().lerp(B1, f / 0.4) : B1.clone().lerp(B2, (f - 0.4) / 0.4));
    // [V1] these procedural trunks stay in merged.bark byte for byte (lightmap hash) but no longer collide or draw:
    // the real-model trees below carry their own collision tubes
    site.add('bark', limbGeo(B0, B1, r, r * 0.78, 7, Math.max(1, Math.round(h * 0.4 / 2.5)), y - 0.1, y + h), false);
    site.add('bark', limbGeo(B1, B2, r * 0.78, r * 0.4, 7, Math.max(1, Math.round(h * 0.4 / 2.5)), y - 0.1, y + h), false);
    // the crown: limb clumps around a centre on the leaning trunk (~1.3x taller than wide), a leader at the top
    const cc = onTrunk(0.64), rx = h * (0.24 + TS() * 0.1), ry = h * 0.3, limbs = [], nl = 3 + Math.floor(TS() * 3);
    for (let l = 0; l < nl; l++) {
      const lead = l === 0, th = TS() * 6.283, cp = lead ? 0.85 : TS() * 1.3 - 0.45, sp = Math.sqrt(Math.max(0, 1 - cp * cp)), rr = lead ? 0.35 : 0.55 + 0.4 * TS();
      const lc = new THREE.Vector3(cc.x + Math.cos(th) * sp * rx * rr, cc.y + cp * ry * rr, cc.z + Math.sin(th) * sp * rx * rr);
      limbs.push([lc.x, lc.y, lc.z, h * (0.12 + TS() * 0.06)]);
      const f = lead ? 0.6 : 0.35 + TS() * 0.25, bp = onTrunk(f), end = bp.clone().lerp(lc, 0.85);
      site.add('bark', limbGeo(bp, end, r * (lead ? 0.42 : 0.4), r * 0.12, 5, 1, y - 0.1, y + h), false);
    }
    treeSpots.push({ x, z, h, r, y, cc: cc.toArray(), rx, ry, limbs });
  };
  const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 60);
  for (let k = 0; k < 9 && bigF.length; k++) {
    const f = bigF[Math.floor(TR() * bigF.length)], side = Math.floor(TR() * 4), off = 3 + TR() * 5, t = TR();
    const cx = side < 2 ? f.x0 + t * (f.x1 - f.x0) : (side === 2 ? f.x0 - off : f.x1 + off);
    const cz = side < 2 ? (side === 0 ? f.z0 - off : f.z1 + off) : f.z0 + t * (f.z1 - f.z0);
    for (let i = 0, n = 3 + Math.floor(TR() * 4); i < n; i++) {
      const x = cx + (TR() - 0.5) * 10, z = cz + (TR() - 0.5) * 10;
      if (okTree(x, z)) addTree(x, z, 5 + TR() * 8);
    }
  }
  for (let k = 0; k < 60 && treeSpots.length < 62; k++) {
    const x = -135 + TR() * 255, z = -105 + TR() * 235;
    if (okTree(x, z) && clearOf(x, z, 9)) addTree(x, z, 7 + TR() * 8);
  }

  // [V1] tree plan: real-model trees (A = Poly Haven tree_small_02, slender; B = island_tree_01, broad) stand on the
  // treeSpots (same bases as the baked lightmap's trunks), each with 1-3 younger neighbours, so trees come in clumps.
  // Trunks and thick limbs collide: tapered hex tubes along the model skeleton (VEG_SKEL), in site.colliders.
  // Own rng streams: the TR/TS sequences above (and so merged.bark) are untouched.
  const vegTrees = [], treeCols = [], vegProx = [];
  {
    const VR = rng(1111), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
    const tube = (a, b, r0, r1, M) => {   // 6-sided open tube a->b (world), radii r0/r1
      const d = new THREE.Vector3().subVectors(b, a), L = d.length(); if (L < 1e-3) return;
      const g = cylGeo(r1, r0, L, 6, true, 1); g.translate(0, L / 2, 0); g.applyQuaternion(_rq.setFromUnitVectors(Y_UP, d.normalize())); g.translate(a.x, a.y, a.z);
      for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
      treeCols.push(g.index ? g : indexify(g));
    };
    const place = (type, x, z, h, main, ck = [1, 1]) => {
      const K = VEG_SKEL[type], y = terrainHeight(x, z) - 0.05, s = h / K.H * ck[1], sx = s * (0.88 + VR() * 0.26) * ck[0] / ck[1], sz = s * (0.88 + VR() * 0.26) * ck[0] / ck[1], yaw = VR() * 6.2832;
      _q.setFromAxisAngle(Y_UP, yaw); _m.compose(_p.set(x, y, z), _q, _s.set(sx, s, sz));
      const t = { type, x, y, z, yaw, sx, sy: s, sz, h, main, tint: VR() };
      vegTrees.push(t);
      for (const q of K.segs) {
        const rs = (sx + sz) / 2, r0 = q[3] * rs, r1 = q[7] * rs; if (Math.max(r0, r1) < 0.045) continue;
        _a.set(q[0], q[1] <= 0.15 ? -0.3 / s : q[1], q[2]).applyMatrix4(_m); _b.set(q[4], q[5], q[6]).applyMatrix4(_m);
        tube(_a.clone(), _b.clone(), Math.max(r0, 0.03), Math.max(r1, 0.03), _m);
      }
      // [A4 C10] crown proxy for the lightmap bake: an ellipsoid at 80 % of the crown (half-transparent foliage)
      if (h > 4) { const c = K.crown, g = new THREE.IcosahedronGeometry(1, 1); g.scale(c.r[0] * 0.8, c.r[1] * 0.8, c.r[2] * 0.8); g.translate(c.c[0], c.c[1], c.c[2]); g.applyMatrix4(_m); vegProx.push(indexify(g)); }
      return t;
    };
    const free = (x, z, m) => !vegTrees.some((t) => Math.hypot(t.x - x, t.z - z) < m);
    // [T5] species by size and stands (art #2): J (jacaranda, broad, pinnate like a robinia) are the big mature trees,
    // B (island_tree_01, rounded) the mid-size ones at ~0.7-1.1x model scale, A (tree_small_02, slender) the young ones,
    // capped at 8 m so its twig tiles are not magnified. Every treeSpot is a stand of 3-7 with overlapping crowns, mostly
    // one species; near the reveal track the crowns are 1.3x wider (and 1.15x taller).
    const reveal = (x, z) => z > 58 && z < 128 && Math.abs(x - (z > 95 ? 0 : 6 * (95 - z) / 35)) < 15;
    const pick = (h, room) => { const r = VR(); return h > 8 && room && r < 0.6 ? 'J' : VR() < 0.3 ? 'B' : 'A'; };
    const plant = (type, x, z, hRaw, main) => {
      if (type === 'A' && reveal(x, z) && VR() < 0.65) type = 'B';   // the reveal is framed by full, rounded crowns
      const H = type === 'J' ? Math.min(12.5, Math.max(7.5, hRaw)) : type === 'B' ? Math.min(5.8, Math.max(3.6, hRaw * 0.6)) : Math.min(8, Math.max(2.4, hRaw));
      return place(type, x, z, H, main, reveal(x, z) ? [1.3, 1.15] : [1, 1]);
    };
    for (const t of treeSpots) {
      const type = pick(t.h, clearOf(t.x, t.z, 4.5));
      const m = plant(type, t.x, t.z, t.h, true), cw = 2 * Math.max(...VEG_SKEL[type].crown.r) * (m.sx + m.sz) / 2;
      for (let k = 0, n = 2 + Math.floor(VR() * 5); k < n; k++) {   // the stand: 2-6 more, crowns overlapping the main's
        const a = VR() * 6.2832, d = cw * (0.32 + VR() * 0.38) + 0.8, x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
        if (!clearOf(x, z, 1.5) || distToPaths(x, z) < 3.2 || Math.hypot(x, z - 120) < 13 || !free(x, z, 1.2)) continue;
        const ty = VR() < 0.6 ? (type === 'J' ? (VR() < 0.35 ? 'B' : 'A') : type) : (VR() < 0.72 ? 'A' : 'B');
        plant(ty, x, z, m.h * (0.55 + VR() * 0.35), false);
      }
    }
  }

  // [B] distant treeline ring (r ~150-420 m around the site): the horizon for skies with no photographed ground.
  // Crowns (round-topped, w = 0.8-1.1 h) are leaf-card instances in buildBando; low-poly proxies keep the drone out of
  // them (site.colliders). Beyond the flight envelope (450-950 m) a looser scatter, no proxies, gives the woodland
  // floor some relief from altitude.
  const treeline = [];
  {
    const LR = rng(1201), fb = new MeshBVH(far.clone()), ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const groundAt = (x, z) => {
      ray.origin.set(x, 400, z); const h = fb.raycastFirst(ray, THREE.DoubleSide);
      let y = h ? h.point.y : 0; if (Math.abs(x + 5) < 158 && Math.abs(z - 10) < 158) y = Math.max(y, terrainHeight(x, z)); return y;
    };
    // a belt with a ragged inner edge (125-185 m) and uneven depth, groves breaking out of it on both sides,
    // and tall/short stands so the skyline isn't a hedge
    const belt = (a) => 0.5 + 0.5 * Math.sin(a * 3 + 1.3) * Math.cos(a * 5 - 0.4);
    const inner = (a) => 150 + 22 * Math.sin(a * 4 + 0.7) + 13 * Math.sin(a * 11 - 1.9);
    const stand = (a) => 0.75 + 0.5 * (0.5 + 0.5 * Math.sin(a * 7 + 2.1) * Math.sin(a * 2.3));
    const groves = Array.from({ length: 16 }, (_, i) => { const a = LR() * 6.283, r = i < 5 ? 118 + LR() * 25 : 250 + LR() * 150; return [-5 + Math.cos(a) * r, 10 + Math.sin(a) * r, i < 5 ? 14 : 30]; });
    const proxy = new THREE.IcosahedronGeometry(1, 0);
    for (let k = 0; k < 780; k++) {
      let x, z, a;
      if (k < 590) { a = LR() * Math.PI * 2; const r = inner(a) + Math.pow(LR(), 1.6) * (30 + 100 * belt(a)); x = -5 + Math.cos(a) * r; z = 10 + Math.sin(a) * r; }
      else { const g = groves[k % groves.length]; x = g[0] + (LR() - 0.5) * 2 * g[2]; z = g[1] + (LR() - 0.5) * 2 * g[2]; a = Math.atan2(z - 10, x + 5); }
      if (!clearOf(x, z, 12) || distToPaths(x, z) < 8 || Math.hypot(x, z - 118) < 25) continue;
      const h = (7 + Math.pow(LR(), 0.8) * 13) * stand(a), w = h * (0.8 + LR() * 0.3), y = groundAt(x, z) - 0.6;
      treeline.push({ x, y, z, h, w, d: w * (0.8 + LR() * 0.4), rot: LR() * 6.283, tint: LR() });
      if (RING_COLLIDE) { const c = proxy.clone(); c.scale(w * 0.36, h * 0.4, w * 0.36); c.translate(x, y + h * 0.5, z); site.colliders.push(indexify(c)); }
    }
    const OR = rng(1202);
    for (let k = 0; k < 480; k++) {
      const a = OR() * Math.PI * 2, r = 450 + Math.pow(OR(), 1.4) * 500, x = -5 + Math.cos(a) * r, z = 10 + Math.sin(a) * r;
      const h = (9 + Math.pow(OR(), 0.8) * 13) * stand(a), w = h * (0.85 + OR() * 0.3);
      treeline.push({ x, y: groundAt(x, z) - 0.8, z, h, w, d: w * (0.8 + OR() * 0.4), rot: OR() * 6.283, tint: OR(), outer: true });
    }
  }

  // merge structures per material + one collision geometry
  const solids = [];
  const merged = {};
  for (const [mat, list] of Object.entries(site.parts)) {
    // [L5] the procedural trunks (site.parts.bark) were never drawn or collided since V1; they only cost the bake rays,
    // atlas texels (and phantom shadows in the bounce). They stay generated (the TR/TS streams the trees use are
    // untouched) but are no longer merged, so they are out of the lightmap, its hash and the bake's trace scene.
    if (mat === 'bark') continue;
    merged[mat] = mergeGeometries(list.map((e) => { const g = e.g; for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'aY'].includes(k)) g.deleteAttribute(k); return g; }), false);
    list.forEach((e) => e.collide && solids.push(e.g));
  }
  const posOnly = (g) => { const c = new THREE.BufferGeometry(); c.setAttribute('position', g.attributes.position); c.setIndex(g.index); return c; };
  const solidGeo = mergeGeometries(solids.map(posOnly), false);
  // collision = everything you can see: structures, the yard terrain and the far field (both terrain meshes are
  // drawn, so the visible ground is the higher of the two; colliding with both matches it)
  // (far triangles lying wholly over the yard tile sit under it, out of sight and reach: leaving them out keeps their
  // 100 m bounding boxes off every query in the yard, which costs the light bake ~40 % in ray time)
  const farCol = (() => {
    const p = far.attributes.position, src = far.index.array, keep = [];
    const inTile = (i) => { const x = p.getX(i), z = p.getZ(i); return x >= -165 && x <= 155 && z >= -150 && z <= 170; };
    for (let k = 0; k < src.length; k += 3) if (!(inTile(src[k]) && inTile(src[k + 1]) && inTile(src[k + 2]))) keep.push(src[k], src[k + 1], src[k + 2]);
    const c = new THREE.BufferGeometry(); c.setAttribute('position', p); c.setIndex(keep); return c;
  })();
  // [B] collision-only treeline proxies go last (A's collider map: solids, then terrain, then anything else)
  const colGeo = mergeGeometries([solidGeo, posOnly(terr), farCol, ...(site.colliders || []).map(posOnly), ...treeCols.map(posOnly)], false);
  colGeo.computeBoundingBox();
  const bvh = new MeshBVH(colGeo, { maxLeafTris: 5 });
  // proximity / skim scoring: built structures and trunks only, so skimming the grass scores nothing
  const skimBvh = new MeshBVH(treeCols.length ? mergeGeometries([solidGeo, ...treeCols.map(posOnly)], false) : solidGeo, { maxLeafTris: 5 });   // [V1] + the trees' tubes
  terr.userData.lm = lightmapUV2(merged, terr, pathG);   // [A1] lightmap uv2 on merged/terr/pathG (append-only; layout on terr.userData.lm)

  const G = { site, terr, far, pathG, treeSpots, vegTrees, treeColVerts: treeCols.reduce((n, g) => n + g.attributes.position.count, 0),
    vegProxies: vegProx.length ? { geometry: mergeGeometries(vegProx.map((g) => { const q = new THREE.BufferGeometry(); q.setAttribute('position', g.attributes.position); q.setIndex(g.index); return q; }), false), occ: 0.6, opacity: 0.55, albedo: MATS.leaf.albedo } : null,   // [V1] for A4's bake (C10)
    treeline, merged, solidGeo, colGeo, bvh, skimBvh, lines: site.lines, takeStart: site.takeStart, startPoints: site.startPoints, funnels: site.funnels };
  let vegI = null;
  G.vegInstances = () => (vegI ||= vegPlan(G));   // [T5] contract C11 (lazy: the bake and the exporter pay only if they ask)
  return G;
}

// [T5] contract C11: the plant plan, a pure function of buildGeometry's result (seeded rngs, geometry raycasts only:
// no textures, no light bake), so the native exporter gets exactly the instances the browser draws.
// geo.vegInstances() -> [{ type, matrix[16], tint[3], ao, lod[2], near, role, centre[3], ay[2], probe[3] }]
//   type: A tree_small_02 | B island_tree_01 | J jacaranda_tree | S island_tree_02 (shrub) | V facade creeper
//   lod: [L0 end, L1 end] in m from the crown centre (quality 'low' scales them x0.75); near: < this = near LOD (0: none)
//   ao: crown openness (cosine sky visibility ^1.15) at `probe`; the browser re-probes the baked light there.
const f32 = Math.fround, frc = (x) => f32(x - Math.floor(x));
function h21js(x, y) { let px = frc(f32(x * 123.34)), py = frc(f32(y * 456.21)); const d = f32(f32(px * f32(px + 45.32)) + f32(py * f32(py + 45.32))); px = f32(px + d); py = f32(py + d); return frc(f32(px * py)); }
function vnjs(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h21js(ix, iy), b = h21js(ix + 1, iy), c = h21js(ix, iy + 1), d = h21js(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
// GLSL_WEATHER's moss pattern on up-facing faces (pt; moss where smoothstep(0.5, 0.78, pt))
const mossPt = (x, z) => vnjs(f32(x * 0.6), f32(z * 0.6)) * 0.6 + vnjs(f32(x * 2.7), f32(z * 2.7)) * 0.4;
function vegPlan(geo) {
  const site = geo.site, bvh = geo.bvh, FR = rng(1301), UPV = new THREE.Vector3(0, 1, 0), fray = new THREE.Ray(), out = [];
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _Q2 = new THREE.Quaternion(), _P = new THREE.Vector3(), _S = new THREE.Vector3(), _o = new THREE.Vector3(), ZA = new THREE.Vector3(0, 0, 1);
  const openAt = (p) => skyVisibility(bvh, p, UPV, 18, 4);
  const addI = (t, x, y, z, yaw, sx, sy, sz, th, { centre = false, yel = 0.06, role = 'tree', near = -1, probe = null, rotZ = 0 } = {}) => {
    const ty = VEG_SKEL[t], cr = ty.crown.c; _Q.setFromAxisAngle(UPV, yaw); if (rotZ) _Q.multiply(_Q2.setFromAxisAngle(ZA, rotZ));
    _P.set(x, y, z);
    if (centre) { _o.set(cr[0] * sx, 0, cr[2] * sz).applyQuaternion(_Q); _P.sub(_o); }
    _M.compose(_P, _Q, _S.set(sx, sy, sz));
    const ctr = new THREE.Vector3(...cr).applyMatrix4(_M), rw = Math.max(ty.crown.r[0] * sx, ty.crown.r[2] * sz);
    const pp = probe || ctr.clone().addScaledVector(UPV, ty.crown.r[1] * sy * 0.5), vis = openAt(pp);
    const r = FR(), b = 0.84 + FR() * 0.3, c = r < yel ? [b * 1.06, b * 1.03, b * 0.8] : [b * (0.9 + FR() * 0.14), b, b * (0.82 + FR() * 0.3)];
    const I = { type: t, matrix: _M.toArray(), tint: c, ao: Math.pow(vis, 1.15), lod: th, near: near < 0 ? Math.max(6, rw * 1.05) : near, role,
      centre: ctr.toArray(), ay: rotZ ? [y - ty.H * sy, y] : [y, y + ty.H * sy], probe: pp.toArray(), vis };
    out.push(I); return I;
  };
  const clear = (x, y, z) => { let m = 6; for (let k = 0; k < 6; k++) { const a = k * 1.047; fray.origin.set(x, y, z); fray.direction.set(Math.cos(a), 0, Math.sin(a)); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 6); if (h) m = Math.min(m, h.distance); } return m; };
  function bush(x, z, s, extra = {}) {   // a shrub mass of about s m: island_tree_02 sunk to its crown
    const y = terrainHeight(x, z), cl = clear(x, y + 0.6 * s, z); if (cl < 0.35) return false;
    s = Math.min(s, (cl + 0.3) / 0.6);
    const k = 0.55 * s, sy = k * (0.95 + FR() * 0.35), pp = new THREE.Vector3(x, y + s * 0.8, z);
    if (openAt(pp) < 0.3) return false;       // no light, no growth
    const lk = Math.min(1.3, Math.max(0.6, s / 2));
    addI('S', x, y - 1.42 * sy, z, FR() * 6.283, k * (0.8 + FR() * 0.25), sy, k * (0.8 + FR() * 0.25), [18 * lk, 50 * lk], { centre: true, probe: pp, role: extra.role || 'shrub' });
    return true;
  }
  const sapling = (x, y, z, h, probe = null, role = 'sapling') => { const s = h / VEG_SKEL.A.H, k = Math.min(1, Math.max(0.5, h / 6)); return addI('A', x, y - 0.05, z, FR() * 6.283, s * (0.85 + FR() * 0.3), s, s * (0.85 + FR() * 0.3), [22 * k, 60 * k], { probe, role }); };
  // the stands: buildGeometry's trees (they collide) + a shrub skirt round every main tree
  for (const t of geo.vegTrees || []) {
    const k = Math.min(1.4, Math.max(0.55, t.h / 9));
    addI(t.type, t.x, t.y, t.z, t.yaw, t.sx, t.sy, t.sz, [30 * k, 85 * k], { yel: 0.08 });
    if (!t.main) continue;
    for (let j = 0, n = 2 + Math.floor(FR() * 3); j < n; j++) {
      const a = FR() * 6.283, d = 0.7 + FR() * 2.2 * Math.max(1, t.sx / 1.5), x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d, s = 0.9 + FR() * 1.2;
      if (distToPaths(x, z) < 2.6) continue;
      bush(x, z, s, { role: 'skirt' });
    }
  }
  // overgrowth against the walls: shrub masses in a 1-4 m band along ~40 % of every footprint edge, in runs, a young
  // stem among a third of them; clear of the tracks and of every low line gate (doors stay visible)
  const gates = (site.lines || []).filter((l) => l.c[1] - l.h / 2 < 4);
  const gateK = (x, z, s) => {
    let k = 0;
    for (const l of gates) {
      const u = l.u || [1, 0, 0], dx = x - l.c[0], dz = z - l.c[2], du = dx * u[0] + dz * u[2], dn = Math.hypot(dx - du * u[0], dz - du * u[2]);
      const along = Math.max(0, Math.abs(du) - l.w / 2);
      if (Math.hypot(along, dn) < 1.5 + s * 0.8) k = Math.max(k, l.w > 6 ? 1 : 2);
    }
    return k;   // 0 free, 1 by a wide gate, 2 in a door
  };
  const inLine = (x, y, z, m) => (site.lines || []).some((l) => { const u = l.u || [1, 0, 0], dx = x - l.c[0], dz = z - l.c[2], du = dx * u[0] + dz * u[2], dn = Math.hypot(dx - du * u[0], dz - du * u[2]);
    return Math.abs(du) < l.w / 2 + m && dn < m + 1 && Math.abs(y - l.c[1]) < l.h / 2 + m; });
  const inFoot = (x, z, m) => site.footprints.some((f) => x > f.x0 - m && x < f.x1 + m && z > f.z0 - m && z < f.z1 + m);
  const masses = [], roomy = (x, z, s) => !masses.some(([mx, mz, ms]) => Math.hypot(x - mx, z - mz) < (s + ms) * 0.36);
  for (const f of site.footprints) {
    if ((f.x1 - f.x0) * (f.z1 - f.z0) < 20) continue;
    for (let side = 0; side < 4; side++) {
      const len = side < 2 ? f.x1 - f.x0 : f.z1 - f.z0;
      for (let t = -1 - FR() * 2; t < len + 1;) {
        const run = 3 + FR() * 8, on = FR() < 0.5;
        if (on) for (let u = t; u < Math.min(len + 1, t + run); u += (0.35 + FR() * 0.5) * 0.7) {
          const o = 0.8 + FR() * 2.8; let s = 1.7 + FR() * 1.9;
          const x = side < 2 ? f.x0 + u : side === 2 ? f.x0 - o : f.x1 + o, z = side < 2 ? (side === 0 ? f.z0 - o : f.z1 + o) : f.z0 + u;
          const gk = gateK(x, z, 1.2); if (gk === 2 || (gk === 1 && FR() < 0.7)) continue;
          if (gk === 1) s = Math.min(s, 1.6);
          if (inFoot(x, z, 0.4) || distToPaths(x, z) < 2.4 + s * 0.5 || !roomy(x, z, s)) continue;
          if (bush(x, z, s, { role: 'thicket' })) {
            masses.push([x, z, s]);
            if (gk === 0 && FR() < 0.35) { const ox = (FR() - 0.5) * s * 0.5, oz = (FR() - 0.5) * s * 0.5; if (!inFoot(x + ox, z + oz, 0.5)) sapling(x + ox, terrainHeight(x + ox, z + oz), z + oz, s * (1.2 + FR() * 0.9), null, 'stem'); }
          }
        }
        t += run;
      }
    }
  }
  // the reveal track from the spawn: thickets 4.5-7 m off its centreline, in runs (the corridor stays open)
  for (let z = 112; z > 64; z -= 1.4 + FR() * 1.6) {
    if (FR() < 0.45) continue;
    for (const sgn of [-1, 1]) {
      if (FR() < 0.35) continue;
      const x0 = z > 95 ? 0 : 6 * (95 - z) / 35, x = x0 + sgn * (4.5 + FR() * 2.5), s = 1.2 + FR() * 1.4;
      if (distToPaths(x, z) < 3.8 + s * 0.4 || !roomy(x, z, s)) continue;
      if (bush(x, z, s, { role: 'track' })) { masses.push([x, z, s]); if (FR() < 0.25) sapling(x, terrainHeight(x, z), z, 2.2 + FR() * 2.5, null, 'stem'); }
    }
  }
  // scrub on the yard: small clumps of 2-4 shrubs, the odd young tree among them
  for (let k = 0; k < 45; k++) {
    const x = -125 + FR() * 240, z = -100 + FR() * 225;
    if (inFoot(x, z, 3) || distToPaths(x, z) < 4 || Math.hypot(x, z - 118) < 12) continue;
    for (let j = 0, n = 2 + Math.floor(FR() * 3); j < n; j++) {
      const xx = x + (FR() - 0.5) * 4, zz = z + (FR() - 0.5) * 4;
      if (distToPaths(xx, zz) < 3.5 || inFoot(xx, zz, 2)) continue;
      bush(xx, zz, 1.1 + FR() * 1.3, { role: 'scrub' });
    }
    if (FR() < 0.3) sapling(x, terrainHeight(x, z), z, 2.5 + FR() * 2.5, null, 'stem');
  }
  const ts = site.takeStart?.pos || [0, -999, 0];
  // saplings where slabs and roofs end (rain, a crack, a little soil)
  const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 60);
  for (let k = 0, nSap = 0; k < 300 && nSap < 30 && bigF.length; k++) {
    const f = bigF[Math.floor(FR() * bigF.length)], x = f.x0 + FR() * (f.x1 - f.x0), z = f.z0 + FR() * (f.z1 - f.z0);
    fray.origin.set(x, 90, z); fray.direction.set(0, -1, 0); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 120);
    if (!h || h.point.y < 3.5 || Math.abs(h.face.normal.y) < 0.9) continue;
    let hits = 0, hx = 0, hz = 0;
    for (const [dx, dz] of [[1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1]]) { fray.origin.set(x + dx, h.point.y + 0.4, z + dz); if (bvh.raycastFirst(fray, THREE.DoubleSide, 0, 1.5)) { hits++; hx += dx; hz += dz; } }
    if (hits < 2 || hits === 4 || (hits === 2 && hx === 0 && hz === 0)) continue;
    const s = 0.8 + FR() * 1.4, pp = h.point.clone().addScaledVector(UPV, s * 0.7);
    if (openAt(pp) < 0.6) continue;
    sapling(x, h.point.y, z, s, pp, 'ledge'); nSap++;
  }
  // [T5] growth on the roofs (art #4): 30-60 shrub/tuft masses per roof where GLSL_WEATHER grows its moss, more along
  // the edges and corners where the dirt collects; L1/L2 cards only (never the 2-card L0 or the near LOD)
  const RR = rng(1311);
  for (const f of site.footprints) {
    const A = (f.x1 - f.x0) * (f.z1 - f.z0); if (A < 20) continue;
    const cand = [];
    for (let x = f.x0 + 0.6; x < f.x1 - 0.3; x += 1.1) for (let z = f.z0 + 0.6; z < f.z1 - 0.3; z += 1.1) {
      const jx = x + (RR() - 0.5) * 0.8, jz = z + (RR() - 0.5) * 0.8;
      fray.origin.set(jx, 95, jz); fray.direction.set(0, -1, 0); const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 130);
      if (!h || h.point.y < 3.2 || Math.abs(h.face.normal.y) < 0.92) continue;
      if (Math.hypot(jx - ts[0], jz - ts[2]) < 7 || inLine(jx, h.point.y, jz, 2.5)) continue;
      let same = 0;
      for (const [dx, dz] of [[1.0, 0], [-1.0, 0], [0, 1.0], [0, -1.0]]) { fray.origin.set(jx + dx, h.point.y + 0.5, jz + dz); const q = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 1.0); if (q && Math.abs(q.point.y - h.point.y) < 0.3) same++; }
      if (same < 2) continue;                                   // a rim or a beam, not a roof
      const pt = mossPt(jx, jz), w = sm(0.42, 0.78, pt) * 0.8 + (same < 4 ? 0.6 : 0) + 0.06;
      cand.push([jx, h.point.y, jz, w * (0.6 + 0.8 * RR())]);
    }
    if (cand.length < 6) continue;
    cand.sort((a, b) => b[3] - a[3]);
    const n = Math.min(cand.length >> 1, Math.round(Math.min(60, Math.max(30, A / 9))));
    for (let i = 0; i < n; i++) {
      const [x, y, z] = cand[i], s = 0.35 + Math.pow(RR(), 1.5) * 0.9, pp = new THREE.Vector3(x, y + 0.4, z);
      if (openAt(pp) < 0.45) continue;                          // under a slab: nothing grows
      const k = 0.55 * s, sy = k * (0.7 + RR() * 0.4);
      addI('S', x, y - 1.42 * sy, z, RR() * 6.283, k * (0.8 + RR() * 0.3), sy, k * (0.8 + RR() * 0.3), [4, 40], { centre: true, probe: pp, role: 'roof', near: 0, yel: 0.15 });
    }
  }
  // [T5] creepers on ~20 % of the facades (art #4): in runs along the footprint sides, hanging from the wall top or
  // climbing from the foot; wall plane and top found by raycasts, doors and low gates left clear
  const VR2 = rng(1321);
  for (const f of site.footprints) {
    if ((f.x1 - f.x0) * (f.z1 - f.z0) < 20) continue;
    for (let side = 0; side < 4; side++) {
      const len = side < 2 ? f.x1 - f.x0 : f.z1 - f.z0, nx = side === 2 ? -1 : side === 3 ? 1 : 0, nz = side === 0 ? -1 : side === 1 ? 1 : 0;
      let runLeft = 0;
      for (let u = 0.8 + VR2() * 1.5; u < len - 0.6; u += 1.0 + VR2() * 0.6) {
        if (runLeft <= 0) { if (VR2() < 0.12) runLeft = 2 + Math.floor(VR2() * 3); else continue; }
        runLeft--;
        const px = side < 2 ? f.x0 + u : side === 2 ? f.x0 : f.x1, pz = side < 2 ? (side === 0 ? f.z0 : f.z1) : f.z0 + u;
        let hit = null;
        for (const hy of [1.4, 3.5, 7, 12]) {   // from 3 m out, toward the footprint
          const gy = terrainHeight(px, pz) + hy; fray.origin.set(px + nx * 3, gy, pz + nz * 3); fray.direction.set(-nx, 0, -nz);
          const h = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 11); if (h && Math.abs(h.face.normal.y) < 0.2) { hit = { h, hy }; break; }
        }
        if (!hit) continue;
        const hp = hit.h.point, n = hit.h.face.normal.clone(); n.y = 0; n.normalize(); if (n.x * nx + n.z * nz < 0) n.negate();
        if (gateK(hp.x + n.x, hp.z + n.z, 1) || inLine(hp.x + n.x, hp.y, hp.z + n.z, 1.5)) continue;
        // the wall top: straight down just inside the face
        fray.origin.set(hp.x - n.x * 0.2, 95, hp.z - n.z * 0.2); fray.direction.set(0, -1, 0); const top = bvh.raycastFirst(fray, THREE.DoubleSide, 0, 130);
        const gY = terrainHeight(hp.x, hp.z), tY = top ? top.point.y : -1, pp = new THREE.Vector3(hp.x + n.x * 0.6, hp.y, hp.z + n.z * 0.6);
        if (openAt(pp) < 0.35) continue;
        const yaw = Math.atan2(n.x, n.z), sx = 0.95 + VR2() * 0.6, sy = 0.6 + VR2() * 0.9, hang = tY - gY > 3.5 && VR2() < 0.6;
        const bx = hp.x + n.x * 0.03, bz = hp.z + n.z * 0.03;
        if (hang) addI('V', bx, tY - 0.15 - 4 * sy, bz, yaw, sx, sy, 1, [14, 60], { role: 'vine', near: 0, probe: pp });
        else if (hit.hy < 2) addI('V', bx, gY + 4 * sy * 0.92, bz, yaw, sx, Math.min(sy, Math.max(0.3, (tY - gY) / 4.2)), 1, [14, 60], { role: 'vine', near: 0, probe: pp, rotZ: Math.PI });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- build everything
export async function buildBando(renderer, { sky = 'sunny', quality = 'auto', seed = 7, onProgress } = {}) {
  const R = rng(seed);
  const prog = (f, t) => onProgress?.(f, t);
  const scene = new THREE.Scene();
  const uniforms = { uTime: { value: 0 } };
  uniforms.aAO = aoUniforms();          // [A1] contract C3 (world.aoUniforms): stream D fills it each frame
  const lmJP = lmFetchJSON();           // [A1] lm.json, fetched while the geometry builds
  const vegP = vegLoad();               // [V1] tree/shrub cards, wood, atlas (flat files next to this module)
  const graffitiP = graffitiWorker();   // [P5] the graffiti atlas, drawn in a Worker while the world builds

  // textures (stream in parallel with the sky)
  const tl = new THREE.TextureLoader(); tl.setCrossOrigin('anonymous');
  // one load per URL (the coping shares the brick's maps: same texture objects, same tile, no extra GPU memory)
  const texURLs = new Set(Object.values(MATS).flatMap((m) => (m.maps || []).map((map) => texURL(m, map))));
  let texDone = 0; const texTotal = texURLs.size, texByURL = {};
  const loadTex = (url, srgb) => (texByURL[url] ||= new Promise((res) => tl.load(url, (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; if (srgb) t.colorSpace = THREE.SRGBColorSpace; texDone++; res(t); }, undefined, () => { texDone++; res(null); })));
  const texJobs = {};
  for (const [k, m] of Object.entries(MATS)) {
    const maps = m.maps || [];
    texJobs[k] = Promise.all(maps.map((map) => loadTex(texURL(m, map), /diff/.test(map))))
      .then((ts) => Object.fromEntries(maps.map((map, i) => [map.replace(/^leaves_/, ''), ts[i]])));
  }
  // [A] sky + light. The bake needs only the per-sky sun direction, so it runs right after the geometry while the HDR
  // and textures stream; the HDR's measured sun/sky intensities then scale it through uniforms (uniforms.aLight).
  // [A2] sunDir is the WORLD sun (the sky's own sunDir turned by rotY), for the bake, the light, shadows and haze
  const skyDef = SKIES[sky] || SKIES.sunny, hasSun = skyDef.sunRatio > 0, envI = skyEnvI(skyDef), sunDir = skySunDir(skyDef);   // [A4] envI = 0.85 bgI
  const aLight = (uniforms.aLight = lightUniforms());
  uniforms.aSky = skyShadowUniforms();   // [A2] ring shadow map (treeline crowns)
  aLight.uSunW.value.copy(sunDir); aLight.uHaze.value = hasSun ? 1.2 : 0;
  let skyFrac = 0, bakeFrac = 0;
  const ticker = setInterval(() => prog(0.05 + 0.85 * (skyFrac * 0.3 + (texDone / texTotal) * 0.3 + bakeFrac * 0.4), bakeFrac < 1 ? 'Baking light' : 'Streaming sky and materials'), 200);
  const skyP = loadSky(skyDef, renderer, { envI, groundAlb: BOUNCE_GROUND(groundAlbedo()),   // [L5] the bake's ground bounce (lmBakeInputs)
    haze: aLight.uHaze.value, onProgress: (f) => (skyFrac = f) });

  // geometry (CPU) while downloads run
  const geo = buildGeometry(R, seed);
  const { site, terr, far, pathG, treeSpots, treeline, merged, colGeo, bvh, skimBvh } = geo;
  prog(0.1, 'Baking light');
  await yieldUI();
  // [A1] the committed lightmap when it was baked for exactly this geometry + sun; else the per-vertex bake (2-4 s)
  let lm = null;
  {
    const m = lmMatch(await lmJP, geo, SKIES[sky] ? sky : 'sunny', sunDir);
    if (m.ok) { try { lm = await lmLoad(m); } catch (e) { console.warn('[A1] lightmap load failed, baking per vertex:', e.message); } }
    else console.info('[A1] lightmap not used (per-vertex bake):', m.why);
  }
  const bake = lm ? setBake(lmProbeBake(geo, sunDir, hasSun, lm)) : await bakeLight(geo, { sunDir, sun: hasSun, quality, onTick: (f) => (bakeFrac = f) });
  if (lm) { aLight.uLM.value = lm.irr.tex; aLight.uLMAux.value = lm.aux.tex; aLight.uLMRange.value.set(lm.s.range[0], lm.s.range[1]); }
  else bake.applyTo(pathG, 4, 18);
  far.setAttribute('ao', new THREE.BufferAttribute(new Float32Array(far.attributes.position.count).fill(1), 1));
  bakeFrac = 1;
  console.info('light bake', bake.stats);

  const sk = await skyP;
  const sunI = sk.sunI;
  aLight.uSunB.value.set(sk.sunColor.r, sk.sunColor.g, sk.sunColor.b).multiplyScalar(sunI);
  aLight.uSkyB.value.copy(sk.skyE).multiplyScalar(envI);
  LP.sun.copy(sunDir); LP.sunRGB.copy(aLight.uSunB.value); LP.skyRGB.copy(aLight.uSkyB.value);   // legacy lightProbe() callers

  const texSets = await Promise.all(Object.values(texJobs));
  clearInterval(ticker);
  const texOf = {}; Object.keys(MATS).forEach((k, i) => (texOf[k] = texSets[i]));
  prog(0.9, 'Lighting');

  const bgI = applySky(scene, skyDef, sk);

  const bStats = { ms: {} }; globalThis.__bandoStats = bStats;    // [B] counts + CPU ms per block, for the smoke harness / integrator
  let tLap = performance.now(); const lap = (k) => { const n = performance.now(); bStats.ms[k] = Math.round(n - tLap); tLap = n; };
  // [B] ground mask (grass density, paved apron, terrain AO, grass height) shared by the ground, tracks and grass
  const gm = buildGroundMask(site, terr), { t: gmask, t2: gmask2 } = gm, grassAt = grassAtFn(gm);
  const maskU = { uMask: { value: gmask }, uMask2: { value: gmask2 }, uMaskO: { value: new THREE.Vector2(MASK.x0, MASK.z0) }, uMaskS: { value: MASK.size } };
  const lin3 = (a) => new THREE.Color().setRGB(a[0], a[1], a[2]);
  const meanOf = (key) => { const m = MATS[key], t = texOf[key]?.diff, raw = t ? texMean(key, t) : null; return raw ? { raw, col: raw.map((v, i) => v * m.color[i]) } : { raw: [0.1, 0.1, 0.1], col: m.albedo }; };
  const kindU = (key) => {
    const m = MATS[key];
    if (m.kind === 'ground') {
      const gm = meanOf('ground'), am = meanOf('apron'), at = texOf.apron?.diff, mt = texOf.meadow?.diff, mm = mt && texMean('meadow', mt);
      if (mt) { mt.repeat.set(1, 1); mt.anisotropy = 8; }
      return { ...maskU, uApron: { value: at || gmask }, uApronN: { value: texOf.apron?.nor_gl || flatNorm() }, uApronRep: { value: 1 / MATS.apron.tile }, uApronCol: { value: lin3(MATS.apron.color) },
        uGMean: { value: lin3(gm.col) }, uAMean: { value: new THREE.Vector4(...am.col, Math.max(0.02, 0.2126 * am.raw[0] + 0.7152 * am.raw[1] + 0.0722 * am.raw[2])) },
        uMeadow: { value: mm ? mt : flatTex() }, uMeadowRep: { value: 1 / MATS.meadow.tile }, uMMean: { value: mm ? lin3(mm.map((v) => Math.max(v, 1e-3))) : new THREE.Color(1, 1, 1) } };
    }
    return m.kind === 'track' ? maskU : {};
  };
  const mkMat = (key, extra = {}) => {
    const m = MATS[key], t = texOf[key] || {};
    const rep = 1 / m.tile;
    Object.values(t).forEach((tx) => tx && tx.repeat.set(rep, rep));
    const mat = new THREE.MeshStandardMaterial({ map: t.diff || null, normalMap: t.nor_gl || null, roughness: m.rough ?? 1, metalness: 0,
      color: t.diff ? lin3(m.color) : new THREE.Color(0x9a9690), normalScale: new THREE.Vector2(1, 1), ...extra });
    return weatherPatch(mat, { kind: m.kind || 'built', w: m.w, wx: m.wx, roughMin: m.roughMin, uniforms: kindU(key) }, uniforms);   // wx: silo streaks, brick soot (never passed before round 4)
  };
  const mats = {}; for (const [k, m] of Object.entries(MATS)) if (m.kind !== 'aux') mats[k] = mkMat(k);
  mats.path.transparent = true; mats.path.vertexColors = true; mats.path.depthWrite = false; mats.path.polygonOffset = true; mats.path.polygonOffsetFactor = -2;

  for (const [mat, g] of Object.entries(merged)) {
    if (mat === 'bark') continue;   // [V1] the procedural trunks: kept for the lightmap hash, replaced by the real trees
    const mesh = new THREE.Mesh(g, mats[mat] || mats.wall); mesh.castShadow = true; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; scene.add(mesh);
  }
  const terrMesh = new THREE.Mesh(terr, mats.ground); terrMesh.receiveShadow = true; scene.add(terrMesh);
  const farMat = mkMat('ground'); const farMesh = new THREE.Mesh(far, farMat); farMesh.receiveShadow = true; scene.add(farMesh);   // [A2] treeline shadows land on it
  const pathMesh = new THREE.Mesh(pathG, mats.path); pathMesh.receiveShadow = true; pathMesh.renderOrder = 1; scene.add(pathMesh);

  lap('mask+materials');
  let graffitiTex = null;   // [P5] its pixels arrive from graffiti-worker.js (uploaded in strips behind the loader)
  // [B] graffiti: ~260 pieces (~900 m2) placed by a raycast pass, so they follow whatever geometry the site builds:
  // big pieces (3.5-8 m) on the ground storey outside, the hall's ground storey densest, tags (0.4-1 m) on the hall and
  // table columns, the silo bases, the stair shaft and the workshop, plus Site.decalSpots as hints. Each piece is a grid
  // conformed to the surface by rays (it wraps silos and the chimney) and is rejected over openings, edges and steps.
  // The paint multiplies the wall texture and gets the same weathering as the wall under it.
  {
    const GR = rng(1401), atlas = (graffitiTex = graffitiAtlas(renderer, graffitiP)); lap('graffitiAtlas');
    const pos = [], uv = [], nor = [], aoA = [], boA = [], ayA = [], sdA = [], idx = [], placed = [];
    const ray = new THREE.Ray(), UP = new THREE.Vector3(0, 1, 0), DN = new THREE.Vector3(0, -1, 0), U = new THREE.Vector3(), V = new THREE.Vector3(), Q = new THREE.Vector3(), nd = new THREE.Vector3();
    const cast = (o, d, maxD) => { ray.origin.copy(o); ray.direction.copy(d); return bvh.raycastFirst(ray, THREE.DoubleSide, 0, maxD); };
    const cellsBy = { piece: [], throw: [], tags: [], buff: [] }; for (let k = 0; k < GCELLS; k++) cellsBy[GTYPE(k)].push(k);
    const kindPref = () => { const r = GR(); return r < 0.5 ? 'piece' : r < 0.82 ? 'throw' : r < 0.92 ? 'buff' : 'tags'; };
    const iu = 2 / (GCOLS * 512), iv = 2 / (GROWS * 256);                 // 2 px inset: no bleed from the next cell in the mips
    const tryPiece = (P, n, w, h, kind) => {
      U.crossVectors(UP, n).normalize(); V.crossVectors(n, U); nd.copy(n).negate();
      for (const p of placed) { const dv = P.clone().sub(p.c); if (p.n.dot(n) > 0.7 && Math.abs(dv.dot(n)) < 0.7 && Math.abs(dv.dot(U)) < (p.w + w) * 0.46 && Math.abs(dv.y) < (p.h + h) * 0.5) return false; }
      const st = w < 1.2 ? 0.3 : 0.55, nx = Math.max(2, Math.round(w / st)), ny = Math.max(2, Math.round(h / st)), grid = [];
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        Q.copy(P).addScaledVector(U, (i / nx - 0.5) * w).addScaledVector(V, (j / ny - 0.5) * h).addScaledVector(n, 0.45);
        const hit = cast(Q, nd, 1.0); if (!hit) return false;
        const hn = hit.face.normal.clone(); if (hn.dot(n) < 0) hn.negate(); if (hn.dot(n) < 0.6) return false;
        grid.push({ p: hit.point.clone().addScaledVector(hn, 0.012), n: hn, d: hit.distance });
      }
      // steps and edges: no vertical jumps, and no kinks across (smooth curvature is fine: silos, the chimney, the tank)
      const D = (i, j) => grid[j * (nx + 1) + i].d;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        if (i < nx && Math.abs(D(i, j) - D(i + 1, j)) > 0.45) return false;
        if (j < ny && Math.abs(D(i, j) - D(i, j + 1)) > 0.12) return false;
        if (i > 0 && i < nx && Math.abs(D(i - 1, j) - 2 * D(i, j) + D(i + 1, j)) > 0.12) return false;
      }
      // the element under the paint: from just inside the surface, the first hits up and down are its top and bottom
      const S = grid[Math.floor(grid.length / 2)].p.clone().addScaledVector(n, -0.1);
      const hu = cast(S, UP, 60), hd = cast(S, DN, 60), top = hu ? S.y + hu.distance : P.y + h, bot = hd ? S.y - hd.distance : 0;
      const list = cellsBy[kind], cell = list[Math.floor(GR() * list.length)], cu = (cell % GCOLS) / GCOLS, cv = 1 - (Math.floor(cell / GCOLS) + 1) / GROWS;
      // light: probe every other grid vertex (and the last row/column), interpolate the rest
      const pr = new Array(grid.length), at = (i, j) => pr[j * (nx + 1) + i];
      const sI = (i, m) => i % 2 === 0 || i === m;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) if (sI(i, nx) && sI(j, ny)) { const q = grid[j * (nx + 1) + i]; pr[j * (nx + 1) + i] = [aoCurve(lightProbe(bvh, q.p, q.n, 22, 4)), LP.out.x, LP.out.y, LP.out.z]; }
      const mix4 = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        if (pr[j * (nx + 1) + i]) continue;
        const i0 = sI(i, nx) ? i : i - 1, i1 = sI(i, nx) ? i : i + 1, j0 = sI(j, ny) ? j : j - 1, j1 = sI(j, ny) ? j : j + 1;
        pr[j * (nx + 1) + i] = mix4(mix4(at(i0, j0), at(i1, j0), i1 > i0 ? 0.5 : 0), mix4(at(i0, j1), at(i1, j1), i1 > i0 ? 0.5 : 0), j1 > j0 ? 0.5 : 0);
      }
      const b = pos.length / 3, seed = GR();
      grid.forEach((q, k) => {
        const i = k % (nx + 1), j = Math.floor(k / (nx + 1)), l = pr[k];
        pos.push(q.p.x, q.p.y, q.p.z); nor.push(q.n.x, q.n.y, q.n.z); ayA.push(bot, top);
        uv.push(cu + iu + (i / nx) * (1 / GCOLS - 2 * iu), cv + iv + (j / ny) * (1 / GROWS - 2 * iv));
        aoA.push(l[0]); boA.push(l[1], l[2], l[3]); sdA.push(seed);
      });
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = b + j * (nx + 1) + i; idx.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1); }
      placed.push({ c: P.clone(), n: n.clone(), w, h, kind });
      return true;
    };
    // the flat (or gently curved) span of surface around H along axis A, probing in `st` steps up to lim each way
    const span = (H, n, A, lim, st = 0.2) => {
      const o = new THREE.Vector3(), nn = n.clone().negate(), r = [0, 0];
      const d0 = cast(o.copy(H).addScaledVector(n, 0.45), nn, 1.0); if (!d0) return r;
      for (const s of [-1, 1]) {
        let prev = d0.distance, t = 0;
        while (t < lim) {
          const h = cast(o.copy(H).addScaledVector(A, s * (t + st)).addScaledVector(n, 0.45), nn, 1.0);
          if (!h || Math.abs(h.distance - prev) > 0.4 * st || Math.abs(h.face.normal.dot(n)) < 0.6) break;
          prev = h.distance; t += st;
        }
        r[s < 0 ? 0 : 1] = s * t;
      }
      return r;
    };
    // H: a hit point on a wall, hn: its normal. Fit the piece into the free span around H (bands under ribbon
    // windows get wide, low pieces up to 3.2:1), then try smaller; tag-sized pieces go on narrow piers.
    const covered = (H, n) => { U.crossVectors(UP, n).normalize(); for (const p of placed) { const dv = H.clone().sub(p.c); if (p.n.dot(n) > 0.7 && Math.abs(dv.dot(n)) < 0.5 && Math.abs(dv.dot(U)) < p.w * 0.5 + 0.3 && Math.abs(dv.y) < p.h * 0.5 + 0.2) return true; } return false; };
    const place = (H, hn, wMin, wMax, minW = 0.6) => {
      const n = hn.clone().setY(0); if (n.lengthSq() < 0.5) return false; n.normalize();
      if (covered(H, n)) return false;
      U.crossVectors(UP, n).normalize();
      const Ua = U.clone(), sv = span(H, n, UP, 3.2), C0 = H.clone().addScaledVector(UP, (sv[0] + sv[1]) / 2);
      const su = span(C0, n, Ua, 4.2), C = C0.clone().addScaledVector(Ua, (su[0] + su[1]) / 2);
      const spanV = sv[1] - sv[0] - 0.12, spanU = su[1] - su[0] - 0.15;
      let w = Math.min(wMin + GR() * (wMax - wMin), spanU);
      for (let t = 0; t < 3 && w >= minW; t++, w *= 0.8) {
        const h = Math.min(w * (0.5 + 0.1 * GR()), spanV); if (h < w * 0.31) w = h / 0.31;
        if (w < minW || h < 0.3) return false;
        const kind = w < 1.7 ? 'tags' : kindPref();
        if (tryPiece(C, n, w, h, kind)) return true;
      }
      return false;
    };
    // a tag (0.4-1 m) on a column or narrow pier: only where the face is narrow
    const placeTag = (H, hn) => {
      const n = hn.clone().setY(0); if (n.lengthSq() < 0.5) return false; n.normalize();
      if (covered(H, n)) return false;
      U.crossVectors(UP, n).normalize();
      const Ua = U.clone(), su = span(H, n, Ua, 1.0, 0.08), spanU = su[1] - su[0] - 0.06;
      if (spanU > 1.5 || spanU < 0.36) return false;
      const w = Math.min(spanU, 0.4 + GR() * 0.6), h = w * (0.45 + GR() * 0.25);
      return tryPiece(H.clone().addScaledVector(Ua, (su[0] + su[1]) / 2), n, w, h, 'tags');
    };
    const shoot = (o, d, maxD, minD, wMin, wMax, tag = false, minW = Math.min(1.7, wMin * 0.5)) => {
      const hit = cast(o, d, maxD); if (!hit || hit.distance < minD) return false;
      const hn = hit.face.normal.clone(); if (hn.dot(d) > 0) hn.negate(); if (Math.abs(hn.y) > 0.3) return false;
      if (tag === true) return placeTag(hit.point, hn);
      return place(hit.point, hn, wMin, wMax, minW) || (tag === 'both' && GR() < 0.3 && placeTag(hit.point, hn));
    };
    const hdir = () => { const a = GR() * 6.283; return new THREE.Vector3(Math.cos(a), 0, Math.sin(a)); };
    const zone = (quota, tries, gen) => { let n = 0; for (let t = 0; t < tries && n < quota; t++) if (gen()) n++; return n; };
    const counts = {};
    // hints from the site plan
    counts.spots = site.decalSpots.reduce((n, s) => n + (shoot(s.c.clone().addScaledVector(s.n, 0.8), s.n.clone().negate(), 2.0, 0, Math.max(2.4, s.w), Math.max(3.6, s.w * 1.5)) ? 1 : 0), 0);
    const bigF = site.footprints.filter((f) => (f.x1 - f.x0) * (f.z1 - f.z0) > 30);
    const ring = (yLo, yHi, wMin, wMax) => () => {
      const f = bigF[Math.floor(GR() * bigF.length)], side = Math.floor(GR() * 4), t = 0.05 + GR() * 0.9, off = 4 + GR() * 3;
      const x = side < 2 ? f.x0 + t * (f.x1 - f.x0) : side === 2 ? f.x0 - off : f.x1 + off, z = side < 2 ? (side === 0 ? f.z0 - off : f.z1 + off) : f.z0 + t * (f.z1 - f.z0);
      const d = side === 0 ? new THREE.Vector3(0, 0, 1) : side === 1 ? new THREE.Vector3(0, 0, -1) : side === 2 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
      return shoot(new THREE.Vector3(x, terrainHeight(x, z) + yLo + GR() * (yHi - yLo), z), d, off + 12, 0.5, wMin, wMax);
    };
    counts.outside = zone(105, 1500, ring(0.6, 3.2, 3.5, 8));
    counts.upper = zone(45, 700, ring(6.2, 11, 3, 6.5));
    const inBox = (x0, x1, z0, z1, ys, minD, wMin = 2.2, wMax = 5.5, tag = false, dir = hdir) => () => shoot(new THREE.Vector3(x0 + GR() * (x1 - x0), ys(), z0 + GR() * (z1 - z0)), dir(), 25, minD, wMin, wMax, tag);
    const hall = site.footprints.find((f) => f.x1 - f.x0 > 50) || bigF[0];
    const hx0 = hall.x0 + 2, hx1 = hall.x1 - 2, hz0 = hall.z0 + 2, hz1 = hall.z1 - 2;
    // half the rays run along the hall (onto the partitions and gables), half anywhere (spandrels, bricked-up bays)
    const hallDir = () => { if (GR() < 0.5) return hdir(); const a = (GR() < 0.5 ? 0 : Math.PI) + (GR() - 0.5) * 0.6; return new THREE.Vector3(Math.cos(a), 0, Math.sin(a)); };
    counts.hall = zone(80, 900, inBox(hx0, hx1, hz0, hz1, () => 0.18 + 0.3 + GR() * 3.6, 1.0, 2.4, 7, 'both', hallDir));    // ground storey, densest
    counts.hallUp = zone(24, 260, inBox(hx0, hx1, hz0, hz1, () => (GR() < 0.6 ? 5 : 10) + 0.3 + GR() * 3.6, 1.0, 2, 5, 'both', hallDir));
    counts.hallCols = zone(45, 500, inBox(hx0, hx1, hz0, hz1, () => 0.18 + 0.8 + GR() * 1.4, 0.4, 0, 0, true));        // column tags
    counts.table = zone(14, 200, inBox(-53, -15, -27, -1, () => 1.3 + GR() * 1.8, 1.0, 2.2, 5, 'both'));
    counts.tableCols = zone(40, 500, inBox(-53, -15, -27, -1, () => 0.8 + GR() * 2.2, 0.3, 0, 0, true));
    // silo bases: from the table top toward a silo's axis (either row), just above the table slab
    counts.silo = zone(20, 180, () => {
      const sx = SILO.x[Math.floor(GR() * SILO.x.length)], sz = SILO.z[Math.floor(GR() * SILO.z.length)], a = GR() * 6.283, rr = SILO.r + 2.2;
      const o = new THREE.Vector3(sx + Math.cos(a) * rr, SILO.table + 0.7 + GR() * 2.2, sz + Math.sin(a) * rr);
      return shoot(o, new THREE.Vector3(sx - o.x, 0, sz - o.z).normalize(), 4, 0.3, 2.4, 3.6);
    });
    counts.shaft = zone(9, 120, () => { const a = Math.floor(GR() * 4) * Math.PI / 2 + (GR() - 0.5) * 0.3; return shoot(new THREE.Vector3(TOWER.x, 1.6 + Math.floor(GR() * 9) * 4 + GR() * 1.4, TOWER.z), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 3, 0.3, 1.6, 2.6); });
    const shop = site.footprints.find((f) => f.x0 < -55 && f.z0 > 30);
    if (shop) counts.workshop = zone(14, 220, inBox(shop.x0 + 2, shop.x1 - 2, shop.z0 + 2, shop.z1 - 2, () => (GR() < 0.7 ? 1.3 : 5.5) + GR() * 1.2, 1.2));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('ao', new THREE.Float32BufferAttribute(aoA, 1)); g.setAttribute('bounce', new THREE.Float32BufferAttribute(boA, 3)); g.setAttribute('aY', new THREE.Float32BufferAttribute(ayA, 2)); g.setAttribute('aSeed', new THREE.Float32BufferAttribute(sdA, 1)); g.setIndex(idx);
    const wallT = texOf.wall?.diff, wm = wallT ? texMean('wall', wallT) : null;
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
    const m = weatherPatch(new THREE.MeshStandardMaterial({ map: atlas, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.85, metalness: 0 }),
      { kind: 'decal', w: MATS.wall.w, roughMin: 0.8, uniforms: { uWallTex: { value: wallT || white }, uWallRep: { value: 1 / MATS.wall.tile }, uWallMean: { value: wm ? Math.max(0.01, 0.2126 * wm[0] + 0.7152 * wm[1] + 0.0722 * wm[2]) : 1 } } }, uniforms);
    const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.renderOrder = 2; scene.add(mesh);
    bStats.graffiti = { pieces: placed.length, big: placed.filter((p) => p.w >= 1.7).length, tags: placed.filter((p) => p.kind === 'tags').length, m2: Math.round(placed.reduce((s, p) => s + p.w * p.h, 0)), verts: pos.length / 3, tris: idx.length / 3, ...counts };
  }

  lap('graffiti');
  // [V2] grass: geometric blades (Ghost of Tsushima style), built entirely in the vertex shader. Two instanced tiers on
  // world-anchored cells (no swimming; every random number comes from the integer base cell, so a tuft is the same
  // tuft in both tiers and the depth twin):
  //   NEAR  every 0.34 m base cell is a tuft of GQ.nb curved blades, 4 segments (9 verts): taper, lean, curl, twist;
  //         dead straw blades by the dry field, seed stalks with a spindle head, a few flower heads, broadleaf weed
  //         rosettes. Out to a hashed 3D distance per tuft (5.5-8 m at auto), so there is no LOD ring.
  //   MID   every 4th cell (the level-2 subset) is a tuft of 7 wider 2-segment blades (5 verts) standing in for its
  //         2x2 block: it takes over from that cell's near tuft at the cell's switch distance, while the other 3
  //         cells' near tufts shrink away in the metre before theirs. Thins out per tuft at 22-32 m; beyond, the ground
  //         shader is the meadow (WP_FRAG.ground: the same dry / lush fields, so there is no felt when it fades).
  // Blades are opaque: no alpha test, so the A18's hidden-surface removal shades ~1 grass fragment per pixel (the
  // alpha-tested cards were 1.3-2.9 fragments/px in skims). Widths never drop under 1 px (uPix). Wind: a per-blade
  // flutter plus gusts that travel downwind across the field. The track profile (bare wheel ruts, a short sparse
  // centre strip, verges rising over ~4 m) comes from the path distance field in mask2, as in the ground and track.
  // [G5] nb upright blades + nt thatch blades per near tuft; mb blades per mid tuft (two tufts per mid instance)
  const GQS = { low: { nb: 11, nt: 4, mb: 6, near: [4.5, 6.5], mid: 24 }, auto: { nb: 15, nt: 6, mb: 6, near: [5.2, 7.6], mid: 30 }, high: { nb: 17, nt: 6, mb: 7, near: [6, 8.5], mid: 34 } };
  const GQ = GQS[quality] || GQS.auto, gCell = 0.34;
  const gShared = { uCam: { value: new THREE.Vector3() }, uCell0: { value: gCell }, uPix: { value: 0.003 },
    uFr: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 1e6)) }, uWind: { value: new THREE.Vector4(0.8, 0.6, 0.3, 3.5) }, ...maskU };
  // uLod = (tier 0 near / 1 mid, switch from, switch to (3D m), blades per tuft); uLod2 = (root radius m, width scale,
  // thin-out from, to (3D m)); uWind = (direction xz, strength, gust travel m/s)
  const tierU = (cell, lod, lod2) => ({ ...gShared, uOrigin: { value: new THREE.Vector2() }, uCell: { value: cell }, uR: { value: 10 },
    uLod: { value: new THREE.Vector4(...lod) }, uLod2: { value: new THREE.Vector4(...lod2) } });
  const nearU = tierU(gCell, [0, GQ.near[0], GQ.near[1], GQ.nb], [0.11, 1, 1e4, 1e4]);
  const midU = tierU(gCell * 2, [1, GQ.near[0], GQ.near[1], GQ.mb], [0.24, 2.7, GQ.mid - 10, GQ.mid]);   // [G5] a tuft stands for 2 cells (was 4)
  // shared by both tiers and the blur-depth twin (contract C2)
  const GRASS_VS_HEAD = `attribute vec2 aCell;
uniform vec2 uOrigin; uniform vec3 uCam; uniform float uCell; uniform float uCell0; uniform float uR; uniform float uPix;
uniform vec4 uLod; uniform vec4 uLod2; uniform vec4 uWind; uniform vec4 uFr[4];
uniform sampler2D uMask; uniform sampler2D uMask2; uniform vec2 uMaskO; uniform float uMaskS;
${GRASS_HASH}
float terrH(vec2 p) { float x = p.x, z = p.y; float d = max(max(abs(x + 5.0) - 95.0, abs(z - 10.0) - 85.0), 0.0);
  float n = sin(x * 0.021) * cos(z * 0.017) * 1.2 + sin(x * 0.053 + z * 0.041) * 0.45 + sin(z * 0.11 - x * 0.07) * 0.15;
  float ramp = min(1.0, d / 40.0); return n * ramp + min(d, 180.0) * 0.012 * ramp - 0.05 * (1.0 - ramp); }`;
  const GRASS_VS_CORE = `
  // ---- the tuft (instance): integer base cell -> 3 x 4 random bytes
  float k = position.z, t = position.y, side = position.x;
  vec2 bi = floor((uOrigin + aCell * uCell) / uCell0 + 0.5);
  // [G5] mid tier on every 2nd cell (checkerboard, was every 4th): an instance sits on an (even, even) cell and draws
  // that tuft (blades 0..w-1) and the (odd, odd) tuft diagonally beside it (blades w..2w-1)
  if (uLod.x > 0.5 && k >= uLod.w) { bi += 1.0; k -= uLod.w; }
  uvec3 th = gTuft(bi);
  uint th2 = th.z;
  vec4 tA = gU4(th.x), tB = gU4(th.y), tC = gU4(th.z);
  vec2 bp = bi * uCell0 + (tA.xy - 0.5) * uCell0 * 0.9;
  vec2 muv = (bp - uMaskO) / uMaskS;
  vec4 mk = textureLod(uMask, muv, 0.0), m2 = textureLod(uMask2, muv, 0.0);
  float gy = terrH(bp);
  vec3 toT = vec3(bp.x, gy + 0.25, bp.y) - uCam;
  float d3 = length(toT), dh = length(toT.xz);
  // track profile from the distance field: bare ruts, a short sparse centre strip, ragged verges rising over ~4 m
  float dP = m2.r * 8.0 + (tA.z - 0.5) * 0.3;
  float rut = 1.0 - smoothstep(0.16, 0.36, abs(dP - 0.8));
  float strip = 1.0 - smoothstep(0.26, 0.44, dP);
  float verge = smoothstep(1.45, 2.6, dP + (gvn(bp * 1.1) - 0.5) * 1.0);
  float edge = min(min(muv.x, muv.y), min(1.0 - muv.x, 1.0 - muv.y));
  // [G5] the meadow stands in 0.5-1.5 m clumps (density x0.2-1.8, art #1); the centre strip is broken into 1-2 m runs;
  // the mid tier keeps 0.6 m clear of the ruts (art #3). mead = the unclumped meadow: the thatch layer follows it.
  float clump = gClump(bp);
  float mead = mk.r * max(verge, 0.55 * strip * gBreak(bp)) * (1.0 - rut) * smoothstep(0.0, 0.02, edge);
  float dens = mead * clump * (uLod.x > 0.5 ? smoothstep(1.35, 1.6, dP) : 1.0);
  float weed = step(0.955, tC.x) * (1.0 - strip);
  float H = (0.3 + 0.62 * mk.a) * (0.72 + 0.56 * tA.w) * mix(0.42, 1.0, smoothstep(1.4, 5.0, dP)) * mix(1.0, 0.5, strip) * mix(0.82, 1.12, smoothstep(0.5, 1.5, clump));
  // tier: near shows the tuft inside its switch distance sw, mid shows member tufts beyond it; non-members shrink
  // away in the 1.2 m before theirs; the mid tier thins out per tuft at fo; nothing within 0.35-1 m of the lens
  float member = 1.0 - abs(mod(bi.x, 2.0) - mod(bi.y, 2.0));   // [G5] checkerboard: the mid tier's cells
  float sw = mix(uLod.y, uLod.z, tB.x), fo = mix(uLod2.z, uLod2.w, tB.y);
  float scl = uLod.x < 0.5 ? (1.0 - step(sw, d3)) * (1.0 - (1.0 - member) * smoothstep(sw - 1.2, sw, d3))
                           : member * step(sw, d3) * (1.0 - smoothstep(fo - 3.0, fo, d3));
  // [G5] near tier: blades 0..w-1 stand upright (40-100 % of them by density: 18-21 with the thatch where dens > 1),
  // blades w.. are the thatch, a 0.03-0.08 m layer of bent, matted dead blades that hides the ground wherever the meadow
  // stands, between the clumps too (art #1). Per blade: off blades go straight to the clip-space bin.
  float isTh = uLod.x < 0.5 && k >= uLod.w ? 1.0 : 0.0;
  float tuftOn = step(tB.z * 0.75 + 0.004, dens), thOn = isTh * step(0.1 + 0.3 * tC.z, mead);
  k -= isTh * uLod.w;
  scl *= max(isTh > 0.5 ? thOn : tuftOn * step(k + 0.5, uLod.w * clamp(0.4 + 0.6 * dens, 0.4, 1.0)), 0.0) * (1.0 - smoothstep(uR - 1.5, uR, dh)) * smoothstep(0.35, 1.0, d3);
  vec3 gc = vec3(bp.x, gy + H * 0.5, bp.y); float rad = H * 1.1 + uLod2.x + 0.2;
  bool cull = scl < 0.01;
  for (int i = 0; i < 4; i++) cull = cull || dot(uFr[i].xyz, gc) + uFr[i].w < -rad;
  if (cull) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  // ---- the blade (vertex): position = (side -1/+1 or 0 at the tip, t along the blade, blade index)
  uint bh0 = gPcg(th2 ^ (uint(k) * 2654435769u + 374761393u));
  vec4 bA = gU4(bh0), bB = gU4(gPcg(bh0));
  float fk = (k + 0.5) / uLod.w;
  float dryT = clamp(m2.g * (0.55 + 0.6 * tB.w) + 0.12 * tC.z, 0.0, 1.0);
  weed *= 1.0 - isTh;
  float flower = step(tC.y, 0.07 * m2.b + 0.004) * (1.0 - weed) * (1.0 - step(0.5, k)) * (1.0 - isTh);   // blade 0 of a flowering tuft
  float stalk = max(step(bA.x, mix(0.025, 0.09, dryT)) * (1.0 - weed) * step(0.5, k) * (1.0 - isTh), flower);   // [G5] <= 1 in 10 (was 1 in 4)
  float ang = tA.x * 6.2832 + k * 2.39996 + (bA.y - 0.5) * 0.8;                                  // golden-angle spread, jittered
  vec2 dir = vec2(cos(ang), sin(ang));
  float rr = mix(uLod2.x * sqrt(fk) * (0.45 + 0.75 * bA.z) * mix(1.0, 0.3, weed) * mix(1.0, 0.4, stalk), uLod2.x * (0.3 + 1.2 * bA.z), isTh);
  float bh = mix(H * (0.55 + 0.5 * bA.w) * (1.0 - 0.3 * fk), H * (1.12 + 0.35 * bB.x), stalk);
  bh = mix(mix(bh, 0.08 + H * 0.12 + 0.06 * bA.w, weed), 0.2 + 0.16 * bA.w, isTh);
  float lean = mix(mix(mix(0.1 + 0.55 * fk * fk + 0.25 * bB.y, 0.05 + 0.12 * bB.y, stalk), 1.05 + 0.3 * bB.y, weed), 1.2 + 0.3 * bB.y, isTh);   // outer blades splay; thatch lies
  float curl = mix(mix(mix((0.2 + 0.8 * bB.z) * (0.5 + fk), 0.1, stalk), 0.3, weed), 0.12 + 0.2 * bB.z, isTh);
  // wind: gusts travel downwind across the field (a 16 m noise field moving at uWind.w m/s) plus a per-blade flutter
  float gust = smoothstep(0.3, 0.85, gvn((bp - uWind.xy * (uTime * uWind.w)) * 0.06));
  float fl = sin(uTime * 2.6 + dot(bp, vec2(1.3, 0.9)) + k * 1.9) * 0.6 + sin(uTime * 6.1 + k * 3.7 + bp.y * 2.3) * 0.25;
  vec3 W = (vec3(uWind.x, 0.0, uWind.y) * uWind.z * (0.3 + 1.5 * gust) + vec3(dir.x, 0.0, dir.y) * fl * 0.07) * mix(1.0, 0.15, max(weed, isTh));
  float a1 = min(lean + curl, 2.4);
  vec3 P0 = vec3(dir.x * rr, 0.0, dir.y * rr);
  vec3 P1 = P0 + vec3(dir.x * sin(lean), cos(lean), dir.y * sin(lean)) * (bh * 0.55) + W * (bh * 0.2);
  vec3 P2 = P1 + vec3(dir.x * sin(a1), cos(a1), dir.y * sin(a1)) * (bh * 0.5) + W * (bh * 0.6);
  P2.y = max(P2.y - dot(W, W) * bh * 0.3, 0.02);
  vec3 bpos = mix(mix(P0, P1, t), mix(P1, P2, t), t);
  vec3 btan = normalize(mix(P1 - P0, P2 - P1, t) + vec3(0.0, 1e-4, 0.0));
  float tw = (bB.w - 0.5) * 1.4;
  vec3 wax = vec3(-dir.y, 0.0, dir.x) * cos(tw) + vec3(dir.x, 0.0, dir.y) * sin(tw);
  // width: leaves taper to a point, stalks are thin with a spindle seed head, weeds are broad; never under 1 px
  float bw = mix((0.009 + 0.009 * bA.w) * (1.0 - 0.8 * pow(t, 2.2)), 0.0022 + 0.012 * smoothstep(0.62, 0.8, t), stalk);
  bw = mix(bw, (0.03 + 0.03 * bA.w) * sin(3.1416 * min(t * 1.15, 1.0)) + 0.004, weed);
  bw = mix(bw, (0.022 + 0.024 * bA.w) * (1.0 - 0.65 * t * t), isTh);
  bw = max(bw * uLod2.y, uPix * d3);
  vec3 lpos = bpos + wax * (side * bw * 0.5);
  transformed = vec3(bp.x, gy - 0.03 + 0.03 * isTh, bp.y) + lpos * scl;
  // a canopy normal: the blade face, rounded across its width, bent toward the sky (both faces lit alike)
  vec3 gFn = normalize(cross(wax, btan)); gFn *= gFn.y < 0.0 ? -1.0 : 1.0;
  vec3 gNrm = normalize(gFn + wax * (side * 0.5) + vec3(0.0, 0.7, 0.0));
  float gHt = clamp(lpos.y / max(H, 0.05), 0.0, 1.0);`;
  const GRASS_VARY = '\nvarying vec3 vGCol; varying float vGv; varying float vThin;';
  // visible material only: normal + colour (linear albedo). Tuft greens (yellow-green .. lush dark), dead straw
  // blades by the dry field (green tufts keep 10 %), ripening seed stalks, dark roots, dry tips, flower heads
  // (white / yellow / violet), dark broadleaf weeds. Mean ~ MATS.grass.albedo (the light bake's grass).
  const GRASS_SHADE = `
  objectNormal = gNrm; transformedNormal = normalMatrix * gNrm;
  #ifndef FLAT_SHADED
  vNormal = normalize(transformedNormal);
  #endif
  vec3 gG = mix(mix(vec3(0.085, 0.112, 0.032), vec3(0.135, 0.14, 0.04), tB.w * tB.w), vec3(0.052, 0.082, 0.022), m2.a * (0.4 + 0.6 * tC.w));
  float dead = step(bB.x, mix(0.1, 0.8, dryT));
  vec3 col = mix(gG * (0.8 + 0.4 * bA.z), mix(vec3(0.23, 0.18, 0.09), vec3(0.15, 0.125, 0.075), bA.y) * (0.85 + 0.3 * bB.z), dead);
  col = mix(col, vec3(0.24, 0.19, 0.1) * (0.8 + 0.4 * bA.z), stalk * (1.0 - flower) * (0.55 + 0.45 * dryT));
  col = mix(col, vec3(0.045, 0.075, 0.025) * (0.85 + 0.3 * bA.z), weed);
  col *= mix(0.5, 1.0, smoothstep(0.0, 0.55, t));
  col = mix(col, vec3(0.25, 0.2, 0.1), smoothstep(0.7, 1.0, t) * (0.2 + 0.5 * dryT) * (1.0 - dead) * (1.0 - weed) * (1.0 - stalk));
  col = mix(col, tC.w < 0.45 ? vec3(0.62, 0.6, 0.55) : tC.w < 0.8 ? vec3(0.62, 0.45, 0.04) : vec3(0.28, 0.1, 0.34), flower * smoothstep(0.66, 0.8, t));
  // [G5] thatch: last year's matted blades, mostly grey-brown straw with some flattened green, dark at the roots
  col = mix(col, mix(vec3(0.05, 0.06, 0.024), mix(vec3(0.15, 0.125, 0.08), vec3(0.11, 0.1, 0.075), bA.y), step(bB.x, 0.55 + 0.35 * dryT)) * (0.7 + 0.45 * bA.z) * mix(0.6, 1.0, t), isTh);
  vGCol = col; vGv = gHt; vThin = mix(1.0, 0.6, max(dead, isTh)) * mix(1.0, 0.4, weed);
  float gAO = mix(0.4, 1.0, smoothstep(0.0, 0.85, gHt)) * (0.3 + 0.7 * mk.b);`;
  // blade strips: per blade 2 verts per level + 1 tip vertex; position = (side, t, blade index)
  const bladeGeo = (nb, lv) => {
    const P = [], I = [], L = lv.length;
    for (let k = 0; k < nb; k++) {
      const b = P.length / 3;
      for (let l = 0; l < L - 1; l++) P.push(-1, lv[l], k, 1, lv[l], k);
      P.push(0, 1, k);
      for (let l = 0; l < L - 2; l++) { const a = b + l * 2; I.push(a, a + 1, a + 3, a, a + 3, a + 2); }
      const a = b + (L - 2) * 2; I.push(a, a + 1, a + 2);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
    return g;
  };
  const ringCount = (ringR, r) => { let lo = 0, hi = ringR.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ringR[m] <= r) lo = m + 1; else hi = m; } return lo; };
  const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
  const setFr = (r, s, cam) => {   // side planes of whichever camera draws (scene or blur depth) + its pixel footprint
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); fr.setFromProjectionMatrix(pm);
    for (let i = 0; i < 4; i++) { const p = fr.planes[i]; gShared.uFr.value[i].set(p.normal.x, p.normal.y, p.normal.z, p.constant); }
    const rt = r.getRenderTarget(), h = rt ? rt.height : r.domElement.height;
    if (cam.isPerspectiveCamera) gShared.uPix.value = 2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, h);
  };
  const tiers = {};
  let grassDepth = null;
  for (const [name, U, nb, lv, rMax] of [['near', nearU, GQ.nb + GQ.nt, [0, 0.4, 0.7, 0.88, 1], GQ.near[1] + 1], ['mid', midU, 2 * GQ.mb, [0, 0.62, 1], GQ.mid + 1]]) {
    const cell = U.uCell.value, gN = 2 * Math.ceil((rMax + 2) / cell), g = bladeGeo(nb, lv);
    // cells in rings around the camera cell: instanceCount stops at the tier's radius
    const order = []; for (let i = 0; i < gN; i++) for (let j = 0; j < gN; j++) order.push([i, j, Math.hypot(i - gN / 2, j - gN / 2)]);
    order.sort((a, b) => a[2] - b[2]);
    const cells = new Float32Array(order.length * 2), ringR = new Float32Array(order.length);
    order.forEach(([i, j, r], k) => { cells[k * 2] = i; cells[k * 2 + 1] = j; ringR[k] = r; });
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2)); g.instanceCount = 0;
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 1, metalness: 0 });
    weatherPatch(m, { kind: 'grass', key: 'blade', aoExpr: 'gAO', uniforms: U, fsLights: GRASS_LIGHTS, diffuseOnly: true,
      vsHead: GRASS_VS_HEAD + GRASS_VARY, vsBegin: GRASS_VS_CORE + GRASS_SHADE, fsHead: GRASS_VARY, fsMap: '\n  diffuseColor.rgb = vGCol;' }, uniforms);
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.renderOrder = 1; mesh.name = 'grass-' + name;
    mesh.onBeforeRender = setFr; scene.add(mesh);
    tiers[name] = { mesh, U, gN, ringR, cell, verts: nb * (2 * lv.length - 1) };
  }
  {   // [B] C2 blur depth: the near blades within ~4.5 m, the same vertex shader, opaque
    const ng = tiers.near.mesh.geometry, dg = new THREE.InstancedBufferGeometry();
    for (const k of ['position', 'aCell']) dg.setAttribute(k, ng.getAttribute(k));
    dg.setIndex(ng.index); dg.instanceCount = 0;
    grassDepth = new THREE.Mesh(dg, depthC2Opaque({ vsHead: GRASS_VS_HEAD, vsMain: GRASS_VS_CORE, uniforms: { ...nearU, uTime: uniforms.uTime } }));
    grassDepth.frustumCulled = false; grassDepth.onBeforeRender = setFr;   // planes for this camera, whichever pass runs first
  }
  const setTier = (T, p, r) => {
    const c = T.cell; T.U.uOrigin.value.set(Math.floor(p.x / c) * c - (T.gN / 2) * c, Math.floor(p.z / c) * c - (T.gN / 2) * c);
    T.U.uR.value = r; T.mesh.visible = r > 0.8;
    T.mesh.geometry.instanceCount = T.mesh.visible ? Math.min(T.gN * T.gN, ringCount(T.ringR, r / c + 1.5)) : 0;
  };
  bStats.grass = { near: { blades: GQ.nb, thatch: GQ.nt, vertsPerTuft: tiers.near.verts, cells: tiers.near.gN ** 2, switch: GQ.near }, mid: { blades: GQ.mb, tuftsPerInstance: 2, vertsPerInstance: tiers.mid.verts, cells: tiers.mid.gN ** 2, out: GQ.mid } };
  scene.userData.grass = { shared: gShared, near: nearU, mid: midU, tiers };   // live tuning (wind, LOD)
  lap('grass');
  // [V1] vegetation: real CC0 trees and shrubs (Poly Haven tree_small_02 'A', island_tree_01 'B', island_tree_02 'S')
  // baked offline into leaf-card clouds (billboard clouds of the models' own leaf clusters, twig tiles in one 2048
  // atlas), simplified wood and trunk skeletons (veg.json / veg.bin / veg_atlas.jpg + veg_atlas_a.png / veg_bark_*.jpg).
  // Per type 3 LODs (L0 two crossed fixed cards per cluster + full wood, L1/L2 camera-facing cards + lighter wood),
  // InstancedMesh per (type, LOD) re-bucketed on the CPU when the camera moves > 0.8 m (L0 sorted near to far).
  // Leaves: wrap lighting + sun transmission (backlit leaves glow instead of going black), crown-mass normals and
  // per-card crown occlusion, per-instance hue/brightness, wind sway + leaf flutter. Trees on the treeSpots in clumps
  // (buildGeometry: vegTrees + collision tubes), every tree with a shrub skirt; thickets hug the walls, scrub lines
  // the reveal track and the yard, saplings on slab edges. The treeline ring is the same cards at LOD 3.
  const foliageStats = bStats.foliage = {}, leafTiles = [];
  let vegUpdate = () => {}, vegFill = null;
  const uWind = { value: new THREE.Vector4(0.22, 0.14, 1, 0) }, uLeafL = { value: new THREE.Vector4(0.6, 0.35, 0.3, 0.55) };
  const veg = await vegP;
  if (!veg) console.warn('[V1] vegetation assets missing (veg.json/veg.bin/atlas): no trees or shrubs');
  if (veg) {
    const man = veg.man, FR = rng(1301), UPV = new THREE.Vector3(0, 1, 0), fray = new THREE.Ray();
    const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const base = {};   // shared BufferAttributes per mesh name
    const mkGeo = (name) => {
      const m = man.meshes[name]; if (!m) return null;
      if (!base[name]) {
        const a = Object.fromEntries(Object.entries(m.attrs).map(([k, [o, n, it]]) => [k, new THREE.BufferAttribute(new Float32Array(veg.bin, o, n), it)]));
        if (a.aOff) {   // cards: pack offset, sway and occlusion into one vec4 (aCard)
          const n = a.aOff.count, c = new Float32Array(n * 4);
          for (let i = 0; i < n; i++) { c[i * 4] = a.aOff.array[i * 2]; c[i * 4 + 1] = a.aOff.array[i * 2 + 1]; c[i * 4 + 2] = a.aSway.array[i]; c[i * 4 + 3] = a.aOcc.array[i]; }
          // [T5] cards at their baked size (K 1.0, was 1.18: magnified twig tiles read as 25-40 cm leaves); the bake has 35 % more
          a.aCard = new THREE.BufferAttribute(c, 4); delete a.aOff; delete a.aSway; delete a.aOcc;
        }
        base[name] = { a, i: new THREE.BufferAttribute(new Uint16Array(veg.bin, m.index[0], m.index[1]), 1) };
      }
      const g = new THREE.BufferGeometry(); for (const [k, a] of Object.entries(base[name].a)) g.setAttribute(k, a); g.setIndex(base[name].i);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5); return g;
    };
    // leaf albedo: each species' atlas mean -> MATS.leaf.albedo (clamped), the per-instance tint varies it
    const target = MATS.leaf.albedo, spOf = { A: 'ts', B: 'is', S: 'is', J: 'jc', V: 'is' };
    const spCol = (t) => { const m = man.atlas.meanLin?.[spOf[t]] || [0.06, 0.085, 0.025]; return new THREE.Color().setRGB(...target.map((v, i) => Math.min(2.2, Math.max(0.8, v / m[i])))); };
    const alphaBoost = `
  #ifdef USE_MAP
  { vec2 tx = vMapUv * vec2(textureSize(map, 0)); diffuseColor.a *= 1.0 + 0.3 * clamp(0.5 * log2(min(dot(dFdx(tx), dFdx(tx)), dot(dFdy(tx), dFdy(tx)))), 0.0, 3.0); }
  #endif`;
    const leafMat = (t, face, kind = 'leaf', extra = {}) => {
      const m = new THREE.MeshStandardMaterial({ map: veg.atlas, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.72, metalness: 0,
        vertexColors: true, color: spCol(t) });
      m.defines = face === 'near' ? { VEG_CARDS: '', VEG_FACE: '', VEG_NEAR: '' } : face ? { VEG_CARDS: '', VEG_FACE: '' } : { VEG_CARDS: '' };
      return weatherPatch(m, { kind, key: face === 'near' ? 'n' : face ? 'f' : 'x', diffuseOnly: true, aoExpr: kind === 'leaf' ? 'ao * aOcc' : 'aOcc', vsPost: kind === 'leaf' ? 'vBounce *= aOcc;' : '',
        fsLights: VEG_LEAF_LIGHTS, uniforms: { uLeafL, uWind }, fsAlpha: alphaBoost, ...extra }, uniforms);
    };
    const woodMat = (t) => weatherPatch(new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, color: new THREE.Color(0.85, 0.85, 0.85) }), {
      kind: 'bark', key: 'v', uniforms: { uBark: { value: veg.bark[t] }, uWind },
      vsHead: VEG_GLSL + '\nattribute float aTile;\nvarying vec2 vBUv;\nvarying float vTile;',
      vsBegin: '  transformed = vegWind(transformed, position, 0.0);\n  vBUv = uv; vTile = aTile;',
      fsHead: 'uniform sampler2D uBark;\nvarying vec2 vBUv;\nvarying float vTile;',
      fsMap: '  { vec2 g = vBUv * vec2(0.5, 1.0); diffuseColor.rgb *= textureGrad(uBark, vec2((vTile + fract(vBUv.x)) * 0.5, fract(vBUv.y)), dFdx(g), dFdy(g)).rgb; }' }, uniforms);
    const cardDepth = (face) => {
      const m = depthC2Mat({ vsHead: VEG_GLSL, vsMain: VEG_CARD_VS + `
  #ifdef USE_INSTANCING
  transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  vUv = uv;`, uniforms: { uTime: uniforms.uTime, uWind }, alphaTex: veg.atlas, alphaCh: 0, alphaTest: 0.42, texN: 2048, edge: [0.12, 0.38], near: true });
      m.defines = face === 'near' ? { VEG_CARDS: '', VEG_FACE: '', VEG_NEAR: '' } : face ? { VEG_CARDS: '', VEG_FACE: '' } : { VEG_CARDS: '' };
      m.vertexShader = m.vertexShader.replace('gl_Position = projectionMatrix * mv;', `gl_Position = projectionMatrix * mv;
  #ifdef USE_INSTANCING
  if (length((modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz) > 42.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);   // C2: leaves within ~40 m
  #endif`);
      return m;
    };

    // ---- instances: the plan (contract C11, pure), lit by the baked light at each plant's probe point
    const qK = quality === 'low' ? 0.75 : 1, VI = [];
    for (const P of geo.vegInstances ? geo.vegInstances() : []) {
      if (!man.types[P.type]) continue;
      const pp = new THREE.Vector3(...P.probe), vis = lightProbe(bvh, pp, UPV, 18, 4);
      VI.push({ t: P.type, m: new Float32Array(P.matrix), c: P.tint, ao: aoCurve(vis), bo: [LP.out.x, LP.out.y, LP.out.z], ay: P.ay, ctr: new THREE.Vector3(...P.centre),
        th: P.lod.map((v) => v * qK), nr: P.near * qK, lod: -2, d: 0, role: P.role });
    }
    const cntR = (r) => VI.filter((I) => I.role === r).length;
    const nTree = cntR('tree'), nSkirt = cntR('skirt'), nBush = cntR('thicket'), nStem = cntR('stem'), nTrack = cntR('track'), nField = cntR('scrub'), nSap = cntR('ledge');

    // ---- meshes per (type, LOD), shared instance buffers per bucket. LOD 3 = the near LOD ([T5] perf #2: within
    // ~6 m of the crown one camera-facing card per cluster at 0.6x L0's card count, turned about world up, so camera
    // roll does not spin the leaves). All of them are static shadow casters (aStaticCaster: in A4's maps at LOD 1).
    const buckets = [];
    for (const t of ['A', 'B', 'J', 'S', 'V']) {
      const cap = VI.filter((I) => I.t === t).length; if (!cap || !man.types[t]) continue;
      const ty = man.types[t], lods = ty.lods.slice(0, 3).concat(ty.near ? [ty.near] : []);
      lods.forEach((lod, li) => {
        const l = ty.near && li === lods.length - 1 ? 3 : li;
        const iM = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16), iC = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        const iAO = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1), iBO = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3), iAY = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
        for (const a of [iM, iC, iAO, iBO, iAY]) a.setUsage(THREE.DynamicDrawUsage);
        const b = { t, l, list: [], meshes: [], iM, iC, iAO, iBO, iAY };
        const mk = (name, mat, depth) => {
          const g = mkGeo(name); if (!g) return;
          g.setAttribute('ao', iAO); g.setAttribute('bounce', iBO); g.setAttribute('aY', iAY);
          const m = new THREE.InstancedMesh(g, mat, cap); m.instanceMatrix = iM; m.instanceColor = iC; m.count = 0; m.visible = false;
          m.frustumCulled = false; m.castShadow = false; m.userData.aStaticCaster = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.name = 'veg'; m.renderOrder = 1; scene.add(m); b.meshes.push(m);
          if (depth) { const dm = new THREE.InstancedMesh(g, depth, cap); dm.instanceMatrix = iM; dm.count = 0; dm.visible = false; dm.frustumCulled = false; dm.matrixAutoUpdate = false; leafTiles.push(dm); b.meshes.push(dm); }
        };
        const fk = l === 3 ? 'near' : t === 'V' ? false : l > 0;
        mk(lod.cards, leafMat(t, fk), l < 2 || l === 3 ? cardDepth(fk) : null);
        if (lod.wood) mk(lod.wood, woodMat(t), null);
        buckets.push(b);
      });
    }
    const BK = new Map(buckets.map((b) => [b.t + b.l, b]));
    const bucketOf = (t, l) => BK.get(t + l) || (l === 3 ? BK.get(t + 0) : null) || BK.get(t + (l - 1)) || BK.get(t + 1) || BK.get(t + 0);
    const writeB = (b) => {
      if (b.l === 0 || b.l === 3) b.list.sort((p, q) => p.d - q.d);   // near to far: alpha-tested crowns reject what they hide
      const n = b.list.length;
      b.list.forEach((I, i) => { b.iM.array.set(I.m, i * 16); b.iC.array.set(I.c, i * 3); b.iAO.array[i] = I.ao; b.iBO.array.set(I.bo, i * 3); b.iAY.array.set(I.ay, i * 2); });
      if (n) for (const a of [b.iM, b.iC, b.iAO, b.iBO, b.iAY]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
      for (const m of b.meshes) { m.count = n; m.visible = n > 0; }
    };
    const relist = () => { for (const b of buckets) b.list.length = 0; for (const I of VI) I.b?.list.push(I); };
    const last = new THREE.Vector3(1e9, 0, 0), lastSort = new THREE.Vector3(1e9, 0, 0), dirty = new Set();
    let uploads = 0;
    vegFill = (lod) => { for (const I of VI) { I.lod = -2; I.b = lod >= 0 ? bucketOf(I.t, lod) : null; } relist(); buckets.forEach(writeB); last.set(1e9, 0, 0); };
    vegUpdate = (cam) => {   // [T5] perf #5: LODs every 0.8 m of travel, but buffers re-uploaded only for buckets that changed
      if (last.distanceToSquared(cam) < 0.64) return;
      last.copy(cam);
      for (const I of VI) {
        const d = (I.d = I.ctr.distanceTo(cam)), l = I.lod;
        const nl = d < I.nr * (l === 3 ? 1.08 : 0.94) ? 3 : d < I.th[0] * (l === 0 || l === 3 ? 1.06 : 0.94) ? 0 : d < I.th[1] * (l >= 0 && l <= 1 || l === 3 ? 1.06 : 0.94) ? 1 : 2;
        if (nl !== l) { const nb = bucketOf(I.t, nl); I.lod = nl; if (nb !== I.b) { if (I.b) dirty.add(I.b); dirty.add(nb); I.b = nb; } }
      }
      const sortDue = lastSort.distanceToSquared(cam) > 25;
      if (!dirty.size && !sortDue) return;
      relist();
      if (sortDue) { lastSort.copy(cam); for (const b of buckets) if ((b.l === 0 || b.l === 3) && b.list.length > 1) { for (const I of b.list) I.d = I.ctr.distanceTo(cam); dirty.add(b); } }
      for (const b of dirty) { writeB(b); uploads++; }
      dirty.clear();
    };
    scene.userData.vegUploads = () => uploads;
    const cnt = (t) => VI.filter((I) => I.t === t).length;
    Object.assign(foliageStats, { trees: nTree, skirts: nSkirt, thickets: nBush, stems: nStem, track: nTrack, shrubs: nField, saplings: nSap, roof: cntR('roof'), vines: cntR('vine'), instances: VI.length, A: cnt('A'), B: cnt('B'), J: cnt('J'), S: cnt('S'), V: cnt('V'), meshes: buckets.reduce((n, b) => n + b.meshes.length, 0) });

    lap('foliage');
    // ---- distant treeline: LOD 3 of A and B (7 camera-facing cards each), one static group named 'treeline' (A2's
    // ring shadow map renders it with the customDepthMaterial below: the same facing cut-out, turned to the sun).
    // No shrink with distance: the camera far plane is 3000 m. Haze = 0.15 (1 - exp(-d / 600)) on top of the fog.
    {
      const list = treeline.slice().sort((a, b) => Math.hypot(a.x + 5, a.z - 10) - Math.hypot(b.x + 5, b.z - 10));
      const group = new THREE.Group(); group.name = 'treeline';
      const tdm = new THREE.MeshBasicMaterial({ map: veg.atlas, alphaTest: 0.42, side: THREE.DoubleSide, colorWrite: false });
      tdm.defines = { VEG_CARDS: '', VEG_FACE: '' };
      tdm.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uWind = uWind;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;\n' + VEG_GLSL).replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VEG_CARD_VS);
        sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', alphaBoost + '\n#include <alphatest_fragment>');
      };
      tdm.customProgramCacheKey = () => 'vegTreelineDepth';
      const greens = [[0.66, 0.72, 0.76], [0.78, 0.8, 0.72], [0.56, 0.64, 0.72], [0.84, 0.8, 0.62]];
      const byT = { A: [], B: [], J: [] }; list.forEach((t) => { const r = t.tint * 7 % 1; byT[r < 0.3 ? 'A' : r < 0.6 || !man.types.J ? 'B' : 'J'].push(t); });   // [T5] + jacaranda crowns
      const M = new THREE.Matrix4(), qq = new THREE.Quaternion(), col = new THREE.Color(), P = new THREE.Vector3(), S = new THREE.Vector3();
      for (const [t, arr] of Object.entries(byT)) {
        const ty = man.types[t], lod = ty.lods[3]; if (!lod || !arr.length) continue;
        const mat = leafMat(t, true, 'treeline', { fsFog: `#ifdef USE_FOG
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, 0.15 * (1.0 - exp(-vFogDepth / 600.0)));   // aerial perspective of a distant wood
#endif` });
        const im = new THREE.InstancedMesh(mkGeo(lod.cards), mat, arr.length), cw = 2 * Math.max(ty.crown.r[0], ty.crown.r[2]);
        arr.forEach((tr, i) => {
          const sy = tr.h / ty.H, sxz = sy * Math.min(1.6, Math.max(0.85, (tr.w / tr.h) / (cw / ty.H)));
          qq.setFromAxisAngle(UPV, tr.rot); M.compose(P.set(tr.x, tr.y, tr.z), qq, S.set(sxz, sy, sxz)); im.setMatrixAt(i, M);
          const gc = greens[Math.min(3, Math.floor(tr.tint * 4))], k = 0.88 + tr.tint * 0.24; im.setColorAt(i, col.setRGB(gc[0] * k, gc[1] * k, gc[2] * k));
        });
        im.customDepthMaterial = tdm; im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = false; im.renderOrder = 1; im.matrixAutoUpdate = false;
        group.add(im);
      }
      group.matrixAutoUpdate = false; scene.add(group);
      foliageStats.treeline = treeline.filter((t) => !t.outer).length; foliageStats.treelineOuter = treeline.length - foliageStats.treeline;
    }
    lap('treeline');
  }
  // [B] contract C2: the blur depth's alpha-tested extras (fpvcam renders this after the collider, same camera, no
  // override material): near grass (<= 8 m ring) and the leaf tiles within 40 m. world.update() keeps them current.
  const depthScene = new THREE.Scene(); depthScene.name = 'depthScene';
  depthScene.add(grassDepth); leafTiles.forEach((m) => depthScene.add(m));
  depthScene.matrixWorldAutoUpdate = false; depthScene.updateMatrixWorld(true);
  scene.userData.depthScene = depthScene;
  const _ds = new THREE.Sphere();

  // [A1] lightmapped materials: the merged structures, the yard terrain, the path ribbons and, when every vertex
  // finds its wall, the graffiti (it then gets exactly the wall's indirect light). The far field keeps env x ao.
  if (lm) {
    for (const k of Object.keys(merged)) lmEnable(mats[k] || mats.wall);
    lmEnable(mats.ground); lmEnable(mats.path);
    const dm = scene.children.find((o) => o.isMesh && o.material?.customProgramCacheKey?.() === 'wp:decal');
    const dr = dm && bake.decalUV2(dm.geometry); if (dr) lmEnable(dm.material);
    if (lm.j.skies?.[SKIES[sky] ? sky : 'sunny']?.light) {   // the sky the map was baked with vs the one measured now
      const b = lm.s.light, d = Math.abs(b.sunI - sunI) / Math.max(1, sunI) + Math.abs(b.skyB[1] - aLight.uSkyB.value.y) / Math.max(0.1, aLight.uSkyB.value.y);
      if (d > 0.02) console.warn('[A1] lightmap baked with sunI', b.sunI, 'skyB', b.skyB, 'but the sky measures sunI', +sunI.toFixed(3), 'skyB', aLight.uSkyB.value.toArray().map((v) => +v.toFixed(3)), ': re-run node tools/bakelm.mjs');
    }
    const fr = lmFresh(lm.j, geo); if (fr.length) console.warn('[A4] lightmap stale in light/vegetation:', fr.join('; '), ': re-run node tools/bakelm.mjs');
    bake.stats.decals = dr || 'probe';
  }
  // [A] sun: a DirectionalLight carrying the energy clamped out of the HDR.
  // [A4] Shadows (decision 6): static maps rendered once here, after every caster exists (renderSunShadows): the near
  // map over the site, the far map over every caster, the ring map over the treeline crowns. No live map and no shadow
  // pass per frame, unless a caster opts out with userData.liveShadow = true (e.g. foliage with a swaying shadow): then
  // three's live map (+-52 m around the camera, A2's snapping) renders those casters alone and multiplies in on top.
  // A static caster added after buildBando returns is picked up by update() (checked 1/s) or world.rebakeShadows().
  const sun = new THREE.DirectionalLight(sk.sunColor, sunI);
  scene.environmentIntensity = envI;
  const sunShadows = sunI > 0.5;                     // overcast: no shadow maps at all
  sun.castShadow = false;
  const sm = quality === 'low' ? 1024 : 2048; sun.shadow.mapSize.set(sm, sm);
  const { ext, back, snapM, lead } = LIVE_SHADOW;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 2 * back });
  sun.shadow.bias = -0.00008; sun.shadow.normalBias = 0.04; sun.shadow.camera.updateProjectionMatrix();   // 2.4 cm depth bias
  sun.shadow.autoUpdate = false; sun.shadow.needsUpdate = true;
  if (mats.brick) mats.brick.shadowSide = THREE.DoubleSide;   // the chimney tube casts with both skins (no leak down its throat)
  scene.add(sun); scene.add(sun.target);
  const texel = (2 * ext) / sm, snap = texel * Math.max(1, Math.round(snapM / texel));
  const lightBasisX = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), sunDir).normalize(), lightBasisY = new THREE.Vector3().crossVectors(sunDir, lightBasisX);
  const _fwd = new THREE.Vector3(), _ctr = new THREE.Vector3(); let shAx = NaN, shAy = NaN, shN = 0;
  // [A4] horizon fog (loadSky's table, x bgI)
  aLight.uHz.value = sk.horizon.tex; aLight.uHzI.value = bgI; aLight.uHzOn.value = 1;
  if (mats.slab) mats.slab.aHorizonTex = sk.horizon.tex;
  // the near map fits the site: the footprints, up to the chimney top, plus the reach of their shadows on the ground
  const nearFit = new THREE.Box3();
  for (const f of site.footprints || []) nearFit.union(new THREE.Box3(new THREE.Vector3(f.x0, -2, f.z0), new THREE.Vector3(f.x1, 4, f.z1)));
  for (const g of Object.values(merged)) { if (!g.boundingBox) g.computeBoundingBox(); }
  if (nearFit.isEmpty()) nearFit.setFromCenterAndSize(new THREE.Vector3(-5, 20, 10), new THREE.Vector3(160, 50, 160));
  nearFit.max.y = Math.max(nearFit.max.y, ...Object.values(merged).map((g) => Math.min(60, g.boundingBox.max.y)));
  nearFit.expandByVector(new THREE.Vector3(12, 0, 12));
  const blank = blankSunMap(renderer); if (mats.slab) mats.slab.aBlankShadowTex = blank;
  aLight.uNearSM.value = blank; aLight.uFarSM.value = blank; uniforms.aSky.uRingSM.value = blank;
  let shadowInfo = { static: false }, liveCasters = [], tCheck = 0;
  scene.userData.vegShadowLod = vegFill;   // [V1/T5] static shadow maps: vegShadowLod(1) = every plant at LOD 1, vegShadowLod(-1) = back to the camera LODs (set before the first renderSunShadows)
  const newCaster = () => { let f = false; scene.traverse((o) => { if (!f && o.isMesh && o.castShadow && o.visible && !o.userData.liveShadow && !o.userData.aStaticCaster && o.name !== 'treeline') f = true; }); return f; };
  const renderSunShadows = () => {
    if (!sunShadows) { shadowInfo = { static: false, why: 'no sun' }; return shadowInfo; }
    const t0 = performance.now();
    scene.userData.vegShadowLod?.(1);   // [V1/T5] every tree/shrub at LOD 1 into the static maps: BEFORE the caster sweep (graphics §3)
    scene.updateMatrixWorld(true);
    const all = [], live = [];
    scene.traverse((o) => { if (o.isMesh && o.visible && (o.castShadow || o.userData.liveShadow || o.userData.aStaticCaster) && o.name !== 'treeline') (o.userData.liveShadow ? live : all).push(o); });
    for (const o of all) { o.castShadow = false; o.userData.aStaticCaster = true; }   // three's shadow pass skips them: they are in the static maps
    for (const o of live) o.castShadow = true;
    liveCasters = live; sun.castShadow = live.length > 0; if (sun.castShadow) sun.shadow.needsUpdate = true;
    for (const k of ['aNearShadowTex', 'aFarShadowTex']) if (mats.slab?.[k]) { mats.slab[k].dispose(); mats.slab[k] = null; }
    const nq = quality === 'low' ? SUN_MAPS.near.sizeLow : SUN_MAPS.near.size, fq = quality === 'low' ? SUN_MAPS.far.sizeLow : SUN_MAPS.far.size;
    const near = renderSunMap(renderer, all, sunDir, nearFit, { size: nq, half: SUN_MAPS.near.half, bias: SUN_MAPS.near.bias, bits: 16, raw: quality === 'low' ? 0 : SUN_MAPS.near.raw });
    const far = renderSunMap(renderer, all, sunDir, null, { size: fq, half: SUN_MAPS.far.half, bias: SUN_MAPS.far.bias, bits: 24 });
    scene.userData.vegShadowLod?.(-1);
    aLight.uNearSM.value = near.tex; aLight.uNearMat.value.copy(near.M); aLight.uNearTexel.value.set(1 / near.size, 1 / near.size);
    if (mats.slab?.aNearRawTex) { mats.slab.aNearRawTex.dispose(); mats.slab.aNearRawTex = null; }
    aLight.uNearRaw.value = near.raw; aLight.uPcss.value.set(near.depthM, near.uvPerM, near.raw ? 1 : 0, 0);   // [L5] PCSS (off on low)
    if (mats.slab && near.raw) mats.slab.aNearRawTex = near.raw;
    aLight.uFarSM.value = far.tex; aLight.uFarMat.value.copy(far.M); aLight.uFarTexel.value.set(1 / far.size, 1 / far.size); aLight.uFarOn.value = 1;
    aLight.uSunShOn.value = 1;
    if (mats.slab) { mats.slab.aNearShadowTex = near.tex; mats.slab.aFarShadowTex = far.tex; }   // so clearWorld()'s material sweep disposes them
    shadowInfo = { static: true, casters: all.length, live: live.length, near: { size: near.size, texel: +near.texel.toFixed(4), half: near.half }, far: { size: far.size, texel: +far.texel.toFixed(3), half: far.half }, ms: Math.round(performance.now() - t0) };
    console.info('[A4] static sun shadows', JSON.stringify(shadowInfo));
    return shadowInfo;
  };
  if (sunShadows) {
    // [A2] treeline crowns (stream B's mesh or group named 'treeline'; absent = no ring map) into a static ring map
    // A sampler2DShadow must always see an allocated compare texture, so without a treeline the blank map stands in.
    const tl = scene.getObjectByName('treeline');
    const siteBox = new THREE.Box3(); for (const g of Object.values(merged)) siteBox.union(g.boundingBox);
    const rs = tl ? renderRingShadow(renderer, tl, sunDir, 1024, uniforms.aSky, new THREE.Vector2((siteBox.min.x + siteBox.max.x) / 2, (siteBox.min.z + siteBox.max.z) / 2)) : null;
    if (rs) { if (mats.slab) mats.slab.aRingShadowTex = rs.tex; console.info('ring shadow', rs.info); }
    else { uniforms.aSky.uRingG.value.w = 0; console.info('ring shadow: no treeline object, off'); }
    renderSunShadows();
  }
  const update = (camPos, dt, camQuat) => {
    uniforms.uTime.value += dt;
    // [V2] grass tiers: each ring stops where no tuft can still be inside the tier's 3D range (the near tier is off
    // above ~8 m AGL, the mid tier above ~32 m; the ground shader is the meadow from there)
    gShared.uCam.value.copy(camPos);
    const alt = Math.max(0, camPos.y - terrainHeight(camPos.x, camPos.z) - 0.3);
    setTier(tiers.near, camPos, Math.sqrt(Math.max(0, GQ.near[1] ** 2 - alt * alt)) + 0.5);
    setTier(tiers.mid, camPos, Math.sqrt(Math.max(0, GQ.mid ** 2 - alt * alt)) + 1);
    // [B] C2 depth: the near blades within ~4.5 m (parallax error beyond is small), the leaf tiles within 40 m
    grassDepth.visible = tiers.near.mesh.visible; grassDepth.geometry.instanceCount = Math.min(tiers.near.mesh.geometry.instanceCount, ringCount(tiers.near.ringR, 4.5 / gCell + 1.5));
    vegUpdate(camPos);   // [V1] tree/shrub LOD buckets (the C2 depth twins share them; their shader keeps < 42 m)
    // [A4] a static caster added after the bake (a mesh with castShadow that is in no map yet; checked once a second):
    // render the static maps again
    if (sunShadows && (tCheck += dt) > 1) { tCheck = 0; if (newCaster()) renderSunShadows(); }
    // [A2] live shadow map (only with userData.liveShadow casters) follows the camera; re-render only when its
    // snapped centre moves
    if (!sun.castShadow) return;
    _ctr.copy(camPos);
    if (camQuat && lead > 0) { _fwd.set(0, 0, -1).applyQuaternion(camQuat); _fwd.y = 0; const l = _fwd.length(); if (l > 1e-3) _ctr.addScaledVector(_fwd, (lead * ext) / l); }
    const ax = Math.round(_ctr.dot(lightBasisX) / snap) * snap, ay = Math.round(_ctr.dot(lightBasisY) / snap) * snap;
    if (ax !== shAx || ay !== shAy) {
      shAx = ax; shAy = ay; shN++;
      const c = _ctr.set(0, 0, 0).addScaledVector(lightBasisX, ax).addScaledVector(lightBasisY, ay).addScaledVector(sunDir, camPos.dot(sunDir));
      sun.target.position.copy(c); sun.position.copy(c).addScaledVector(sunDir, back);
      sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
      sun.shadow.needsUpdate = true;
    }
  };
  update(new THREE.Vector3(0, 0, 100), 0);

  // depth for the shutter blur = the solid geometry
  const colScene = new THREE.Scene();
  const cm = new THREE.Mesh(colGeo, new THREE.MeshBasicMaterial()); cm.frustumCulled = false; colScene.add(cm);
  // [P5] the graffiti strips land behind the loader (the worker is normally done long before this; never wait > 3 s)
  if (graffitiTex) { await Promise.race([graffitiTex.userData.ready, new Promise((r) => setTimeout(r, 3000))]); Object.defineProperty(bStats, 'graffitiUpload', { get: () => graffitiTex.userData.graffiti, enumerable: true }); }
  prog(0.98, 'Ready');
  setBake(null);   // [A] the probe solution was only needed while building (decals); free it
  if (lm) lm.irr.pix = null;   // [A1] the CPU copy of the lightmap (14 MB) served the build-time probes only
  scene.userData.aLight = aLight; scene.userData.lightBake = bake.stats; scene.userData.aoUniforms = uniforms.aAO;   // [A] live tuning hooks (uSunB, uSkyB, uFarOn, uHaze...)
  // [A2] sky/shadow hooks: ring map uniforms, live-map re-render count (for perf checks), the world sun
  scene.userData.aSky = { u: uniforms.aSky, shadowUpdates: () => shN, sunDir: sunDir.clone(), rotY: skyDef.rotY || 0, bgI, envI, shadows: () => shadowInfo, rebakeShadows: renderSunShadows };
  return {
    scene, colliderScene: colScene, depthScene, bvh, skimBvh, update, hdr: true, stats: bStats,      // [B] depthScene: contract C2
    spawn: new THREE.Vector3(0, terrainHeight(0, 118) + 1.4, 118), yaw: 0,                       // first flight: the reveal
    takeStart: { pos: new THREE.Vector3(...site.takeStart.pos), yaw: site.takeStart.yaw },      // take retries: over the chimney mouth
    startPoints: site.startPoints.map((s) => ({ name: s.name, pos: new THREE.Vector3(...s.pos), yaw: s.yaw, ...(s.hint ? { hint: s.hint } : {}) })),   // START AT (C1)
    funnels: site.funnels,                                                                      // dive assist axes (C1, stream E)
    lines: site.lines,
    bounds: new THREE.Box3(new THREE.Vector3(-480, -5, -480), new THREE.Vector3(480, 260, 480)),
    envelope: { min: new THREE.Vector3(-440, -2, -440), max: new THREE.Vector3(440, 220, 440) },
    aoUniforms: uniforms.aAO,   // [A1] contract C3
    rebakeShadows: renderSunShadows,   // [A4] re-render the static sun maps after adding/moving a static caster
    grassAt,                           // [G5] contract C7: grass height (m) at x, z (prop strikes in main.js)
  };
}

// ---------------------------------------------------------------- [S0] the engine, bound to this site
// weathering GLSL with bando's open silo caps (graphics #3) and the graffiti atlas grid; the light bake kit reads MATS,
// terrainHeight and the track paths (identical text and numbers to the pre-split module: bando stays bit-exact)
const GLSL_WEATHER = glslWeather(`  // [G5] the open silo caps (graphics #3: "marble", L82 C5): 20 % darker, a sooty tide band at the parapet foot,
  // ragged tide rings where water stood and dried, darker round the filling hatch
  { float cd = 9.0;
    ${SILO.x.map((x) => `cd = min(cd, length(wp.xz - vec2(${x.toFixed(2)}, ${SILO.z[0].toFixed(1)})));`).join(' ')}
    float cap = up * (1.0 - step(0.3, abs(wp.y - ${SILO.top.toFixed(1)}))) * (1.0 - step(${(SILO.r - SILO.rim.wall + 0.05).toFixed(2)}, cd));
    float ns = vn(wp.xz * 1.3 + 2.0), soot = smoothstep(2.6, 3.8, cd + (ns - 0.5) * 0.7);
    float tr = abs(fract(cd * 0.75 + vn(wp.xz * 0.6) * 0.5) - 0.5), ring = (1.0 - smoothstep(0.02, 0.07, tr)) * smoothstep(0.3, 0.6, vn(wp.xz * 0.4 + 9.0));
    c *= mix(1.0, 0.8 * (1.0 - 0.5 * soot) * (1.0 - 0.22 * ring) * (0.85 + 0.3 * ns), cap); }
`);
const WP_FRAG = wpFrag(GCOLS, GROWS);
const weatherPatch = makeWeatherPatch({ GLSL_WEATHER, WP_FRAG });
const { albedoOf, groundAlbedo, lightProbe, bakeLight, lmProbeBake, setBake } = siteBake({ MATS, terrainHeight, distToPaths });
export { bakeLight };
