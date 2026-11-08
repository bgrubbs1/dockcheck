import { createHash, randomUUID } from 'node:crypto';

export const reference = Object.freeze({
  vendor: {name:'Northline Components',id:'V-NORTH',bankLast4:'4821'},
  po: {number:'PO-4102',quantity:100,unitPriceCents:2400},
  receipt: {number:'GR-8801',quantity:80},
});
export class WorkflowError extends Error {
  constructor(message,status=409) { super(message); this.status=status; }
}
const stamp=()=>new Date().toISOString();
const fingerprint=invoice=>createHash('sha256').update(JSON.stringify(invoice)).digest('hex');
const append=(run,step,kind,detail)=>run.trace.push({step,kind,detail,at:stamp()});
const assert=(condition,message,status=409)=>{if(!condition) throw new WorkflowError(message,status);};
export const createWorkspace=()=>({runs:[],ledger:[{invoiceNumber:'INV-1048',vendorId:'V-NORTH',totalCents:192000,source:'Synthetic prior export'}]});

function evaluate(run,workspace) {
  const invoice=run.invoice;
  const duplicate=workspace.ledger.some(e=>e.vendorId===invoice.vendorId && e.invoiceNumber.toUpperCase()===invoice.number.toUpperCase());
  run.checks=[
    {id:'vendor',label:'Vendor registry',status:invoice.vendorId===reference.vendor.id?'pass':'fail',detail:`${reference.vendor.name} · approved synthetic vendor`},
    {id:'bank',label:'Payment destination',status:invoice.bankLast4===reference.vendor.bankLast4?'pass':'fail',detail:`Invoice •${invoice.bankLast4}; registry •${reference.vendor.bankLast4}`},
    {id:'duplicate',label:'Duplicate invoice',status:duplicate?'fail':'pass',detail:duplicate?'Invoice already appears in the release ledger.':'No earlier release for this vendor and invoice.'},
    {id:'price',label:'Purchase order price',status:invoice.unitPriceCents===reference.po.unitPriceCents?'pass':'fail',detail:`${invoice.unitPriceCents} cents per unit; order ${reference.po.unitPriceCents} cents`},
    {id:'quantity',label:'Goods received',status:invoice.quantity<=reference.receipt.quantity&&invoice.quantity<=reference.po.quantity?'pass':'fail',detail:`${invoice.quantity} invoiced · ${reference.receipt.quantity} received · ${reference.po.quantity} ordered`},
    {id:'total',label:'Invoice arithmetic',status:Number.isSafeInteger(invoice.totalCents)&&invoice.totalCents===invoice.quantity*invoice.unitPriceCents?'pass':'fail',detail:`${invoice.quantity} × ${invoice.unitPriceCents} cents = ${invoice.totalCents} cents`},
  ];
  const titles={bank:'Restore the registered payment destination',duplicate:'Duplicate: stop this release',quantity:'Reconcile invoice with received goods',price:'Investigate purchase order price',vendor:'Verify vendor identity',total:'Correct invoice arithmetic'};
  for(const check of run.checks) {
    const task=run.tasks.find(t=>t.id===check.id);
    if(check.status==='fail'&&!task)run.tasks.push({id:check.id,title:titles[check.id],status:'open'});
    else if(check.status==='fail'&&task)task.status='open';
  }
  run.status=run.checks.some(c=>c.status==='fail')?'needs_review':'awaiting_approval';
}

export function createRun(workspace,scenario) {
  assert(['clean','quantity','bank','duplicate'].includes(scenario),'Choose a supported synthetic scenario.',400);
  assert(workspace.runs.length<40,'This demo workspace is full. Start a new browser session.',429);
  const number=scenario==='duplicate'?'INV-1048':`INV-${2000+workspace.runs.length}`;
  const quantity=scenario==='quantity'?100:80;
  const run={id:randomUUID(),title:{clean:'Matched delivery',quantity:'Partial delivery',bank:'Changed bank details',duplicate:'Repeated invoice'}[scenario],scenario,createdAt:stamp(),status:'needs_review',revision:1,
    invoice:{number,vendor:reference.vendor.name,vendorId:reference.vendor.id,poNumber:reference.po.number,quantity,unitPriceCents:2400,totalCents:quantity*2400,bankLast4:scenario==='bank'?'9912':'4821'},
    checks:[],tasks:[],trace:[],approval:null,export:null,brief:null};
  run.originalInvoice=structuredClone(run.invoice);
  append(run,'Intake','executed',`Structured synthetic invoice ${number} accepted. No OCR or model extraction is claimed.`);
  append(run,'Retrieve references','executed',`Loaded vendor V-NORTH, order PO-4102 and receipt GR-8801 from the server-owned fixture.`);
  evaluate(run,workspace);
  for(const check of run.checks)append(run,check.label,check.status==='pass'?'passed':'blocked',check.detail);
  append(run,'Route work',run.status==='needs_review'?'blocked':'waiting',run.status==='needs_review'?`${run.tasks.length} exception(s) assigned for review. Nothing can be released.`:'All checks passed. A named human must approve before a release packet can be exported.');
  workspace.runs.unshift(run);
  return run;
}

