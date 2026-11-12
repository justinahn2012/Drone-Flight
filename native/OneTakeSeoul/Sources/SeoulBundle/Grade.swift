// [P8 H, panel7 native #2: PARITY section 4 "grade"] The browser's night grade at retro 0 (fpvcam.js FINAL_FS with NIGHT,
// the path camgate's <shot>.r0.png stills take), per pixel, from the exported look (look.json `resolved`) and the AE's EV
// (stills.json `ev0`): e = lin 2^ev wb; the lens vignette cos(theta)^2.2; contrast about the AE target 0.24; the veil;
// the Lottes 2016 shoulder (nightTone, tonePc); the toe; saturation with the shadow roll-off; sRGB; the display S-curve;
// the lift. And the fisheye: output pixel -> theta -> the rectilinear render's uv (fpvcam.js lensUv, solveLens).
// Not ported (screen-space or stochastic, PARITY section 5): bloom / halo / ghost / airlight lobes, white cores, codec
// blocks, sensor noise, sharpening, CA. The veil uses the AE target (0.24) for the metered mean (the browser reads its meter).
import Foundation

public struct NightGrade {
    public let wb: SIMD3<Float>, wbShade: SIMD3<Float>
    public let con: Float, toe: Float, sat: Float, shSat: Float, lift: Float, vig: Float, veil: Float
    public let a: Float, d: Float, b: Float, c: Float, tonePc: Float

    static func f(_ x: Any?, _ d: Float) -> Float { (x as? NSNumber).map { Float(truncating: $0) } ?? d }
    static func v3(_ x: Any?, _ d: SIMD3<Float>) -> SIMD3<Float> {
        guard let a = x as? [NSNumber], a.count >= 3 else { return d }
        return SIMD3(Float(truncating: a[0]), Float(truncating: a[1]), Float(truncating: a[2]))
    }

    /// `look`: look.json `resolved` (the night look the game set).
    public init(look L: [String: Any]) {
        wb = NightGrade.v3(L["wb"], SIMD3(1, 1, 1)); wbShade = NightGrade.v3(L["wbShade"], wb)
        con = NightGrade.f(L["con"], 1); toe = NightGrade.f(L["toe"], 0); sat = NightGrade.f(L["saturation"], 1)
        shSat = NightGrade.f(L["shadowSat"], 1); lift = NightGrade.f(L["lift"], 0); vig = NightGrade.f(L["vignette"], 0); veil = NightGrade.f(L["veil"], 0)
        let tn = (L["tone"] as? [NSNumber])?.map { Double(truncating: $0) } ?? [1.0839, 0.928, 0.2194]
        let wp = 0.24 * pow(2, (L["clipEv"] as? NSNumber)?.doubleValue ?? 7.5)
        let bc = NightGrade.toneBC(tn[0], tn[1], tn[2], wp)
        a = Float(tn[0]); d = Float(tn[1]); b = Float(bc.0); c = Float(bc.1); tonePc = NightGrade.f(L["tonePc"], 1)
    }

    /// fpvcam.js nightToneBC: x^a / (x^(a d) b + c) passes (0.24, mid) and reaches 1 at the white point.
    public static func toneBC(_ a: Double, _ d: Double, _ mid: Double, _ hdrMax: Double) -> (Double, Double) {
        let mi = 0.24, ad = a * d, den = (pow(hdrMax, ad) - pow(mi, ad)) * mid
        return ((-pow(mi, a) + pow(hdrMax, a) * mid) / den, (pow(hdrMax, ad) * pow(mi, a) - pow(hdrMax, a) * pow(mi, ad) * mid) / den)
    }

    @inline(__always) static func sstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float { let t = min(max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t) }
    @inline(__always) static func luma(_ v: SIMD3<Float>) -> Float { 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z }

    func tone(_ e: SIMD3<Float>) -> SIMD3<Float> {
        let x = simd_max3(e, 0)
        func t1(_ v: Float) -> Float { pow(v, a) / (pow(v, a * d) * b + c) }
        let pc = SIMD3(min(t1(x.x), 1), min(t1(x.y), 1), min(t1(x.z), 1))
        let m = max(max(x.x, max(x.y, x.z)), 1e-8), fm = t1(m)
        return x * (min(fm, 1) / m) * (1 - tonePc) + pc * tonePc
    }

