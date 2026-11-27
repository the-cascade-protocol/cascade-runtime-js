import type { Database } from "./database.js";
import { BLANK, dayKey, instantKey, parsedNt } from "./statements.js";

const CASCADE = "https://ns.cascadeprotocol.org/cascade#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

/** One change a keyed run may be given over a pod's statements, named, and what it puts in scope. */
export interface KeyedChange {
  readonly name: string;
  /** Makes the change on the database and gives the terms (ids) the keyed run is given in scope. */
  readonly make: (db: Database) => number[];
}

/** Each kind of change, by the pattern its changes' names match. */
export const KEYED_KINDS: Readonly<Record<string, RegExp>> = {
  unchanged: / unchanged$/,
  moved: / moved out of entry /,
  "agent renamed": /^agent .* renamed$/,
  "reasons dropped": /'s reasons dropped$/,
  "entry renamed": / its records give reasons for renamed, /,
  "reason given": / given condition .* as a reason$/,
  "record put in an entry": /^a record with no reason put in entry /,
  "record taken out of an entry":
    /^a record with no reason taken out of entry /,
  "document retrieved again": / retrieved again$/,
};

/** Which kind of change a keyed run's change of that name is, or undefined where it is of none. */
export function keyedKind(name: string): string | undefined {
  return Object.entries(KEYED_KINDS).find(([, pattern]) =>
    pattern.test(name),
  )?.[0];
}

const ids = (db: Database, text: string, ...parameters: unknown[]): number[] =>
  db
    .prepare(text)
    .all(...parameters)
    .map((row) => Number(Object.values(row)[0]));

const termId = (db: Database, iri: string): number | undefined => {
  const found = db
    .prepare("SELECT id FROM term WHERE nt = ?")
    .get(`<${iri}>`)?.id;
  return found === undefined ? undefined : Number(found);
};

/** The id of the term N-Triples writes, made where the pod has none. */
function made(db: Database, nt: string): number {
  const held = db.prepare("SELECT id FROM term WHERE nt = ?").get(nt)?.id;
  if (held !== undefined) return Number(held);
  const term = parsedNt(nt);
  db.prepare(
    "INSERT INTO term (nt, kind, lex, datatype, lang, instant, day) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    nt,
    term.kind,
    term.kind === BLANK ? null : term.value,
    term.datatype ?? null,
    term.lang ?? null,
    instantKey(term),
    dayKey(term),
  );
  return Number(db.prepare("SELECT id FROM term WHERE nt = ?").get(nt)?.id);
}

const madeIri = (db: Database, iri: string): number => made(db, `<${iri}>`);

function lexOf(db: Database, id: number): string {
  return String(db.prepare("SELECT lex FROM term WHERE id = ?").get(id)?.lex);
}

/** Each statement of the subjects by the predicates given one new name as its object. */
function renamed(
  db: Database,
  subjects: readonly number[],
  predicates: readonly number[],
): void {
  const name = made(db, '"renamed"');
  const update = db.prepare(
    "UPDATE OR IGNORE quad SET o = ? WHERE s = ? AND p = ?",
  );
  for (const subject of subjects)
    for (const predicate of predicates) update.run(name, subject, predicate);
}

/**
 * Each change a keyed run may be given over the pod's statements, named: a record of each entry unchanged; each record
 * but the lead of an entry of two or more, moved to an entry of its own; each agent, renamed; each record whose current
 * version gives a reason condition, its reasons dropped, and given each other condition's record as a reason; each entry
 * such a record is in, its lead's name changed, the record in scope, and changed as a new record whose version gives no
 * reason is put in it or, after `refill`, taken out of it again, that record alone in scope; and each document a
 * record's current revision derives from, retrieved again.
 */
