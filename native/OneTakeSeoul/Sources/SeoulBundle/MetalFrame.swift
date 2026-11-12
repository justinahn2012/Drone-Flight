// The Metal frame: the Seoul export drawn by Metal, headless (no window, no drawable), toward the browser's still.
// [P7 H, panel6 native #2] world.glb's opaque meshes (meshopt-decoded, as the parity tests decode them), the height rules
// (Visibility.swift: at street height dr_roof is not drawn), the night lightmap's ground (NightLM: the browser's own file,
// MTLPixelFormat.rgb9e5Float, the browser's ground lookup).
// [P8 H, panel7 native #2, PARITY section 4 in order]
//   walls     the lightmap's wall rects: the 1 m edge raster + edge table of light/records.bin (RGBA32UI), as cityLightmap;
//   materials per-vertex albedo: the layer's world.json albedo (aLay into `layers`) x COLOR_0 (vcol), as the city shader's
//             layer colour x vertex colour (KTX2 -> ASTC maps not yet: the albedo is the layer's measured mean);
//   lights    where the lightmap has no texel, the irradiance volume (light/volume.bin, RGBA16F 3D, E = A max(0, 1 + B.n));
//             radiance = E albedo / pi (three's indirect diffuse). The static records' direct lobes 0-3 and emitters are
//             next (PARITY section 4.2), then signs;
//   sky       not yet (the canyon slot stays black: SKY_AIR is a section 4 item);
//   grade     Grade.swift: the browser's retro-0 night grade at the browser's AE EV, through the fisheye (FisheyeLens).
// Targets (rectilinear, the browser's render frustum: tan half-extents lens.tx, lens.ty): radiance, world position + kind
// (1 ground lightmap, 2 wall lightmap, 3 volume), albedo, normal; MetalFrameTests checks them pixel by pixel against
// CityLight's CPU lookups, then grades the frame and writes it for tools/parity-de.py (Delta E against the browser still).
#if canImport(Metal)
import Foundation
import Metal
import simd

public struct MetalFrame {
    public let width: Int, height: Int            // the rectilinear render
    public let radiance: [SIMD4<Float>]           // rgb scene-linear, a = 1 where geometry was drawn
    public let world: [SIMD4<Float>]              // xyz world position, w = kind (0 sky, 1 ground lightmap, 2 wall lightmap, 3 volume)
    public let albedo: [SIMD4<Float>]             // rgb the pixel's albedo
    public let normal: [SIMD4<Float>]             // xyz the flat world normal (facing the eye)
    public let drawn: [String], hidden: [String]
    public let device: String
    public let lens: FisheyeLens

