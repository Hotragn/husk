import CoreGraphics

/// Where the notch is, from what `NSScreen` reports. Never hardcoded.
///
/// `safeAreaInsets.top` is non-zero only on a display with a camera housing,
/// and `auxiliaryTopLeftArea` / `auxiliaryTopRightArea` are the menu-bar areas
/// either side of it, so the notch is the gap between them.
/// https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets
/// https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea
///
/// Returns nil on an external display or a Mac without a notch; the app then
/// shows only its menu-bar icon.
public func notchRect(screenFrame: CGRect, safeAreaTop: CGFloat, topLeftArea: CGRect?, topRightArea: CGRect?) -> CGRect? {
    guard safeAreaTop > 0, let left = topLeftArea, let right = topRightArea else { return nil }
    let width = right.minX - left.maxX
    guard width > 0 else { return nil }
    return CGRect(x: left.maxX, y: screenFrame.maxY - safeAreaTop, width: width, height: safeAreaTop)
}

/// The pill's frame: centred under the notch, wider than it so the text fits,
/// growing downward when expanded. Screen coordinates, origin bottom-left.
public func pillFrame(notch: CGRect, width: CGFloat, height: CGFloat) -> CGRect {
    let w = max(width, notch.width)
    return CGRect(x: notch.midX - w / 2, y: notch.minY - height, width: w, height: height)
}
