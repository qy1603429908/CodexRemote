import { describe, expect, it } from "vitest";
import { asyncUserInputs, nativeUserInput, questionReplyText, validateUserInputAnswers } from "../src/user-input.js";

const questionId = '["request_user_input_async","agent-1",0]';
const question = { id: questionId, title: "Choose?", options: [{ label: "A" }, { label: "B", description: "Second" }], allowFreeform: true };
const history = (items: unknown[]) => ({ turns: [{ id: "turn-1", items }] });
const agent = { id: "agent-1", type: "agentMessage", questions: [{ title: "Choose?", options: ["A", { label: "B", description: "Second" }] }] };
const reply = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-1\\",0]","question":"Choose?","answer":"A"}]\n</send_user_message_question_reply>';

describe("authoritative user input extraction", () => {
  it("normalizes stable async questions and preserves option descriptions", () => {
    expect(asyncUserInputs("thread-1", history([agent]))).toEqual([{
      id: '["async","turn-1","agent-1",["[\\"request_user_input_async\\",\\"agent-1\\",0]"]]', threadId: "thread-1", turnId: "turn-1", kind: "async", questions: [question],
    }]);
  });
  it("subtracts only accepted structured user replies, never tool text or unacknowledged steering", () => {
    for (const item of [{ type: "commandExecution", text: reply }, { type: "steeringUserMessage", input: [{ type: "text", text: reply }], status: "pending" }]) {
      expect(asyncUserInputs("thread-1", history([agent, item]))).toHaveLength(1);
    }
    for (const item of [{ type: "userMessage", content: [{ type: "text", text: reply }] }, { type: "steeringUserMessage", input: [{ type: "text", text: reply }], status: "accepted" }]) {
      expect(asyncUserInputs("thread-1", history([agent, item]))).toEqual([]);
    }
  });
  it("expires older turn questions and ignores malformed replies", () => {
    expect(asyncUserInputs("thread-1", { turns: [...history([agent]).turns, { id: "new", items: [] }] })).toEqual([]);
    expect(asyncUserInputs("thread-1", history([agent, { type: "userMessage", content: [{ type: "text", text: '<send_user_message_question_reply>{"questionItemId":1}</send_user_message_question_reply>' }] }]))).toHaveLength(1);
  });
  it("normalizes native questions, including custom text and secrets", () => {
    expect(nativeUserInput("thread-1", { id: 42, method: "item/tool/requestUserInput", params: { turnId: "t", questions: [{ id: "q", header: "Pick", question: "Choose?", isOther: true, isSecret: true, options: [{ label: "A", description: "First" }] }] } }, "desktop")).toMatchObject({
      id: '["tool","desktop","t","number",42]', kind: "tool", threadId: "thread-1", turnId: "t", questions: [{ id: "q", header: "Pick", title: "Choose?", allowFreeform: true, isSecret: true }],
    });
  });
  it("gives reused typed native RPC IDs distinct identities in different turns", () => {
    const request = { id: 42, method: "item/tool/requestUserInput", params: { turnId: "first", questions: [{ id: "q", question: "Choose?" }] } };
    expect(nativeUserInput("thread-1", request, "desktop")?.id).toBe('["tool","desktop","first","number",42]');
    expect(nativeUserInput("thread-1", { ...request, params: { ...request.params, turnId: "second" } }, "desktop")?.id).toBe('["tool","desktop","second","number",42]');
    expect(nativeUserInput("thread-1", { ...request, id: "42" }, "desktop")?.id).toBe('["tool","desktop","first","string","42"]');
  });
  it("changes async request identity when the Desktop answers part of the pending set", () => {
    const twoQuestions = { ...agent, questions: [...agent.questions, { title: "Second?", options: ["Yes", "No"] }] };
    const before = asyncUserInputs("thread-1", history([twoQuestions]))[0]!;
    const after = asyncUserInputs("thread-1", history([twoQuestions, { type: "userMessage", content: [{ type: "text", text: reply }] }]))[0]!;
    expect(before.questions).toHaveLength(2);
    expect(after.questions.map(question => question.id)).toEqual(['["request_user_input_async","agent-1",1]']);
    expect(after.id).not.toBe(before.id);
  });
});

describe("answer validation", () => {
  it("builds the Desktop envelope from authoritative questions", () => {
    expect(questionReplyText([question], { [questionId]: ["custom <text>"] })).toBe('<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"agent-1\\",0]","question":"Choose?","answer":"custom <text>"}]\n</send_user_message_question_reply>');
  });
  it("rejects unknown IDs, missing/blank answers, multiple single answers and non-option values", () => {
    for (const answers of [{ unknown: ["A"] }, {}, { [questionId]: [""] }, { [questionId]: ["A", "B"] }]) expect(() => validateUserInputAnswers([question], answers)).toThrow();
    expect(() => validateUserInputAnswers([{ ...question, allowFreeform: false }], { [questionId]: ["custom"] })).toThrow();
    expect(validateUserInputAnswers([{ ...question, multiSelect: true }], { [questionId]: ["A", "B"] })).toEqual({ [questionId]: ["A", "B"] });
  });
});
