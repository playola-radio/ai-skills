import type { IOSConfig, WebConfig } from "./config.ts";

export const WEB_CONFIG: WebConfig = {
  version: 1,
  platform: "web",
  baseBranch: "develop",
  relevant: ["client/**", "server/**"],
  requiresEvidence: ["client/**"],
  ignored: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.md"],
  web: { viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "America/Chicago" },
};

export const IOS_CONFIG: IOSConfig = {
  version: 1,
  platform: "ios",
  baseBranch: "develop",
  relevant: ["PlayolaRadio/**", "PlayolaRadio.xcodeproj/**"],
  requiresEvidence: ["PlayolaRadio/**", "PlayolaRadio.xcodeproj/**"],
  ignored: ["**/*Tests.swift"],
  ios: {
    project: "PlayolaRadio.xcodeproj",
    scheme: "PlayolaRadio-Staging",
    configuration: "Debug",
    productName: "PlayolaRadio Staging.app",
    bundleId: "fm.playola.playolaradio.staging",
    apiHost: "https://admin-api-staging.playola.fm",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    xcodePath: "/Applications/Xcode.app",
    maestroPath: "/home/u/.maestro/bin/maestro",
    javaHome: "/opt/java17",
    secretsSource: "/home/u/ios",
  },
};
