'use strict';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = (cents) => new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(cents || 0) / 100);
const clock = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}); };
const date = (value) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], {month:'short',day:'numeric'}); };
const labels = {needs_review:'Needs review',awaiting_approval:'Awaiting approval',ready_to_export:'Approved',exported:'Exported'};
const tones = {needs_review:'warn',awaiting_approval:'ink',ready_to_export:'good',exported:'good'};
let state = null;
let selectedId = null;
let busy = false;
const drafts = new Map();
let lastVerifiedRun = null;
const emptyStateMarkup = $('#detail').innerHTML;

function message(text, error=false) {
  const feedback = $('#feedback');
  feedback.hidden = !text;
  feedback.className = error ? 'error' : '';
  feedback.textContent = text;
  feedback.setAttribute('role', error ? 'alert' : 'status');
}

async function api(path, body) {
  const response = await fetch(path, {method:body === undefined ? 'GET' : 'POST',headers:body === undefined ? {} : {'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json().catch(() => ({error:'The server returned an unreadable response.'}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function statusPill(status) {return `<span class="pill ${tones[status] || ''}">${escapeHtml(labels[status] || status)}</span>`;}

function renderQueue() {
  $('#case-count').textContent = state.runs.length;
  $('#case-list').innerHTML = state.runs.length ? state.runs.map(run => `<button class="case-item ${run.id === selectedId ? 'selected' : ''}" data-case="${escapeHtml(run.id)}" aria-pressed="${run.id === selectedId}"><span class="case-item-top"><strong>${escapeHtml(run.invoice.number)}</strong><span class="record-number">${escapeHtml(date(run.createdAt))}</span></span><span class="case-title">${escapeHtml(run.title)}</span><span class="case-item-bottom"><span class="amount">${money(run.invoice.totalCents)}</span>${statusPill(run.status)}</span></button>`).join('') : '<p class="muted">No cases yet. Start a synthetic case below.</p>';
  $('#metric-runs').textContent = state.metrics.runs;
  $('#metric-held').textContent = money(state.metrics.blockedCents);
  $('#metric-exported').textContent = money(state.metrics.exportedCents);
  $('#engine-label').textContent = state.engine;
}

function resolutionFor(task) {
  const identity = `${task.id} ${task.title}`.toLowerCase();
  if (/quantity|receipt|received|overbill/.test(identity)) return {value:'correct_to_received',label:'Correct invoice to received quantity',copy:'Use the recorded receipt to reduce the payable quantity. The original mismatch remains in the execution trace.'};
  if (/bank|vendor|payment detail/.test(identity)) return {value:'confirm_registered_bank',label:'Keep the registered vendor bank',copy:'Discard the changed bank details and use the existing vendor master. This demo does not verify a real bank account.'};
  return null;
}

function renderTask(task, run) {
  if (task.status === 'resolved') return `<div class="task"><h4>${escapeHtml(task.title)}</h4><div class="resolved"><span aria-hidden="true">✓</span><span>Resolved · ${escapeHtml(task.resolution || 'Review completed')}</span></div></div>`;
  const choice = resolutionFor(task);
  return `<div class="task"><h4>${escapeHtml(task.title)}</h4>${choice ? `<p>${choice.copy}</p><button class="button secondary" data-resolve="${escapeHtml(task.id)}" data-resolution="${choice.value}" ${busy ? 'disabled' : ''}>${choice.label}</button>` : '<p class="hard-stop">This case cannot proceed. A duplicate invoice is a hard stop; start a different synthetic case to continue the workflow.</p>'}</div>`;
}

function render() {
  if (!state) return;
  renderQueue();
  const run = state.runs.find(r => r.id === selectedId);
  document.querySelectorAll('[data-scenario], #refresh').forEach(button => button.disabled = busy);
  if (!run) { $('#detail').innerHTML = emptyStateMarkup; document.querySelectorAll('[data-scenario]').forEach(button => button.disabled = busy); return; }
  const ref = state.reference;
  const hasOpen = run.tasks.some(t => t.status === 'open') || run.checks.some(c => c.status === 'fail');
  const draft = drafts.get(run.id) || {by:'Demo reviewer',note:''};
  const stage = run.export ? 4 : run.approval ? 3 : hasOpen ? 1 : 2;
  const workflow = ['Records collected','Match & resolve','Human approval','Evidence export'].map((title, index) => `<div class="workflow-step ${index < stage ? 'complete' : ''} ${index === stage ? 'current' : ''}"><span class="step-number" aria-hidden="true">${index < stage ? '✓' : index + 1}</span><span>${title}</span></div>`).join('');
  const matching = run.checks.filter(c=>c.status==='pass').length;
  $('#detail').innerHTML = `
    <section class="case-header" aria-label="Selected case"><div><div class="eyebrow">CASE ${escapeHtml(run.id)} · REVISION ${escapeHtml(run.revision)}</div><h2>${escapeHtml(run.title)}</h2><div class="case-meta"><span>${escapeHtml(run.invoice.vendor)}</span><span>Invoice ${escapeHtml(run.invoice.number)}</span><span>${escapeHtml(date(run.createdAt))}</span></div></div><div class="case-header-status">${statusPill(run.status)}<small>${matching} of ${run.checks.length} checks passed</small></div></section>
    <div class="workflow" aria-label="Workflow progress">${workflow}</div>
    <section class="records" aria-label="Three-way record comparison">
      <article class="record active"><div class="record-heading"><h3>01 · Invoice</h3><span class="record-number">${escapeHtml(run.invoice.number)}</span></div><dl><dt>Quantity billed</dt><dd>${escapeHtml(run.invoice.quantity)} units</dd><dt>Unit price</dt><dd>${money(run.invoice.unitPriceCents)}</dd><dt>Purchase order</dt><dd>${escapeHtml(run.invoice.poNumber)}</dd></dl><div class="total"><span>Invoice total</span><strong>${money(run.invoice.totalCents)}</strong></div>${run.originalInvoice && run.originalInvoice.totalCents !== run.invoice.totalCents ? `<p class="original-total">Originally submitted: ${money(run.originalInvoice.totalCents)}<br><strong>${money(Math.abs(run.originalInvoice.totalCents-run.invoice.totalCents))} ${run.originalInvoice.totalCents>run.invoice.totalCents?'removed':'added'} during reconciliation.</strong><br>Synthetic original preserved in the evidence packet.</p>` : ''}</article>
      <article class="record"><div class="record-heading"><h3>02 · Purchase order</h3><span class="record-number">${escapeHtml(ref.po.number)}</span></div><dl><dt>Quantity ordered</dt><dd>${escapeHtml(ref.po.quantity)} units</dd><dt>Agreed unit price</dt><dd>${money(ref.po.unitPriceCents)}</dd><dt>Vendor</dt><dd>${escapeHtml(ref.vendor.id)}</dd></dl><div class="total"><span>Order ceiling</span><strong>${money(ref.po.quantity * ref.po.unitPriceCents)}</strong></div></article>
      <article class="record"><div class="record-heading"><h3>03 · Goods receipt</h3><span class="record-number">RECEIVING RECORD</span></div><dl><dt>Quantity received</dt><dd>${escapeHtml(ref.receipt.quantity)} units</dd><dt>Outstanding units</dt><dd>${escapeHtml(ref.po.quantity - ref.receipt.quantity)} units</dd><dt>Registered bank</dt><dd>•••• ${escapeHtml(ref.vendor.bankLast4)}</dd></dl><div class="total"><span>Received value</span><strong>${money(ref.receipt.quantity * ref.po.unitPriceCents)}</strong></div></article>
    </section>
    <div class="review-grid"><div>
      <section class="panel"><div class="panel-header"><h3>Match results</h3><small>Rule-based verification</small></div><ul class="checks">${run.checks.map(check=>`<li class="check ${check.status === 'fail' ? 'fail' : ''}"><span class="check-icon" aria-hidden="true">${check.status === 'pass' ? '✓' : '!'}</span><div><strong>${escapeHtml(check.label)}</strong><p>${escapeHtml(check.detail)}</p></div></li>`).join('')}</ul></section>
      ${run.tasks.length ? `<section class="panel"><div class="panel-header"><h3>Exception desk</h3><small>${run.tasks.filter(t=>t.status==='open').length} open</small></div>${run.tasks.map(t=>renderTask(t,run)).join('')}</section>` : ''}
      <section class="panel"><div class="panel-header"><h3>Human approval</h3><span class="small-tag">REQUIRED</span></div><div class="panel-body">${run.approval ? `<div class="approved-box"><strong>✓ Reconciliation approved</strong><p>Reviewed by ${escapeHtml(run.approval.by)} · ${escapeHtml(clock(run.approval.at))}</p><p class="approval-note">${escapeHtml(run.approval.note)}</p></div>${run.export ? `<a class="button primary export-button" href="/api/runs/${encodeURIComponent(run.id)}/export" download="dockcheck-${escapeHtml(run.id)}.json">Download evidence package <span aria-hidden="true">↓</span></a><p class="export-caption">Export ${escapeHtml(run.export.id)} · ${money(run.export.totalCents)} · Synthetic evidence only.</p>` : `<button class="button primary export-button" data-export ${busy ? 'disabled' : ''}>Export approved evidence <span aria-hidden="true">→</span></button><p class="export-caption">Creates a downloadable reconciliation record. No money moves.</p>`}` : `<form class="approval-form" id="approval-form">${hasOpen ? '<p class="gate-note">Resolve all exceptions before approving this case. Failed checks cannot be overridden here.</p>' : '<p class="muted">The records agree. Add your review note to authorize evidence export.</p>'}<label for="reviewer-name">Reviewer name</label><input id="reviewer-name" name="by" value="${escapeHtml(draft.by)}" minlength="2" maxlength="80" required autocomplete="off" aria-describedby="reviewer-help"><p class="field-help" id="reviewer-help">Use 2–80 characters.</p><label for="reviewer-note">Review note</label><textarea id="reviewer-note" name="note" placeholder="What did you verify before approving?" minlength="12" maxlength="500" required aria-describedby="review-note-help">${escapeHtml(draft.note)}</textarea><p class="field-help" id="review-note-help">Describe your checks in 12–500 characters.</p><button class="button primary" type="submit" ${hasOpen || busy ? 'disabled' : ''}>Approve reconciliation <span aria-hidden="true">✓</span></button><p class="export-caption">Approval is recorded against this revision. It does not authorize a payment.</p></form>`}</div></section>
    </div><div>
      <section class="panel"><div class="panel-header"><h3>Execution trace</h3><small>${run.trace.length} events</small></div><ol class="trace">${run.trace.map((event,index)=>`<li><span class="trace-dot" aria-hidden="true">${index+1}</span><div class="trace-content"><div class="trace-title"><strong>${escapeHtml(event.step)}</strong><time datetime="${escapeHtml(event.at)}">${escapeHtml(clock(event.at))}</time></div><p>${escapeHtml(event.detail)}</p><span class="trace-kind">${escapeHtml(event.kind)}</span></div></li>`).join('')}</ol></section>
      <section class="panel"><div class="panel-header"><h3 class="brief-title"><span aria-hidden="true">✦</span> Review briefing</h3><span class="small-tag">OPTIONAL AI</span></div><div class="panel-body">${run.brief ? `<p class="brief-copy">${escapeHtml(run.brief.text)}</p><div class="brief-source">Generated by ${escapeHtml(run.brief.source)}</div>` : `<p class="brief-copy">${run.export ? 'This evidence packet is final. Its records and execution trace can no longer change.' : state.ai.available ? 'Summarize the current records and exceptions with the connected model.' : 'AI briefing is not connected. All checks, resolutions, and approval controls work independently.'}</p>`}<button class="button secondary" data-brief ${run.export || !state.ai.available || busy ? 'disabled' : ''}>${run.export ? 'Exported record is locked' : run.brief ? 'Refresh AI briefing' : 'Generate AI briefing'}</button><p class="brief-disclaimer">${state.ai.available && !run.export ? `Connected model: ${escapeHtml(state.ai.model)}. ` : ''}Briefings explain the record. They cannot approve, change checks, or move funds.</p></div></section>
    </div></div>`;
}

async function refresh() {
  state = await api('/api/state');
  if (!state.runs.some(r=>r.id===selectedId)) selectedId = state.runs[0]?.id || null;
  render();
}

async function act(action, success) {
  if (busy) return;
  busy = true;
  message('Working…');
  render();
  try {
    const result = await action();
    if (result?.run?.id) {
      lastVerifiedRun = result.run;
      selectedId = result.run.id;
      if (state) {
        const index = state.runs.findIndex(run => run.id === result.run.id);
        if (index < 0) state.runs.unshift(result.run);
        else state.runs[index] = result.run;
        state.metrics = {
          runs:state.runs.length,
          blockedCents:state.runs.filter(run => run.status === 'needs_review').reduce((sum,run) => sum + run.invoice.totalCents,0),
          exportedCents:state.runs.filter(run => run.export).reduce((sum,run) => sum + run.export.totalCents,0),
        };
        render();
      }
    }
    try {
      await refresh();
      message(success);
    } catch (error) {
      message(result?.run?.id
        ? 'Action completed. Workspace refresh failed; press Refresh before another action.'
        : `Workspace refresh failed: ${error.message}`,true);
    }
  } catch (error) {
    try { await refresh(); } catch { /* Retain the last readable state. */ }
    message(error.message, true);
  } finally { busy = false; render(); }
}

document.addEventListener('input', event => {
  if (event.target.closest('#approval-form')) drafts.set(selectedId, {by:$('#reviewer-name').value,note:$('#reviewer-note').value});
});

document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target || target.disabled || busy) return;
  if (target.dataset.case) { selectedId = target.dataset.case; message(''); render(); if (window.innerWidth <= 760) $('#workbench').scrollIntoView({behavior:'smooth',block:'start'}); return; }
  if (target.dataset.scenario) { act(()=>api('/api/runs',{scenario:target.dataset.scenario}),'Case created. The matching checks have completed.'); return; }
  if (target.id === 'refresh' || target.hasAttribute('data-retry')) { act(async()=>{},'Workspace refreshed.'); return; }
  const run = state?.runs.find(r=>r.id === selectedId);
  if (!run) return;
  const path = `/api/runs/${encodeURIComponent(run.id)}`;
  if (target.dataset.resolve) act(()=>api(`${path}/resolve`,{taskId:target.dataset.resolve,resolution:target.dataset.resolution,revision:run.revision}),'Exception resolved. Checks were run again.');
  if (target.hasAttribute('data-export')) act(()=>api(`${path}/export`,{revision:run.revision}),'Evidence package created. No payment was made.');
  if (target.hasAttribute('data-brief')) act(()=>api(`${path}/brief`,{revision:run.revision}),'AI briefing generated from the current case.');
});

document.addEventListener('submit', event => {
  if (event.target.id !== 'approval-form') return;
  event.preventDefault();
  const run = state.runs.find(r=>r.id === selectedId);
  if (!run || busy) return;
  const data = new FormData(event.target);
  act(()=>api(`/api/runs/${encodeURIComponent(run.id)}/approve`,{by:data.get('by'),note:data.get('note'),revision:run.revision}),'Review recorded. This case is ready for evidence export.');
});

refresh().catch(error=>{ $('#case-list').innerHTML = '<p class="muted">The workspace could not be loaded.</p><button class="button secondary" data-retry>Retry loading</button>'; message(`Could not load the workspace: ${error.message}`,true); });
