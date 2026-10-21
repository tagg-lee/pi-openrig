// Decision requests: a seat asks the human a few multiple-choice questions through the pi conversation.
//
// OpenRig's own `--human-intent decision` only accepts a registered human destination, so a seat
// sends an ordinary qitem to the pi address instead: tag `decision` (or no tag) and a fenced block
//
//   ```decision
//   [{"id":"pick","question":"Which cut?","options":[{"id":"b","label":"B"},{"id":"d","label":"D","recommended":true}]}]
//   ```
//
// The schema matches `rig queue create --human-questions-file` (1-4 questions, 2-4 options each),
// so a rig that later registers a human can send the same file there.

export type DecisionOption = { id: string; label: string; recommended?: boolean };
export type DecisionQuestion = { id: string; question: string; options: DecisionOption[] };
export type DecisionAnswer =
  | { id: string; kind: "option"; optionId: string; label: string }
  | { id: string; kind: "typed"; text: string };

const FENCE = /```decision[^\n]*\n([\s\S]*?)```/;

/** Returns the questions, null when the body has no decision block, or an error string when it is malformed. */
export function parseDecision(body: string): DecisionQuestion[] | null | string {
  const m = FENCE.exec(body ?? "");
  if (!m) return null;
  let v: unknown;
  try { v = JSON.parse(m[1]); } catch (e) { return `decision block is not JSON: ${(e as Error).message}`; }
  if (!Array.isArray(v) || v.length < 1 || v.length > 4) return "decision block must be an array of 1-4 questions";
  const ids = new Set<string>();
  for (const [i, q] of v.entries()) {
    if (!q || typeof q.id !== "string" || !q.id || typeof q.question !== "string" || !q.question)
      return `question ${i + 1} needs a non-empty id and question`;
    if (ids.has(q.id)) return `duplicate question id: ${q.id}`;
    ids.add(q.id);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4)
      return `question ${q.id} needs 2-4 options`;
    const oids = new Set<string>();
    let rec = 0;
    for (const o of q.options) {
      if (!o || typeof o.id !== "string" || !o.id || typeof o.label !== "string" || !o.label)
        return `question ${q.id} has an option without id or label`;
      if (oids.has(o.id)) return `question ${q.id} has duplicate option id: ${o.id}`;
      oids.add(o.id);
      if (o.recommended) rec++;
    }
    if (rec > 1) return `question ${q.id} has more than one recommended option`;
  }
  return v as DecisionQuestion[];
}

/** Text shown in the selector for one option. */
export function optionLabel(o: DecisionOption): string {
  return o.recommended ? `${o.label} (추천)` : o.label;
}

/** Recommended option first, the rest in their authored order. */
export function orderedOptions(q: DecisionQuestion): DecisionOption[] {
  return [...q.options.filter((o) => o.recommended), ...q.options.filter((o) => !o.recommended)];
}

/** The reply body the asking seat receives: a readable list plus a machine-readable block. */
export function formatAnswers(qs: DecisionQuestion[], answers: DecisionAnswer[], from: string, qitemId: string): string {
  const lines = [`결정 결과 (${from}, 원 항목 ${qitemId})`, ""];
  for (const q of qs) {
    const a = answers.find((x) => x.id === q.id);
    if (!a) lines.push(`- ${q.question} → (답 없음)`);
    else if (a.kind === "option") lines.push(`- ${q.question} → ${a.label} [${a.optionId}]`);
    else lines.push(`- ${q.question} → 직접 입력: ${a.text}`);
  }
  lines.push("", "```decision-answers", JSON.stringify(answers), "```");
  return lines.join("\n");
}
