// [P7 H, panel6 native #2] The first Metal frame: the Seoul export drawn by Metal, headless (no window, no drawable).
// world.glb's opaque meshes (meshopt-decoded, as the parity tests decode them), the height rules (Visibility.swift: at
// street height dr_roof is not drawn), and the night lightmap (NightLM: the browser's own file, uploaded as
// MTLPixelFormat.rgb9e5Float, sampled with the browser's ground lookup, seoul-light.js cityLightmap). Two targets:
// scene-linear radiance (rgba32Float) and the world position with a ground flag, so a test can check, pixel by pixel, that
// what Metal drew is the lightmap the browser reads at the same world point (MetalFrameTests).
// Not yet: wall rects of the lightmap (the edge raster in light/records.bin), emitters, signs, KTX2 -> ASTC maps, the grade
// and the EDR output. PARITY.md section 4 orders them.
#if canImport(Metal)
import Foundation
import Metal
import simd

public struct MetalFrame {
    public let width: Int, height: Int
    public let radiance: [SIMD4<Float>]   // rgb scene-linear (irradiance x albedo), a = 1 where geometry was drawn
    public let world: [SIMD4<Float>]      // xyz world position, w = k + 1 where the ground lightmap lit the pixel of drawn[k]
    public let albedo: [String: SIMD3<Float>]
    public let drawn: [String], hidden: [String]
    public let device: String

    /// The city's opaque shader: flat normals from the world position, the ground lightmap (up-facing below 0.6 m, as
    /// seoul-light.js cityLightmap), a constant ambient elsewhere.
    static let msl = """
    #include <metal_stdlib>
    using namespace metal;
    struct U { float4x4 vp; float4 cam; float4 lmG; float4 lm; float4 lmA; float4 albedo; float4 amb; };
    struct VOut { float4 pos [[position]]; float3 wp; };
    vertex VOut vmain(uint vid [[vertex_id]], const device packed_float3* P [[buffer(0)]], constant U& u [[buffer(1)]]) {
      VOut o; float3 p = float3(P[vid]); o.wp = p; o.pos = u.vp * float4(p, 1.0); return o;
    }
    struct FOut { float4 c [[color(0)]]; float4 w [[color(1)]]; };
    fragment FOut fmain(VOut in [[stage_in]], constant U& u [[buffer(1)]], texture2d<float> lm [[texture(0)]], sampler s [[sampler(0)]]) {
      float3 n = normalize(cross(dfdx(in.wp), dfdy(in.wp)));
      if (dot(n, in.wp - u.cam.xyz) > 0.0) n = -n;
      float3 E = u.amb.rgb; float g = 0.0;
      if (u.lm.x > 0.5 && n.y > 0.7 && in.wp.y < 0.6) {
        float2 uv = (in.wp.xz - u.lmG.xy) / u.lm.y / u.lmA.xy;
        E = lm.sample(s, uv).rgb; g = 1.0;
      }
      FOut o; o.c = float4(E * u.albedo.rgb, 1.0); o.w = float4(in.wp, g * (u.amb.w + 1.0)); return o;
    }
    """

    public enum MetalError: Error { case noDevice, shader(String), lightmap(String), command(String) }

    /// Draws the bundle from an eye at `eye` (metres, world), yaw / pitch in degrees (three.js: yaw 0 looks along -Z,
    /// pitch up positive), vertical field of view `fovY` degrees.
    public static func render(_ b: SeoulBundle, eye: SIMD3<Float>, yaw: Float, pitch: Float, fovY: Float = 70,
                              width: Int = 320, height: Int = 180, ambient: SIMD3<Float> = SIMD3(0.02, 0.02, 0.025)) throws -> MetalFrame {
        guard let dev = MTLCreateSystemDefaultDevice(), let q = dev.makeCommandQueue() else { throw MetalError.noDevice }
        let lib: MTLLibrary
        do { lib = try dev.makeLibrary(source: msl, options: nil) } catch { throw MetalError.shader("\(error)") }
        let pd = MTLRenderPipelineDescriptor()
        pd.vertexFunction = lib.makeFunction(name: "vmain"); pd.fragmentFunction = lib.makeFunction(name: "fmain")
        pd.colorAttachments[0].pixelFormat = .rgba32Float; pd.colorAttachments[1].pixelFormat = .rgba32Float
        pd.depthAttachmentPixelFormat = .depth32Float
        let pipe: MTLRenderPipelineState
        do { pipe = try dev.makeRenderPipelineState(descriptor: pd) } catch { throw MetalError.shader("\(error)") }
        let dd = MTLDepthStencilDescriptor(); dd.depthCompareFunction = .less; dd.isDepthWriteEnabled = true
        let depthState = dev.makeDepthStencilState(descriptor: dd)!

        // the night lightmap: the shipped file, key-checked, RGB9E5 texels as stored (rows bottom-up = v up, as GL)
        let L = (try JSONSerialization.jsonObject(with: b.data("light.json")) as! [String: Any])["lightmap"] as! [String: Any]
        guard let file = L["file"] as? String, let key = L["key"] as? String, let U = L["uniforms"] as? [String: [Double]],
              let G = U["uCityLMG"], let LM = U["uCityLM"], let A = U["uCityLMA"] else { throw MetalError.lightmap("light.json lightmap has no file / key / uniforms") }
        let nlm = try NightLM(b.data(file), key: key)
        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgb9e5Float, width: nlm.width, height: nlm.height, mipmapped: false)
        td.usage = .shaderRead
        guard let lmTex = dev.makeTexture(descriptor: td) else { throw MetalError.lightmap("no rgb9e5Float texture") }
        nlm.texels.withUnsafeBytes { lmTex.replace(region: MTLRegionMake2D(0, 0, nlm.width, nlm.height), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: nlm.width * 4) }
        let sd = MTLSamplerDescriptor(); sd.minFilter = .linear; sd.magFilter = .linear; sd.sAddressMode = .clampToEdge; sd.tAddressMode = .clampToEdge
        let samp = dev.makeSamplerState(descriptor: sd)!

