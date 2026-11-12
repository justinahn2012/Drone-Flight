// [P7 H, panel6 native #2] The first Metal frame (Sources/SeoulBundle/MetalFrame.swift), on macOS (CI: native-macos).
// walk0's pose (tests/browser.mjs LEVEL_SHOTS: -36, 3, -23, yaw 0, camera pitch +4): the city's opaque meshes drawn with
// the night lightmap. Checks: Metal compiled the shader and drew the street (>= 60 % of the frame covered); the height
// rule hid dr_roof at 3 m; and every sampled ground pixel's radiance is the browser's lightmap at that pixel's world point
// times the mesh albedo (CPU bilinear of the same RGB9E5 texels, within 3 % + 1e-5): the RGB9E5 upload, the row order and
// the ground lookup match seoul-light.js. ONETAKE_FRAME_OUT=<file.png> writes the frame (CI uploads it).
#if canImport(Metal)
import XCTest
import Metal
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
import simd
@testable import SeoulBundle

final class MetalFrameTests: XCTestCase {
    func testMetalFirstFrame() throws {
        guard let p = ProcessInfo.processInfo.environment["ONETAKE_EXPORT"] else { throw XCTSkip("set ONETAKE_EXPORT to an export directory") }
        guard let dev = MTLCreateSystemDefaultDevice() else {
            if ProcessInfo.processInfo.environment["ONETAKE_METAL_REQUIRED"] == "1" { return XCTFail("no Metal device on this host") }
            print("::warning title=no Metal device::MTLCreateSystemDefaultDevice() is nil on this host: the first-frame test did not run"); return
        }
        print("Metal device: \(dev.name)")
        let b = try SeoulBundle(dir: URL(fileURLWithPath: p))
        let t0 = Date()
        let f = try MetalFrame.render(b, eye: SIMD3(-36, 3, -23), yaw: 0, pitch: 4)
        print("frame \(f.width)x\(f.height) in \(String(format: "%.2f", Date().timeIntervalSince(t0))) s on \(f.device); drawn \(f.drawn), hidden \(f.hidden)")
        let n = f.width * f.height, covered = f.radiance.filter { $0.w > 0 }.count
        XCTAssertGreaterThanOrEqual(Double(covered) / Double(n), 0.6, "walk0 is a street canyon: geometry covers most of the frame")
        XCTAssertTrue(f.hidden.contains("dr_roof"), "the height rule hides the roof props at 3 m")
        XCTAssertFalse(f.drawn.contains("dr_roof"))

        let L = (try JSONSerialization.jsonObject(with: b.data("light.json")) as! [String: Any])["lightmap"] as! [String: Any]
        let U = L["uniforms"] as! [String: [Double]], nlm = try NightLM(b.data(L["file"] as! String), key: L["key"] as? String)
        let ground = (0 ..< n).filter { f.world[$0].w > 0.5 }
        XCTAssertGreaterThanOrEqual(ground.count, n / 50, "the ground lightmap lights the street floor")
        var ok = 0, worst: Float = 0, lit = 0
        let step = max(1, ground.count / 3000)
        let samples = stride(from: 0, to: ground.count, by: step).map { ground[$0] }
        for i in samples {
            let w = f.world[i], mesh = f.drawn[Int(w.w.rounded()) - 1], a = f.albedo[mesh]!
            let want = MetalFrame.lightmapAt(nlm, G: U["uCityLMG"]!, LM: U["uCityLM"]!, A: U["uCityLMA"]!, x: Double(w.x), z: Double(w.z)) * a
            let got = SIMD3(f.radiance[i].x, f.radiance[i].y, f.radiance[i].z)
            let err = abs(got - want).max(), tol = 0.03 * want.max() + 1e-5
            if err <= tol { ok += 1 }; worst = max(worst, err / max(want.max(), 1e-6)); if want.max() > 1e-4 { lit += 1 }
        }
        print("ground pixels \(ground.count), sampled \(samples.count), within 3 %: \(ok), lit \(lit), worst relative error \(worst)")
        XCTAssertGreaterThanOrEqual(Double(ok), 0.99 * Double(samples.count), "Metal's ground radiance = the browser's lightmap lookup")
        XCTAssertGreaterThan(lit, samples.count / 2, "the street floor is lit (not a black lightmap)")

        if let out = ProcessInfo.processInfo.environment["ONETAKE_FRAME_OUT"] {
            let px = f.rgba8(), cs = CGColorSpace(name: CGColorSpace.sRGB)!
            let ctx = px.withUnsafeBytes { CGContext(data: UnsafeMutableRawPointer(mutating: $0.baseAddress!), width: f.width, height: f.height, bitsPerComponent: 8, bytesPerRow: f.width * 4, space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!.makeImage()! }
            let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
            CGImageDestinationAddImage(dst, ctx, nil); XCTAssertTrue(CGImageDestinationFinalize(dst)); print("wrote \(out)")
        }
    }
}
#endif
