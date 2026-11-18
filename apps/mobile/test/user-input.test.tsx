import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseQuestionReply,collectQuestionAnswers} from '../src/lib/userInput';
import {HistoryQuestionReply,UserQuestionCard} from '../src/components/QuestionCard';
import {itemToMessage} from '../src/hooks/useRemote';
import type {UserInputRequest} from '../src/types/protocol';

const reply={questionItemId:'["request_user_input_async","call_123",0]',question:'选择路径？',answer:'D:/some_project'};
const envelope=(value:unknown)=>`<send_user_message_question_reply>\n${JSON.stringify(value)}\n</send_user_message_question_reply>`;
const input:UserInputRequest={id:'input1',threadId:'thread',turnId:'turn',kind:'async',questions:[{id:'q1',title:'选择方案',options:[{label:'A',description:'第一种'},{label:'B'}],allowFreeform:true}]};
describe('structured historical question answers',()=>{
 it('extracts an array and preserves other user text',()=>{
  expect(parseQuestionReply('补充说明\n'+envelope([reply])+'\n附加要求')).toEqual({replies:[reply],content:'补充说明\n\n附加要求'});
 });
 it('also supports the Desktop single-object format',()=>expect(parseQuestionReply(envelope(reply))?.replies).toEqual([reply]));
 it('leaves malformed, ambiguous and oversized records alone',()=>{
  for(const raw of [envelope({answer:'missing identity'}),envelope([reply,reply]),'<send_user_message_question_reply>{broken}</send_user_message_question_reply>','x'.repeat(150000)])expect(parseQuestionReply(raw)).toBeNull();
 });
 it('does not reinterpret a fenced code sample as an actual reply',()=>expect(parseQuestionReply('```text\n'+envelope(reply)+'\n```')).toBeNull());
 it('projects historical user answers into persistent UI metadata',()=>{
  const message=itemToMessage({type:'userMessage',id:'u',content:[{type:'text',text:envelope(reply)}]},'thread','turn',0);
  expect(message?.questionReplies).toEqual([reply]);
  expect(message?.content).not.toContain('send_user_message_question_reply');
 });
 it('renders answer contents as text and keeps underscores intact',()=>{
  const html=renderToStaticMarkup(<HistoryQuestionReply replies={[{...reply,answer:'<img src=x onerror=alert(1)> my_answer'}]} />);
  expect(html).toContain('my_answer');expect(html).toContain('&lt;img');expect(html).not.toContain('<img');
 });
});
describe('mobile question forms',()=>{
 it('collects an option or a freeform answer, never silently selects the first option',()=>{
  expect(collectQuestionAnswers(input,{},{})).toBeNull();
  expect(collectQuestionAnswers(input,{q1:['B']},{})).toEqual({q1:['B']});
  expect(collectQuestionAnswers(input,{}, {q1:' 自定义 '})).toEqual({q1:['自定义']});
 });
 it('rejects freeform when not offered and rejects obsolete/unknown option selections',()=>{
  const restricted={...input,questions:[{...input.questions[0]!,allowFreeform:false}]};
  expect(collectQuestionAnswers(restricted,{}, {q1:'unknown'})).toBeNull();
  expect(collectQuestionAnswers(input,{q1:['removed']},{})).toBeNull();
 });
 it('supports explicit multi-select without dropping custom text',()=>{
  const multi={...input,questions:[{...input.questions[0]!,multiSelect:true}]};
  expect(collectQuestionAnswers(multi,{q1:['A','B']},{q1:'other'})).toEqual({q1:['A','B','other']});
  expect(collectQuestionAnswers(input,{q1:['A','B']},{})).toBeNull();
 });
 it('renders named accessible choices, text field and disabled submit before any answer',()=>{
  const html=renderToStaticMarkup(<UserQuestionCard request={input} connected onAnswer={async()=>true} />);
  expect(html).toContain('选择方案');expect(html).toContain('第一种');expect(html).toContain('自行填写');expect(html).toContain('type="radio"');expect(html).toMatch(/disabled[^>]*>提交回答/);
 });
});
