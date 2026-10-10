// Run only against DISPOSABLE Redis, not production: AUDIT_REDIS_URL=... tsx this file.
// Uses the real BullMQ scheduler/worker and local mock HTTP; never calls CRM/WhatsApp.
import assert from 'node:assert/strict';
import http from 'node:http';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { BullWebhookProxy, createWebhookProxyWorker, webhookForwardJobId } from '../../src/crm/webhook-proxy';
import { BullConversationScheduler } from '../../src/queue/conversation.queue';
import { createConversationWorker } from '../../src/queue/conversation.worker';
import { RedisConversationStore } from '../../src/buffer/redis-store';
import { createHarness } from '../../tests/helpers/harness';
import { ingestMessage } from '../../src/buffer/message-buffer';

const url=process.env.AUDIT_REDIS_URL;
if(!url)throw new Error('AUDIT_REDIS_URL must explicitly target disposable Redis');
async function until(fn:()=>Promise<boolean>,limit=15000){const start=Date.now();while(Date.now()-start<limit){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('probe timed out');}
async function main(){
 const redis=new Redis(url!,{maxRetriesPerRequest:null});
 const h=createHarness({OWNER_DIALOGUE_MODE:'cooperation_only'});
 let received=0,healthy=false;
 const server=http.createServer((req,res)=>{received++;req.resume();res.writeHead(healthy?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:healthy}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as import('node:net').AddressInfo;
 const config={...h.config,mockCrm:false,crmBaseUrl:`http://127.0.0.1:${address.port}/api`,crmApiKey:'synthetic'};
 const proxy=new BullWebhookProxy(redis);
 const proxyWorker=createWebhookProxyWorker(config,h.services.logger,redis);
 const proxyQueue=new Queue('webhook-forward',{connection:redis});
 const convName='audit-conversation-'+Date.now();
 const scheduler=new BullConversationScheduler(redis,convName);
 h.config.queueName=convName;
 h.services.store=new RedisConversationStore(redis);h.services.scheduler=scheduler;
 const worker=createConversationWorker(h.services,redis);
 const convQueue=new Queue(convName,{connection:redis});
 try{
  const payload={typeWebhook:'incomingMessageReceived',idMessage:'synthetic-audit-webhook-'+Date.now()};
  const id=webhookForwardJobId('synthetic-line',payload);
  await proxy.forward('synthetic-line',payload);
  await until(async()=>await(await proxyQueue.getJob(id))?.getState()==='failed');
  const firstCalls=received;healthy=true;
  await proxy.forward('synthetic-line',payload);
  await new Promise(r=>setTimeout(r,500));
  const state=await(await proxyQueue.getJob(id))?.getState();
  assert.equal(state,'failed');assert.equal(received,firstCalls);
  console.log(JSON.stringify({name:'failed_webhook_retry_does_not_requeue',observed:{firstAttempts:firstCalls,state,additionalAttempts:received-firstCalls}}));

  const instanceId=h.config.instances[0].id,chatId='995555700090@c.us',key=h.key(instanceId,chatId);
  const lock=await h.services.store.acquireLock(key,60000);assert.ok(lock);
  let completed:any;
  worker.on('completed',(_,result)=>{completed=result});
  await ingestMessage(h.makeMessage({instanceId,chatId,text:'Какая квартира?'}),h.services);
  await until(async()=>!!completed);
  await new Promise(r=>setTimeout(r,100));
  const counts=await convQueue.getJobCounts('waiting','delayed','active','failed','completed');
  assert.equal(completed.status,'rescheduled');assert.equal(counts.waiting+counts.delayed+counts.active,0);
  assert.equal(await h.services.store.pendingCount(key),1);
  console.log(JSON.stringify({name:'lock_busy_reschedule_duplicate_job_id',observed:{outcome:completed.status,counts,pending:await h.services.store.pendingCount(key)}}));
  await h.services.store.releaseLock(key,lock!.token);
 } finally{
  await worker.close();await proxyWorker.close();await scheduler.close();await proxy.close();await convQueue.close();await proxyQueue.close();await redis.quit();await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
