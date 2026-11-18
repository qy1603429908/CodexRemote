import {useState} from 'react';
import type {QuestionReply,UserInputRequest} from '../types/protocol';
import {collectQuestionAnswers} from '../lib/userInput';
import './question-card.css';

export function HistoryQuestionReply({replies}:{replies:QuestionReply[]}){
  return <div className="question-history" aria-label="已回答的问题">
    <span className="question-status">已回答</span>
    {replies.map(reply=><section className="question-history-item" key={reply.questionItemId}>
      <p className="question-history-title">{reply.question}</p>
      <p className="question-history-answer">{reply.answer}</p>
    </section>)}
  </div>;
}

export function UserQuestionCard({request,connected,onAnswer}:{
  request:UserInputRequest;connected:boolean;
  onAnswer:(request:UserInputRequest,answers:Record<string,string[]>)=>Promise<boolean>;
}){
  const [selected,setSelected]=useState<Record<string,string[]>>({});
  const [custom,setCustom]=useState<Record<string,string>>({});
  const [submitting,setSubmitting]=useState(false);
  const [error,setError]=useState('');
  const answers=collectQuestionAnswers(request,selected,custom);
  const disabled=!connected||submitting;
  const choose=(id:string,label:string,multiple:boolean)=>{
    setSelected(current=>({...current,[id]:multiple?(current[id]??[]).includes(label)?current[id]!.filter(value=>value!==label):[...(current[id]??[]),label]:[label]}));
    if(!multiple)setCustom(current=>({...current,[id]:''}));
  };
  return <form className="user-question-card" onSubmit={async event=>{
    event.preventDefault();if(disabled||!answers)return;
    setSubmitting(true);setError('');
    try{if(!await onAnswer(request,answers))setError('回答尚未确认。请查看连接状态或错误提示，确认后再操作。');}
    catch{setError('回答未能确认，请刷新会话核实。');}
    finally{setSubmitting(false);}
  }}>
    <header><span className="question-status">需要你回答</span><h3>Agent 有问题需要确认</h3></header>
    {request.questions.map((question,index)=><fieldset key={question.id} disabled={disabled}>
      <legend>{request.questions.length>1?`${index+1}. `:''}{question.title}</legend>
      {question.header&&question.header!==question.title&&<p className="question-description">{question.header}</p>}
      <div className="question-options">{question.options.map(option=><label className={`question-option ${(selected[question.id]??[]).includes(option.label)?'is-selected':''}`} key={option.label}>
        <input type={question.multiSelect?'checkbox':'radio'} name={question.id} value={option.label}
          checked={(selected[question.id]??[]).includes(option.label)} onChange={()=>choose(question.id,option.label,!!question.multiSelect)} />
        <span><strong>{option.label}</strong>{option.description&&<small>{option.description}</small>}</span>
      </label>)}</div>
      {question.allowFreeform&&<label className="question-custom"><span>自行填写</span>
        {question.isSecret?<input type="password" autoComplete="off" value={custom[question.id]??''} maxLength={16000} onChange={event=>{
          setCustom(current=>({...current,[question.id]:event.target.value}));if(!question.multiSelect)setSelected(current=>({...current,[question.id]:[]}));
        }} />:<textarea rows={2} value={custom[question.id]??''} maxLength={16000} placeholder="输入你的回答" onChange={event=>{
          setCustom(current=>({...current,[question.id]:event.target.value}));if(!question.multiSelect)setSelected(current=>({...current,[question.id]:[]}));
        }} />}
      </label>}
    </fieldset>)}
    {!connected&&<p className="question-description" role="status">重新连接并确认问题状态后可提交。</p>}
    {error&&<p className="question-error" role="alert">{error}</p>}
    <button className="question-submit" type="submit" disabled={disabled||!answers}>{submitting?'正在提交…':'提交回答'}</button>
  </form>;
}
