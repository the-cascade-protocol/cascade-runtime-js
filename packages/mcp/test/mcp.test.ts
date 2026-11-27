import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { openPod, sixWords } from "cascade-runtime";
import type * as Fixtures from "cascade-runtime/fixtures";
import { TOOLS } from "cascade-runtime/tools";

/** A folder cascade-mcp's and cascade-runtime's tarballs are installed in, to run the `cascade-mcp` bin they installed. */
const APP =
  process.env.CASCADE_RUNTIME_APP === undefined
    ? undefined
    : resolve(process.env.CASCADE_RUNTIME_APP);

/** The script to start: the installed package's `cascade-mcp` bin, or this package's own. `npx` is `npx.cmd` on Windows, so node starts the script. */
const CLI =
  APP === undefined
    ? fileURLToPath(new URL("../src/cli.js", import.meta.url))
    : join(
        APP,
        "node_modules",
        "cascade-mcp",
        (
          JSON.parse(
            readFileSync(
              join(APP, "node_modules", "cascade-mcp", "package.json"),
              "utf8",
            ),
          ) as { bin: { "cascade-mcp": string } }
        ).bin["cascade-mcp"],
      );

/**
 * A module of cascade-runtime, from the installed package when there is one: the pods the installed bin is asked about are
 * built by the vocabulary that package carries, not by whatever checkout of it sits beside this one.
 */
async function runtimeModule<T>(specifier: string): Promise<T> {
  if (APP === undefined) return (await import(specifier)) as T;
  const path = createRequire(join(APP, "package.json")).resolve(specifier);
  return (await import(pathToFileURL(path).href)) as T;
}

/** The command, its arguments and its folder that start cascade-mcp with `args`, as the tests start it. */
const command = (args: string[]) => ({
  command: process.execPath,
  args: [CLI, ...args],
  ...(APP === undefined ? {} : { cwd: APP }),
});

let folder: string;
let client: Client;

/** A tool's answer: its text as JSON, or, for an error, the text. */
async function call(name: string, input: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: input });
  const [first] = result.content as { type: string; text: string }[];
  return result.isError === true
    ? { refused: first!.text }
    : { value: JSON.parse(first!.text) as unknown };
}

