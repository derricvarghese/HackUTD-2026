#if canImport(UIKit)
import UIKit

/// Client-side image processing: downscales to at most 1600 px on the long edge,
/// bakes the EXIF rotation into the pixel buffer, strips metadata (including GPS),
/// and encodes as JPEG at quality ~75%.
public enum ImageProcessor {
    public static let maxLongEdge: CGFloat = 1600.0
    public static let jpegQuality: CGFloat = 0.75

    /// Downscales image, bakes rotation, and strips metadata by redrawing into a fresh context.
    public static func process(_ image: UIImage) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }

        let longEdge = max(size.width, size.height)
        let scale = longEdge > maxLongEdge ? (maxLongEdge / longEdge) : 1.0
        let targetSize = CGSize(
            width: max(1, (size.width * scale).rounded()),
            height: max(1, (size.height * scale).rounded())
        )

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
        let normalized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }

        return normalized.jpegData(compressionQuality: jpegQuality)
    }

    /// Processes raw image data (JPEG, PNG, HEIC) and returns clean, downscaled JPEG data.
    public static func process(data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        return process(image)
    }
}
#endif
