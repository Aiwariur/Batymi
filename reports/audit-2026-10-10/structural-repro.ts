// Run from Batymi: node_modules/.bin/tsx reports/audit-2026-10-10/structural-repro.ts
// Reproduces current defects; all services are mocked, no real API calls.
import assert from 'node:assert/strict';
import { assembleCrmHistory } from '../../src/conversation/crm-history';
import { planCooperation } from '../../src/conversation/cooperation-agent';
import { createHarness } from '../../tests/helpers/harness';
import { handleConversationJob } from '../../src/conversation/conversation.service';
import { RealCrmClient } from '../../src/crm/crm.client';
import { normalizeGreenApiWebhook } from '../../src/webhooks/greenapi.normalizer';

const line='test-line';
function record(name:string,observed:unknown){ console.log(JSON.stringify({name,observed})); }
async function main(){
 const phoneManual=assembleCrmHistory([
  {id:1,direction:'outgoing',sender:'agent',instance_id:line,text:'Готовы сотрудничать?',sent_at:'2026-10-10T08:00:00Z'},
  {id:2,direction:'outgoing',sender:'phone',instance_id:line,text:'Отвечаю лично, дальше веду разговор сам',sent_at:'2026-10-10T08:01:00Z'},
 ],[],[],line);
 assert.equal(phoneManual.managerTakeover,false);
 record('manual_phone_not_detected',{managerTakeover:phoneManual.managerTakeover});

 const audio=assembleCrmHistory([
  {id:1,direction:'incoming',sender:null,instance_id:line,text:'🎵 Аудио',sent_at:'2026-10-10T08:00:00Z',message_id:'voice-1'},
 ],[{role:'user',content:'Да, готов сотрудничать',ts:1791619200000,messageId:'voice-1'}],[],line);
 assert.equal(audio.history[0].content,'🎵 Аудио');
 record('audio_transcript_discarded',{contents:audio.history.map(x=>x.content)});

 const normalized=normalizeGreenApiWebhook(line,{typeWebhook:'incomingMessageReceived',idMessage:'previous-owner',timestamp:1791619260,
  senderData:{chatId:'995555700090@c.us'},messageData:{typeMessage:'textMessage',textMessageData:{textMessage:'Какая квартира?'}}});
 assert.ok(normalized);
 const mixed=assembleCrmHistory([
  {id:1,direction:'outgoing',sender:null,instance_id:line,text:'Первое предложение сотрудничества',sent_at:'2026-10-10T08:00:00Z'},
 ],[{role:'user',content:'Ответ собственника минутой позже',ts:normalized.timestamp,messageId:'previous-owner'}],[],line);
 assert.equal(mixed.history[0].role,'user');
 record('seconds_vs_milliseconds',{order:mixed.history.map(x=>({role:x.role,ts:x.ts}))});

 const listings=[{id:102,address:'Тестовая улица, 31',url:'https://example.com/flat/102'}];
 const interactions=[{id:1,direction:'outgoing' as const,sender:null,instance_id:line,text:'Первое предложение',sent_at:'2026-10-10T08:00:00Z',notes:'cooperation_outreach:v1:102'}];
 const wrongAddress=await planCooperation({complete:async()=>JSON.stringify({reply:'Пишу по адресу: Выдуманная улица, 99. Готовы сотрудничать?',actions:[],stopConversation:false})},
  {history:[],batchText:'Какая квартира?',listings,interactions,instanceId:line});
 assert.ok(wrongAddress.reply.includes('Выдуманная'));
 record('address_only_not_grounded',{reply:wrongAddress.reply,selectedListingId:wrongAddress.selectedListingId});

 const internal='https://admin.batumi-key.homes/flat/102';
 const internalReply=await planCooperation({complete:async()=>JSON.stringify({reply:internal,selectedListingId:102,actions:[],stopConversation:false})},
  {history:[],batchText:'Ссылку?',listings:[{...listings[0],url:internal}],interactions,instanceId:line});
 assert.equal(internalReply.reply,internal);
 record('internal_url_not_excluded',{reply:internalReply.reply});

 const h=createHarness({OWNER_DIALOGUE_MODE:'cooperation_only'});
 const instanceId=h.config.instances[0].id,phone='+995555700090',chatId=phone.slice(1)+'@c.us';
 h.crm.setContactState(phone,{status:'new',listings:[{id:102,address:'Тестовая улица, 31'}] as never});
 let calls=0;
 h.services.llm.complete=async()=>{calls++;if(calls===2)await h.ingest(h.makeMessage({instanceId,chatId,text:'Вы получили сообщение?'}));throw new Error('synthetic temporary model failure');};
 await h.ingest(h.makeMessage({instanceId,chatId,text:'Какая квартира?'}));
 const outcomes=await h.scheduler.runAll();
 const key=h.key(instanceId,chatId);
 assert.equal(outcomes.at(-1)?.status,'failed');assert.equal(h.scheduler.jobs.length,0);
 assert.ok(await h.store.getActiveBatch(key));assert.equal(await h.store.pendingCount(key),1);
 record('retry_exhaustion_strands_batch',{outcomes:outcomes.map(x=>x.status),active:!!await h.store.getActiveBatch(key),pending:await h.store.pendingCount(key),scheduled:h.scheduler.jobs.length});

 const stale=createHarness({OWNER_DIALOGUE_MODE:'cooperation_only'});
 const sid=stale.config.instances[0].id,sk=stale.key(sid,chatId);
 await stale.ingest(stale.makeMessage({instanceId:sid,chatId,text:'Какая квартира?'}));
 const job=stale.scheduler.take()[0];await stale.store.drainPending(sk);
 await stale.store.pushPending(sk,stale.makeMessage({instanceId:sid,chatId,text:'Ещё один вопрос'}));
 await stale.store.setDebounce(sk,job.token,1);await new Promise(r=>setTimeout(r,10));
 const staleResult=await handleConversationJob(job,{attemptsMade:0,maxAttempts:3},stale.services);
 assert.equal(staleResult.status,'skipped');assert.ok(await stale.store.getActiveBatch(sk));assert.equal(await stale.store.pendingCount(sk),1);
 record('expired_token_strands_batch',{status:staleResult.status,active:!!await stale.store.getActiveBatch(sk),pending:await stale.store.pendingCount(sk),scheduled:stale.scheduler.jobs.length});

 const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({success:true,status:'agreed',applied:false,notification:'skipped'}),{status:200});
 try{
  const client=new RealCrmClient({...h.config,crmBaseUrl:'http://synthetic.invalid',crmApiKey:'synthetic'},h.services.logger);
  await client.setStatus(102,'agreed',{cooperationOnly:true});
  record('crm_applied_false_treated_as_success',{setStatusReturnedWithoutError:true});
 } finally{globalThis.fetch=oldFetch;}
}
main().catch(e=>{console.error(e);process.exitCode=1});
