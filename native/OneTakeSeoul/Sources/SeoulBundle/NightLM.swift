// The night lightmap the browser ships (seoul/light/night-lm.bin = export light/night-lm.bin): NLM2 header, gzip of the
// RGB9E5 texels as 4 byte planes, each delta-coded along the rows (seoul-nightlm.js lmFile / lmPlanes / lmUnplanes).
// [P6 H, native #2] Used only when its header key equals light.json `lightmap.key` (the game's rule: a stale file
// would light the phone with another build's bake). The texels upload as MTLPixelFormatRGB9E5Float, rows bottom-up.
import Foundation
import CZlib

public struct NightLM {
    public let header: [String: Any]
    public let width: Int, height: Int
    public let texels: [UInt32]   // RGB9E5, little-endian u32, w x h, rows bottom-up as the GL DataTexture

    public enum NLMError: Error { case notNLM2, header, gunzip(Int32), size(Int, Int), staleKey(file: String, want: String) }

    /// Parse + gunzip + un-plane. `key`: light.json lightmap.key; a different file key throws .staleKey.
    public init(_ data: Data, key: String?) throws {
        let u = [UInt8](data)
        guard u.count >= 8, u[0] == 78, u[1] == 76, u[2] == 77, u[3] == 50 else { throw NLMError.notNLM2 }
        let n = Int(u[4]) | Int(u[5]) << 8 | Int(u[6]) << 16 | Int(u[7]) << 24
        guard 8 + n <= u.count, let h = try JSONSerialization.jsonObject(with: Data(u[8 ..< 8 + n])) as? [String: Any],
              let w = h["w"] as? Int, let hh = h["h"] as? Int else { throw NLMError.header }
        if let key, let fk = h["key"] as? String, fk != key { throw NLMError.staleKey(file: fk, want: key) }
        header = h; width = w; height = hh
        let planes = try NightLM.gunzip(Array(u[(8 + n)...]), expected: w * hh * 4)
        guard planes.count == w * hh * 4 else { throw NLMError.size(planes.count, w * hh * 4) }
        texels = NightLM.unplanes(planes, w, hh)
    }

    /// lmUnplanes: plane p holds byte p of every texel, each row delta-coded from 0.
    public static func unplanes(_ P: [UInt8], _ W: Int, _ H: Int) -> [UInt32] {
        let N = W * H; var D = [UInt32](repeating: 0, count: N)
        for p in 0 ..< 4 {
            let o = p * N, sh = UInt32(p * 8)
            for j in 0 ..< H { var prev: UInt8 = 0; for i in 0 ..< W { let k = j * W + i; prev = prev &+ P[o + k]; D[k] |= UInt32(prev) << sh } }
        }
        return D
    }

    /// decodeRGB9E5 (seoul-nightlm.js): 9-bit mantissas, shared exponent bias 15.
    public static func rgb(_ t: UInt32) -> (Float, Float, Float) {
        let sc = Float(pow(2.0, Double(Int(t >> 27) - 15 - 9)))
        return (Float(t & 511) * sc, Float((t >> 9) & 511) * sc, Float((t >> 18) & 511) * sc)
    }

    static func gunzip(_ src: [UInt8], expected: Int) throws -> [UInt8] {
        var out = [UInt8](repeating: 0, count: expected)
        var s = z_stream()
        var rc = inflateInit2_(&s, 16 + 15, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))   // 16 + 15: a gzip wrapper
        guard rc == Z_OK else { throw NLMError.gunzip(rc) }
        defer { inflateEnd(&s) }
        var input = src
        rc = input.withUnsafeMutableBufferPointer { ib in out.withUnsafeMutableBufferPointer { ob in
            s.next_in = ib.baseAddress; s.avail_in = uInt(ib.count)
            s.next_out = ob.baseAddress; s.avail_out = uInt(ob.count)
            return inflate(&s, Z_FINISH)
        } }
        guard rc == Z_STREAM_END else { throw NLMError.gunzip(rc) }
        return Array(out[0 ..< Int(s.total_out)])
    }
}
