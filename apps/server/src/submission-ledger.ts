import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export class SubmissionLedgerError extends Error {
  constructor(readonly code:string,message:string){super(message);}
}

export interface SubmissionReservation {
  /** Only the caller that acquired this fresh batch may undo a proven pre-delivery abort. */
  release(): Promise<void>;
}

/** Durable reservation before IPC delivery. An unconfirmed old request is never replayed. */
export class SubmissionLedger {
  private entries: Record<string,string> = {};
  private chain: Promise<void> = Promise.resolve();
  private constructor(private readonly filename:string){}
  static async create(filename:string):Promise<SubmissionLedger>{
    const ledger=new SubmissionLedger(filename);
    try{
      const data=JSON.parse(await readFile(filename,'utf8'));
      if(data.version!==1||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries)
        ||Object.entries(data.entries).some(([k,v])=>!/^[a-f0-9]{64}$/.test(k)||typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))
        throw Error('Invalid submission ledger; refusing to lose duplicate protection');
      ledger.entries=data.entries;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return ledger;
  }
  async reserve(key:string,payload:string):Promise<void>{
    await this.reserveBatch([key],payload);
  }
  reserveBatch(keys:readonly string[],payload:string):Promise<SubmissionReservation>{
    return this.enqueue(async()=>{
      const ids=[...new Set(keys.map(digest))],fingerprint=digest(payload);
      if(!ids.length)throw Error('Submission reservation must contain at least one key');
      // Check the complete batch before consuming any previously unused question.
      for(const id of ids){
        const existing=this.entries[id];
        if(!existing)continue;
        if(existing!==fingerprint)throw new SubmissionLedgerError('idempotency_conflict','同一消息标识对应不同内容，已拒绝提交。');
        throw new SubmissionLedgerError('submission_state_unknown','此消息曾由 Bridge 接收；重启后不会自动重发。请刷新历史确认执行结果。');
      }
      if(Object.keys(this.entries).length+ids.length>50000)throw Error('Submission ledger is full; archive it after confirming pending messages');
      const next={...this.entries};
      for(const id of ids)next[id]=fingerprint;
      await this.persist(next);
      let released:Promise<void>|undefined;
      return {release:()=>released??=this.enqueue(async()=>{
        if(ids.some(id=>this.entries[id]!==fingerprint))throw Error('Submission reservation ownership changed; refusing to release');
        const next={...this.entries};
        for(const id of ids)delete next[id];
        await this.persist(next);
      })};
    });
  }
  private enqueue<T>(operation:()=>Promise<T>):Promise<T>{
    const result=this.chain.then(operation);
    this.chain=result.then(()=>{},()=>{});
    return result;
  }
  private async persist(next:Record<string,string>):Promise<void>{
    await mkdir(dirname(this.filename),{recursive:true});
    const temporary=this.filename+'.'+randomUUID()+'.tmp';
    try{
      const handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({version:1,entries:next}));await handle.sync();}finally{await handle.close();}
      await rename(temporary,this.filename);
      this.entries=next;
    }finally{await unlink(temporary).catch(()=>{});}
  }
}
function digest(value:string):string{return createHash('sha256').update(value).digest('hex');}
