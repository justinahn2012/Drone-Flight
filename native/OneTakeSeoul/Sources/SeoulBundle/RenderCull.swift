// [P9 H, panel8 native #6] The render-only culls the browser applies, as data in the export (JS-only until P9):
//   light.json farDetail  (seoul-light.js FAR_DETAIL): sub-pixel detail batches drop their far cells;
//   life.json vehicleCull (seoul-life.js VCULL): vehicles outside the widened view cone or past `far` are not drawn,
//                         a culled one keeps its headlight pool while the pool can reach the view.
// Neither touches the sim, the collider, the lamps or the lightmap: they only decide what the Metal frame draws.
import Foundation

public struct FarDetail: Equatable {
    /// batch name (the browser's BatchedMesh name, e.g. "seoul:ao") -> metres from the camera to the cell sphere's surface
    public let radii: [String: Double]
    /// whether a cell of `batch` (sphere `center`, `radius`) is drawn with the camera at `cam` (batches without a radius: always)
    public func drawn(batch: String, center: SIMD3<Double>, radius: Double, cam: SIMD3<Double>) -> Bool {
        guard let r = radii[batch] else { return true }
        let d = center - cam
        return (d * d).sum().squareRoot() - radius <= r
    }
}

public struct VehicleCull: Equatable {
    public let near: Double, far: Double, pad: Double
    public enum Draw: Equatable { case body, poolOnly, none }
    /// `centre` = the vehicle's position at ground + 1 m, `forward` the camera's unit forward, `fovHalf` its half angle
    /// (the browser's ctx.fovHalf, 1.15 when unset), `halfLength` = L / 2. Mirrors seoul-life.js update() line for line.
    public func classify(centre: SIMD3<Double>, cam: SIMD3<Double>, forward: SIMD3<Double>, fovHalf: Double = 1.15, halfLength hl: Double) -> Draw {
        let v = centre - cam, d = (v * v).sum().squareRoot()
        let c = (v * forward).sum() / max(d, 1e-3)
        let cosV = cos(min(Double.pi, min(1.55, fovHalf) + pad))
        if d < near || (d < far && c > cosV - (hl + 1.5) / d) { return .body }
        return (c > cosV - (hl + 14) / d && d < far + 14) ? .poolOnly : .none
    }
}

public extension SeoulBundle {
    func farDetail() throws -> FarDetail? {
        let lj = try JSONSerialization.jsonObject(with: data("light.json")) as! [String: Any]
        guard let f = lj["farDetail"] as? [String: Any], let r = f["radii"] as? [String: Any] else { return nil }
        return FarDetail(radii: r.compactMapValues { ($0 as? NSNumber)?.doubleValue })
    }
    func vehicleCull() throws -> VehicleCull? {
        let lj = try JSONSerialization.jsonObject(with: data("life.json")) as! [String: Any]
        guard let v = lj["vehicleCull"] as? [String: Any], let n = (v["near"] as? NSNumber)?.doubleValue,
              let f = (v["far"] as? NSNumber)?.doubleValue, let p = (v["pad"] as? NSNumber)?.doubleValue else { return nil }
        return VehicleCull(near: n, far: f, pad: p)
    }
}
