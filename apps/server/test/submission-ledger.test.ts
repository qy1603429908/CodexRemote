import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe,it,expect } from 'vitest';
import { SubmissionLedger } from '../src/submission-ledger.js';

describe('submission protection across Bridge restarts',()=>{
 it('reserves before delivery and refuses the same message after restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmr-ledger-'));
  try{
   const file=join(dir,'submissions.json');
   const first=await SubmissionLedger.create(file);await first.reserve('thread:once','payload');
   const restarted=await SubmissionLedger.create(file);
   await expect(restarted.reserve('thread:once','payload')).rejects.toMatchObject({code:'submission_state_unknown'});
   await expect(restarted.reserve('thread:once','other')).rejects.toMatchObject({code:'idempotency_conflict'});
   await expect(restarted.reserve('thread:new','payload')).resolves.toBeUndefined();
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('serializes concurrent reservations so only one caller may deliver',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmr-ledger-'));
  try{
   const ledger=await SubmissionLedger.create(join(dir,'submissions.json'));
   const results=await Promise.allSettled([ledger.reserve('once','same'),ledger.reserve('once','same')]);
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('atomically reserves a question batch and never consumes fresh keys on overlap',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmr-ledger-'));
  try{
   const ledger=await SubmissionLedger.create(join(dir,'submissions.json'));
   expect(ledger.reserveBatch).toBeTypeOf('function');
   await ledger.reserveBatch(['q1','q2'],'question-attempt');
   await expect(ledger.reserveBatch(['q2','q3'],'question-attempt')).rejects.toMatchObject({code:'submission_state_unknown'});
   await expect(ledger.reserveBatch(['q3'],'question-attempt')).resolves.toHaveProperty('release');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('releases only a freshly acquired batch for a proven aborted preflight',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cmr-ledger-'));
  try{
   const filename=join(dir,'submissions.json');
   const ledger=await SubmissionLedger.create(filename);
   expect(ledger.reserveBatch).toBeTypeOf('function');
   const aborted=await ledger.reserveBatch(['q1','q2'],'question-attempt');
   await aborted.release();
   const replacement=await ledger.reserveBatch(['q2'],'question-attempt');
   await aborted.release(); // an old release handle cannot delete a replacement
   const restarted=await SubmissionLedger.create(filename);
   await expect(restarted.reserveBatch(['q2'],'question-attempt')).rejects.toMatchObject({code:'submission_state_unknown'});
   await replacement.release();
   await expect(ledger.reserveBatch(['q2'],'question-attempt')).resolves.toHaveProperty('release');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
