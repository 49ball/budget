import AppKit

let args = CommandLine.arguments
guard args.count == 4 else {
    print("usage: swift render-emoji-icon.swift <emoji> <size> <outputPath>")
    exit(1)
}

let emoji = args[1]
let pixelSize = Int(args[2]) ?? 512
let outputPath = args[3]

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

// Background: solid fill matching the app's theme color (#7c6ff7)
let bgColor = NSColor(calibratedRed: 124.0/255.0, green: 111.0/255.0, blue: 247.0/255.0, alpha: 1.0)
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
