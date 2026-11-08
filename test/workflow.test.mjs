import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server.mjs';
import {createWorkspace,createRun,approve,exportPacket} from '../workflow.mjs';

async function fixture(t) {
  const dataDir=mkdtempSync(path.join(tmpdir(),'dockcheck-test-'));
  let server;
  async function start(){server=createApp({dataDir,allowAI:false});server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
  let base=await start();
  const stop=()=>new Promise(resolve=>server.close(resolve));
  t.after(async()=>{await stop();rmSync(dataDir,{recursive:true,force:true});});
  function client(){
    let cookie='';
    return async (url,{method='GET',body,headers={}}={})=>{
      const response=await fetch(base+url,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
      const issued=response.headers.get('set-cookie');if(issued)cookie=issued.split(';')[0];
      return {status:response.status,headers:response.headers,data:await response.json()};
    };
  }
  return {client,restart:async()=>{await stop();base=await start();}};
}
const write=(body,headers)=>({method:'POST',body,headers});
const review={by:'Synthetic reviewer',note:'Compared the invoice with the order and delivery receipt.'};

test('partial receipt blocks approval and export, correction removes $480, exact approval exports once',async t=>{
  const {client}=await fixture(t);const api=client();
  let response=await api('/api/runs',write({scenario:'quantity'}));assert.equal(response.status,200);let run=response.data.run;
  assert.equal(run.status,'needs_review');assert.equal(run.invoice.totalCents,240000);
  assert.equal((await api(`/api/runs/${run.id}/approve`,write({...review,revision:run.revision}))).status,409);
  assert.equal((await api(`/api/runs/${run.id}/export`,write({revision:run.revision}))).status,409);
  response=await api(`/api/runs/${run.id}/resolve`,write({taskId:'quantity',resolution:'correct_to_received',revision:run.revision}));
  assert.equal(response.status,200);run=response.data.run;
  assert.equal(run.invoice.totalCents,192000);assert.equal(run.originalInvoice.totalCents,240000);assert.equal(run.status,'awaiting_approval');assert.equal(run.tasks[0].status,'resolved');
  assert.equal((await api(`/api/runs/${run.id}/approve`,write({...review,revision:1}))).status,409);
  run=(await api(`/api/runs/${run.id}/approve`,write({...review,revision:run.revision}))).data.run;
  assert.equal(run.status,'ready_to_export');const revision=run.revision;
  run=(await api(`/api/runs/${run.id}/export`,write({revision}))).data.run;
  assert.equal(run.status,'exported');assert.equal(run.export.paymentExecuted,false);
  const retry=(await api(`/api/runs/${run.id}/export`,write({revision}))).data.run;
  assert.equal(retry.export.id,run.export.id);assert.equal(retry.revision,run.revision);
  const state=(await api('/api/state')).data;assert.equal(state.metrics.exportedCents,192000);assert.equal(state.metrics.blockedCents,0);
  const packet=await api(`/api/runs/${run.id}/export`);assert.equal(packet.status,200);assert.match(packet.headers.get('content-disposition'),/attachment/);assert.equal(packet.data.reference.receipt.quantity,80);
  assert.equal(packet.data.trace.filter(e=>e.step==='Export packet').length,1);
  assert.equal((await api(`/api/runs/${run.id}/approve`,write({...review,revision:run.revision}))).status,409);
  assert.equal((await api(`/api/runs/${run.id}/brief`,write({revision:run.revision}))).status,409);
});

test('bank mismatch has an explicit correction and duplicate invoice has no override',async t=>{
  const {client}=await fixture(t);const api=client();
  let run=(await api('/api/runs',write({scenario:'bank'}))).data.run;
  assert.equal(run.checks.find(c=>c.id==='bank').status,'fail');
  run=(await api(`/api/runs/${run.id}/resolve`,write({taskId:'bank',resolution:'confirm_registered_bank',revision:run.revision}))).data.run;
  assert.equal(run.invoice.bankLast4,'4821');assert.equal(run.status,'awaiting_approval');
  const duplicate=(await api('/api/runs',write({scenario:'duplicate'}))).data.run;
  assert.equal((await api(`/api/runs/${duplicate.id}/resolve`,write({taskId:'duplicate',resolution:'override',revision:duplicate.revision}))).status,409);
  assert.equal((await api(`/api/runs/${duplicate.id}/approve`,write({...review,revision:duplicate.revision}))).status,409);
  assert.equal((await api(`/api/runs/${duplicate.id}/export`,write({revision:duplicate.revision}))).status,409);
});

test('matched invoice still needs a meaningful human approval',async t=>{
  const {client}=await fixture(t);const api=client();const run=(await api('/api/runs',write({scenario:'clean'}))).data.run;
  assert.equal(run.status,'awaiting_approval');assert.ok(run.checks.every(c=>c.status==='pass'));
  assert.equal((await api(`/api/runs/${run.id}/export`,write({revision:run.revision}))).status,409);
  assert.equal((await api(`/api/runs/${run.id}/approve`,write({by:'X',note:'ok',revision:run.revision}))).status,400);
  assert.equal((await api(`/api/runs/${run.id}/export`)).status,404);
});

test('approval fingerprint rejects changed invoice and duplicate discovered at final check',()=>{
  const workspace=createWorkspace();let run=createRun(workspace,'clean');approve(workspace,run.id,{...review,revision:1});
  run.invoice.totalCents=1;
  assert.throws(()=>exportPacket(workspace,run.id,{revision:run.revision}),/Approve the current invoice/);
  const second=createRun(workspace,'clean');approve(workspace,second.id,{...review,revision:1});
  workspace.ledger.push({invoiceNumber:second.invoice.number,vendorId:second.invoice.vendorId});
  assert.throws(()=>exportPacket(workspace,second.id,{revision:second.revision}),/final check failed/);
  assert.equal(second.export,null);
});

test('browser workspaces are isolated and survive server restart',async t=>{
  const fx=await fixture(t);const alice=fx.client();const bob=fx.client();
  const run=(await alice('/api/runs',write({scenario:'clean'}))).data.run;
  assert.equal((await bob('/api/state')).data.runs.length,0);
  assert.equal((await bob(`/api/runs/${run.id}/approve`,write({...review,revision:1}))).status,404);
  await fx.restart();
  assert.equal((await alice('/api/state')).data.runs[0].id,run.id);
  assert.equal((await bob('/api/state')).data.runs.length,0);
});

test('cross-origin writes, malformed input and unsupported scenarios are rejected',async t=>{
  const {client}=await fixture(t);const api=client();
  assert.equal((await api('/api/runs',write({scenario:'clean'},{Origin:'https://unrelated.example'}))).status,403);
  assert.equal((await api('/api/runs',write({scenario:'clean'},{'Sec-Fetch-Site':'cross-site'}))).status,403);
  assert.equal((await api('/api/runs',write('invalid'))).status,400);
  assert.equal((await api('/api/runs',write([]))).status,400);
  assert.equal((await api('/api/runs',write({scenario:'send_money'}))).status,400);
  assert.equal((await api('/api/runs',write({scenario:'clean',padding:'x'.repeat(17000)}))).status,413);
  assert.equal((await api('/api/state')).data.runs.length,0);
});

test('unconfigured AI reports unavailable without fabricating a brief or action',async t=>{
  const {client}=await fixture(t);const api=client();
  const run=(await api('/api/runs',write({scenario:'quantity'}))).data.run;
  const unavailable=await api(`/api/runs/${run.id}/brief`,write({revision:run.revision}));assert.equal(unavailable.status,503);
  const state=(await api('/api/state')).data;assert.equal(state.ai.available,false);assert.equal(state.runs[0].brief,null);assert.equal(state.runs[0].approval,null);assert.equal(state.runs[0].revision,1);
  assert.match(unavailable.data.error,/deterministic workflow remains/);
});