    /// One pixel: scene-linear radiance `lin`, AE `ev`, lens angle `theta` (rad) -> display sRGB 0..1.
    public func apply(_ lin: SIMD3<Float>, ev: Float, theta: Float) -> SIMD3<Float> {
        let s: Float = NightGrade.sstep(1.5, 3, ev)
        let wbm: SIMD3<Float> = wb * (1 - s) + wbShade * s
        let gain: Float = Float(pow(2.0, Double(ev)))
        var e: SIMD3<Float> = lin * wbm * gain
        let cv: Float = Float(pow(Double(max(cos(theta), 0)), 2.2))
        e *= 1 + (cv - 1) * vig
        if con != 1 { let cg: Float = Float(pow(Double(max(NightGrade.luma(e), 1e-6) / 0.24), Double(con - 1))); e *= cg }
        let vt: SIMD3<Float> = SIMD3<Float>(1, 0.99, 0.97) * (veil * 0.24)
        e += vt
        var t = tone(e)
        if toe > 0 { t = t * t / (t + toe) * (1 + toe) }
        let l = NightGrade.luma(t), k = sat * (shSat + (1 - shSat) * NightGrade.sstep(0.01, 0.16, l))
        t = simd_max3(SIMD3(repeating: l) + (t - SIMD3(repeating: l)) * k, 0)
        var o = SIMD3<Float>(NightGrade.srgb(t.x), NightGrade.srgb(t.y), NightGrade.srgb(t.z))
        o = o + (o * o * (3 - 2 * o) - o) * 0.22
        return o * (1 - lift) + SIMD3(repeating: lift)
    }

    public static func srgb(_ c: Float) -> Float { let x = max(c, 0); return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055 }
}

@inline(__always) func simd_max3(_ v: SIMD3<Float>, _ m: Float) -> SIMD3<Float> { SIMD3(max(v.x, m), max(v.y, m), max(v.z, m)) }

/// fpvcam.js solveLens + the final pass's lens lookup: output pixel -> (render uv, theta). `k`, `F`, `hw`, `hh`, `tx`, `ty`
/// as stills.json `cam.lens` records them (or solveLens for the output size).
public struct FisheyeLens {
    public let k: Double, F: Double, hw: Double, hh: Double, tx: Double, ty: Double
    public init(k: Double, F: Double, hw: Double, hh: Double, tx: Double, ty: Double) { self.k = k; self.F = F; self.hw = hw; self.hh = hh; self.tx = tx; self.ty = ty }
    /// solveLens(Ls, outW, outH) for Ls = { thetaS, k } (cornerCapRad 1.16, renderMargin 1.035).
    public init(thetaS: Double, k: Double, width: Int, height: Int) {
        let A = Double(width) / Double(height), hw = A >= 1 ? A : 1, hh = A >= 1 ? 1 : 1 / A, rc = (hw * hw + hh * hh).squareRoot(), thMax = 1.16
        let rect = k > 0.999
        let Fs = rect ? 1 / tan(thetaS) : k / tan(k * thetaS), Fc = rect ? rc / tan(thMax) : rc * k / tan(k * thMax), F = max(Fs, Fc)
        let thc = rect ? atan(rc / F) : atan(rc * k / F) / k, Tc = tan(thc) * 1.035
        self.init(k: k, F: F, hw: hw, hh: hh, tx: Tc * hw / rc, ty: Tc * hh / rc)
    }
    /// uv (0..1, y up as GL) of the output pixel centre -> uv in the rectilinear render (y up) and the lens angle.
    public func map(u: Double, v: Double) -> (u: Double, v: Double, theta: Double) {
        let lx = (u - 0.5) * 2 * hw, ly = (v - 0.5) * 2 * hh, r = (lx * lx + ly * ly).squareRoot()
        let th = k > 0.999 ? atan(r / F) : atan(r * k / F) / k
        let s = r > 1e-5 ? tan(th) / r : 1 / F
        return (0.5 + lx * s * 0.5 / tx, 0.5 + ly * s * 0.5 / ty, th)
    }
}
