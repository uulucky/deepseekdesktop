'use strict';
// Isolated pinned Harness + local model. Temporary conversation storage; no real credentials, phone or paid API calls.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dmuse-workbench-e2e-'));process.env.DEEPSEEK_DESKTOP_HOME=temp;process.env.DEEPSEEK_DESKTOP_NODE_BIN=process.execPath;delete process.env.DEEPSEEK_API_KEY;delete process.env.DSH_HOME;
const {Bootstrap}=require('../src/main/modules/bootstrap'),{DeepSeekHarnessClient}=require('../src/main/modules/api'),{ChatController}=require('../src/main/modules/chat'),{applyHarnessCredential}=require('../src/main/modules/credentials');
const {MobileWorkbench}=require('../src/main/remote/workbench'),{RequestLedger}=require('../src/main/remote/task-state'),{startModelServer,eventually}=require('./fixtures/model-server');
(async()=>{
 let boot,client,chat,work,provider;const values=new Map(),store={get:(k,f)=>values.get(k)??f,set:(k,v)=>values.set(k,v)};let now=Date.now();
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 try{
  provider=await startModelServer();process.env.DEEPSEEK_BASE_URL=provider.baseUrl;
  boot=new Bootstrap({port,emit(){}});boot.dshBin=path.join(__dirname,'../vendor/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js');await boot.spawnServer(port);await boot.awaitReady(port);
  client=new DeepSeekHarnessClient(`http://127.0.0.1:${port}`,{cookie:boot.authCookie});await applyHarnessCredential(client,'DEEPSEEK_API_KEY','sk-isolated-fixture-not-a-real-key');
  let ready=false;client.onHostFrame(frame=>{if(frame.type==='remote-events/ready')ready=true;});client.connect();await eventually(()=>ready,'Private event stream connects');
  chat=new ChatController(client,{onUpdate:({sessionId,transcript})=>work?.onTranscript(sessionId,transcript)});
  const cwd=path.join(temp,'workspace');fs.mkdirSync(cwd,{recursive:true});const catalog=await client.listModels(),group=catalog.groups.find(g=>g.id==='deepseek-official'),model=group.models[0].id;
  const context={client,chat,uiStore:store,defaultSessionOptions:()=>({cwd,agentPreset:'standard'})};
  const rows=async()=>(await client.listSessions()).map(s=>({sessionId:s.sessionId,running:s.running,title:s.projections?.values?.title,cwd:s.cwd}));
  const api={createSession:async({body})=>{const created=await chat.createSession({cwd,...body});await client.selectPermission(created.sessionId,body.permission??'workspace-write');await client.selectModel(created.sessionId,group.id,model,'off');return created;},sendMessage:async({params:[id],body})=>{await chat.send(id,work.prompt(id,body.text,body),[],body.mode??'queue');return{ok:true};}};
  const remote={getContext:()=>context,state:{name:'isolated-pc'},enabled:()=>true,gateway:{publish(){}},sessions:{sessionRows:rows},api:()=>api,log(){}};work=new MobileWorkbench(remote,{now:()=>now});
  const waitForTask=async(marker)=>{let found;await eventually(()=>{found=provider.requests.find(r=>r.body.messages?.some(m=>m.role==='user'&&JSON.stringify(m.content).includes(marker))&&!r.body.messages.some(m=>JSON.stringify(m.content).includes('Generate the session title from this JSON array')));return found;},`Task model did not receive ${marker}`);return found;};
  const a=(await api.createSession({body:{permission:'workspace-write'}})).sessionId;
  const skillHome=path.join(temp,'fake-home'),skillDir=path.join(skillHome,'.claude/skills/phone-fixture');fs.mkdirSync(skillDir,{recursive:true});fs.writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: phone-fixture\ndescription: Phone fixture skill.\n---\n\nOnly say hello.\n');
  const bridge=require('../src/main/modules/skill-bridge'),skill=bridge.listSkills(temp,skillHome).skills.find(s=>s.name==='phone-fixture');bridge.setSkillEnabled(temp,skill.id,true,skillHome);
  await eventually(async()=>(await work.skills(a)).items.some(s=>s.name==='phone-fixture'),'Phone skill picker receives actual Harness skill names');
  const chosen=(await work.skills(a)).items.find(s=>s.name==='phone-fixture');assert.equal(typeof chosen.id,'string');assert(chosen.enabled);
  await api.sendMessage({params:[a],body:{text:'mobile-primary'}});const first=await waitForTask('mobile-primary');
  const ledger=new RequestLedger(()=>store),body={requestId:'mobile-queue-123',text:'mobile-followup',mode:'queue'};
  await ledger.once('phone',`send:${a}`,body,()=>api.sendMessage({params:[a],body}));await ledger.once('phone',`send:${a}`,body,()=>assert.fail('duplicate queued request ran twice'));
  first.finish('First task response');const followup=await waitForTask('mobile-followup');followup.finish('Follow-up applied');await eventually(()=>!chat.transcripts.get(a).running,'Queued follow-up finishes');
  assert.equal(provider.requests.filter(r=>JSON.stringify(r.body.messages.filter(m=>m.role==='user').at(-1)?.content).includes('mobile-followup')).length,1);
  await work.action({phone:'phone',body:{op:'rename',sessionId:a,title:'手机重命名'}});await eventually(async()=>(await rows()).some(r=>r.title==='手机重命名'),'Rename persists in the actual kernel');
  const workspace=(await client.createWorkspace(cwd)).workspace;assert(workspace.workspaceId);await work.action({phone:'phone',body:{op:'project',workspaceId:workspace.workspaceId,name:'手机项目',description:'先列出计划再操作',output:'中文'}});assert.match(work.prompt(a,'做测试',{workspaceId:workspace.workspaceId}),/先列出计划再操作/);
  await work.action({phone:'phone',elevated:true,body:{op:'schedule-save',title:'自动检查',prompt:'mobile-schedule',workspaceId:workspace.workspaceId,permission:'read-only',rule:{kind:'once',at:now+1000}}});const scheduleId=work.state().schedules[0].id;await work.action({phone:'phone',body:{op:'schedule-toggle',id:scheduleId,on:false}});now+=500;await work.tick();assert.equal(work.state().schedules[0].history.length,0,'Paused schedule must not execute');await work.action({phone:'phone',body:{op:'schedule-toggle',id:scheduleId,on:true}});now+=500;await work.tick();const scheduled=work.state().schedules[0].history.at(-1);assert.equal(scheduled.status,'running');assert.equal((await client.permissions(scheduled.sessionId)).currentValue,'read-only');const response=await waitForTask('mobile-schedule');response.finish('Scheduled response');await eventually(()=>!chat.transcripts.get(scheduled.sessionId).running,'Scheduled task completes');
  await work.action({phone:'phone',body:{op:'archive',sessionId:a}});assert((await client.listWorkspaces()).archivedSessionIds.includes(a));
  console.log('PASS real Harness mobile workbench: installed skills, idempotent running-task follow-up, rename, project memory, pause/resume, scheduled read-only execution and archive');
 }finally{work?.stop();chat?.dispose();client?.dispose();await boot?.stop();await provider?.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
})().catch(e=>{console.error(e);process.exitCode=1;});