    static let msl = """
    #include <metal_stdlib>
    using namespace metal;
    struct U { float4x4 vp; float4 cam; float4 lmG; float4 lm; float4 lmA; float4 lmR; float4 grid; float4 dims; float4 h0; float4 h1; };
    struct VOut { float4 pos [[position]]; float3 wp; float3 alb; };
    vertex VOut vmain(uint vid [[vertex_id]], const device packed_float3* P [[buffer(0)]], const device packed_float3* C [[buffer(2)]], constant U& u [[buffer(1)]]) {
      VOut o; float3 p = float3(P[vid]); o.wp = p; o.alb = float3(C[vid]); o.pos = u.vp * float4(p, 1.0); return o;
    }
    struct FOut { float4 c [[color(0)]]; float4 w [[color(1)]]; float4 a [[color(2)]]; float4 n [[color(3)]]; };
    float layerOf(float y, constant U& u) {
      float H[8] = { u.h0.x, u.h0.y, u.h0.z, u.h0.w, u.h1.x, u.h1.y, u.h1.z, u.h1.w };
      for (int k = 0; k < 7; k++) if (y < H[k + 1]) return float(k) + (y - H[k]) / (H[k + 1] - H[k]);
      return 7.0;
    }
    // seoul-light.js cityLightmap
    bool cityLM(float3 wp, float3 n, constant U& u, texture2d<float> lm, texture2d<uint> rec, sampler s, thread float3& E, thread float& kind) {
      if (u.lm.x < 0.5) return false;
      if (n.y > 0.7 && wp.y < 0.6) { E = lm.sample(s, (wp.xz - u.lmG.xy) / u.lm.y / u.lmA.xy).rgb; kind = 1.0; return true; }
      if (abs(n.y) > 0.35) return false;
      int2 rc = int2(floor(wp.xz - u.lmG.xy));
      if (rc.x < 0 || rc.y < 0 || rc.x >= int(u.lmA.z) || rc.y >= int(u.lmA.w)) return false;
      int li = rc.y * int(u.lmA.z) + rc.x, lt = li >> 1;
      uint4 rq = rec.read(uint2(uint(lt & 511), uint(int(u.lmR.y) + (lt >> 9))));
      uint2 ids = (li & 1) == 0 ? rq.xy : rq.zw;
      for (int k = 0; k < 2; k++) {
        uint id = k == 0 ? ids.x : ids.y; if (id == 0u) continue;
        int e = int(id) - 1; uint2 b = uint2(uint((e & 255) * 2), uint(int(u.lmR.x) + (e >> 8)));
        float4 r0 = as_type<float4>(rec.read(b)), r1 = as_type<float4>(rec.read(b + uint2(1, 0)));
        float sg = r1.z < 0.0 ? -1.0 : 1.0, len = abs(r1.z);
        float2 nn = sg * float2(r0.w, -r0.z);
        if (dot(nn, n.xz) < 0.8) continue;
        float2 d = wp.xz - r0.xy; if (abs(dot(d, nn)) > u.lm.w) continue;
        float2 tc = float2(clamp(dot(d, r0.zw), 0.0, len), clamp(wp.y, 0.0, r1.w));
        E = lm.sample(s, (r1.xy + 1.0 + tc / u.lm.z) / u.lmA.xy).rgb; kind = 2.0; return true;
      }
      return false;
    }
    fragment FOut fmain(VOut in [[stage_in]], constant U& u [[buffer(1)]], texture2d<float> lm [[texture(0)]], texture2d<uint> rec [[texture(1)]],
                        texture3d<float> vA [[texture(2)]], texture3d<float> vB [[texture(3)]], sampler s [[sampler(0)]]) {
      float3 n = normalize(cross(dfdx(in.wp), dfdy(in.wp)));
      if (dot(n, in.wp - u.cam.xyz) > 0.0) n = -n;
      float3 E = float3(0.0); float kind = 0.0;
      if (!cityLM(in.wp, n, u, lm, rec, s, E, kind)) {   // seoul-light.js cityIrradiance (no SSAO)
        float3 uvw = float3((in.wp.xz - u.grid.xy) * u.grid.z / u.dims.xy, (max(layerOf(in.wp.y, u), 0.0) + 0.5) / u.dims.z);
        float4 A = vA.sample(s, uvw), B = vB.sample(s, uvw);
        E = A.rgb * max(0.0, 1.0 + dot(B.xyz, n)); kind = 3.0;
      }
      FOut o; o.c = float4(E * in.alb / M_PI_F, 1.0); o.w = float4(in.wp, kind); o.a = float4(in.alb, 1.0); o.n = float4(n, 0.0); return o;
    }
    """

    public enum MetalError: Error { case noDevice, shader(String), lightmap(String), command(String) }

    /// The quaternion three.js builds for tp(): yaw about +Y, then pitch about the local X (degrees).
    public static func quat(yaw: Float, pitch: Float) -> simd_quatf {
        simd_quatf(angle: yaw * .pi / 180, axis: SIMD3(0, 1, 0)) * simd_quatf(angle: pitch * .pi / 180, axis: SIMD3(1, 0, 0))
    }

    /// Draws the bundle from `eye` (metres, world) with the camera orientation `q` (three.js: looks along local -Z), into the
    /// browser's rectilinear render frustum for `lens` (tan half-extents lens.tx x lens.ty), `width` x `height`.
    public static func render(_ b: SeoulBundle, light: CityLight? = nil, eye: SIMD3<Float>, q: simd_quatf, lens: FisheyeLens,
                              width: Int = 640, height: Int = 360) throws -> MetalFrame {
        guard let dev = MTLCreateSystemDefaultDevice(), let cq = dev.makeCommandQueue() else { throw MetalError.noDevice }
        let L = try light ?? CityLight(b)
        let lib: MTLLibrary
        do { lib = try dev.makeLibrary(source: msl, options: nil) } catch { throw MetalError.shader("\(error)") }
        let pd = MTLRenderPipelineDescriptor()
        pd.vertexFunction = lib.makeFunction(name: "vmain"); pd.fragmentFunction = lib.makeFunction(name: "fmain")
        for i in 0 ..< 4 { pd.colorAttachments[i].pixelFormat = .rgba32Float }
        pd.depthAttachmentPixelFormat = .depth32Float
        let pipe: MTLRenderPipelineState
        do { pipe = try dev.makeRenderPipelineState(descriptor: pd) } catch { throw MetalError.shader("\(error)") }
        let dd = MTLDepthStencilDescriptor(); dd.depthCompareFunction = .less; dd.isDepthWriteEnabled = true
        let depthState = dev.makeDepthStencilState(descriptor: dd)!

        // the night lightmap (rows bottom-up = v up, as GL), the records (edge table + raster), the volume (A, B)
        let nlm = L.lm
        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgb9e5Float, width: nlm.width, height: nlm.height, mipmapped: false)
        td.usage = .shaderRead
        guard let lmTex = dev.makeTexture(descriptor: td) else { throw MetalError.lightmap("no rgb9e5Float texture") }
        nlm.texels.withUnsafeBytes { lmTex.replace(region: MTLRegionMake2D(0, 0, nlm.width, nlm.height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: nlm.width * 4) }
        let rh = L.records.count / (L.recW * 4)
        let rd = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Uint, width: L.recW, height: rh, mipmapped: false); rd.usage = .shaderRead
        let recTex = dev.makeTexture(descriptor: rd)!
        L.records.withUnsafeBytes { recTex.replace(region: MTLRegionMake2D(0, 0, L.recW, rh), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: L.recW * 16) }
        func vol(_ h: [UInt16]) -> MTLTexture {
            let d = MTLTextureDescriptor(); d.textureType = .type3D; d.pixelFormat = .rgba16Float; d.width = L.gw; d.height = L.gh; d.depth = L.nl; d.usage = .shaderRead
            let t = dev.makeTexture(descriptor: d)!
            h.withUnsafeBytes { t.replace(region: MTLRegionMake3D(0, 0, 0, L.gw, L.gh, L.nl), mipmapLevel: 0, slice: 0, withBytes: $0.baseAddress!, bytesPerRow: L.gw * 8, bytesPerImage: L.gw * L.gh * 8) }
            return t
        }
        let vA = vol(L.volAHalf), vB = vol(L.volBHalf)
        let sd = MTLSamplerDescriptor(); sd.minFilter = .linear; sd.magFilter = .linear; sd.sAddressMode = .clampToEdge; sd.tAddressMode = .clampToEdge; sd.rAddressMode = .clampToEdge
        let samp = dev.makeSamplerState(descriptor: sd)!

