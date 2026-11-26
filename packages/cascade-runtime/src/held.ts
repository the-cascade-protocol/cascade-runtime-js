// What a pod holds of the field a reply's fact names: as items, each a field of the entry or a part of it (a dosage, a
// reference bound) with the sources that state exactly this, and `heldInWords`, which words an item for a person, once,
// so no app reads field names or codes of the vocabulary to do it.
import {
  type FieldRow,
  type Fields,
  type Held,
  shownCode,
} from "./citations.js";

/** A field of an entry or of one of its parts, as the pod holds it. */
export interface HeldField {
  readonly name: string;
  readonly value: string;
  /** What the question gives for the value, when it has one: a code's display. */
  readonly label?: string;
}

/** A part of an entry as the pod holds it, with the parts beneath it. */
export interface HeldPart {
  /** The way to the part from the member's values, as the question's `?part` writes it: `structuredDosage 1/dosageDoseQuantity`. */
  readonly part: string;
  readonly fields: readonly HeldField[];
  readonly parts?: readonly HeldPart[];
}

/**
 * What the pod holds of one field of an entry (`fields` is that field alone), or of one part of it with the parts beneath
 * it, the way the pod holds it and never worded. Records that hold exactly the same are one item, each source of them in
 * `sources` by its short name; two records that differ are two items, so one record's schedule is never shown with
 * another's dose.
 */
export interface HeldItem {
  /** The sources that state it, by short name (`S3`); none for a value of the entry as a whole. */
  readonly sources: readonly string[];
  readonly part?: string;
  readonly fields: readonly HeldField[];
  readonly parts?: readonly HeldPart[];
}

type Content = Omit<HeldItem, "sources">;

/** Source short names in the order a compact read numbers them. */
export const bySourceNumber = (a: string, b: string) =>
  Number(a.slice(1)) - Number(b.slice(1));

const byName = (a: HeldField, b: HeldField) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Contents joined to the sources that state them, one item for each different content, in the order each is first met. */
function joined(
  stated: readonly { content: Content; source: string | undefined }[],
): HeldItem[] {
  const items = new Map<string, { content: Content; sources: Set<string> }>();
  for (const { content, source } of stated) {
    const key = JSON.stringify(content);
    const item = items.get(key) ?? { content, sources: new Set<string>() };
    items.set(key, item);
    if (source !== undefined) item.sources.add(source);
  }
  return [...items.values()].map(({ content, sources }) => ({
    sources: [...sources].sort(bySourceNumber),
    ...content,
  }));
}

const fieldOf = ({ name, value, label }: FieldRow): HeldField => ({
  name,
  value,
  ...(label === undefined ? {} : { label }),
});

/**
 * The items of the rows a fact that names a `property` rests on: a row of the entry's own is an item of its own, and the
 * rows of a part are one item with the parts beneath it, for each record, so what a record states is never mixed with
 * what another does. The items of the entry come first, then the parts by their way.
 */
export function heldItems(
  rows: readonly FieldRow[],
  sourceOf: (record: string | undefined) => string | undefined,
): HeldItem[] {
  type Node = { part: string; fields: HeldField[]; parts: Node[] };
  const nodes = new Map<string, Node>();
  const roots: { node: Node; record: string | undefined }[] = [];
  const own: { content: Content; source: string | undefined }[] = [];
  for (const row of rows) {
    if (row.part === undefined) {
      own.push({
        content: { fields: [fieldOf(row)] },
        source: sourceOf(row.record),
      });
      continue;
    }
    const key = `${row.record ?? ""}\n${row.part}`;
    let node = nodes.get(key);
    if (node === undefined) {
      node = { part: row.part, fields: [], parts: [] };
      nodes.set(key, node);
    }
    node.fields.push(fieldOf(row));
  }
  for (const [key, node] of nodes) {
    const record = key.slice(0, key.indexOf("\n"));
    const above = node.part.lastIndexOf("/");
    const parent =
      above === -1
        ? undefined
        : nodes.get(`${record}\n${node.part.slice(0, above)}`);
    if (parent === undefined)
      roots.push({ node, record: record === "" ? undefined : record });
    else parent.parts.push(node);
  }
  const content = ({ part, fields, parts }: Node): HeldPart => ({
    part,
    fields: [...fields].sort(byName),
    ...(parts.length === 0
      ? {}
      : {
          parts: [...parts].sort((a, b) => byWay(a.part, b.part)).map(content),
        }),
  });
  return joined([
    ...own,
    ...roots
      .map(({ node, record }) => ({
        content: content(node),
        source: sourceOf(record),
      }))
      .sort((a, b) => byWay(a.content.part!, b.content.part!)),
  ]);
}

