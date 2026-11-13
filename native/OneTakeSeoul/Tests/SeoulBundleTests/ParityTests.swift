// Parity tests for the native slice (PARITY.md). [P6 H] Run in CI on Linux (native-linux) and macOS (native-macos)
// against the same commit's export; first compiled and passed (5/5) on main bc45fbe's export, Swift 6.1.2 Linux.
// Run: ONETAKE_EXPORT=/path/to/exports/seoul-hongdae swift test   (the CI "exports" artifact, or a local export)
import XCTest
@testable import SeoulBundle

final class ParityTests: XCTestCase {
    // vectors from geohash.js (node -e: new GeoHash()...)
    func testGeoHashVectors() {
        XCTAssertEqual(GeoHash().hex(), "ebb6c22840c3ae08")
        var s = GeoHash(); s.str("soup"); XCTAssertEqual(s.hex(), "200f620da5cd55ae")
        var t = GeoHash(); t.str("soup"); t.word(1)
        let f: [Float] = [0, 1, 2, 3.5, -4.25, 5, 1e-3, 600.125, -7]; _ = f.withUnsafeBufferPointer { t.floats($0) }
        XCTAssertEqual(t.hex(), "548932860d2092b2")
        var u = GeoHash(); u.uints([1, 2, 3, 0xffffffff]); XCTAssertEqual(u.hex(), "0443f58f3cf89db5")
    }

