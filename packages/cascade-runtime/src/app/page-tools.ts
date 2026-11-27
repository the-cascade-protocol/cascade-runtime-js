// The tools a page runs itself, with no runtime of its own: six move the app to one of its pages, by the addresses its
// door gives, and three write once the person has said yes. `TOOLS` in `tools.ts` lists them last.
import { TIER_OF_KIND, type ToolKind, type ToolTier } from "../pod-tools.js";
import { entryId, SOURCES } from "./said.js";

/** The view a model can open: the trend of one test, a medication marked. A host registers it with what runs it. */
const TREND_VIEW = {
  name: "open_trend",
  description:
    "Opens the trend of one lab test over time, the days a medication was prescribed, started and stopped marked on it. It shows what changed after what, never why.",
  inputSchema: {
    type: "object",
    properties: {
      test: { type: "string", description: "A LOINC code such as 18262-6." },
      medication: {
        type: "string",
        description:
          "An RxNorm code such as 617310, or the medication's name where it has no code; none marked if left out.",
      },
    },
    required: ["test"],
    additionalProperties: false,
  },
};

/** A tool's input, as its door checked it against the tool's schema; `pod` for a tool with `ofPod`. */
export type PageToolInput = Readonly<Record<string, string | undefined>>;

/** The PodApi operations the tools a page runs call, each as PodApi answers it. */
interface PageToolsApi {
  pod(input: { pod: string }): Promise<unknown>;
  trend(input: {
    pod: string;
    test?: string;
    medication?: string;
    named?: boolean;
  }): Promise<unknown>;
  ask(input: { pod: string; question: string }): Promise<unknown>;
  table(input: { id: string }): Promise<unknown>;
  makePod(input: { person: string }): Promise<unknown>;
  checkTables(input: object): Promise<unknown>;
  setWorldDate(input: { date: string }): Promise<unknown>;
}

/** What a door gives the tools that move its app: its own addresses, and `open`, which moves the app to one. */
export interface PageDoor {
  readonly address: {
    pod(name: string): string;
    trend(
      name: string,
      trend: { test: string; medication?: string | undefined },
    ): string;
    entry(name: string, entry: string): string;
    classes(name: string, picked?: string): string;
    panel(name: string, panel: string): string;
    table(
      id?: string,
      asked?: {
        q?: string | undefined;
        code?: string | undefined;
      },
    ): string;
  };
  open(address: string): Promise<void>;
}

/** A tool a page can run itself, with no runtime: it moves the app, or writes once the person has said yes (`ask`). Its `tier` is its `kind`'s. */
export interface PageTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly kind: ToolKind;
  readonly tier: ToolTier;
  readonly ofPod?: true;
  readonly opens?: true;
  run(
    api: PageToolsApi,
    input: PageToolInput,
    door: PageDoor,
  ): Promise<unknown>;
}

/** An error its door tells by its name, as PodApi's own refusals: the input was turned down and nothing was done. */
const refusal = (message: string): Error =>
  Object.assign(new Error(message), { name: "Refusal" });

const NO_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** Goes to `address` by the door's `open`, and gives it. */
async function going(address: string, { open }: PageDoor) {
  await open(address);
  return { opened: address };
}

/**
 * The tools a page runs itself, the last nine of `TOOLS` in `tools.ts`: the six that move the app, each giving
 * `{ opened }`, and the three writes the person confirms first, each giving PodApi's answer. They need no runtime, so
 * the Node target's chat runs them in the page.
 */
