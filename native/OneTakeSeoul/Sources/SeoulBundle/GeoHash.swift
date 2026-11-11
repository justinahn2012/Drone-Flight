// GeoHash "mm3x2/1" (geohash.js): two MurmurHash3_x86_32 body lanes over a uint32 word stream. UNTESTED (no toolchain
// here); Tests/SeoulBundleTests holds vectors computed by geohash.js.
public struct GeoHash {
    var a: UInt32 = 0x9747b28c, b: UInt32 = 0x2f0f5d1b, n: UInt32 = 0
    public init() {}
    @inline(__always) static func rotl(_ x: UInt32, _ r: UInt32) -> UInt32 { (x << r) | (x >> (32 - r)) }
    @inline(__always) static func fmix(_ h0: UInt32) -> UInt32 {
        var h = h0; h ^= h >> 16; h = h &* 0x85ebca6b; h ^= h >> 13; h = h &* 0xc2b2ae35; h ^= h >> 16; return h
    }
    @discardableResult public mutating func word(_ w: UInt32) -> GeoHash {
        var k = w &* 0xcc9e2d51; k = GeoHash.rotl(k, 15); k = k &* 0x1b873593
        a ^= k; a = GeoHash.rotl(a, 13); a = a &* 5 &+ 0xe6546b64
        b ^= k; b = GeoHash.rotl(b, 13); b = b &* 5 &+ 0xe6546b64
        n &+= 1; return self
    }
    /// A string: its length, then each UTF-16 code unit (as JS charCodeAt).
    @discardableResult public mutating func str(_ s: String) -> GeoHash {
        let u = Array(s.utf16); word(UInt32(u.count)); for c in u { word(UInt32(c)) }; return self
    }
    /// A Float32 array: its count, then each value's IEEE-754 bit pattern.
    @discardableResult public mutating func floats(_ f: UnsafeBufferPointer<Float>) -> GeoHash {
        word(UInt32(f.count)); for v in f { word(v.bitPattern) }; return self
    }
    @discardableResult public mutating func uints(_ u: [UInt32]) -> GeoHash { word(UInt32(u.count)); for v in u { word(v) }; return self }
    public func hex() -> String {
        let x = GeoHash.fmix(a ^ n), y = GeoHash.fmix(b ^ n)
        func h8(_ v: UInt32) -> String { let s = String(v, radix: 16); return String(repeating: "0", count: 8 - s.count) + s }
        return h8(x) + h8(y)
    }
}
