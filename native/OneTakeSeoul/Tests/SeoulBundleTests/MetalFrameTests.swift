// The Metal frame (Sources/SeoulBundle/MetalFrame.swift) on macOS (CI: native-macos), at the camera that drew the browser's
// walk0 still (ref/walk0.json: stills.json `cam` and `ev0` of the CI run the reference was taken from; without it, the
// tp pose -36, 3, -23, yaw 0, pitch +4). Checks:
//   - Metal compiled and drew the street (>= 60 % of the frame); the height rule hid dr_roof at street height;
//   - [P7 H] ground: every sampled ground pixel's radiance is CityLight's CPU lookup at its world point x albedo / pi
//     (the RGB9E5 upload, the row order, the ground lookup);
//   - [P8 H] walls: the same for the wall-rect pixels (the edge raster and table of light/records.bin);
//   - [P8 H] volume: the same for the pixels the lightmap leaves to the irradiance volume (RGBA16F 3D, trilinear);
//   - [P8 H] the GPU and the CPU pick the same source (ground / wall / volume) for >= 98 % of pixels.
// ONETAKE_FRAME_OUT=<file.png> writes the frame graded as the browser's retro-0 still (Grade.swift, the reference's EV),
// through the fisheye, RGBA (alpha = drawn); CI runs tools/parity-de.py on it against ref/walk0.r0.png.
#if canImport(Metal)
import XCTest
import Metal
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
import simd
@testable import SeoulBundle

final class MetalFrameTests: XCTestCase {
    func testMetalFrame() throws {
        guard let p = ProcessInfo.processInfo.environment["ONETAKE_EXPORT"] else { throw XCTSkip("set ONETAKE_EXPORT to an export directory") }
        guard let dev = MTLCreateSystemDefaultDevice() else {
            if ProcessInfo.processInfo.environment["ONETAKE_METAL_REQUIRED"] == "1" { return XCTFail("no Metal device on this host") }
            print("::warning title=no Metal device::MTLCreateSystemDefaultDevice() is nil on this host: the Metal frame test did not run"); return
        }
        print("Metal device: \(dev.name)")
        let b = try SeoulBundle(dir: URL(fileURLWithPath: p))
        let light = try CityLight(b)

        // the browser's camera for walk0 (ref/walk0.json), else the tp pose
        let refURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("ref/walk0.json")
        let ref = (try? Data(contentsOf: refURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        var eye = SIMD3<Float>(-36, 3, -23), q = MetalFrame.quat(yaw: 0, pitch: 4), ev: Float = -4.24
        var lens = FisheyeLens(thetaS: 50 * .pi / 180, k: 0.28, width: 320, height: 180)
        if let cam = ref?["cam"] as? [String: Any], let pos = cam["pos"] as? [Double], let qu = cam["quat"] as? [Double], let ln = cam["lens"] as? [String: Double] {
            eye = SIMD3(Float(pos[0]), Float(pos[1]), Float(pos[2])); q = simd_quatf(ix: Float(qu[0]), iy: Float(qu[1]), iz: Float(qu[2]), r: Float(qu[3]))
            lens = FisheyeLens(k: ln["k"]!, F: ln["F"]!, hw: ln["hw"]!, hh: ln["hh"]!, tx: ln["tx"]!, ty: ln["ty"]!)
            ev = Float((ref?["ev0"] as? Double) ?? Double(ev))
            print("camera from \(refURL.lastPathComponent) (\(ref?["source"] ?? "?")): eye \(eye), ev0 \(ev)")
        } else { print("::warning title=no parity reference::\(refURL.path) missing: tp pose, EV \(ev)") }

        let t0 = Date()
        let f = try MetalFrame.render(b, light: light, eye: eye, q: q, lens: lens)
        print("frame \(f.width)x\(f.height) in \(String(format: "%.2f", Date().timeIntervalSince(t0))) s on \(f.device); drawn \(f.drawn), hidden \(f.hidden)")
        let n = f.width * f.height, covered = f.radiance.filter { $0.w > 0 }.count
        XCTAssertGreaterThanOrEqual(Double(covered) / Double(n), 0.6, "walk0 is a street canyon: geometry covers most of the frame")
        XCTAssertTrue(f.hidden.contains("dr_roof"), "the height rule hides the roof props at 3 m")
        XCTAssertFalse(f.drawn.contains("dr_roof"))

        // pixel by pixel against the CPU lookups, per source
        var stats: [Int: (n: Int, ok: Int, worst: Float, lit: Int)] = [1: (0, 0, 0, 0), 2: (0, 0, 0, 0), 3: (0, 0, 0, 0)]
        var same = 0, sampled = 0
        for i in stride(from: 0, to: n, by: 7) where f.radiance[i].w > 0 {
            let w = f.world[i], nn = f.normal[i], a = f.albedo[i], kind = Int(w.w.rounded())
            let P = SIMD3<Double>(Double(w.x), Double(w.y), Double(w.z)), N = SIMD3<Double>(Double(nn.x), Double(nn.y), Double(nn.z))
            let cpu = light.cityE(P, N); sampled += 1
            if cpu.kind == kind { same += 1 } else { continue }   // a pixel on a lookup's edge (n.y 0.7 / 0.35, the 1.25 m reach)
            let want = cpu.E * SIMD3(a.x, a.y, a.z) / Float.pi, got = SIMD3(f.radiance[i].x, f.radiance[i].y, f.radiance[i].z)
            let err = abs(got - want).max(), tol = 0.03 * want.max() + 1e-5
            var s = stats[kind]!; s.n += 1; if err <= tol { s.ok += 1 }; s.worst = max(s.worst, err / max(want.max(), 1e-6)); if want.max() > 1e-4 { s.lit += 1 }; stats[kind] = s
        }
        for (k, label) in [(1, "ground"), (2, "wall"), (3, "volume")] {
            let s = stats[k]!
            print("\(label) pixels sampled \(s.n), within 3 %: \(s.ok), lit \(s.lit), worst relative error \(s.worst)")
            XCTAssertGreaterThan(s.n, 50, "walk0 shows \(label) pixels")
            XCTAssertGreaterThanOrEqual(Double(s.ok), 0.98 * Double(s.n), "Metal's \(label) radiance = the browser's lookup x albedo / pi")
            XCTAssertGreaterThan(s.lit, s.n / 2, "the \(label) is lit (not a black lookup)")
        }
        print("source agreement GPU / CPU: \(same) of \(sampled)")
        XCTAssertGreaterThanOrEqual(Double(same), 0.98 * Double(sampled), "the GPU picks the CPU's source (ground / wall / volume)")

        if let out = ProcessInfo.processInfo.environment["ONETAKE_FRAME_OUT"] {
            let look = (try JSONSerialization.jsonObject(with: b.data("look.json")) as! [String: Any])["resolved"] as! [String: Any]
            var px = f.graded(NightGrade(look: look), ev: ev)
            let cs = CGColorSpace(name: CGColorSpace.sRGB)!
            let img = px.withUnsafeMutableBytes { CGContext(data: $0.baseAddress!, width: 320, height: 180, bitsPerComponent: 8, bytesPerRow: 320 * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()! }
            let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
            CGImageDestinationAddImage(dst, img, nil); XCTAssertTrue(CGImageDestinationFinalize(dst)); print("wrote \(out) (graded at EV \(ev); alpha = drawn)")
        }
    }
}
#endif
