import AppKit

let args = CommandLine.arguments
guard args.count == 5 else {
    print("usage: swift render-emoji-icon.swift <emoji> <size> <outputPath> <hexColor>")
    exit(1)
}

let emoji = args[1]
let pixelSize = Int(args[2]) ?? 512
let outputPath = args[3]
let hexColor = args[4]

func colorFromHex(_ hex: String) -> NSColor {
    var cleaned = hex.trimmingCharacters(in: .whitespaces)
    if cleaned.hasPrefix("#") { cleaned.removeFirst() }
    var rgb: UInt64 = 0
    Scanner(string: cleaned).scanHexInt64(&rgb)
    let r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
    let g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
    let b = CGFloat(rgb & 0x0000FF) / 255.0
    return NSColor(calibratedRed: r, green: g, blue: b, alpha: 1.0)
}

guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixelSize,
    pixelsHigh: pixelSize,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    print("Failed to create bitmap")
    exit(1)
}
bitmap.size = NSSize(width: pixelSize, height: pixelSize)

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

let size = CGFloat(pixelSize)

// Background: solid fill using the passed-in color
let bgColor = colorFromHex(hexColor)
bgColor.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: size, height: size)).fill()

// Draw emoji centered, large
let fontSize = size * 0.6
let font = NSFont.systemFont(ofSize: fontSize)
let paragraphStyle = NSMutableParagraphStyle()
paragraphStyle.alignment = .center

let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .paragraphStyle: paragraphStyle
]

let attrString = NSAttributedString(string: emoji, attributes: attrs)
let textSize = attrString.size()
let textRect = NSRect(
    x: (size - textSize.width) / 2,
    y: (size - textSize.height) / 2,
    width: textSize.width,
    height: textSize.height
)
attrString.draw(in: textRect)

NSGraphicsContext.restoreGraphicsState()

guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
    print("Failed to generate PNG data")
    exit(1)
}

do {
    try pngData.write(to: URL(fileURLWithPath: outputPath))
    print("Wrote \(outputPath)")
} catch {
    print("Failed to write file: \(error)")
    exit(1)
}
