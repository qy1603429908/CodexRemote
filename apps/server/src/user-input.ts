import type { UserInputOption, UserInputQuestion, UserInputRequest } from "@codex-mobile/protocol";
import { canonicalTurns } from "./desktop-ipc-bridge.js";

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";

export function asyncUserInputs(threadId: string, thread: Record<string, unknown>): UserInputRequest[] {
  const turn = record(canonicalTurns(thread).at(-1));
  const turnId = string(turn?.id) ?? string(turn?.turnId);
  if (!turnId || !Array.isArray(turn?.items)) return [];
  const requests: Array<{ itemId: string; questions: UserInputQuestion[] }> = [];
  const answered = new Set<string>();
  for (const value of turn.items) {
    const item = record(value);
    if (!item) continue;
    for (const id of acceptedReplyIds(item)) answered.add(id);
    const itemId = string(item.id) ?? string(item.itemId);
    if (item.type !== "agentMessage" || !itemId || !Array.isArray(item.questions)) continue;
    const questions = item.questions.flatMap((value, index) => {
      const question = normalizeQuestion(value, JSON.stringify(["request_user_input_async", itemId, index]), true);
      return question ? [question] : [];
    });
    if (questions.length) requests.push({ itemId, questions });
  }
  return requests.flatMap(request => {
    const questions = request.questions.filter(question => !answered.has(question.id));
    return questions.length ? [{
      id: JSON.stringify(["async", turnId, request.itemId, questions.map(question => question.id)]),
      threadId, turnId, kind: "async" as const, questions,
    }] : [];
  });
}

export function nativeUserInput(threadId: string, request: { id: string | number; method: string; params?: Record<string, unknown> }, source: "desktop" | "appServer"): UserInputRequest | null {
  const params = request.params;
  if (request.method !== "item/tool/requestUserInput" || !Array.isArray(params?.questions) || typeof params.turnId !== "string") return null;
  const questions = params.questions.flatMap(value => {
    const id = string(record(value)?.id);
    const question = id ? normalizeQuestion(value, id, false) : null;
    return question ? [question] : [];
  });
  if (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length) return null;
  return { id: JSON.stringify(["tool", source, params.turnId, typeof request.id, request.id]), threadId, turnId: params.turnId, kind: "tool", questions };
}

function normalizeQuestion(value: unknown, id: string, async: boolean): UserInputQuestion | null {
  const question = record(value);
  const title = string(question?.title) ?? string(question?.question);
  if (!question || !title) return null;
  const options: UserInputOption[] = Array.isArray(question.options) ? question.options.flatMap(value => {
    if (typeof value === "string" && value.trim()) return [{ label: value }];
    const option = record(value);
    return typeof option?.label === "string" && option.label.trim() ? [{ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) }] : [];
  }) : [];
  return { id, title, ...(typeof question.header === "string" ? { header: question.header } : {}), options,
    allowFreeform: typeof question.allowFreeform === "boolean" ? question.allowFreeform : async || options.length === 0 || question.isOther === true,
    ...(typeof question.isSecret === "boolean" ? { isSecret: question.isSecret } : {}),
    ...(typeof question.multiSelect === "boolean" ? { multiSelect: question.multiSelect } : {}),
  };
}

function acceptedReplyIds(item: Record<string, unknown>): string[] {
  if (item.type !== "userMessage" && !(item.type === "steeringUserMessage" && (item.status === "accepted" || item.steerAcknowledged === true))) return [];
  const content = item.type === "userMessage" ? item.content : item.input;
  if (!Array.isArray(content)) return [];
  const text = content.flatMap(value => { const part = record(value); return part?.type === "text" && typeof part.text === "string" ? [part.text] : []; }).join("\n").trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return [];
  try {
    const parsed = JSON.parse(text.slice(OPEN.length, -CLOSE.length));
    const replies: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (!replies.length || !replies.every(value => { const reply = record(value); return typeof reply?.questionItemId === "string" && typeof reply.question === "string" && typeof reply.answer === "string"; })) return [];
    return replies.map(value => (value as { questionItemId: string }).questionItemId);
  } catch { return []; }
}

export function validateUserInputAnswers(questions: UserInputQuestion[], value: unknown): Record<string, string[]> {
  const answers = record(value);
  if (!answers || Object.keys(answers).length !== questions.length || Object.keys(answers).some(id => !questions.some(q => q.id === id))) throw new Error("Answers must match the pending questions.");
  const normalized: Record<string, string[]> = Object.create(null);
  for (const question of questions) {
    const answer = answers[question.id];
    if (!Array.isArray(answer) || !answer.length || answer.length > 50 || (!question.multiSelect && answer.length !== 1) || answer.some(v => typeof v !== "string" || !v.trim() || v.length > 20_000)) throw new Error("Each pending question requires a valid answer.");
    const texts = (answer as string[]).map(v => v.trim());
    if (new Set(texts).size !== texts.length || (!question.allowFreeform && texts.some(text => !question.options.some(option => option.label === text)))) throw new Error("Answer is not an available option.");
    normalized[question.id] = texts;
  }
  return normalized;
}

export function questionReplyText(questions: UserInputQuestion[], answers: Record<string, string[]>): string {
  return `${OPEN}\n${JSON.stringify(questions.map(question => ({ questionItemId: question.id, question: question.title, answer: answers[question.id]!.join("\n") })))}\n${CLOSE}`;
}

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
