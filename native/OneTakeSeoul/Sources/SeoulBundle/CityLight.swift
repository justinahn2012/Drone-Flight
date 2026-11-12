// [P8 H, panel7 native #2: PARITY section 4 "walls" and the light step] The static city light the browser's opaque shader
// reads (seoul-light.js CITY_HEAD), on the CPU, bit-for-bit the same lookups: the Metal frame's shader does them on the GPU
// and MetalFrameTests checks its pixels against these functions.
//   - cityLightmap(): ground (up-facing below 0.6 m) from the atlas origin; walls from the 1 m raster of the two nearest
//     exposed footprint edges and the edge table (rows uCityLMR.x / .y of light/records.bin, RGBA32UI, 512 wide), the
//     edge whose outward normal matches, then its wall rect in the atlas (bilinear, as GL samples RGB9E5).
//   - cityIrradiance(): the irradiance volume (light/volume.bin, RGBA16F [cz][cx][layer][4], A then B) where the
//     lightmap has no texel: E(n) = A.rgb max(0, 1 + B.xyz . n), trilinear, layers at light.json VOLUME.heights.
// Radiance (three's indirect diffuse) = E x albedo / pi; SSAO and the wet floor's mirror are not ported (PARITY section 4).
import Foundation

public struct CityLight {
    public let lm: NightLM
    public let G: [Double], LM: [Double], A: [Double], R: [Double]   // uCityLMG, uCityLM, uCityLMA, uCityLMR
    public let records: [UInt32]                                      // light/records.bin decoded: RGBA32UI texels, 512 wide
    public let recW = 512
    public let volA: [Float], volB: [Float]                           // x = cx fastest, then cz, then layer (as the browser's Data3DTexture)
    public let volAHalf: [UInt16], volBHalf: [UInt16]                 // the same texels as stored (RGBA16F upload)
    public let gw: Int, gh: Int, nl: Int
    public let gx0: Double, gz0: Double, cell: Double, heights: [Double]

    public enum CityLightError: Error { case light(String) }

    public init(_ b: SeoulBundle) throws {
        let J = try JSONSerialization.jsonObject(with: b.data("light.json")) as! [String: Any]
        guard let L = J["lightmap"] as? [String: Any], let file = L["file"] as? String, let U = L["uniforms"] as? [String: [Double]],
              let g = U["uCityLMG"], let m = U["uCityLM"], let a = U["uCityLMA"], let r = U["uCityLMR"] else { throw CityLightError.light("light.json lightmap") }
        lm = try NightLM(b.data(file), key: L["key"] as? String); G = g; LM = m; A = a; R = r
        let rd = try b.unpacked("light/records.bin")
        records = rd.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
        guard let V = J["volume"] as? [String: Any], let dims = V["dims"] as? [Int], let hs = V["heights"] as? [Double],
              let VA = V["A"] as? [String: Int], let VB = V["B"] as? [String: Int], let grid = J["grid"] as? [String: Any] else { throw CityLightError.light("light.json volume / grid") }
        gw = dims[0]; gh = dims[1]; nl = dims[2]; heights = hs
        gx0 = (grid["x0"] as! NSNumber).doubleValue; gz0 = (grid["z0"] as! NSNumber).doubleValue; cell = (grid["cell"] as! NSNumber).doubleValue
        let vd = [UInt8](try b.unpacked(V["file"] as? String ?? "light/volume.bin"))
        func block(_ off: Int) -> [UInt16] {   // [cz][cx][k][4] halves -> [k][cz][cx][4] (x = cx fastest)
            var o = [UInt16](repeating: 0, count: dims[0] * dims[1] * dims[2] * 4)
            for cz in 0 ..< dims[1] { for cx in 0 ..< dims[0] { for k in 0 ..< dims[2] { for j in 0 ..< 4 {
                let s = off + (((cz * dims[0] + cx) * dims[2] + k) * 4 + j) * 2
                o[((k * dims[1] + cz) * dims[0] + cx) * 4 + j] = UInt16(vd[s]) | UInt16(vd[s + 1]) << 8
            } } } }
            return o
        }
        volAHalf = block(VA["byteOffset"]!); volBHalf = block(VB["byteOffset"]!)
        volA = volAHalf.map(CityLight.half); volB = volBHalf.map(CityLight.half)
    }

