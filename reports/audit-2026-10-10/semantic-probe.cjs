// Read-only synthetic probe: run on the deployed app with `node` on stdin.
// Uses the configured LLM; does not call CRM, WhatsApp, or the conversation worker.
const { planCooperation, COOPERATION_QUESTION } = require('/app/dist/conversation/cooperation-agent');
const { createLlmProvider } = require('/app/dist/agent/llm.provider');
const { loadConfig } = require('/app/dist/config/env');
const { createLogger } = require('/app/dist/observability/logger');
const config = loadConfig();
const llm = createLlmProvider(config, createLogger({level:'silent',pretty:false}));
const instanceId='audit-synthetic-line';
const listing={id:102,address:'Тестовая улица, 31',url:'https://example.com/flat/102',contact_type:'potential_owner',crm_status:'delivered'};
const initial='Здравствуйте! Пишу по поводу вашей квартиры по адресу: Тестовая улица, 31. '+COOPERATION_QUESTION;
const interaction={id:1,direction:'outgoing',sender:null,instance_id:instanceId,sent_at:'2026-10-10T08:00:00Z',text:initial,notes:'cooperation_outreach:v1:102'};
const cases=[
 ['clear_consent_ru','Да, готов сотрудничать', 'agreed'],
 ['clear_consent_en','Yes, happy to work with your agency', 'agreed'],
 ['clear_consent_ka','დიახ, მზად ვარ სააგენტოსთან თანამშრომლობისთვის', 'agreed'],
 ['clear_consent_translit','Da, gotov sotrudnichat', 'agreed'],
 ['availability_only','Да, квартира ещё актуальна', 'reply'],
 ['two_questions_bare_yes','Да', 'ambiguous'],
 ['availability_both','Здравствуйте. Да обе квартиры актуальны', 'reply'],
 ['clear_refusal','С агентствами не сотрудничаю', 'disagreed'],
 ['already_rented','Здравствуйте, вчера уже сдал', 'listing_removed'],
 ['question_resolved','Здравствуйте! Вопрос решен!', 'ambiguous'],
 ['what_property','Здравствуйте, какая именно квартира?', 'reply'],
 ['send_link','Скиньте ссылку пожалуйста', 'reply'],
 ['who_writes','Кто пишет?', 'reply'],
 ['purpose','Что вы предлагаете? В чем смысл сотрудничества?', 'reply'],
 ['are_you_ai','Are you ai?', 'identity'],
 ['ask_human','Можно поговорить с человеком?', 'identity'],
 ['commission_question','Сколько у вас комиссия?', 'terms'],
 ['conditional_commission','Да, но только без комиссии с меня', 'terms'],
 ['lease_fact_en','We rent till season', 'reply'],
 ['lease_fact_ka','გამარჯობა 1 თვით ქირავდება', 'reply'],
 ['lease_contract_fact','So contract will be around 6 months possibly extending', 'reply'],
 ['consent_and_season','Мы готовы сотрудничать с агентством, но имейте в виду что долгосрочная аренда возможна до 1 мая 2027 года, до начала туристического сезона', 'agreed'],
 ['price_fact','Цена 600 долларов, свободна сейчас', 'reply'],
 ['clear_realtor','Я агент, работаем 50 на 50?', 'realtor'],
 ['source_listing_wrong_url','Какая квартира?', 'reply', {url:'https://admin.batumi-key.homes/flat/102'}],
 ['no_external_url','Какая квартира?', 'reply', {url:null}],
 ['consent_after_clarification','Да, сотрудничать готов', 'agreed', null, [
  {role:'user',content:'Какая квартира?',ts:1791619201000},
  {role:'assistant',content:'Тестовая улица, 31. https://example.com/flat/102 Готовы сотрудничать с агентством?',ts:1791619202000}]],
 ['bare_yes_after_single_question','Да', 'agreed', null, [
  {role:'user',content:'Квартира актуальна',ts:1791619201000},
  {role:'assistant',content:'Готовы сотрудничать с нашим агентством?',ts:1791619202000}]],
];
function classify(r){return r.handoffReason || r.actions[0]?.status || 'reply';}
async function probe(c){
 const [name,batchText,expected,override,extra=[]]=c;
 const started=Date.now();
 let calls=0;
 const provider={complete: async messages=>{calls++;return llm.complete(messages)}};
 try{
  const result=await planCooperation(provider,{history:[{role:'assistant',content:initial,ts:1791619200000},...extra],batchText,listings:[{id:101,address:'Другая тестовая улица, 12',url:'https://example.com/flat/101',contact_type:'potential_owner',crm_status:'delivered'},{...listing,...override}],interactions:[interaction],instanceId,representativeName:'Александр'});
  const actual=classify(result);
  console.log(JSON.stringify({name,input:batchText,expected,actual,match:expected==='ambiguous'?actual==='reply':actual===expected,calls,durationMs:Date.now()-started,result}));
 }catch(e){console.log(JSON.stringify({name,input:batchText,expected,actual:'error',error:e.message,calls,durationMs:Date.now()-started}));}
}
const filter=process.env.BATYMI_AUDIT_CASES?.split(',');
const selected=filter?cases.filter(c=>filter.includes(c[0])):cases;
const repeats=Number(process.env.BATYMI_AUDIT_REPEATS||1);
(async()=>{console.log(JSON.stringify({probe:'synthetic-only',model:config.llmModel,cases:selected.length,repeats})); for(let iteration=1;iteration<=repeats;iteration++){console.log(JSON.stringify({iteration}));for(let n=0;n<selected.length;n+=2)await Promise.all(selected.slice(n,n+2).map(probe));}})().catch(e=>{console.log(JSON.stringify({error:e.message}));process.exitCode=1});
