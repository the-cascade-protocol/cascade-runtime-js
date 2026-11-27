#!/usr/bin/env node
// `cascade-mcp --pods <folder>`: an MCP server on stdio over the pods in the folder, for Claude Desktop, VS Code or any
// MCP client to start. stdout is the protocol; what it says of itself goes to stderr.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { argv, execPath, exit, stderr, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { configureTables } from "cascade-runtime";
import { podReads, podsIn } from "cascade-runtime/tools/node";
import { podServer } from "./server.js";

const USAGE = `usage: cascade-mcp --pods <folder> [--check-tables] [--settings]

  --pods <folder>   the folder whose folders are the pods, as an app keeps them
  --settings        print the block for Claude Desktop's claude_desktop_config.json, with absolute paths, and
                    start no server
  --check-tables    check the reference tables' feeds for newer tables when the first pod opens (a network call),
                    and offer reference_table_checks' rows; without it, the tables the folder holds are used as
                    they are, and reference_table_checks says the tables are off
`;

function refuse(message: string): never {
  stderr.write(`${message}\n\n${USAGE}`);
  exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    args: argv.slice(2),
    options: {
      pods: { type: "string" },
      "check-tables": { type: "boolean", default: false },
      settings: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  }));
} catch (error) {
  refuse((error as Error).message);
}
if (values.help) {
  stderr.write(USAGE);
  exit(0);
}
if (values.pods === undefined) refuse("give the pods' folder with --pods");
const folder = resolve(values.pods);
if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory())
  refuse(`${folder} is no folder`);

if (values.settings) {
  stderr.write(
    "warning: a hosted model is sent what the tools return, so give it only pods you are content to share with it\n",
  );
  const args = [fileURLToPath(import.meta.url), "--pods", folder];
  if (values["check-tables"]) args.push("--check-tables");
  const block = { mcpServers: { cascade: { command: execPath, args } } };
  stdout.write(`${JSON.stringify(block, null, 2)}\n`, () => exit(0));
} else {
  serve(folder, values["check-tables"]);
}

function serve(pods: string, checkTables: boolean): void {
  configureTables({ checkOnOpen: checkTables });
  const reads = podReads(podsIn(pods), { tables: checkTables });
  const serving = serveStdio(() => podServer(reads));

  stdin.on("close", async () => {
    await serving.close();
    await reads.close();
    exit(0);
  });
}
