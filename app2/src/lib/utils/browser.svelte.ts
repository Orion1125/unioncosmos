type BrowserSvelte = "Chrome" | "Firefox" | "Brave" | "Safari" | "Unknown"

export const detectBrowser = (): BrowserSvelte => {
  const userAgent = navigator.userAgent.toLowerCase()

  if (userAgent.includes("firefox")) {
    return "Firefox"
  }

  if (userAgent.includes("safari") && !userAgent.includes("chrome")) {
    return "Safari"
  }

  if (userAgent.includes("chrome")) {
    const isBrave = (navigator as any).brave?.isBrave
    if (isBrave?.()) {
      return "Brave"
    }

    return "Chrome"
  }

  return "Unknown"
}