        // targets
        func target(_ f: MTLPixelFormat) -> MTLTexture {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: f, width: width, height: height, mipmapped: false)
            d.usage = [.renderTarget]; d.storageMode = .private; return dev.makeTexture(descriptor: d)!
        }
        let tc = target(.rgba32Float), tw = target(.rgba32Float), tdep = target(.depth32Float)
        let rp = MTLRenderPassDescriptor()
        rp.colorAttachments[0].texture = tc; rp.colorAttachments[0].loadAction = .clear; rp.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0); rp.colorAttachments[0].storeAction = .store
        rp.colorAttachments[1].texture = tw; rp.colorAttachments[1].loadAction = .clear; rp.colorAttachments[1].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0); rp.colorAttachments[1].storeAction = .store
        rp.depthAttachment.texture = tdep; rp.depthAttachment.loadAction = .clear; rp.depthAttachment.clearDepth = 1; rp.depthAttachment.storeAction = .dontCare

        // camera: three.js convention (right-handed, -Z forward), Metal clip z in [0, 1]
        let rad = Float.pi / 180, cy = cos(yaw * rad), sy = sin(yaw * rad), cp = cos(pitch * rad), spp = sin(pitch * rad)
        let fwd = SIMD3<Float>(-sy * cp, spp, -cy * cp), right = simd_normalize(simd_cross(fwd, SIMD3(0, 1, 0))), up = simd_cross(right, fwd)
        let view = simd_float4x4(rows: [SIMD4(right, -simd_dot(right, eye)), SIMD4(up, -simd_dot(up, eye)), SIMD4(-fwd, simd_dot(fwd, eye)), SIMD4(0, 0, 0, 1)])
        let n: Float = 0.05, f: Float = 3000, t = 1 / tan(fovY * rad / 2), asp = Float(width) / Float(height)
        let proj = simd_float4x4(rows: [SIMD4(t / asp, 0, 0, 0), SIMD4(0, t, 0, 0), SIMD4(0, 0, f / (n - f), n * f / (n - f)), SIMD4(0, 0, -1, 0)])
        struct Uni { var vp: simd_float4x4; var cam: SIMD4<Float>; var lmG: SIMD4<Float>; var lm: SIMD4<Float>; var lmA: SIMD4<Float>; var albedo: SIMD4<Float>; var amb: SIMD4<Float> }
        let v4 = { (a: [Double]) in SIMD4<Float>(Float(a[0]), Float(a[1]), Float(a[2]), Float(a[3])) }

        // meshes: every opaque one (no decals, no transparency); height rules applied at the eye's Y
        var g = try GLB(b.data("world.glb"))
        let rows = b.world["meshes"] as! [[String: Any]], mats = b.world["materials"] as? [String: [String: Any]] ?? [:]
        let rules = b.heightRules()
        guard let cb = q.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: rp) else { throw MetalError.command("encoder") }
        enc.setRenderPipelineState(pipe); enc.setDepthStencilState(depthState); enc.setCullMode(.none)
        enc.setFragmentTexture(lmTex, index: 0); enc.setFragmentSamplerState(samp, index: 0)
        var drawn: [String] = [], hidden: [String] = [], alb: [String: SIMD3<Float>] = [:], keep: [MTLBuffer] = []
        for (i, r) in rows.enumerated() {
            let name = r["name"] as! String, m = mats[r["material"] as? String ?? name] ?? [:]
            if m["decal"] != nil || (m["transparent"] as? Bool) == true || !SeoulBundle.drawn(rules[name], cameraY: Double(eye.y)) { hidden.append(name); continue }
            let (pos, idx) = try g.positionsAndIndex(mesh: i)
            guard let I = idx, !I.isEmpty, let vb = dev.makeBuffer(bytes: pos, length: pos.count * 4, options: .storageModeShared),
                  let ib = dev.makeBuffer(bytes: I, length: I.count * 4, options: .storageModeShared) else { continue }
            keep += [vb, ib]
            let a = (m["albedo"] as? [Double]) ?? [0.3, 0.29, 0.27], av = SIMD3<Float>(Float(a[0]), Float(a[1]), Float(a[2]))
            alb[name] = av
            var u = Uni(vp: proj * view, cam: SIMD4(eye, 1), lmG: v4(G), lm: v4(LM), lmA: v4(A), albedo: SIMD4(av, 1), amb: SIMD4(ambient, Float(drawn.count)))
            enc.setVertexBuffer(vb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<Uni>.stride, index: 1); enc.setFragmentBytes(&u, length: MemoryLayout<Uni>.stride, index: 1)
            enc.drawIndexedPrimitives(type: .triangle, indexCount: I.count, indexType: .uint32, indexBuffer: ib, indexBufferOffset: 0)
            drawn.append(name)
        }
        enc.endEncoding()
        let bytes = width * height * 16
        let oc = dev.makeBuffer(length: bytes, options: .storageModeShared)!, ow = dev.makeBuffer(length: bytes, options: .storageModeShared)!
        let bl = cb.makeBlitCommandEncoder()!
        for (tex, buf) in [(tc, oc), (tw, ow)] {
            bl.copy(from: tex, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: width, height: height, depth: 1),
                    to: buf, destinationOffset: 0, destinationBytesPerRow: width * 16, destinationBytesPerImage: bytes)
        }
        bl.endEncoding()
        cb.commit(); cb.waitUntilCompleted()
        if let e = cb.error { throw MetalError.command("\(e)") }
        let read = { (buf: MTLBuffer) in Array(UnsafeBufferPointer(start: buf.contents().bindMemory(to: SIMD4<Float>.self, capacity: width * height), count: width * height)) }
        _ = keep
        return MetalFrame(width: width, height: height, radiance: read(oc), world: read(ow), albedo: alb, drawn: drawn, hidden: hidden, device: dev.name)
    }

    /// CPU reference for one ground point: the browser's lookup (uv = (xz - G.xy) / gres / atlas), bilinear as GL / Metal
    /// filter it (texel centres at +0.5, clamp to edge), RGB9E5 decoded as NightLM.rgb.
    public static func lightmapAt(_ nlm: NightLM, G: [Double], LM: [Double], A: [Double], x: Double, z: Double) -> SIMD3<Float> {
        let u = (x - G[0]) / LM[1] / A[0], v = (z - G[1]) / LM[1] / A[1]
        let fx = u * Double(nlm.width) - 0.5, fy = v * Double(nlm.height) - 0.5
        let x0 = Int(floor(fx)), y0 = Int(floor(fy)), ax = Float(fx - floor(fx)), ay = Float(fy - floor(fy))
        func t(_ i: Int, _ j: Int) -> SIMD3<Float> {
            let ci = min(max(i, 0), nlm.width - 1), cj = min(max(j, 0), nlm.height - 1)
            let (r, g, b) = NightLM.rgb(nlm.texels[cj * nlm.width + ci]); return SIMD3(r, g, b)
        }
        let top = t(x0, y0) * (1 - ax) + t(x0 + 1, y0) * ax, bot = t(x0, y0 + 1) * (1 - ax) + t(x0 + 1, y0 + 1) * ax
        return top * (1 - ay) + bot * ay
    }

    /// A viewable PNG-ready 8-bit sRGB frame: exposure set so the median drawn luminance lands at 0.18, Reinhard, sRGB.
    public func rgba8() -> [UInt8] {
        let lum = radiance.filter { $0.w > 0 }.map { 0.2126 * $0.x + 0.7152 * $0.y + 0.0722 * $0.z }.sorted()
        let k = lum.isEmpty ? 1 : 0.18 / max(lum[lum.count / 2], 1e-6)
        var out = [UInt8](repeating: 255, count: width * height * 4)
        for (i, c) in radiance.enumerated() {
            for ch in 0 ..< 3 {
                let x = c[ch] * k, y = x / (1 + x), s = y <= 0.0031308 ? 12.92 * y : 1.055 * pow(y, 1 / 2.4) - 0.055
                out[i * 4 + ch] = UInt8(max(0, min(255, (s * 255).rounded())))
            }
        }
        return out
    }
}
#endif