        func target(_ f: MTLPixelFormat) -> MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: f, width: width, height: height, mipmapped: false)
            d.usage = [.renderTarget]; d.storageMode = .private; return dev.makeTexture(descriptor: d)!
        }
        let targets = (0 ..< 4).map { _ in target(.rgba32Float) }, tdep = target(.depth32Float)
        let rp = MTLRenderPassDescriptor()
        for (i, t) in targets.enumerated() {
            rp.colorAttachments[i].texture = t; rp.colorAttachments[i].loadAction = .clear; rp.colorAttachments[i].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0); rp.colorAttachments[i].storeAction = .store
        }
        rp.depthAttachment.texture = tdep; rp.depthAttachment.loadAction = .clear; rp.depthAttachment.clearDepth = 1; rp.depthAttachment.storeAction = .dontCare

        // camera: three.js (right-handed, -Z forward) world -> view = R^T (p - eye); the browser's render frustum, Metal clip z 0..1
        let R = simd_float3x3(q), Rt = R.transpose, t = -(Rt * eye)
        let view = simd_float4x4(columns: (SIMD4(Rt.columns.0, 0), SIMD4(Rt.columns.1, 0), SIMD4(Rt.columns.2, 0), SIMD4(t, 1)))
        let n: Float = 0.04, f: Float = 3000, sx = Float(1 / lens.tx), sy = Float(1 / lens.ty)
        let proj = simd_float4x4(rows: [SIMD4(sx, 0, 0, 0), SIMD4(0, sy, 0, 0), SIMD4(0, 0, f / (n - f), n * f / (n - f)), SIMD4(0, 0, -1, 0)])
        struct Uni { var vp: simd_float4x4; var cam, lmG, lm, lmA, lmR, grid, dims, h0, h1: SIMD4<Float> }
        let v4 = { (a: [Double]) in SIMD4<Float>(Float(a[0]), Float(a[1]), Float(a[2]), Float(a[3])) }
        let H: [Float] = L.heights.map { Float($0) } + Array(repeating: Float(1e9), count: max(0, 8 - L.heights.count))
        var u = Uni(vp: proj * view, cam: SIMD4(eye, 1), lmG: v4(L.G), lm: v4(L.LM), lmA: v4(L.A), lmR: v4(L.R),
                    grid: SIMD4(Float(L.gx0), Float(L.gz0), Float(1 / L.cell), Float(L.cell)), dims: SIMD4(Float(L.gw), Float(L.gh), Float(L.nl), 0),
                    h0: SIMD4(H[0], H[1], H[2], H[3]), h1: SIMD4(H[4], H[5], H[6], H[7]))

        // meshes: every opaque one (no decals, no transparency); height rules applied at the eye's Y
        var g = try GLB(b.data("world.glb"))
        let rows = b.world["meshes"] as! [[String: Any]], mats = b.world["materials"] as? [String: [String: Any]] ?? [:]
        let rules = b.heightRules()
        guard let cb = cq.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { throw MetalError.command("encoder") }
        enc.setRenderPipelineState(pipe); enc.setDepthStencilState(depthState); enc.setCullMode(.none)
        enc.setFragmentTexture(lmTex, index: 0); enc.setFragmentTexture(recTex, index: 1); enc.setFragmentTexture(vA, index: 2); enc.setFragmentTexture(vB, index: 3)
        enc.setFragmentSamplerState(samp, index: 0)
        enc.setVertexBytes(&u, length: MemoryLayout<Uni>.stride, index: 1); enc.setFragmentBytes(&u, length: MemoryLayout<Uni>.stride, index: 1)
        var drawn: [String] = [], hidden: [String] = [], keep: [MTLBuffer] = []
        for (i, r) in rows.enumerated() {
            let name = r["name"] as! String, m = mats[r["material"] as? String ?? name] ?? [:]
            if m["decal"] != nil || (m["transparent"] as? Bool) == true || !SeoulBundle.drawn(rules[name], cameraY: Double(eye.y)) { hidden.append(name); continue }
            let (pos, idx) = try g.positionsAndIndex(mesh: i)
            let alb = try CityMaterials.albedos(&g, mesh: i, row: r, mats: mats, count: pos.count / 3)
            guard let I = idx, !I.isEmpty, let vb = dev.makeBuffer(bytes: pos, length: pos.count * 4, options: .storageModeShared),
                  let ab = dev.makeBuffer(bytes: alb, length: alb.count * 4, options: .storageModeShared),
                  let ib = dev.makeBuffer(bytes: I, length: I.count * 4, options: .storageModeShared) else { continue }
            keep += [vb, ab, ib]
            enc.setVertexBuffer(vb, offset: 0, index: 0); enc.setVertexBuffer(ab, offset: 0, index: 2)
            enc.drawIndexedPrimitives(type: .triangle, indexCount: I.count, indexType: .uint32, indexBuffer: ib, indexBufferOffset: 0)
            drawn.append(name)
        }
        enc.endEncoding()
        let bytes = width * height * 16
        let outs = (0 ..< 4).map { _ in dev.makeBuffer(length: bytes, options: .storageModeShared)! }
        let bl = cb.makeBlitCommandEncoder()!
        for (tex, buf) in zip(targets, outs) {
            bl.copy(from: tex, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: width, height: height, depth: 1),
                    to: buf, destinationOffset: 0, destinationBytesPerRow: width * 16, destinationBytesPerImage: bytes)
        }
        bl.endEncoding()
        cb.commit(); cb.waitUntilCompleted()
        if let e = cb.error { throw MetalError.command("\(e)") }
        let read = { (buf: MTLBuffer) in Array(UnsafeBufferPointer(start: buf.contents().bindMemory(to: SIMD4<Float>.self, capacity: width * height), count: width * height)) }
        _ = keep
        return MetalFrame(width: width, height: height, radiance: read(outs[0]), world: read(outs[1]), albedo: read(outs[2]), normal: read(outs[3]),
                          drawn: drawn, hidden: hidden, device: dev.name, lens: lens)
    }

    /// The browser's still: the frame graded (Grade.swift, retro 0, AE `ev`) through the fisheye at `outW` x `outH`, as
    /// RGBA8 sRGB, rows top-down; alpha 255 where all four bilinear taps hit geometry (tools/parity-de.py's mask), else 0.
    public func graded(_ grade: NightGrade, ev: Float, outW: Int = 320, outH: Int = 180) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: outW * outH * 4)
        for y in 0 ..< outH {
            for x in 0 ..< outW {
                let m = lens.map(u: (Double(x) + 0.5) / Double(outW), v: 1 - (Double(y) + 0.5) / Double(outH))
                // render rows are top-down (Metal); uv y up
                let fx = m.u * Double(width) - 0.5, fy = (1 - m.v) * Double(height) - 0.5
                let x0 = Int(floor(fx)), y0 = Int(floor(fy)), ax = Float(fx - floor(fx)), ay = Float(fy - floor(fy))
                var c = SIMD4<Float>(0, 0, 0, 0), all = true
                for (dx, dy, w) in [(0, 0, (1 - ax) * (1 - ay)), (1, 0, ax * (1 - ay)), (0, 1, (1 - ax) * ay), (1, 1, ax * ay)] {
                    let xi = min(max(x0 + dx, 0), width - 1), yi = min(max(y0 + dy, 0), height - 1), p = radiance[yi * width + xi]
                    c += p * w; if p.w <= 0 { all = false }
                }
                let o = grade.apply(SIMD3(c.x, c.y, c.z), ev: ev, theta: Float(m.theta)), i = (y * outW + x) * 4
                out[i] = UInt8(max(0, min(255, (o.x * 255).rounded()))); out[i + 1] = UInt8(max(0, min(255, (o.y * 255).rounded())))
                out[i + 2] = UInt8(max(0, min(255, (o.z * 255).rounded()))); out[i + 3] = all ? 255 : 0
            }
        }
        return out
    }
}
#endif
