// Light-record lobes (seoul-nightlm.js, seoul-light.js LT): the angular shapes the static light records carry in their
// type field. A port's light shader needs every id or those lights go dark. [P6 H, from D's P6 change]
//   0 lambert (area emitters), 1 street (type-II head), 2 beam (low beam), 3 pack (P6: the wall pack's pool lobe).
// light.json `lobes` (seoul-light.js exportParams) carries each lobe's id, solid angle omega and formula; Tests check
// these against vectors from the JS functions.
import Foundation

public enum Lobe: Int { case lambert = 0, street = 1, beam = 2, pack = 3 }

public enum Lobes {
    /// sstep (seoul-nightlm.js): smoothstep clamped to [0, 1]
    @inline(__always) public static func sstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let t = min(1, max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
    }
    /// lobePack (P6, D): a full-cutoff wall pack. (dx, dy, dz) = unit direction from the light to the point, (fx, fz) =
    /// the pack's horizontal forward (out of the wall). Axis 20 deg out from straight down (cos 0.9397, sin 0.342); 0 past
    /// cos 0.42 (~65 deg: the 120 deg cone + a soft edge to 0.58); peak 1 on the axis. Intensity = flux / omega(2.222485 sr) x this.
    /// In the Metal shader: float cityPack(float3 D, float3 f) with the same constants (seoul-light.js cityPack, GLSL).
    public static func pack(_ dx: Double, _ dy: Double, _ dz: Double, _ fx: Double, _ fz: Double) -> Double {
        let c = -dy * 0.9397 + (dx * fx + dz * fz) * 0.342
        if c <= 0.42 { return 0 }
        return (0.3 + 0.7 * c * c) * sstep(0.42, 0.58, c)
    }
    public static let packOmega = 2.222485   // sr: lobeIntegral(lobePack) (seoul-light.js OMEGA.pack)
}