interface Ended {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** cascade-mcp started with `args`, in `inFolder` when given, and left to end, which it does for a start it cannot serve. */
function endsWith(args: string[], inFolder?: string): Promise<Ended> {
  return new Promise((done, fail) => {
    const { command: program, args: given, cwd } = command(args);
    const child = spawn(program, given, {
      ...((inFolder ?? cwd) === undefined ? {} : { cwd: inFolder ?? cwd }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const USAGE = "usage: cascade-mcp --pods <folder> [--check-tables]";

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), "cascade-mcp-"));
    const { replayKit } = await runtimeModule<typeof Fixtures>(
      "cascade-runtime/fixtures",
    );
    // An app runs in its own folder, whose settings its runtime reads; this checkout's folder has the repository's.
    const here = process.cwd();
    if (APP !== undefined) process.chdir(APP);
    try {
      await replayKit("tamsin-vale", join(folder, "tamsin-vale"), {
        through: "J1",
      });
    } finally {
      process.chdir(here);
    }
    await (
      await openPod(join(folder, "locked"), { secret: sixWords() })
    ).close();
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StdioClientTransport(command(["--pods", folder])));
  },
  { timeout: 120_000 },
);

after(async () => {
  await client?.close();
  await rm(folder, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * `cascade-mcp --pods <folder>` is started by an MCP client and offers it the tools a model reads a pod with, over the
 * pods in the folder. What each tool returns is on cascade-runtime's page, from "Tools a model reads a pod with" to
 * "Checking a pod against the reference tables"; here is what the command adds.
 */
describe("Serving a folder of pods to an MCP client · cascade-mcp --pods, --check-tables", () => {
  describe("when a client connects", () => {
    it("offers each tool of `cascade-runtime/tools` that reads, by its name, to a client that cannot ask the person", async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map(({ name }) => name).sort(),
        TOOLS.map(({ name }) => name).sort(),
      );
    });

    it("serves the pods of the folder that `--pods` names", async () => {
      assert.deepEqual((await call("list_pods", {})).value, [
        "locked",
        "tamsin-vale",
      ]);
    });

    it("returns the `ask` tool's rows, for a named question of a pod in the folder, as JSON text", async () => {
      const { value } = await call("ask", {
        pod: "tamsin-vale",
        question: "pod/My lab results",
      });
      const { rows } = value as { rows: Record<string, string>[] };
      assert.ok(
        rows.length > 0,
        "a pod of the folder holds a lab result once J1 judges the first pull about the person",
      );
    });
  });

  describe("when a tool refuses its input", () => {
    it("answers with `isError` and the tool's reason", async () => {
      assert.match(
        (await call("ask", { pod: "nobody", question: "pod/My lab results" }))
          .refused ?? "",
        /there is no pod nobody/,
      );
    });
  });

  describe("when started without `--check-tables`", () => {
    it('answers `reference_table_checks` with `tables: "off"` and a sentence that names the flag', async () => {
      const { value } = await call("reference_table_checks", {
        pod: "tamsin-vale",
      });
      assert.deepEqual(Object.keys(value as object).sort(), ["said", "tables"]);
      assert.equal((value as { tables: string }).tables, "off");
      assert.match((value as { said: string }).said, /--check-tables/);
    });
  });
});

/**
 * The command keeps its standard output for the protocol, so what it has to say to a person goes to standard error.
 * A start it cannot serve ends with status 2 and the usage.
 */
describe("Starting cascade-mcp · --pods, --help", () => {
  const started = new Map<string, Ended>();
  const never = () => resolve(folder, "never-made");

  before(
    async () => {
      const starts = {
        none: [],
        missing: ["--pods", never()],
        unknown: ["--nope"],
        help: ["--help"],
      };
      await Promise.all(
        Object.entries(starts).map(async ([name, args]) => {
          started.set(name, await endsWith(args));
        }),
      );
    },
    { timeout: 120_000 },
  );

  describe("when started with no `--pods`", () => {
    it("exits with status 2, telling the person to give the pods' folder", () => {
      const { status, stdout, stderr } = started.get("none")!;
      assert.equal(status, 2);
      assert.equal(stderr.split("\n")[0], "give the pods' folder with --pods");
      assert.ok(stderr.includes(USAGE));
      assert.equal(stdout, "");
    });
  });

  describe("with a `--pods` that is no folder", () => {
    it("exits with status 2, naming the folder", () => {
      const { status, stdout, stderr } = started.get("missing")!;
      assert.equal(status, 2);
      assert.equal(stderr.split("\n")[0], `${never()} is no folder`);
      assert.equal(stdout, "");
    });
  });

  describe("with a flag it does not have", () => {
    it("exits with status 2, with the usage", () => {
      const { status, stdout, stderr } = started.get("unknown")!;
      assert.equal(status, 2);
      assert.match(stderr.split("\n")[0]!, /--nope/);
      assert.ok(stderr.includes(USAGE));
      assert.equal(stdout, "");
    });
  });

  describe("with `--help`", () => {
    it("prints the usage to standard error and exits with status 0", () => {
      const { status, stdout, stderr } = started.get("help")!;
      assert.equal(status, 0);
      assert.ok(stderr.startsWith(USAGE));
      assert.equal(stdout, "");
    });
  });
});

interface Block {
  readonly mcpServers: Record<
    string,
    { readonly command: string; readonly args: string[] }
  >;
}

/**
 * `cascade-mcp --pods <folder> --settings` prints the `mcpServers` block a person pastes into Claude Desktop's
 * `claude_desktop_config.json`, with absolute paths, and starts no server. Standard output is the JSON alone, so a
 * person can pipe or paste it; the warning goes to standard error.
 */
describe("Printing Claude Desktop's settings · cascade-mcp --settings", () => {
  describe("when given the pods' folder", () => {
    it("prints a block whose command and arguments, started as printed, serve that folder", async () => {
      const { status, stdout, stderr } = await endsWith([
        "--pods",
        folder,
        "--settings",
      ]);
      assert.equal(status, 0);
      assert.match(stderr, /hosted model is sent what the tools return/);
      const { mcpServers } = JSON.parse(stdout) as Block;
      const [server] = Object.values(mcpServers);
      assert.equal(Object.keys(mcpServers).length, 1);
      const [script, pods, printed, ...rest] = server!.args;
      assert.equal(isAbsolute(server!.command), true);
      assert.equal(existsSync(server!.command), true);
      assert.equal(isAbsolute(script!), true);
      assert.equal(realpathSync(script!), realpathSync(CLI));
      assert.equal(pods, "--pods");
      assert.equal(printed, resolve(folder));
      assert.deepEqual(rest, []);

      // What Claude Desktop does with the block: start the command with the arguments, from any folder.
      const asked = new Client({ name: "test", version: "0.0.0" });
      try {
        await asked.connect(
          new StdioClientTransport({
            command: server!.command,
            args: server!.args,
          }),
        );
        const [first] = (
          await asked.callTool({ name: "list_pods", arguments: {} })
        ).content as { text: string }[];
        assert.deepEqual(JSON.parse(first!.text), ["locked", "tamsin-vale"]);
      } finally {
        await asked.close();
      }
    });

    it("resolves a relative folder to an absolute one and keeps `--check-tables`", async () => {
      const { stdout } = await endsWith(
        ["--pods", basename(folder), "--settings", "--check-tables"],
        dirname(folder),
      );
      const [server] = Object.values((JSON.parse(stdout) as Block).mcpServers);
      const [option, printed, kept] = server!.args.slice(1);
      assert.ok(isAbsolute(printed!));
      assert.deepEqual(
        [option, realpathSync(printed!), kept],
        ["--pods", realpathSync(folder), "--check-tables"],
      );
    });
  });

  describe("when the block would not start", () => {
    it("exits with status 2, naming what is missing, and prints no block", async () => {
      const without = await endsWith(["--settings"]);
      assert.equal(without.status, 2);
      assert.equal(
        without.stderr.split("\n")[0],
        "give the pods' folder with --pods",
      );
      assert.equal(without.stdout, "");

      const missing = resolve(folder, "never-made");
      const nowhere = await endsWith(["--pods", missing, "--settings"]);
      assert.equal(nowhere.status, 2);
      assert.equal(nowhere.stderr.split("\n")[0], `${missing} is no folder`);
      assert.equal(nowhere.stdout, "");
    });
  });
});
