// pi-openrig: makes a pi conversation a participant in an OpenRig rig.
//
//   place    /rig attach <rig> [pod] [member] · /rig detach · rig context in the system prompt
//   receive  queue items sent to this address arrive as messages; decision items open a selector
//   send     rig_send_work tool: hand work to a seat through the queue
//   watch    status line (seat states, open items), alerts on needs-input / launch failure, /rig peek
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSseParser } from "./sse.ts";
import { bodyFile, daemonUrl, rig, rigIdFor, rigJson, seatsOf, type Seat } from "./rig.ts";
import {
  type DecisionAnswer, type DecisionQuestion, formatAnswers, optionLabel, orderedOptions, parseDecision,
} from "./decision.ts";

const ENTRY = "pi-openrig-binding";
const TYPED = "직접 입력…";
const LATER = "나중에 (대화로 넘기기)";

// session = the name OpenRig recorded for the claim (inside tmux it is the tmux session name, not addr)
// sessionId = the claim's id, used to release it (names can be ambiguous across rigs)
type Binding = { addr: string; rig: string; rigId: string; nodeId?: string; session?: string; sessionId?: string };

export default function piOpenrig(pi: ExtensionAPI) {
  let binding: Binding | undefined;
  let ctx: ExtensionContext | undefined;
  let abort: AbortController | undefined;
  let connected = false;
  let lastSeq: string | undefined;
  let seats: Seat[] = [];
  const seen = new Set<string>(); // qitem ids already delivered in this process
  const waiting: any[] = []; // items held until the conversation is idle
  let draining = false;

  // ---------- small helpers ----------
  const label = (s: Seat) => s.session.split("@")[0];
  const icon = (state: string) =>
    state === "running" ? "●" : state === "needs_input" ? "!" : state === "idle" ? "○" : "·";

  function refreshStatus() {
    if (!ctx) return;
    if (!binding) return ctx.ui.setStatus("pi-openrig", undefined);
    const others = seats.filter((s) => s.session !== binding!.addr && s.session !== binding!.session);
    const seatText = others.map((s) => `${label(s)}${icon(s.state)}`).join(" ");
    const pend = waiting.length ? ` · 대기 ${waiting.length}` : "";
    ctx.ui.setStatus("pi-openrig", `rig ${binding.addr}${connected ? "" : " (끊김)"}${seatText ? ` · ${seatText}` : ""}${pend}`);
  }

  function alert(title: string, body: string, level: "info" | "warning" | "error" = "info") {
    ctx?.ui.notify(`${title}: ${body}`, level);
    // cmux shows a desktop/sidebar notification even when this tab is not focused
    if (process.env.CMUX_SOCKET_PATH)
      execFile("cmux", ["notify", "--title", title, "--body", body.slice(0, 200)], { timeout: 5000 }, () => {});
  }

  function setEnv(b: Binding | undefined) {
    // bash tool calls inherit process.env, so `rig queue claim` etc. know who is calling
    if (b) { process.env.OPENRIG_SESSION_NAME = b.addr; if (b.nodeId) process.env.OPENRIG_NODE_ID = b.nodeId; }
    else { delete process.env.OPENRIG_SESSION_NAME; delete process.env.OPENRIG_NODE_ID; }
  }

  async function loadSeats() {
    if (binding) seats = await seatsOf(binding.rig);
    refreshStatus();
  }

  // ---------- receive ----------
  async function fetchItem(id: string): Promise<any | undefined> {
    const r = await rig(["queue", "show", id, "--full", "--json"]);
    try { return JSON.parse(r.out); } catch { return undefined; }
  }

  async function arrive(id: string) {
    if (!binding || seen.has(id)) return;
    seen.add(id);
    const q = await fetchItem(id);
    if (!q || q.destinationSession !== binding.addr || q.state !== "pending") return;
    alert(`rig: ${q.sourceSession}`, q.summary ?? id);
    waiting.push(q);
    refreshStatus();
    void drain();
  }

  async function drain() {
    if (draining || !ctx) return;
    draining = true;
    try {
      // a selector or an injected turn must not cut into a running turn
      while (waiting.length && ctx.isIdle()) {
        const q = waiting.shift();
        refreshStatus();
        const qs = parseDecision(String(q.body ?? ""));
        if (Array.isArray(qs) && ctx.hasUI && (await askDecision(q, qs))) continue;
        injectItem(q, typeof qs === "string" ? qs : undefined);
      }
    } finally { draining = false; }
  }

  function injectItem(q: any, decisionError?: string) {
    const text = [
      `[rig 큐 ${q.qitemId}] ${q.sourceSession} → ${binding?.addr}`,
      `제목: ${q.summary ?? "(없음)"}`,
      ...(q.tags?.length ? [`태그: ${q.tags.join(", ")}`] : []),
      ...(decisionError ? [`(결정 블록 오류: ${decisionError})`] : []),
      "",
      String(q.body ?? "").trim(),
      "",
      "---",
      `처리: rig queue claim ${q.qitemId} → 사람에게 보고하거나 일을 이어감 → ` +
        `rig queue update ${q.qitemId} --state done --closure-reason <no-follow-on|blocked_on> ` +
        `(답을 돌려줄 때는 rig queue handoff ${q.qitemId} --to ${q.sourceSession} --summary … --body-file …)`,
    ].join("\n");
    pi.sendUserMessage(text, ctx?.isIdle() ? undefined : { deliverAs: "followUp" });
  }

  /** Returns true when the decision was answered and handed back, false to fall back to the conversation. */
  async function askDecision(q: any, qs: DecisionQuestion[]): Promise<boolean> {
    if (!ctx || !binding) return false;
    const claim = await rig(["queue", "claim", q.qitemId]);
    if (!claim.ok) return false;
    const answers: DecisionAnswer[] = [];
    for (const [i, question] of qs.entries()) {
      const opts = orderedOptions(question);
      const title = `[${q.sourceSession}] ${q.summary ?? "결정 요청"} (${i + 1}/${qs.length})\n${question.question}`;
      const pick = await ctx.ui.select(title, [...opts.map(optionLabel), TYPED, LATER]);
      if (pick === undefined || pick === LATER) {
        await rig(["queue", "unclaim", q.qitemId]);
        if (answers.length === 0) { injectItem(q); return true; }
        // partial answers stay with the conversation, which can finish the decision in chat
        pi.sendUserMessage(`[rig 결정 일부 응답 ${q.qitemId}]\n${formatAnswers(qs, answers, binding.addr, q.qitemId)}\n\n원래 요청:\n${q.body}`,
          ctx.isIdle() ? undefined : { deliverAs: "followUp" });
        return true;
      }
      if (pick === TYPED) {
        const text = await ctx.ui.input(question.question, "답을 입력하세요");
        if (text?.trim()) answers.push({ id: question.id, kind: "typed", text: text.trim() });
        continue;
      }
      const o = opts.find((x) => optionLabel(x) === pick)!;
      answers.push({ id: question.id, kind: "option", optionId: o.id, label: o.label });
    }
    const reply = formatAnswers(qs, answers, binding.addr, q.qitemId);
    const r = await rig(["queue", "handoff", q.qitemId, "--to", q.sourceSession,
      "--summary", `결정 결과: ${q.summary ?? q.qitemId}`.slice(0, 200), "--tags", "decision-answer",
      "--body-file", bodyFile(reply)]);
    if (!r.ok) {
      alert("rig 결정 전달 실패", r.err.slice(0, 200), "error");
      pi.sendUserMessage(`[rig 결정 전달 실패 ${q.qitemId}] ${r.err.slice(0, 300)}\n답:\n${reply}`);
      return true;
    }
    // record in the conversation without starting a turn
    pi.sendMessage({ customType: "pi-openrig", content: `rig 결정 응답 → ${q.sourceSession}\n${reply}`, display: true });
    ctx.ui.notify(`결정을 ${q.sourceSession}에게 보냈습니다.`, "info");
    return true;
  }

  async function catchUp() {
    if (!binding) return;
    const v = await rigJson<any>(["queue", "list", "--destination", binding.addr, "--state", "pending"]);
    for (const q of Array.isArray(v) ? v : v?.items ?? []) if (q.qitemId) await arrive(q.qitemId);
  }

  // ---------- watch ----------
  function onEvent(ev: any) {
    if (!binding) return;
    if ((ev.type === "queue.created" && ev.destinationSession === binding.addr) ||
        (ev.type === "queue.handed_off" && ev.toSession === binding.addr)) {
      void arrive(ev.qitemId);
      return;
    }
    if (ev.rigId !== binding.rigId) return;
    if (ev.type === "agent.activity") {
      const s = seats.find((x) => x.session === ev.sessionName);
      const state = ev.activity?.state ?? "unknown";
      if (s) {
        if (state === "needs_input" && s.state !== "needs_input")
          alert(`rig: ${label(s)} 확인 필요`, ev.activity?.reason ?? "seat가 입력을 기다립니다", "warning");
        s.state = state;
      } else void loadSeats();
      refreshStatus();
    } else if (ev.type === "seat.fresh_launch_failed" || ev.type === "node.startup_failed") {
      alert("rig: seat 실행 실패", `${ev.sessionName ?? ev.nodeId}: ${String(ev.error ?? ev.type).slice(0, 150)}`, "error");
    } else if (ev.type === "node.added" || ev.type === "node.removed" || ev.type === "rig.expanded" || ev.type === "rig.stopped") {
      void loadSeats();
    }
  }

  async function listen() {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    let backoff = 1000;
    while (!ac.signal.aborted && binding) {
      try {
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (lastSeq) headers["Last-Event-ID"] = lastSeq;
        const res = await fetch(`${daemonUrl()}/api/events${lastSeq ? "" : "?replay=0"}`, { headers, signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        connected = true; backoff = 1000;
        await loadSeats();
        await catchUp(); // anything that arrived while disconnected
        const parse = createSseParser();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const e of parse(dec.decode(value, { stream: true }))) {
            if (e.id) lastSeq = e.id;
            try { onEvent(JSON.parse(e.data)); } catch { /* not JSON */ }
          }
        }
      } catch { /* aborted or daemon down */ }
      connected = false; refreshStatus();
      if (ac.signal.aborted) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  function bind(b: Binding | undefined, persist: boolean) {
    binding = b; setEnv(b);
    seats = []; waiting.length = 0;
    if (persist) pi.appendEntry(ENTRY, b ?? null);
    if (b) void listen(); else { abort?.abort(); connected = false; }
    refreshStatus();
  }

  // ---------- place ----------
  pi.on("session_start", async (_e, c) => {
    ctx = c;
    let saved: Binding | undefined;
    for (const e of c.sessionManager.getEntries() as any[])
      if (e.type === "custom" && e.customType === ENTRY) saved = e.data ?? undefined;
    const envAddr = process.env.PI_OPENRIG_ADDR;
    if (!saved && envAddr) {
      const rigName = envAddr.split("@")[1] ?? "";
      saved = { addr: envAddr, rig: rigName, rigId: (await rigIdFor(rigName)) ?? "" };
    }
    if (saved) bind(saved, false);
  });

  pi.on("session_shutdown", async () => abort?.abort());
  pi.on("agent_settled", async (_e, c) => { ctx = c; void drain(); });

  pi.on("before_agent_start", async (event) => {
    if (!binding) return;
    const others = seats.filter((s) => s.session !== binding!.addr && s.session !== binding!.session);
    event.systemPromptOptions.sections.openrig = [
      `이 대화는 OpenRig rig \`${binding.rig}\`에 주소 \`${binding.addr}\`로 연결되어 있다. 이 대화는 사람과 rig 사이의 창구다.`,
      `rig의 다른 seat: ${others.map((s) => `${s.session} (${s.runtime}, ${s.state})`).join(", ") || "(없음)"}`,
      "- 사람이 구체화한 일을 seat에게 맡길 때는 rig_send_work 도구를 쓴다. 맡을 seat가 분명하지 않으면 사람에게 묻는다.",
      "- seat가 이 주소로 보낸 큐 항목은 `[rig 큐 <id>]` 메시지로 들어온다. claim하고, 사람에게 짧게 보고하고, 처리가 끝나면 닫는다.",
      "- seat가 사람의 결정을 받으려면 본문에 ```decision 블록(JSON 질문 1-4개, 선택지 2-4개)을 넣어 이 주소로 보낸다. 확장이 선택 창을 띄우고 답을 큐로 돌려준다.",
      "- seat 화면은 `rig capture <session> --lines 30`, 상태는 `rig ps --nodes --rig " + binding.rig + "`로 본다.",
    ].join("\n");
  });

  // ---------- send ----------
  pi.registerTool({
    name: "rig_send_work",
    label: "Rig: send work",
    description:
      "Hand a piece of work to a seat of the attached OpenRig rig through the durable queue (rig queue create). " +
      "The seat is woken. Use after the human has agreed what should be done.",
    promptSnippet: "Hand work to an OpenRig seat through the queue",
    parameters: Type.Object({
      to: Type.String({ description: "Destination seat session, e.g. orch-lead@my-rig" }),
      summary: Type.String({ description: "One-line subject: what the work is and why this seat" }),
      body: Type.String({ description: "Complete brief: goal, input files, output paths, done criteria, what to report back" }),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags, e.g. project:x,slice:y" })),
    }),
    async execute(_id, p) {
      if (!binding) throw new Error("rig에 연결되어 있지 않다. 사람에게 /rig attach <rig>를 요청한다.");
      const args = ["queue", "create", "--source", binding.addr, "--destination", p.to, "--summary", p.summary,
        "--body-file", bodyFile(p.body), "--json"];
      if (p.tags) args.push("--tags", p.tags);
      const r = await rig(args);
      const id = /qitem-[0-9a-z-]+/.exec(r.out + r.err)?.[0];
      if (!(r.ok && /"qitemId"/.test(r.out))) throw new Error(`rig queue create 실패: ${(r.err || r.out).slice(0, 500)}`);
      return { content: [{ type: "text", text: `보냄: ${id} → ${p.to}` }], details: { qitemId: id } };
    },
  });

  // ---------- commands ----------
  pi.registerCommand("rig", {
    description: "OpenRig: /rig attach <rig> [pod=orch] [member=pi] · status · seats · peek <seat> [lines] · detach",
    handler: async (args, c) => {
      ctx = c;
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

      if (sub === "attach") {
        const [rigName, pod = "orch", member = "pi"] = rest;
        if (!rigName) return c.ui.notify("사용법: /rig attach <rig> [pod=orch] [member=pi]", "warning");
        const rigId = await rigIdFor(rigName);
        if (!rigId) return c.ui.notify(`rig를 찾지 못했습니다: ${rigName}`, "error");
        const addr = `${pod}-${member}@${rigName}`;
        const attach = async (where: string[]) => {
          const r = await rig(["attach", "--self", "--rig", rigId, ...where, "--display-name", addr, "--cwd", c.cwd, "--json"]);
          try { return JSON.parse(r.out); } catch { return { ok: false, error: r.err.slice(0, 200) }; }
        };
        let j = await attach(["--pod", pod, "--member", member, "--runtime", "pi"]);
        // the address exists already (attached before): claim that node again
        const reused = !j.ok && j.code === "duplicate_logical_id";
        if (reused) j = await attach(["--node", `${pod}.${member}`]);
        if (!j.ok) return c.ui.notify(`attach 실패: ${j.error ?? "알 수 없는 오류"}`, "error");
        bind({ addr, rig: rigName, rigId, nodeId: j.nodeId, session: j.sessionName, sessionId: j.sessionId }, true);
        return c.ui.notify(`연결됨: ${addr}${reused ? " (기존 주소 재사용)" : ""}`, "info");
      }

      if (sub === "detach") {
        if (!binding) return c.ui.notify("연결된 rig가 없습니다.", "info");
        const addr = binding.addr;
        const r = await rig(["unclaim", binding.sessionId ?? binding.session ?? addr]);
        bind(undefined, true);
        return c.ui.notify(`해제: ${addr}${r.ok ? "" : ` (unclaim 실패: ${r.err.slice(0, 120)})`}`, r.ok ? "info" : "warning");
      }

      if (!binding) return c.ui.notify("연결된 rig가 없습니다. /rig attach <rig> [pod] [member]", "info");

      if (sub === "seats") {
        await loadSeats();
        pi.sendMessage({ customType: "pi-openrig", display: true,
          content: `rig ${binding.rig} seats\n` + (seats.map((s) => `${icon(s.state)} ${s.session} · ${s.runtime} · ${s.state}`).join("\n") || "seat 없음") });
        return;
      }

      if (sub === "peek") {
        const [who, lines = "20"] = rest;
        if (!who) return c.ui.notify("사용법: /rig peek <seat> [lines]", "warning");
        // accepts orch-lead@rig, orch-lead, orch.lead or just the member name lead
        const session = who.includes("@") ? who
          : seats.find((s) => label(s) === who || s.logicalId === who || s.logicalId.split(".").pop() === who)?.session
            ?? `${who}@${binding.rig}`;
        const r = await rig(["capture", session, "--lines", String(Number(lines) || 20)]);
        if (!r.ok) return c.ui.notify(`capture 실패: ${(r.err || r.out).slice(0, 200)}`, "error");
        // shown in the chat so multi-line output stays readable; no turn is started
        pi.sendMessage({ customType: "pi-openrig", content: `rig peek ${session}\n${r.out.trimEnd()}`, display: true });
        return;
      }

      return c.ui.notify(
        `주소 ${binding.addr} · 이벤트 ${connected ? "연결됨" : "끊김"} · 받은 항목 ${seen.size}개 · 대기 ${waiting.length}개 · daemon ${daemonUrl()}`,
        "info");
    },
  });
}
