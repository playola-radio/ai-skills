import { nodeVersionError } from "./node-version.ts";

const versionError = nodeVersionError(process.versions.node);
if (versionError !== undefined) {
  console.error(`error: ${versionError}`);
  process.exit(1);
}

const { main, wireCommands } = await import("./cli.ts");
process.exit(await main(process.argv.slice(2), wireCommands(), console.log));
