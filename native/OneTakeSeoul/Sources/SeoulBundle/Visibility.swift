// [P7 H, panel6 native #6] Height rules: meshes the renderer draws only above a camera height. world.json meshes[].visibility
// (tools/export-world.mjs) carries E's rule for the roofOnly material (dr_roof: planters, pipe runs, solar panels under the
// 0.9 m parapets, seoul-dressing.js updateRoof): drawn only while the eye's world Y >= cameraYMin = facts.roofHideY - margin.
// The Metal frame loop asks `drawn(_:cameraY:)` per mesh each frame (the browser does the same in seoul-dressing.js).
import Foundation

public struct HeightRule: Equatable {
    public let mesh: String
    public let cameraYMin: Double
    public let roofHideY: Double
    public let margin: Double
}

public extension SeoulBundle {
    /// Every mesh with a height rule, by mesh name.
    func heightRules() -> [String: HeightRule] {
        var out: [String: HeightRule] = [:]
        for r in (world["meshes"] as? [[String: Any]]) ?? [] {
            guard let n = r["name"] as? String, let v = r["visibility"] as? [String: Any], let y = v["cameraYMin"] as? Double else { continue }
            out[n] = HeightRule(mesh: n, cameraYMin: y, roofHideY: v["roofHideY"] as? Double ?? .nan, margin: v["margin"] as? Double ?? .nan)
        }
        return out
    }
    /// Whether a mesh is drawn with the camera's eye at world height `cameraY` (meshes without a rule: always).
    static func drawn(_ rule: HeightRule?, cameraY: Double) -> Bool { rule.map { cameraY >= $0.cameraYMin } ?? true }
}