    /// IEEE half -> float (no Float16: unavailable on some hosts)
    public static func half(_ h: UInt16) -> Float {
        let s: Float = (h & 0x8000) != 0 ? -1 : 1, e = Int((h >> 10) & 0x1f), f = Float(h & 0x3ff)
        if e == 0 { return s * f * pow(2, -24) }
        if e == 31 { return f == 0 ? s * .infinity : .nan }
        return s * (1 + f / 1024) * pow(2, Float(e - 15))
    }

    /// The atlas sampled as GL / Metal sample it: normalized uv, bilinear, texel centres at +0.5, clamp to edge.
    public func atlas(u: Double, v: Double) -> SIMD3<Float> {
        let fx = u * Double(lm.width) - 0.5, fy = v * Double(lm.height) - 0.5
        let x0 = Int(floor(fx)), y0 = Int(floor(fy)), ax = Float(fx - floor(fx)), ay = Float(fy - floor(fy))
        func t(_ i: Int, _ j: Int) -> SIMD3<Float> {
            let ci = min(max(i, 0), lm.width - 1), cj = min(max(j, 0), lm.height - 1)
            let (r, g, b) = NightLM.rgb(lm.texels[cj * lm.width + ci]); return SIMD3(r, g, b)
        }
        let top = t(x0, y0) * (1 - ax) + t(x0 + 1, y0) * ax, bot = t(x0, y0 + 1) * (1 - ax) + t(x0 + 1, y0 + 1) * ax
        return top * (1 - ay) + bot * ay
    }

    @inline(__always) func texel(_ x: Int, _ y: Int) -> SIMD4<UInt32> {
        let o = (y * recW + x) * 4; return SIMD4(records[o], records[o + 1], records[o + 2], records[o + 3])
    }

    /// seoul-light.js cityLightmap(wp, nW): the lightmap irradiance at a world point with world normal n, or nil (= the volume).
    public func lightmap(_ p: SIMD3<Double>, _ n: SIMD3<Double>) -> SIMD3<Float>? {
        guard LM[0] > 0.5 else { return nil }
        if n.y > 0.7 && p.y < 0.6 { return atlas(u: (p.x - G[0]) / LM[1] / A[0], v: (p.z - G[1]) / LM[1] / A[1]) }
        if abs(n.y) > 0.35 { return nil }
        let rx = Int(floor(p.x - G[0])), rz = Int(floor(p.z - G[1]))
        if rx < 0 || rz < 0 || rx >= Int(A[2]) || rz >= Int(A[3]) { return nil }
        let li = rz * Int(A[2]) + rx, lt = li >> 1
        let rq = texel(lt & 511, Int(R[1]) + (lt >> 9)), ids = (li & 1) == 0 ? (rq.x, rq.y) : (rq.z, rq.w)
        for id in [ids.0, ids.1] where id != 0 {
            let e = Int(id) - 1, bx = (e & 255) * 2, by = Int(R[0]) + (e >> 8)
            let t0 = texel(bx, by), t1 = texel(bx + 1, by)
            let r0 = SIMD4<Double>(Double(Float(bitPattern: t0.x)), Double(Float(bitPattern: t0.y)), Double(Float(bitPattern: t0.z)), Double(Float(bitPattern: t0.w)))
            let r1 = SIMD4<Double>(Double(Float(bitPattern: t1.x)), Double(Float(bitPattern: t1.y)), Double(Float(bitPattern: t1.z)), Double(Float(bitPattern: t1.w)))
            let sg: Double = r1.z < 0 ? -1 : 1, len = abs(r1.z)
            let nx = sg * r0.w, nz = sg * -r0.z
            if nx * n.x + nz * n.z < 0.8 { continue }
            let dx = p.x - r0.x, dz = p.z - r0.y
            if abs(dx * nx + dz * nz) > LM[3] { continue }
            let tcx = min(max(dx * r0.z + dz * r0.w, 0), len), tcy = min(max(p.y, 0), r1.w)
            return atlas(u: (r1.x + 1 + tcx / LM[2]) / A[0], v: (r1.y + 1 + tcy / LM[2]) / A[1])
        }
        return nil
    }

