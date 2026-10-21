import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "../src/sse.ts";
import { formatAnswers, orderedOptions, parseDecision } from "../src/decision.ts";

test("sse: events split across chunks, id kept, CRLF tolerated", () => {
  const parse = createSseParser();
  assert.deepEqual(parse('id: 7\r\ndata: {"a"'), []);
  assert.deepEqual(parse(':1}\r\n\r\nid: 8\ndata: x\n'), [{ id: "7", data: '{"a":1}' }]);
  assert.deepEqual(parse("\n"), [{ id: "8", data: "x" }]);
});

test("sse: comment-only blocks are skipped, multi-line data joined", () => {
  const parse = createSseParser();
  assert.deepEqual(parse(": ping\n\ndata: a\ndata: b\n\n"), [{ id: undefined, data: "a\nb" }]);
});

const good = [
  { id: "pick", question: "후보?", options: [{ id: "b", label: "B" }, { id: "d", label: "D", recommended: true }] },
];
const wrap = (v: unknown) => "앞 설명\n```decision\n" + JSON.stringify(v) + "\n```\n뒤";

test("decision: no block -> null, good block -> questions", () => {
  assert.equal(parseDecision("그냥 보고"), null);
  assert.deepEqual(parseDecision(wrap(good)), good);
});

test("decision: malformed blocks give a reason", () => {
  assert.match(String(parseDecision("```decision\nnot json\n```")), /not JSON/);
  assert.match(String(parseDecision(wrap([]))), /1-4/);
  assert.match(String(parseDecision(wrap([{ id: "a", question: "q", options: [{ id: "x", label: "X" }] }]))), /2-4 options/);
  assert.match(String(parseDecision(wrap([...good, good[0]]))), /duplicate question/);
  const twoRec = [{ id: "a", question: "q", options: [{ id: "x", label: "X", recommended: true }, { id: "y", label: "Y", recommended: true }] }];
  assert.match(String(parseDecision(wrap(twoRec))), /more than one recommended/);
});

test("decision: recommended first, answers formatted with machine block", () => {
  assert.deepEqual(orderedOptions(good[0]).map((o) => o.id), ["d", "b"]);
  const out = formatAnswers(good, [{ id: "pick", kind: "option", optionId: "d", label: "D" }], "orch-pi@r", "qitem-1");
  assert.match(out, /후보\? → D \[d\]/);
  const block = /```decision-answers\n(.*)\n```/.exec(out)![1];
  assert.deepEqual(JSON.parse(block), [{ id: "pick", kind: "option", optionId: "d", label: "D" }]);
});