const byWay = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true });

/** The items of what a pod holds of an entry as one kind of field, a field of the entry for each different value. */
export function heldValues(
  held: readonly Held[],
  kind: keyof Fields,
  sourceOf: (record: string | undefined) => string | undefined,
): HeldItem[] {
  return joined(
    held.flatMap(({ kind: its, name, value, label, record }) =>
      its !== kind || name === undefined
        ? []
        : [
            {
              content: {
                fields: [
                  { name, value, ...(label === undefined ? {} : { label }) },
                ],
              },
              source: sourceOf(record),
            },
          ],
    ),
  );
}

/** The words of a field's name: `dispenseDaysSupply` is "dispense days supply". */
const words = (name: string) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const last = (part: string) => part.slice(part.lastIndexOf("/") + 1);

/** A value as a person reads it: by its label and then its code when it has a label, else as the compact read shows a code. */
const valueOf = ({ value, label }: HeldField) =>
  label === undefined
    ? (shownCode(value) ?? value)
    : `${label} (${shownCode(value) ?? value})`;

const COMPARATORS: Readonly<Record<string, string>> = {
  "<": "less than",
  "<=": "at most",
  ">=": "at least",
  ">": "more than",
};
const QUANTITY = [
  "writtenValue",
  "decimalValue",
  "quantityComparator",
  "unitText",
  "ucumUnit",
];

/** The fields of a part split into its quantity, worded, and what is left: the number as written, its comparator before it, its unit as the source shows it. */
function quantityOf(fields: readonly HeldField[]): {
  quantity?: string;
  rest: HeldField[];
} {
  const first = (name: string) => fields.find((it) => it.name === name);
  const used = new Set(
    QUANTITY.flatMap((name) => {
      const it = first(name);
      return it === undefined ? [] : [it];
    }),
  );
  if (used.size === 0) return { rest: [...fields] };
  const comparator = first("quantityComparator")?.value;
  const shown = [
    comparator === undefined
      ? undefined
      : (COMPARATORS[comparator] ?? comparator),
    (first("writtenValue") ?? first("decimalValue"))?.value,
    (first("unitText") ?? first("ucumUnit"))?.value,
  ].filter((it) => it !== undefined);
  return {
    quantity: shown.join(" "),
    rest: fields.filter((it) => !used.has(it)),
  };
}

const TIME = new Map([
  ["s", "second"],
  ["min", "minute"],
  ["h", "hour"],
  ["d", "day"],
  ["wk", "week"],
  ["mo", "month"],
  ["a", "year"],
]);

/** A part's own fields as words, its quantity first. */
const fieldsIn = (fields: readonly HeldField[]): string[] => {
  const { quantity, rest } = quantityOf(fields);
  return [
    ...(quantity === undefined ? [] : [quantity]),
    ...rest.map((it) => `${words(it.name)} ${valueOf(it)}`),
  ];
};

