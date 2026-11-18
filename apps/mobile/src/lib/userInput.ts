import type {QuestionReply,UserInputRequest} from '../types/protocol';

const opening='<send_user_message_question_reply>';
const closing='</send_user_message_question_reply>';
export function parseQuestionReply(text:string):{replies:QuestionReply[];content:string}|null{
  if(text.length>128*1024)return null;
  const start=text.indexOf(opening),end=text.indexOf(closing,start+opening.length);
  if(start<0||end<0||text.indexOf(opening,start+opening.length)>=0)return null;
  const before=text.slice(0,start),after=text.slice(end+closing.length);
  if((before.match(/^\s*```/gm)?.length??0)%2===1)return null;
  try{
    const parsed:unknown=JSON.parse(text.slice(start+opening.length,end).trim());
    const values=Array.isArray(parsed)?parsed:[parsed];
    if(values.length===0||values.length>100)return null;
    const ids=new Set<string>(),replies:QuestionReply[]=[];
    for(const value of values){
      if(!value||typeof value!=='object'||Array.isArray(value))return null;
      const item=value as Record<string,unknown>;
      if(typeof item.questionItemId!=='string'||!item.questionItemId||typeof item.question!=='string'||typeof item.answer!=='string'
        ||item.questionItemId.length>2048||item.question.length>16000||item.answer.length>16000||ids.has(item.questionItemId))return null;
      ids.add(item.questionItemId);replies.push({questionItemId:item.questionItemId,question:item.question,answer:item.answer});
    }
    return {replies,content:[before.trim(),after.trim()].filter(Boolean).join('\n\n')};
  }catch{return null;}
}

export function collectQuestionAnswers(request:UserInputRequest,selected:Record<string,string[]>,custom:Record<string,string>):Record<string,string[]>|null{
  const result:Record<string,string[]>={};
  if(request.questions.length===0)return null;
  for(const question of request.questions){
    const choices=selected[question.id]??[],free=(custom[question.id]??'').trim();
    if(choices.some(value=>!question.options.some(option=>option.label===value))||new Set(choices).size!==choices.length)return null;
    if(free&&(!question.allowFreeform||free.length>16000))return null;
    const answers=[...choices,...(free?[free]:[])];
    if(answers.length===0||(!question.multiSelect&&answers.length!==1))return null;
    result[question.id]=answers;
  }
  return result;
}
