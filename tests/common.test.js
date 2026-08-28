import assert from "node:assert/strict";
import test from "node:test";
import { clean, extractId, numeric, prune } from "../dist/core/common.js";
import { toYaml } from "../dist/format.js";

test("extracts Zap identifiers from IDs and URLs", () => {
  assert.equal(extractId("1252741", "modelid"), "1252741");
  assert.equal(extractId("https://www.zap.co.il/model.aspx?modelid=1252741", "modelid"), "1252741");
  assert.equal(extractId("https://www.zap.co.il/clientcard.aspx?siteid=422", "siteid"), "422");
});

test("rejects invalid identifiers", () => assert.throws(() => extractId("bad", "modelid"), /numeric Zap ID/));
test("cleans text and parses prices", () => {
  assert.equal(clean("\u200f  hello   world "), "hello world");
  assert.equal(numeric("₪2,544"), 2544);
});
test("prunes empty values while retaining false and zero", () => {
  assert.deepEqual(prune({ empty: "", false: false, zero: 0, value: "x" }), { false: false, zero: 0, value: "x" });
});
test("YAML preserves Hebrew", () => assert.match(toYaml({ name: "טלויזיות" }), /טלויזיות/));