/** A dosage as one line: its dose, its schedule, its route, its bounds, and anything else it holds. */
function dosageIn(part: Pick<HeldPart, "fields" | "parts">): string {
  const taken = new Set<HeldField>();
  const take = (name: string) => {
    const it = part.fields.find(
      (field) => field.name === name && !taken.has(field),
    );
    if (it !== undefined) taken.add(it);
    return it;
  };
  const written = new Map<string, string>();
  const dose: string[] = [];
  const beneath: string[] = [];
  for (const child of part.parts ?? []) {
    const [name, of] = last(child.part).split(" ");
    if (name === "dosageDoseQuantity") dose.push(...fieldsIn(child.fields));
    else if (name === "paddedDateTime" && of !== undefined) {
      const as = child.fields.find((it) => it.name === "timeAsWritten");
      if (as !== undefined) written.set(of, as.value);
      beneath.push(
        ...fieldsIn(
          child.fields.filter(
            (it) => it !== as && it.name !== "paddedDateTimeProperty",
          ),
        ),
      );
    } else beneath.push(...heldInWords(child));
  }
  const frequency = take("dosageRepeatFrequency")?.value;
  const period = take("dosageRepeatPeriod")?.value;
  const unit = take("dosageRepeatPeriodUnit")?.value;
  const unitWords =
    unit === undefined
      ? undefined
      : `${TIME.get(unit) ?? unit}${period !== undefined && Number(period) !== 1 && TIME.has(unit) ? "s" : ""}`;
  const schedule =
    frequency !== undefined && period !== undefined && unitWords !== undefined
      ? [`${frequency} per ${period} ${unitWords}`]
      : [
          ...(frequency === undefined ? [] : [`frequency ${frequency}`]),
          ...(period === undefined
            ? []
            : [
                `period ${period}${unitWords === undefined ? "" : ` ${unitWords}`}`,
              ]),
          ...(period === undefined && unitWords !== undefined
            ? [`period unit ${unitWords}`]
            : []),
        ];
  const routes = [
    ...part.fields
      .filter((it) => it.name === "dosageRouteCode")
      .map((it) => {
        taken.add(it);
        return it.label ?? `route ${shownCode(it.value) ?? it.value}`;
      }),
    ...part.fields
      .filter((it) => it.name === "dosageRouteCodeInOtherSystem")
      .map((it) => {
        taken.add(it);
        return `route ${it.value} (another code system)`;
      }),
  ];
  const bounds = [
    ["dosageBoundsPeriodStart", "from"],
    ["dosageBoundsPeriodEnd", "until"],
  ].flatMap(([name, say]) => {
    const it = take(name!);
    return it === undefined ? [] : [`${say} ${written.get(name!) ?? it.value}`];
  });
  const rest = fieldsIn(part.fields.filter((it) => !taken.has(it)));
  const said = [
    ...dose,
    ...schedule,
    ...routes,
    ...bounds,
    ...rest,
    ...beneath,
  ];
  return `Dosage: ${said.length === 0 ? "nothing stated" : said.join(" · ")}`;
}

/**
 * An item as a person reads it, without its sources: the lines to show, a part with the parts beneath it. A dosage is
 * one line, its dose as the source wrote it with its comparator in words ("at most 2 tablet"), its schedule as "3 per 1
 * day", its route and its bounds; any other quantity is its number, comparator and unit together; any other field is
 * its name in words and its value, by label and then code. A field it has no wording for is shown as its name and value,
 * never dropped.
 */
export function heldInWords(
  item: Pick<HeldItem, "part" | "fields" | "parts">,
): string[] {
  if (item.part === undefined)
    return item.fields.map(
      (it) => `${capital(words(it.name))}: ${valueOf(it)}`,
    );
  const way = last(item.part);
  const [name] = way.split(" ");
  if (name === "structuredDosage") return [dosageIn(item)];
  const own = fieldsIn(item.fields);
  const label = name === "dosageDoseQuantity" ? "dose" : words(way);
  return [
    ...(own.length === 0 ? [] : [`${capital(label)}: ${own.join(" · ")}`]),
    ...(item.parts ?? []).flatMap(heldInWords),
  ];
}
