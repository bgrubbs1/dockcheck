import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

async function fixture(t,secure){
  const old=process.env.COOKIE_SECURE;process.env.COOKIE_SECURE=secure?'1':'0';
  const dataDir=mkdtempSync(path.join(tmpdir(),'dockcheck-proxy-test-'));
  const server=createApp({dataDir,allowAI:false});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));rmSync(dataDir,{recursive:true,force:true});if(old===undefined)delete process.env.COOKIE_SECURE;else process.env.COOKIE_SECURE=old;});
  let cookie='';
  return (url,body,headers={})=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:url,method:body===undefined?'GET':'POST',headers:{Host:'dockcheck.example',...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>{const issued=res.headers['set-cookie']?.[0];if(issued)cookie=issued.split(';')[0];resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(text)});});});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}

test('HTTPS proxy preserves Host, sets secure cookies and rejects wrong-scheme or foreign origins',async t=>{
  const api=await fixture(t,true);const state=await api('/api/state');const cookie=state.headers['set-cookie'][0];
  assert.match(cookie,/; Secure(?:;|$)/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const https={Origin:'https://dockcheck.example','X-Forwarded-Proto':'https'};
  let r=await api('/api/runs',{scenario:'clean'},https);assert.equal(r.status,200);let run=r.data.run;
  run=(await api(`/api/runs/${run.id}/approve`,{by:'Synthetic reviewer',note:'Verified the synthetic records behind the HTTPS proxy headers.',revision:run.revision},https)).data.run;
  run=(await api(`/api/runs/${run.id}/export`,{revision:run.revision},https)).data.run;assert.equal(run.status,'exported');assert.equal(run.export.paymentExecuted,false);
  for(const headers of [{Origin:'http://dockcheck.example'},{Origin:'https://unrelated.example'},{Origin:'null'},{Origin:'not a URL'},{Origin:'https://dockcheck.example',Host:'127.0.0.1:8191'},{...https,'Sec-Fetch-Site':'cross-site'}])assert.equal((await api('/api/runs',{scenario:'clean'},headers)).status,403);
  assert.equal((await api('/api/runs',{scenario:'clean'},{Origin:'https://dockcheck.example:8443',Host:'dockcheck.example:8443'})).status,200);
  assert.equal((await api('/api/runs',{scenario:'clean'},{Origin:'https://dockcheck.example','X-Forwarded-Proto':'http'})).status,200);
});

test('local HTTP mode remains usable and forwarded headers cannot relax origin checks',async t=>{
  const api=await fixture(t,false);const state=await api('/api/state');assert.doesNotMatch(state.headers['set-cookie'][0],/; Secure(?:;|$)/);
  assert.equal((await api('/api/runs',{scenario:'clean'},{Origin:'http://dockcheck.example'})).status,200);
  assert.equal((await api('/api/runs',{scenario:'clean'},{Origin:'https://dockcheck.example','X-Forwarded-Proto':'https'})).status,403);
  assert.equal((await api('/api/runs',{scenario:'clean'},{Origin:'http://unrelated.example','X-Forwarded-Host':'unrelated.example'})).status,403);
});