    // [P6 H] FIPS 180-4 vectors: the portable SHA-256 (Linux) and the platform one (CryptoKit on Apple) agree
    func testSHA256Vectors() {
        let v: [(String, String)] = [("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
                                     ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
                                     (String(repeating: "a", count: 1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")]
        for (m, h) in v { XCTAssertEqual(SHA256Hex.portable(Data(m.utf8)), h); XCTAssertEqual(SHA256Hex.hex(Data(m.utf8)), h) }
    }

    // [P6 H, native #2] the night lightmap: the file the browser ships, read with the key check, decoded bit for bit
    func testNightLightmap() throws {
        let b = try bundle()
        let L = (try JSONSerialization.jsonObject(with: b.data("light.json")) as! [String: Any])["lightmap"] as! [String: Any]
        guard L["status"] as? String != "stale", let file = L["file"] as? String, let key = L["key"] as? String else { return XCTFail("light.json lightmap is stale: \(L["note"] ?? "")") }
        let d = try b.data(file), t = try NightLM(d, key: key)
        XCTAssertEqual(t.width, L["width"] as! Int); XCTAssertEqual(t.height, L["height"] as! Int)
        XCTAssertEqual(t.texels.count, t.width * t.height)
        let want = L["texelHash"] as? String; XCTAssertNotNil(want, "light.json lightmap.texelHash (tools/export-seoul-data.mjs, P6)")
        var h = GeoHash(); h.str("nlm"); h.uints(t.texels); XCTAssertEqual(h.hex(), want ?? "", "decoded texels = the JS decode")
        let lit = t.texels.filter { $0 != 0 }.count, tx = L["texels"] as? [String: Int] ?? [:]
        XCTAssertGreaterThanOrEqual(lit, (tx["ground"] ?? 0) + (tx["facade"] ?? 0) / 2, "lit texels")
        let (r, g, bb) = NightLM.rgb(t.texels[t.texels.count / 2]); XCTAssert(r.isFinite && g.isFinite && bb.isFinite)
        XCTAssertThrowsError(try NightLM(d, key: "0000000000000000"), "a stale key must be refused (the game's rule)")
    }

    // [P6 H] D's P6 wall-pack lobe (record type 3): vectors from seoul-nightlm.js lobePack at p6/D-light 14f871e
    func testWallPackLobe() throws {
        let v: [[Double]] = [[0, -1, 0, 1, 0, 0.9181252629999999],
                             [0.34199998461000103, -0.9396999577135028, 0, 1, 0, 1.0000000629999997],
                             [-0.34199998461000103, -0.9396999577135028, 0, 1, 0, 0.7108064759812946],
                             [0.502518907629606, -0.7035264706814485, 0.502518907629606, 0, 1, 0.7856818231010101],
                             [0.8082903768654761, -0.5773502691896258, 0.11547005383792516, 1, 0, 0.7694998583333335],
                             [0, 1, 0, 1, 0, 0],
                             [0.204926207831424, -0.973399487199264, -0.102463103915712, 0.6, 0.8, 0.9037651729317584]]
        for r in v { XCTAssertEqual(Lobes.pack(r[0], r[1], r[2], r[3], r[4]), r[5], accuracy: 1e-12) }
        // the export's lobe table, once D's change is in it: id 3 and the same solid angle
        if let b = try? bundle(), let lj = try? JSONSerialization.jsonObject(with: b.data("light.json")) as? [String: Any],
           let p = Self.find(lj, "pack") {
            XCTAssertEqual(p["id"] as? Int, Lobe.pack.rawValue)
            if let om = p["omega"] as? Double { XCTAssertEqual(om, Lobes.packOmega, accuracy: 1e-6) }
        }
    }
    /// the first dictionary under key `k` inside a "lobes" object anywhere in light.json
    static func find(_ o: Any, _ k: String) -> [String: Any]? {
        if let d = o as? [String: Any] {
            if let l = d["lobes"] as? [String: Any], let p = l[k] as? [String: Any] { return p }
            for v in d.values { if let r = find(v, k) { return r } }
        } else if let a = o as? [Any] { for v in a { if let r = find(v, k) { return r } } }
        return nil
    }

    func bundle() throws -> SeoulBundle {
        guard let p = ProcessInfo.processInfo.environment["ONETAKE_EXPORT"] else { throw XCTSkip("set ONETAKE_EXPORT to an export directory") }
        return try SeoulBundle(dir: URL(fileURLWithPath: p))
    }
    func testFilesIntact() throws { XCTAssertEqual(try bundle().staleFiles(), []) }

    func testColliderBitExact() throws {
        let b = try bundle(), soup = try b.colliderSoup(), col = b.world["collider"] as! [String: Any]
        XCTAssertEqual(soup.count / 9, col["triangles"] as! Int)
        XCTAssertEqual(SeoulBundle.soupHash(soup), col["soupHash"] as! String)
    }

    func testWorldMeshesDecode() throws {
        let b = try bundle(); var g = try GLB(b.data("world.glb"))
        let rows = b.world["meshes"] as! [[String: Any]]
        XCTAssertEqual(g.meshes.count, rows.count)
        for (m, r) in rows.enumerated() {
            let (pos, idx) = try g.positionsAndIndex(mesh: m)
            XCTAssertEqual((idx?.count ?? pos.count / 3) / 3, r["triangles"] as! Int, r["name"] as! String)
            let bounds = r["bounds"] as! [String: [Double]], mn = bounds["min"]!, mx = bounds["max"]!
            for c in 0 ..< 3 {   // 20-bit mantissa: within 2 mm of the game's bounds
                let vals = stride(from: c, to: pos.count, by: 3).map { Double(pos[$0]) }
                XCTAssertEqual(vals.min()!, mn[c], accuracy: 0.002); XCTAssertEqual(vals.max()!, mx[c], accuracy: 0.002)
            }
        }
    }

    // [P7 H, panel6 native #6] E's roof-prop height rule reaches the port: every roofOnly mesh has one, it equals
    // dressing.json facts.roofHideY minus build()'s margin, and every prop sits at or above that roof (so hiding is safe)
    func testHeightRules() throws {
        let b = try bundle(), rules = b.heightRules()
        let mats = b.world["materials"] as! [String: [String: Any]], rows = b.world["meshes"] as! [[String: Any]]
        let roofOnly = rows.filter { (mats[$0["material"] as! String]?["roofOnly"] as? Bool) == true }.map { $0["name"] as! String }
        XCTAssertFalse(roofOnly.isEmpty, "world.json has no roofOnly mesh (E's dr_roof)")
        XCTAssertEqual(Set(rules.keys), Set(roofOnly), "a height rule on exactly the roofOnly meshes")
        let facts = (try JSONSerialization.jsonObject(with: b.data("dressing.json")) as! [String: Any])["facts"] as! [String: Any]
        let hideY = facts["roofHideY"] as! Double
        for n in roofOnly {
            let r = try XCTUnwrap(rules[n])
            XCTAssertEqual(r.roofHideY, hideY, accuracy: 1e-9, n)
            XCTAssertEqual(r.cameraYMin, hideY - r.margin, accuracy: 1e-6, n)
            XCTAssert(r.margin >= 0 && r.margin < 1, "margin \(r.margin)")
            let minY = ((rows.first { $0["name"] as? String == n }!["bounds"] as! [String: [Double]])["min"]!)[1]
            XCTAssertGreaterThanOrEqual(minY, hideY - 0.01, "\(n): a prop below roofHideY would vanish in view")
            XCTAssertFalse(SeoulBundle.drawn(r, cameraY: 1.6), "street eye height: hidden")
            XCTAssertTrue(SeoulBundle.drawn(r, cameraY: hideY), "at the lowest roof: drawn")
        }
        XCTAssertTrue(SeoulBundle.drawn(nil, cameraY: 0), "meshes without a rule always draw")
    }

    // [P7 H, panel6 native #6] the bundled traffic snapshots (life/traffic-snapshots.json): one per opening city from
    // LIFE.warm to LIFE.warmMax, steps = round(t x hz), every vehicle on a lane of life.json's network, the RNG state kept
    func testTrafficSnapshots() throws {
        let b = try bundle(), ts = (b.world["data"] as! [String: Any])["trafficSnapshots"] as? [String: Any]
        let file = try XCTUnwrap(ts?["file"] as? String, "world.json data.trafficSnapshots")
        XCTAssertEqual(ts?["exact"] as? Bool, true, "the exporter's restore check")
        let j = try JSONSerialization.jsonObject(with: b.data(file)) as! [String: Any]
        let hz = j["hz"] as! Double, warm = j["warm"] as! Double, warmMax = j["warmMax"] as! Double, nVeh = j["vehicles"] as! Int
        let life = try JSONSerialization.jsonObject(with: b.data("life.json")) as! [String: Any]
        let lanes = ((life["network"] as? [String: Any])?["lanes"] as? [Any])?.count ?? (j["lanes"] as! Int)
        XCTAssertEqual(j["lanes"] as? Int, lanes, "the snapshot's lane count = life.json's network")
        let snaps = j["snapshots"] as! [[String: Any]]
        let ts0 = snaps.map { $0["t"] as! Double }
        XCTAssertEqual(ts0.first, warm); XCTAssertEqual(ts0.last, warmMax); XCTAssertEqual(ts0, ts0.sorted())
        for S in snaps {
            let t = S["t"] as! Double, v = S["v"] as! [[String: Any]]
            XCTAssertEqual(S["n"] as? Int, Int((t * hz).rounded()), "step of t \(t)")
            XCTAssertNotNil(S["rs"], "rng state"); XCTAssertEqual((S["na"] as? [Any])?.count, lanes)
            XCTAssertEqual(v.count, nVeh)
            for x in v {
                let ln = x["lane"] as! Int, nx = x["next"] as! Int
                XCTAssert(ln >= 0 && ln < lanes && nx >= -1 && nx < lanes, "lane indices in range")
                XCTAssert((x["s"] as! Double).isFinite && (x["v"] as! Double).isFinite)
            }
        }
    }

    // [P8 H] Grade.swift: the night shoulder passes the AE target to tone[2] and reaches 1 at the white point (nightToneBC's
    // construction), the grade is monotonic in radiance, and the fisheye maps the centre to the centre and the corner to the
    // 1.16 rad cap (solveLens at 320 x 180: the corner cap sets F)
    func testNightGradeAndLens() throws {
        let b = try bundle()
        let look = (try JSONSerialization.jsonObject(with: b.data("look.json")) as! [String: Any])["resolved"] as! [String: Any]
        let g = NightGrade(look: look), tn = look["tone"] as! [Double]
        XCTAssertEqual(Double(g.tone(SIMD3(repeating: 0.24)).x), tn[2], accuracy: 1e-4, "grey -> tone[2]")
        let wp = Float(0.24 * pow(2, (look["clipEv"] as? Double) ?? 7.5))
        XCTAssertEqual(g.tone(SIMD3(repeating: wp)).y, 1, accuracy: 1e-4, "the white point -> 1")
        // [integ14] P9's grade (lift 0.025, wb 0.92/1/1.02) saturates to 1 a little earlier; on that plateau float32 rounding
        // wobbles by ~4e-7, so allow 1e-6 (a real non-monotonic grade moves by >= 1e-3)
        var last: Float = -1
        for k in 0 ..< 40 { let o = g.apply(SIMD3(repeating: 0.002 * pow(1.4, Float(k))), ev: -4.2, theta: 0).y; XCTAssertGreaterThanOrEqual(o, last - 1e-6, "monotonic (float32 rounding on the white plateau allowed)"); last = o }
        let L = FisheyeLens(thetaS: 50 * .pi / 180, k: 0.28, width: 320, height: 180)
        let c = L.map(u: 0.5, v: 0.5); XCTAssertEqual(c.u, 0.5, accuracy: 1e-9); XCTAssertEqual(c.v, 0.5, accuracy: 1e-9); XCTAssertEqual(c.theta, 0, accuracy: 1e-9)
        XCTAssertEqual(L.map(u: 1, v: 1).theta, 1.16, accuracy: 1e-6, "corner = cornerCapRad")
        let e = L.map(u: 1, v: 1); XCTAssertEqual(e.u, 0.5 + 0.5 / 1.035, accuracy: 1e-6, "the render margin (1.035) past the corner")
    }

    // [P8 H] CityLight (the browser's cityLightmap / cityIrradiance on the CPU, which the Metal shader mirrors): every wall rect
    // the edge table names is found again from a point on its own face (raster -> edge -> normal -> reach -> rect), the
    // ground lookup is the atlas at the ground map's uv, and the volume is finite and non-negative
    func testCityLightLookups() throws {
        let b = try bundle(), L = try CityLight(b)
        XCTAssertEqual(L.records.count % (L.recW * 4), 0)
        XCTAssertEqual(L.volA.count, L.gw * L.gh * L.nl * 4)
        let J = try JSONSerialization.jsonObject(with: b.data("light.json")) as! [String: Any]
        let edges = ((J["lightmap"] as! [String: Any])["plan"] as! [String: Any])["edges"] as! Int
        var found = 0, tried = 0
        for e in stride(from: 0, to: edges, by: 7) {
            let bx = (e & 255) * 2, by = Int(L.R[0]) + (e >> 8)
            let t0 = L.texel(bx, by), t1 = L.texel(bx + 1, by)
            let x0 = Double(Float(bitPattern: t0.x)), z0 = Double(Float(bitPattern: t0.y)), ux = Double(Float(bitPattern: t0.z)), uz = Double(Float(bitPattern: t0.w))
            let len = abs(Double(Float(bitPattern: t1.z))), sg: Double = Float(bitPattern: t1.z) < 0 ? -1 : 1, nx = sg * uz, nz = -sg * ux
            guard len > 1 else { continue }
            tried += 1
            let p = SIMD3(x0 + ux * len / 2 + nx * 0.05, 1.5, z0 + uz * len / 2 + nz * 0.05)
            if let v = L.lightmap(p, SIMD3(nx, 0, nz)), v.x.isFinite { found += 1 }
        }
        print("wall rects found again from their own faces: \(found) of \(tried)")
        XCTAssertGreaterThanOrEqual(Double(found), 0.9 * Double(tried), "the raster names the edge whose face the point is on")
        let gx = L.G[0] + 100.25, gz = L.G[1] + 200.25
        let gv = L.lightmap(SIMD3(gx, 0.1, gz), SIMD3(0, 1, 0))!, ga = L.atlas(u: (gx - L.G[0]) / L.LM[1] / L.A[0], v: (gz - L.G[1]) / L.LM[1] / L.A[1])
        XCTAssertEqual(gv, ga)
        for (x, y, z) in [(-36.0, 2.0, -24.0), (63.7, 3.0, 129.6), (31.8, 8.0, -309.0), (0.0, 40.0, 0.0)] {
            let v = L.irradiance(SIMD3(x, y, z), SIMD3(0, 1, 0)); XCTAssert(v.x.isFinite && v.x >= 0 && v.y >= 0 && v.z >= 0, "volume at \(x), \(y), \(z): \(v)")
        }
        XCTAssertGreaterThan(L.irradiance(SIMD3(-36, 1, -24), SIMD3(0, 1, 0)).y, 0, "walk0's street has ambient light")
    }

    // [P8 H] CityMaterials: per-vertex albedo of the city and the ground (aLay into the material's layers, x COLOR_0): every
    // value is a layer's albedo times a vertex colour in 0..2 (finite, non-negative), and the city uses several layers
    func testCityAlbedos() throws {
        let b = try bundle()
        var g = try GLB(b.data("world.glb"))
        let rows = b.world["meshes"] as! [[String: Any]], mats = b.world["materials"] as! [String: [String: Any]]
        for name in ["city", "ground"] {
            let i = rows.firstIndex { $0["name"] as? String == name }!
            let n = try g.positionsAndIndex(mesh: i).pos.count / 3
            let a = try CityMaterials.albedos(&g, mesh: i, row: rows[i], mats: mats, count: n)
            XCTAssertEqual(a.count, n * 3)
            XCTAssert(a.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 2 }, "\(name): albedo in 0..2")
            let distinct = Set(stride(from: 0, to: a.count, by: 3 * 97).map { Int(a[$0] * 1000) })
            print("\(name): \(n) vertices, \(distinct.count) distinct albedo reds in a 1/97 sample")
            XCTAssertGreaterThan(distinct.count, name == "city" ? 8 : 1)
        }
    }

    // [P9 H, panel8 native #6] the render-only culls are in the export, with the browser's numbers and rule
    func testRenderCulls() throws {
        let b = try bundle()
        let fd = try XCTUnwrap(try b.farDetail(), "light.json farDetail (seoul-light.js FAR_DETAIL)")
        XCTAssertFalse(fd.radii.isEmpty)
        for (k, r) in fd.radii { XCTAssert(k.hasPrefix("seoul:") && r >= 30 && r <= 400, "\(k) \(r) m") }
        let k = fd.radii.keys.sorted()[0], r = fd.radii[k]!, o = SIMD3<Double>(0, 2, 0)
        XCTAssertTrue(fd.drawn(batch: k, center: SIMD3(r + 9, 2, 0), radius: 10, cam: o), "a cell whose sphere reaches r: drawn")
        XCTAssertFalse(fd.drawn(batch: k, center: SIMD3(r + 11, 2, 0), radius: 10, cam: o), "past r: dropped")
        XCTAssertTrue(fd.drawn(batch: "seoul:not-a-detail-batch", center: SIMD3(5000, 0, 0), radius: 1, cam: o))
        let vc = try XCTUnwrap(try b.vehicleCull(), "life.json vehicleCull (seoul-life.js VCULL)")
        XCTAssert(vc.near > 0 && vc.near < vc.far && vc.pad >= 0 && vc.pad < 1, "\(vc)")
        let fwd = SIMD3<Double>(0, 0, -1), cam = SIMD3<Double>(0, 1.6, 0)
        XCTAssertEqual(vc.classify(centre: SIMD3(0, 1, -50), cam: cam, forward: fwd, halfLength: 2.2), .body, "ahead, in range")
        XCTAssertEqual(vc.classify(centre: SIMD3(0, 1, vc.near - 1), cam: cam, forward: fwd, halfLength: 2.2), .body, "behind but within near")
        XCTAssertEqual(vc.classify(centre: SIMD3(0, 1, 60), cam: cam, forward: fwd, halfLength: 2.2), .none, "60 m behind")
        XCTAssertEqual(vc.classify(centre: SIMD3(0, 1, -(vc.far + 5)), cam: cam, forward: fwd, halfLength: 2.2), .poolOnly, "just past far: the pool still reaches")
        XCTAssertEqual(vc.classify(centre: SIMD3(0, 1, -(vc.far + 30)), cam: cam, forward: fwd, halfLength: 2.2), .none)
    }

    func testPackedStreamsDecode() throws {
        let b = try bundle()
        let packed = ((b.world["data"] as! [String: Any])["packed"] as! [String: Any])["files"] as! [String: [String: Any]]
        for (f, p) in packed { XCTAssertEqual(try b.unpacked(f).count, p["decodedBytes"] as! Int, f) }
    }
}