const PAGE_TOOLS_OF_KIND: readonly Omit<PageTool, "tier">[] = [
  {
    name: "open_pod",
    description: "Opens a pod's page in the app.",
    inputSchema: NO_INPUT,
    kind: "MovingTheAppsView",
    ofPod: true,
    opens: true,
    async run(api, { pod = "" }, door) {
      await api.pod({ pod });
      return going(door.address.pod(pod), door);
    },
  },
  {
    name: TREND_VIEW.name,
    description: TREND_VIEW.description,
    inputSchema: TREND_VIEW.inputSchema,
    kind: "MovingTheAppsView",
    ofPod: true,
    opens: true,
    async run(api, { pod = "", test, medication }, door) {
      const drug = medication === "" ? undefined : medication;
      const { series, timeline } = (await api.trend({
        pod,
        ...(test === undefined ? {} : { test }),
        ...(drug === undefined ? {} : { medication: drug }),
        named: false,
      })) as {
        series: { test: { notation?: string; code: string } };
        timeline: { notation?: string; code?: string; name: string }[];
      };
      const wanted = drug?.toLowerCase();
      const found =
        drug === undefined
          ? undefined
          : timeline.find(
              (each) =>
                each.notation === drug ||
                each.code === drug ||
                each.name.toLowerCase() === wanted,
            );
      return going(
        door.address.trend(pod, {
          test: series.test.notation ?? series.test.code,
          ...(found === undefined
            ? {}
            : { medication: found.notation ?? found.name }),
        }),
        door,
      );
    },
  },
  {
    name: "open_entry",
    description:
      "Opens the page of one entry of a pod: what it is and where it came from.",
    inputSchema: {
      type: "object",
      properties: {
        entry: {
          type: "string",
          description:
            "The entry's IRI or ID, as the entry column of the rows of ask gives it.",
        },
      },
      required: ["entry"],
      additionalProperties: false,
    },
    kind: "MovingTheAppsView",
    ofPod: true,
    opens: true,
    async run(api, { pod = "", entry = "" }, door) {
      const { rows } = (await api.ask({ pod, question: SOURCES })) as {
        rows: { entry: string }[];
      };
      if (!rows.some((row) => entryId(row.entry) === entryId(entry)))
        throw refusal(
          `the pod ${pod} holds no entry ${entry}; ask's rows give each entry's ID in their entry column`,
        );
      return going(door.address.entry(pod, entry), door);
    },
  },
  {
    name: "open_classes",
    description:
      "Opens the page of a pod's medications by the classes they belong to, or with a class named, that class.",
    inputSchema: {
      type: "object",
      properties: {
        class: {
          type: "string",
          description: "A class's name, to open it; left out for all of them.",
        },
      },
      additionalProperties: false,
    },
    kind: "MovingTheAppsView",
    ofPod: true,
    opens: true,
    async run(api, { pod = "", class: picked }, door) {
      await api.pod({ pod });
      return going(
        door.address.classes(pod, picked === "" ? undefined : picked),
        door,
      );
    },
  },
  {
    name: "open_panel",
    description:
      "Opens the page of a pod's results in one LOINC panel, with the tests the panel names that it has no result for.",
    inputSchema: {
      type: "object",
      properties: {
        panel: {
          type: "string",
          description: "The panel's LOINC code, such as 24326-1.",
        },
      },
      required: ["panel"],
      additionalProperties: false,
    },
    kind: "MovingTheAppsView",
    ofPod: true,
    opens: true,
    async run(api, { pod = "", panel = "" }, door) {
      if (panel === "") throw refusal("a panel is a LOINC code: name one");
      await api.pod({ pod });
      return going(door.address.panel(pod, panel), door);
    },
  },
  {
    name: "open_table",
    description:
      "Opens a reference table, a search in it or one code of it; with none named, the list of the tables the app holds.",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "The table's ID, as its address names it.",
        },
        q: { type: "string", description: "Words to search the table for." },
        code: {
          type: "string",
          description: "One code, to open what the tables say of it.",
        },
      },
      additionalProperties: false,
    },
    kind: "MovingTheAppsView",
    opens: true,
    async run(api, { table, q, code }, door) {
      if (table !== undefined && table !== "") await api.table({ id: table });
      return going(
        door.address.table(table === "" ? undefined : table, {
          q: q === "" ? undefined : q,
          code: code === "" ? undefined : code,
        }),
        door,
      );
    },
  },
  {
    name: "make_pod",
    description:
      "Makes a pod for a person, named after them: empty, or the sample of that name; a pod of that name already there is left as it is. It is never encrypted.",
    inputSchema: {
      type: "object",
      properties: {
        person: {
          type: "string",
          description: "The person's name, as they write it.",
        },
      },
      required: ["person"],
      additionalProperties: false,
    },
    kind: "MakingAPodThatIsNotEncrypted",
    run: (api, { person = "" }) => api.makePod({ person }),
  },
  {
    name: "check_tables",
    description:
      "Checks each source of the reference tables for a newer version and keeps any there is.",
    inputSchema: NO_INPUT,
    kind: "ChangingTheAppsTablesOrSettings",
    run: (api) => api.checkTables({}),
  },
  {
    name: "set_world_date",
    description:
      "Sets the date the demo hospitals answer as of: their records as they stood at the end of that day. An empty date takes it back to everything they hold.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description:
            "A day as YYYY-MM-DD, or an instant with its timezone; empty for none.",
        },
      },
      required: ["date"],
      additionalProperties: false,
    },
    kind: "ChangingTheAppsTablesOrSettings",
    run: (api, { date = "" }) => api.setWorldDate({ date }),
  },
];

/** The tools a page runs itself, each with the `tier` the protocol gives its `kind` of act. */
export const PAGE_TOOLS: readonly PageTool[] = PAGE_TOOLS_OF_KIND.map(
  (tool) => ({ ...tool, tier: TIER_OF_KIND[tool.kind] }),
);