export function keyedChanges(
  db: Database,
  refill: (db: Database) => void,
): KeyedChange[] {
  const [
    inEntry,
    lead,
    member,
    agent,
    label,
    foafName,
    current,
    reason,
    rdfType,
    conditionKind,
    ...nameTerms
  ] = [
    `${CASCADE}inEntry`,
    `${CASCADE}leadMember`,
    `${CASCADE}entryMember`,
    "http://www.w3.org/ns/prov#agent",
    "http://www.w3.org/2000/01/rdf-schema#label",
    "http://xmlns.com/foaf/0.1/name",
    "http://purl.org/pav/hasCurrentVersion",
    `${CASCADE}reasonCondition`,
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    `${CASCADE}ProblemOrDiagnosis`,
    `${CASCADE}drugName`,
    `${CASCADE}procedureName`,
    `${CASCADE}vaccineName`,
  ].map((iri) => termId(db, iri));
  if (inEntry === undefined) return [];
  const names = nameTerms.flatMap((term) => term ?? []);
  const changes: KeyedChange[] = [];
  const entries = new Map<number, number[]>();
  for (const row of db
    .prepare("SELECT DISTINCT s, o FROM quad WHERE p = ? ORDER BY s, o")
    .all(inEntry))
    entries.set(Number(row.o), [
      ...(entries.get(Number(row.o)) ?? []),
      Number(row.s),
    ]);
  const lex = (id: number): string => lexOf(db, id);
  for (const [entry, records] of entries) {
    const leads = new Set(
      lead === undefined
        ? []
        : ids(db, "SELECT o FROM quad WHERE s = ? AND p = ?", entry, lead),
    );
    const kept = records.find((record) => !leads.has(record)) ?? records[0];
    if (kept !== undefined)
      changes.push({
        name: `record ${lex(kept)} unchanged`,
        make: () => [kept],
      });
    if (records.length > 1 && lead !== undefined && member !== undefined)
      for (const record of records
        .filter((each) => !leads.has(each))
        .sort((a, b) => a - b))
        changes.push({
          name: `record ${lex(record)} moved out of entry ${lex(entry)}`,
          make: (c) => {
            const apart = madeIri(c, `urn:cascade:entry:moved-${lex(record)}`);
            c.prepare(
              "UPDATE quad SET o = ? WHERE s = ? AND p = ? AND o = ?",
            ).run(apart, record, inEntry, entry);
            c.prepare(
              "UPDATE quad SET s = ? WHERE s = ? AND p = ? AND o = ?",
            ).run(apart, entry, member, record);
            c.prepare(
              "INSERT OR IGNORE INTO quad (s, p, o, g) SELECT ?, ?, ?, g FROM quad WHERE s = ? AND p = ?",
            ).run(apart, lead, record, entry, lead);
            return [record];
          },
        });
  }
  const agents =
    agent === undefined
      ? []
      : ids(db, "SELECT DISTINCT o FROM quad WHERE p = ?", agent);
  for (const named of agents)
    changes.push({
      name: `agent ${lex(named)} renamed`,
      make: (c) => {
        const versions =
          current === undefined
            ? []
            : ids(
                c,
                "SELECT o FROM quad WHERE s = ? AND p = ?",
                named,
                current,
              );
        if (label !== undefined) renamed(c, [named], [label]);
        if (foafName !== undefined) renamed(c, versions, [foafName]);
        return [named];
      },
    });
  const given =
    reason === undefined || current === undefined
      ? []
      : db
          .prepare(
            "SELECT DISTINCT r.s AS record, e.o AS entry, v.o AS version FROM quad r JOIN quad v ON v.s = r.s AND v.p = ? JOIN quad x ON x.s = v.o AND x.p = ? " +
              "JOIN quad e ON e.s = r.s AND e.p = ? ORDER BY r.s, e.o, v.o",
          )
          .all(current, reason, inEntry)
          .map((row) => ({
            record: Number(row.record),
            entry: Number(row.entry),
            version: Number(row.version),
          }));
  const leadVersions = (c: Database, entry: number): number[] =>
    lead === undefined || current === undefined
      ? []
      : ids(
          c,
          "SELECT v.o FROM quad l JOIN quad v ON v.s = l.o AND v.p = ? WHERE l.s = ? AND l.p = ?",
          current,
          entry,
          lead,
        );
  for (const { record, entry, version } of given) {
    changes.push({
      name: `record ${lex(record)}'s reasons dropped`,
      make: (c) => {
        c.prepare("DELETE FROM quad WHERE s = ? AND p = ?").run(
          version,
          reason as number,
        );
        return [record];
      },
    });
    changes.push({
      name: `entry ${lex(entry)} its records give reasons for renamed, ${lex(record)} in scope`,
      make: (c) => {
        renamed(c, leadVersions(c, entry), names);
        return [record];
      },
    });
    if (rdfType === undefined || conditionKind === undefined) continue;
    for (const condition of ids(
      db,
      "SELECT DISTINCT q.s FROM quad q JOIN quad t ON t.s = q.s AND t.p = ? AND t.o = ? WHERE q.p = ? " +
        "AND q.s NOT IN (SELECT o FROM quad WHERE s = ? AND p = ?)",
      rdfType,
      conditionKind,
      inEntry,
      version,
      reason as number,
    ))
      changes.push({
        name: `record ${lex(record)} given condition ${lex(condition)} as a reason`,
        make: (c) => {
          c.prepare(
            "INSERT INTO quad (s, p, o, g) SELECT s, p, ?, g FROM quad WHERE s = ? AND p = ? LIMIT 1",
          ).run(condition, version, reason as number);
          return [record];
        },
      });
  }
  const joined = (c: Database, entry: number, like: number): number => {
    const record = madeIri(c, `urn:cascade:joined-${lex(entry)}`);
    const version = madeIri(c, `urn:cascade:joined-${lex(entry)}-version`);
    const graph = c
      .prepare("SELECT g FROM quad WHERE s = ? AND p = ? LIMIT 1")
      .get(like, inEntry)?.g;
    const put = c.prepare(
      "INSERT OR IGNORE INTO quad (s, p, o, g) VALUES (?, ?, ?, ?)",
    );
    put.run(record, inEntry, entry, graph);
    put.run(entry, member as number, record, graph);
    put.run(record, current as number, version, graph);
    c.prepare(
      "INSERT OR IGNORE INTO quad (s, p, o, g) SELECT ?, p, o, g FROM quad WHERE s = ? AND p = ?",
    ).run(record, like, rdfType as number);
    return record;
  };
  const likeEntry = new Map<number, number>();
  for (const { record, entry } of given) likeEntry.set(entry, record);
  if (member !== undefined && current !== undefined && rdfType !== undefined)
    for (const [entry, like] of [...likeEntry].sort((a, b) => a[0] - b[0])) {
      changes.push({
        name: `a record with no reason put in entry ${lex(entry)}, which is renamed, it alone in scope`,
        make: (c) => {
          const record = joined(c, entry, like);
          renamed(c, leadVersions(c, entry), names);
          return [record];
        },
      });
      changes.push({
        name: `a record with no reason taken out of entry ${lex(entry)}, which is renamed, it alone in scope`,
        make: (c) => {
          const record = joined(c, entry, like);
          refill(c);
          c.prepare(
            "DELETE FROM quad WHERE (? = s OR ? = o) AND p IN (?, ?, ?)",
          ).run(record, record, inEntry, member, current);
          renamed(c, leadVersions(c, entry), names);
          return [record];
        },
      });
    }
  const derivedFrom = termId(db, "http://www.w3.org/ns/prov#wasDerivedFrom");
  const currentRevision = termId(db, `${CASCADE}currentRevision`);
  const documents =
    derivedFrom === undefined || currentRevision === undefined
      ? []
      : ids(
          db,
          "SELECT DISTINCT d.o FROM quad r JOIN quad d ON d.s = r.o AND d.p = ? WHERE r.p = ? ORDER BY d.o",
          derivedFrom,
          currentRevision,
        );
  for (const document of documents)
    changes.push({
      name: `document ${lex(document)} retrieved again`,
      make: (c) => {
        const retrieved = madeIri(c, "http://purl.org/pav/retrievedOn");
        const when = made(c, `"2030-01-01T00:00:00Z"^^<${XSD}dateTime>`);
        c.prepare(
          "INSERT OR IGNORE INTO quad (s, p, o, g) SELECT ?, ?, ?, g FROM quad WHERE o = ? AND p = ? LIMIT 1",
        ).run(document, retrieved, when, document, derivedFrom as number);
        return [document];
      },
    });
  return changes;
}

const SCHEMA_TABLES = new Set(["term", "quad", "scope", "asked", "ledger"]);

/** The rows of each table a screen made, by table, each table's rows written out and sorted. */
export function screenTables(db: Database): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all()) {
    const table = String(name);
    if (SCHEMA_TABLES.has(table)) continue;
    found.set(
      table,
      db
        .prepare(`SELECT * FROM "${table}"`)
        .all()
        .map((row) => JSON.stringify(Object.values(row)))
        .sort(),
    );
  }
  return found;
}

let undoDepth = 0;

/** Runs `work` on the database, and puts back all it wrote: held in a savepoint, nested in any it is already held by. */
export function undone<T>(db: Database, work: () => T): T {
  const name = `undone_${(undoDepth += 1)}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    return work();
  } finally {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    undoDepth -= 1;
  }
}