    /// seoul-light.js cityLayer(y): the fractional probe layer.
    public func layer(_ y: Double) -> Double {
        for k in 0 ..< heights.count - 1 where y < heights[k + 1] { return Double(k) + (y - heights[k]) / (heights[k + 1] - heights[k]) }
        return Double(heights.count - 1)
    }

    /// seoul-light.js cityIrradiance(wp, nW) without SSAO (uCityIrrGain 1): trilinear over (cx, cz, layer), clamp to edge.
    public func irradiance(_ p: SIMD3<Double>, _ n: SIMD3<Double>) -> SIMD3<Float> {
        let ly = max(layer(p.y), 0)
        let u = (p.x - gx0) / cell, v = (p.z - gz0) / cell, w = ly + 0.5   // in texels (uvw x dims)
        func samp(_ vol: [Float]) -> SIMD4<Float> {
            let fx = u - 0.5, fy = v - 0.5, fz = w - 0.5
            let x0 = Int(floor(fx)), y0 = Int(floor(fy)), z0 = Int(floor(fz))
            let ax = Float(fx - floor(fx)), ay = Float(fy - floor(fy)), az = Float(fz - floor(fz))
            func t(_ i: Int, _ j: Int, _ k: Int) -> SIMD4<Float> {
                let ci = min(max(i, 0), gw - 1), cj = min(max(j, 0), gh - 1), ck = min(max(k, 0), nl - 1), o = ((ck * gh + cj) * gw + ci) * 4
                return SIMD4(vol[o], vol[o + 1], vol[o + 2], vol[o + 3])
            }
            func plane(_ k: Int) -> SIMD4<Float> {
                let a = t(x0, y0, k) * (1 - ax) + t(x0 + 1, y0, k) * ax, b = t(x0, y0 + 1, k) * (1 - ax) + t(x0 + 1, y0 + 1, k) * ax
                return a * (1 - ay) + b * ay
            }
            return plane(z0) * (1 - az) + plane(z0 + 1) * az
        }
        let a = samp(volA), b = samp(volB)
        let k = max(0, 1 + b.x * Float(n.x) + b.y * Float(n.y) + b.z * Float(n.z))
        return SIMD3(a.x, a.y, a.z) * k
    }

    /// What the browser's opaque city shader takes as indirect irradiance at a point: the lightmap, else the volume.
    public func cityE(_ p: SIMD3<Double>, _ n: SIMD3<Double>) -> (E: SIMD3<Float>, kind: Int) {
        if let e = lightmap(p, n) { return (e, n.y > 0.7 && p.y < 0.6 ? 1 : 2) }
        return (irradiance(p, n), 3)
    }
}

/// [P8 H, PARITY section 4 "materials"] The city shader's diffuse without its KTX2 maps: the layer's world.json albedo (the
/// layer texture's measured mean x its colour) selected by aLay, x the vertex colour when the material has vcol.
public enum CityMaterials {
    /// Per-vertex albedo of mesh row `r`: world.json albedo of its layer (aLay) or its material, x COLOR_0 when vcol.
    public static func albedos(_ g: inout GLB, mesh i: Int, row r: [String: Any], mats: [String: [String: Any]], count: Int) throws -> [Float] {
        let m = mats[r["material"] as? String ?? (r["name"] as! String)] ?? [:]
        func alb(_ x: [String: Any]?) -> SIMD3<Float>? { (x?["albedo"] as? [Double]).map { SIMD3(Float($0[0]), Float($0[1]), Float($0[2])) } }
        let base = alb(m) ?? SIMD3(0.3, 0.29, 0.27)
        let layers = (m["layers"] as? [String])?.map { alb(mats[$0]) ?? base }
        let lay = try (layers != nil ? g.floatAttribute(mesh: i, "_ALAY") : nil)
        let col = try ((m["vcol"] as? Bool) == true ? g.floatAttribute(mesh: i, "COLOR_0") : nil)
        var out = [Float](repeating: 0, count: count * 3)
        for v in 0 ..< count {
            var a = base
            if let L = layers, let l = lay { a = L[min(max(Int(l.vals[v].rounded()), 0), L.count - 1)] }
            if let c = col { a *= SIMD3(c.vals[v * c.comps], c.vals[v * c.comps + 1], c.vals[v * c.comps + 2]) }
            out[v * 3] = a.x; out[v * 3 + 1] = a.y; out[v * 3 + 2] = a.z
        }
        return out
    }

}
