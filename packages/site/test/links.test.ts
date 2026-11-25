import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileHref, ruleHref, termHref } from "../src/links.js";

const FOAF_NAME = "http://xmlns.com/foaf/0.1/name";
const HOST = "https://ns.cascadeprotocol.org/";
const BLOB =
  "https://github.com/the-cascade-protocol/cascade-vocabulary/blob/abc123";

/** Asserts that `call` refuses each base that is the vocabulary's host, however it is written. */
function refusesHost(call: (base: string) => unknown): void {
  for (const base of [
    "http://ns.cascadeprotocol.org/terms/",
    "https://ns.cascadeprotocol.org",
    "HTTPS://NS.CASCADEPROTOCOL.ORG/x",
    HOST,
  ])
    assert.throws(() => call(base), /ns\.cascadeprotocol\.org/, base);
}

/**
 * Every page of the site links what it names through these, so a vocabulary term, a rule and a file each
 * have one address. None of them links `ns.cascadeprotocol.org`, the host of the vocabulary's names, which serves no page.
 */
describe("Linking a vocabulary term, a rule or a file · termHref(), ruleHref(), fileHref()", () => {
  describe("`termHref()`", () => {
    it("keeps the namespace's prefix in the folder of a term's page, as in `terms/foaf/name.html`", () => {
      const known: [string, string][] = [
        [FOAF_NAME, "terms/foaf/name.html"],
        ["http://purl.org/pav/version", "terms/pav/version.html"],
        [
          "http://www.w3.org/ns/prov#wasDerivedFrom",
          "terms/prov/wasDerivedFrom.html",
        ],
        [
          "http://www.w3.org/ns/solid/terms#account",
          "terms/solid/account.html",
        ],
        [
          "https://ns.cascadeprotocol.org/cascade#name",
          "terms/cascade/name.html",
        ],
        [
          "https://ns.cascadeprotocol.org/bridge/v1-draft#Source",
          "terms/bridge/Source.html",
        ],
        [
          "http://www.w3.org/2004/02/skos/core#prefLabel",
          "terms/skos/prefLabel.html",
        ],
        [
          "http://www.w3.org/2004/02/skos/core#Concept",
          "terms/skos/Concept.html",
        ],
        ["http://www.w3.org/2002/07/owl#sameAs", "terms/owl/sameAs.html"],
        [
          "http://purl.obolibrary.org/obo/BFO_0000050",
          "terms/obo/BFO_0000050.html",
        ],
        ["http://rdfs.org/ns/void#inDataset", "terms/void/inDataset.html"],
        [
          "https://w3id.org/sssom/mapping_justification",
          "terms/sssom/mapping_justification.html",
        ],
        ["http://www.w3.org/ns/org#identifier", "terms/org/identifier.html"],
        ["http://www.w3.org/ns/dcat#Dataset", "terms/dcat/Dataset.html"],
      ];
      for (const [iri, href] of known)
        assert.equal(termHref(iri, "terms/"), href, iri);
    });

    it("gives two vocabulary terms of one name two pages, one for each namespace", () => {
      assert.notEqual(
        termHref(FOAF_NAME, "terms/"),
        termHref("https://ns.cascadeprotocol.org/cascade#name", "terms/"),
      );
    });

    it("writes a vocabulary term of a namespace it does not know as a slug of its IRI under `other/`", () => {
      assert.equal(
        termHref("http://example.org/a b#c", "terms/"),
        "terms/other/http-example-org-a-b-c.html",
      );
    });

    it("puts a property's page in `properties/` of its prefix's folder, so `cascade:Subject` and `cascade:subject` are two files on a disk that ignores case", () => {
      const subject = "https://ns.cascadeprotocol.org/cascade#subject";
      assert.equal(
        termHref(subject, "terms/", true),
        "terms/cascade/properties/subject.html",
      );
      assert.equal(
        termHref("https://ns.cascadeprotocol.org/cascade#Subject", "terms/"),
        "terms/cascade/Subject.html",
      );
      assert.equal(
        termHref(FOAF_NAME, "../", true),
        "../foaf/properties/name.html",
      );
      assert.equal(
        termHref("http://example.org/a b#c", "terms/", true),
        "terms/other/properties/http-example-org-a-b-c.html",
      );
    });

    it("takes the folder of the term pages as its base", () => {
      assert.equal(
        termHref("http://www.w3.org/ns/prov#wasDerivedFrom", "../"),
        "../prov/wasDerivedFrom.html",
      );
      assert.equal(
        termHref("http://www.w3.org/ns/solid/terms#account", ""),
        "solid/account.html",
      );
    });

    it("refuses `ns.cascadeprotocol.org` as a base, on either scheme, however it is capitalised", () => {
      refusesHost((base) => termHref(FOAF_NAME, base));
    });
  });

  describe("`ruleHref()`", () => {
    it("links a rule to its feature's page and its number's anchor", () => {
      assert.equal(
        ruleHref("runtime/matcher.feature", "R19", "spec/"),
        "spec/matcher.html#r19",
      );
    });

    it("links a rule numbered with a lower-case letter to its anchor, `m4a`", () => {
      assert.equal(
        ruleHref("runtime/matcher.feature", "M4a", "spec/"),
        "spec/matcher.html#m4a",
      );
    });

    it("links a kit's check to the page named for the kit's folder", () => {
      assert.equal(
        ruleHref("conformance/alex-rivera/alex-rivera.feature", "Check 3", ""),
        "alex-rivera.html#check-3",
      );
    });

    it("refuses `ns.cascadeprotocol.org` as a base", () => {
      assert.throws(
        () => ruleHref("runtime/matcher.feature", "R1", `${HOST}spec/`),
        /ns\.cascadeprotocol\.org/,
      );
    });
  });

  describe("`fileHref()`", () => {
    it("links a file on GitHub from GitHub's address, with or without slashes", () => {
      const file = `${BLOB}/queries/a.rq`;
      assert.equal(fileHref("queries/a.rq", BLOB), file);
      assert.equal(fileHref("queries/a.rq", `${BLOB}/`), file);
      assert.equal(fileHref("/queries/a.rq", BLOB), file);
    });

    it("refuses `ns.cascadeprotocol.org` as a base", () => {
      assert.throws(
        () => fileHref("queries/a.rq", HOST),
        /ns\.cascadeprotocol\.org/,
      );
    });
  });
});