export function getRun(workspace,id){const run=workspace.runs.find(r=>r.id===id);assert(run,'Run not found.',404);return run;}
function mutable(run,revision){assert(Number.isInteger(revision)&&revision===run.revision,'This record changed. Refresh before continuing.');assert(!run.export,'Exported runs are immutable.');}
export function resolveTask(workspace,id,{taskId,resolution,revision}){
  const run=getRun(workspace,id);mutable(run,revision);
  const task=run.tasks.find(t=>t.id===taskId&&t.status==='open');assert(task,'This exception is not open.');
  assert(taskId!=='duplicate','A duplicate cannot be cleared by overriding the workflow. Keep it blocked.');
  if(taskId==='quantity'&&resolution==='correct_to_received'){
    const before=run.invoice.totalCents;
    run.invoice.quantity=reference.receipt.quantity;run.invoice.totalCents=run.invoice.quantity*run.invoice.unitPriceCents;
    task.resolution=`Synthetic corrected invoice reflects ${reference.receipt.quantity} received units; ${before-run.invoice.totalCents} cents removed.`;
  }else if(taskId==='bank'&&resolution==='confirm_registered_bank'){
    run.invoice.bankLast4=reference.vendor.bankLast4;
    task.resolution='Synthetic invoice restored to the registered account. Real bank verification is outside this demo.';
  }else throw new WorkflowError('Unsupported correction for this exception.',400);
  task.status='resolved';run.approval=null;run.brief=null;
  append(run,'Apply correction','executed',task.resolution);
  evaluate(run,workspace);append(run,'Recheck',run.status==='needs_review'?'blocked':'passed',`${run.checks.filter(c=>c.status==='pass').length} of ${run.checks.length} checks pass after correction.`);
  run.revision++;return run;
}
export function approve(workspace,id,{by,note,revision}){
  const run=getRun(workspace,id);mutable(run,revision);
  assert(typeof by==='string'&&by.trim().length>=2&&by.trim().length<=80,'Add the reviewer name (2–80 characters).',400);
  assert(typeof note==='string'&&note.trim().length>=12&&note.length<=500,'Add a meaningful review note (12–500 characters).',400);
  evaluate(run,workspace);
  assert(run.checks.every(c=>c.status==='pass')&&run.tasks.every(t=>t.status==='resolved'),'Resolve every exception before approval.');
  run.approval={by:by.trim(),note:note.trim(),at:stamp(),fingerprint:fingerprint(run.invoice)};
  run.brief=null;run.status='ready_to_export';run.revision++;
  append(run,'Human approval','approved',`${run.approval.by} approved this exact invoice revision: ${run.approval.note}`);return run;
}
export function exportPacket(workspace,id,{revision}){
  const run=getRun(workspace,id);
  // Retry after a successful export returns the same receipt, without a second ledger entry.
  if(run.export)return run;
  mutable(run,revision);
  assert(run.approval&&run.approval.fingerprint===fingerprint(run.invoice),'Approve the current invoice before export.');
  evaluate(run,workspace);assert(run.checks.every(c=>c.status==='pass'),'A final check failed. Export stopped.');
  run.export={id:`DC-${randomUUID().slice(0,8).toUpperCase()}`,totalCents:run.invoice.totalCents,createdAt:stamp(),mode:'synthetic-release-packet',paymentExecuted:false};
  workspace.ledger.push({invoiceNumber:run.invoice.number,vendorId:run.invoice.vendorId,totalCents:run.invoice.totalCents,source:run.export.id});
  run.brief=null;run.status='exported';run.revision++;append(run,'Export packet','executed',`${run.export.id} recorded once. This downloadable review artifact does not send money or contact a vendor.`);return run;
}
export function metrics(workspace){return {runs:workspace.runs.length,blockedCents:workspace.runs.filter(r=>r.status==='needs_review').reduce((s,r)=>s+r.invoice.totalCents,0),exportedCents:workspace.runs.filter(r=>r.export).reduce((s,r)=>s+r.export.totalCents,0)};}
