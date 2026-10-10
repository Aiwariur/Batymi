// Run locally after build, or pipe into `docker exec -i <app> node`.
// Entirely isolated: in-memory store, CRM, LLM, and sender; no external I/O.
const assert = require('node:assert/strict');
const path = require('node:path');
const base = path.resolve(process.env.BATYMI_DIST_DIR || 'dist');
const from = file => require(path.join(base, file));
const { loadConfig } = from('config/env');
const { createLogger } = from('observability/logger');
const { MemoryConversationStore } = from('buffer/memory-store');
const { handleConversationJob } = from('conversation/conversation.service');
const { normalizeGreenApiWebhook } = from('webhooks/greenapi.normalizer');
const { COOPERATION_QUESTION } = from('conversation/cooperation-agent');

function setup(intent) {
  const config = loadConfig({NODE_ENV:'test', MOCK_EXTERNALS:'true', OWNER_DIALOGUE_MODE:'cooperation_only', ALLOWED_MANAGER_IDS:'2', LOG_LEVEL:'silent'});
  assert(config.mockCrm && config.mockLlm && config.mockGreenApi);
  const instanceId=config.instances[0].id,phone='+995555000111',chatId=phone.slice(1)+'@c.us';
  const store=new MemoryConversationStore(),sent=[],writes=[];
  const listings=[{id:101,phone,crm_status:'new',contact_type:'owner',assigned_manager_id:2,address:'Тестовый адрес',url:'https://example.com/flat/101'}];
  let rows=[{id:1,direction:'outgoing',sender:null,instance_id:instanceId,sent_at:new Date().toISOString(),text:COOPERATION_QUESTION,notes:'cooperation_outreach:v1:101'}];
  let calls=0;
  const services={config,store,logger:createLogger({level:'silent',pretty:false}),
    scheduler:{schedule:async()=>{},close:async()=>{}},
    crm:{getListingsByPhone:async()=>listings,getInteractions:async()=>rows,setStatus:async(id,status)=>{writes.push(status);listings[0].crm_status=status;return {applied:true};}},
    sender:{sendMessage:async input=>{sent.push(input.message);return {mocked:true,idMessage:'mock-send-'+sent.length};}},
    llm:{complete:async()=>{calls++;return JSON.stringify({intent,language:'ru'});}},
    transcription:{transcribe:async()=>{throw Error('Unexpected transcription');}},
  };
  let number=0;
  const run=async text=>{
    const now=Math.floor(Date.now()/1000);
    const msg=normalizeGreenApiWebhook(instanceId,{typeWebhook:'incomingMessageReceived',idMessage:'mock-in-'+(++number),timestamp:now,senderData:{chatId,sender:chatId,senderName:'Synthetic'},messageData:{typeMessage:'textMessage',textMessageData:{textMessage:text}}});
    assert(msg);assert(msg.timestamp>1e12);
    const key=instanceId+':'+chatId;
    await store.pushPending(key,msg);await store.setDebounce(key,'mock-token-'+number,60000);
    return handleConversationJob({conversationKey:key,token:'mock-token-'+number},{attemptsMade:0,maxAttempts:3,jobId:'isolated-'+number},services);
  };
  return {run,sent,writes,store,key:instanceId+':'+chatId,get calls(){return calls},setRows:value=>{rows=value}};
}
(async()=>{
  const h=setup('explain_service');
  const first=await h.run('Что вы предлагаете?');assert.equal(first.status,'processed');assert(first.reply.includes('помощь со сдачей'));
  const second=await h.run('Да');assert.equal(second.status,'processed');assert.deepEqual(h.writes,['agreed']);assert.equal(h.sent.length,1);assert.equal(h.calls,1);
  const third=await h.run('Ещё вопрос');assert.equal(third.status,'terminal');assert.equal(h.calls,1);assert.equal(h.sent.length,1);
  const no=setup('ask_cooperation');await no.run('Да');assert.equal(no.calls,0);await no.run('Нет');assert.deepEqual(no.writes,['disagreed']);assert.equal(no.sent.length,1);assert.equal(no.calls,0);
  const manual=setup('explain_service');manual.setRows([{id:2,direction:'outgoing',sender:'phone',instance_id:manual.key.split(':')[0],sent_at:new Date().toISOString(),text:'Manual'}]);
  await manual.run('Какая квартира?');assert.equal(await manual.store.getManualHandoff(manual.key),'manager_takeover');manual.setRows([]);await manual.run('Да');assert.equal(manual.calls,0);assert.equal(manual.sent.length,0);
  console.log(JSON.stringify({isolated:true,checks:['normalized_ingress','service_explanation','consent','post_consent_silence','bare_yes_then_refusal_without_llm','persistent_manual_takeover'],passed:6,realProviderCalls:0,realCrmWrites:0,realWhatsAppSends:0}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
