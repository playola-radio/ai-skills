import { nodeVersionError } from "./node-version.ts";

const versionError = nodeVersionError(process.versions.node);
if (versionError !== undefined) {
  console.error(`error: ${versionError}`);
  process.exit(1);
}

// npm run starts scripts in the tool's folder; INIT_CWD is where the user ran it.
const { run, wireCommands } = await import("./cli.ts");
process.exit(await run(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd(), wireCommands, console.log));
