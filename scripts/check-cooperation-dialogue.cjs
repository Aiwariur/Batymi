// Synthetic owner messages only. No CRM writes or WhatsApp provider calls.
const { execFileSync } = require('node:child_process');
const { planCooperation, COOPERATION_QUESTION } = require('../dist/conversation/cooperation-agent');
const { OpenAiCompatibleProvider, LlmError } = require('../dist/agent/llm.provider');
const { loadConfig } = require('../dist/config/env');
const { createLogger } = require('../dist/observability/logger');
let config;
if (process.argv.includes('--production-model')) {
  const remote = `const {loadConfig}=require('/app/dist/config/env');const c=loadConfig();process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k])=>k.startsWith('llm')))));`;
  config = JSON.parse(execFileSync('ssh', ['-i', `${process.env.USERPROFILE}/.ssh/id_ed25519`, '-o', 'BatchMode=yes', 'root@162.55.163.35',
    'docker exec -i $(docker ps --format "{{.Names}}" | grep "^app-whmhbopxj4li56vh7pmsaf2s-" | head -1) node'], {input: remote, encoding:'utf8'}));
} else config = loadConfig();
const llm = new OpenAiCompatibleProvider(config, createLogger({level:'silent',pretty:false}));
const instanceId='synthetic-dialogue-check';
const listing={id:102,address:'Тестовая улица, 31',url:'https://example.com/flat/102',contact_type:'potential_owner',crm_status:'delivered'};
const initial='Здравствуйте! Пишу по поводу вашей квартиры по адресу: Тестовая улица, 31. '+COOPERATION_QUESTION;
const interaction={id:1,direction:'outgoing',sender:null,instance_id:instanceId,sent_at:'2026-10-10T08:00:00Z',text:initial,notes:'cooperation_outreach:v1:102'};
const cases=[
 ['consent_ru','Да, готов сотрудничать','agreed'],
 ['consent_en','Yes, happy to work with your agency','agreed'],
 ['consent_ka','დიახ, მზად ვარ სააგენტოსთან თანამშრომლობისთვის','agreed'],
 ['consent_translit','Da, gotov sotrudnichat','agreed'],
 ['availability_only','Да, квартира ещё актуальна','reply'],
 ['initial_bare_yes','Да','reply'],
 ['availability_both','Здравствуйте. Да обе квартиры актуальны','reply'],
 ['refusal','С агентствами не сотрудничаю','disagreed'],
 ['refusal_en','No, I do not work with agencies','disagreed'],
 ['rented','Здравствуйте, вчера уже сдал','listing_removed'],
 ['unclear_resolved','Здравствуйте! Вопрос решен!','reply'],
 ['which_property','Здравствуйте, какая именно квартира?','reply'],
 ['send_link','Скиньте ссылку пожалуйста','reply'],
 ['identity','Кто пишет?','reply'],
 ['explain_service','Что вы предлагаете? В чем смысл сотрудничества?','reply'],
 ['explain_service_en','What do you offer? Why should I work with you?','reply'],
 ['ai','Are you ai?','identity'],
 ['human','Можно поговорить с человеком?','identity'],
 ['commission','Сколько у вас комиссия?','terms'],
 ['conditional_commission','Да, но только без комиссии с меня','terms'],
 ['lease_en','We rent till season','reply'],
 ['lease_ka','გამარჯობა 1 თვით ქირავდება','reply'],
 ['lease_contract','So contract will be around 6 months possibly extending','reply'],
 ['consent_lease','Мы готовы сотрудничать с агентством, но имейте в виду что долгосрочная аренда возможна до 1 мая 2027 года, до начала туристического сезона','agreed'],
 ['price','Цена 600 долларов, свободна сейчас','reply'],
 ['realtor','Я агент, работаем 50 на 50?','realtor'],
 ['internal_url','Какая квартира?','reply', {url:'https://admin.batumi-key.homes/flat/102'}],
 ['missing_url','Какая квартира?','reply', {url:null}],
 ['consent_after_link','Да, сотрудничать готов','agreed', null, [{role:'user',content:'Какая квартира?'},{role:'assistant',content:'Тестовая улица, 31. https://example.com/flat/102 Готовы сотрудничать с агентством?'}]],
 ['yes_after_single_question','Да','agreed', null, [{role:'user',content:'Квартира актуальна'},{role:'assistant',content:'Готовы сотрудничать с нашим агентством?'}]],
 ['no_after_single_question','Нет','disagreed', null, [{role:'user',content:'Квартира актуальна'},{role:'assistant',content:'Готовы сотрудничать с нашим агентством?'}]],
];
const classify=r=>r.handoffReason||r.actions[0]?.status||'reply';
let failures=0;
async function probe(c){
 const [name,batchText,expected,override,extra=[]]=c;
 const started=Date.now();let calls=0;const raw=[];
 try {
  const provider={complete:async (messages,options)=>{for(let retry=0;retry<3;retry++){calls++;try{return await llm.complete(messages,options)}catch(e){if(!(e instanceof LlmError)||!e.retryable||retry===2)throw e;await new Promise(resolve=>setTimeout(resolve,1000));}}}};
  const result=await planCooperation(provider,{history:[{role:'assistant',content:initial,ts:1791619200000},...extra.map((r,i)=>({...r,ts:1791619201000+i}))],batchText,listings:[{...listing,id:101,address:'Другой тестовый адрес',url:'https://example.com/flat/101'}, {...listing,...override}],interactions:[interaction],instanceId,representativeName:'Александр',crmBaseUrl:'https://admin.batumi-key.homes',onRaw:async value=>{raw.push(value)}});
  const actual=classify(result);
  const correctLanguage=!['explain_service_en','lease_en','lease_contract'].includes(name)||!/[А-Яа-яЁё]/.test(result.reply.replace(listing.address,''));
  const safeUrl=!result.reply.includes('admin.batumi-key.homes');
  const match=actual===expected&&correctLanguage&&safeUrl;
  if(!match)failures++;
  console.log(JSON.stringify({name,expected,actual,match,calls,durationMs:Date.now()-started,result,raw}));
 }catch(e){failures++;console.log(JSON.stringify({name,expected,actual:'error',match:false,error:e.message,calls,raw}));}
}
(async()=>{
 const filter=process.env.BATYMI_CHECK_CASES?.split(',');
 const selected=filter?cases.filter(row=>filter.includes(row[0])):cases;
 console.log(JSON.stringify({probe:'synthetic-only',model:config.llmModel,cases:selected.length}));
 const repeats=Number(process.env.BATYMI_CHECK_REPEATS||1);
 for(let i=0;i<repeats;i++)for(const row of selected)await probe(row);
 console.log(JSON.stringify({total:selected.length*repeats,failures}));process.exitCode=failures?1:0;
})().catch(e=>{console.error(e.message);process.exitCode=1});
