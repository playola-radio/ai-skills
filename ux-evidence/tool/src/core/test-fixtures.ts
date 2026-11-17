import type { WebConfig } from "./config.ts";

export const WEB_CONFIG: WebConfig = {
  version: 1,
  platform: "web",
  baseBranch: "develop",
  relevant: ["client/**", "server/**"],
  requiresEvidence: ["client/**"],
  ignored: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/*.md"],
  web: { viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "America/Chicago" },
};
