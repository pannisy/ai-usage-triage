const state = { rows: [], cases: [], decisions: [], view: 'review', selected: null, sourceName: 'employee_ai_usage.csv' };

function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && quoted && n === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && n === '\n') i++; row.push(cell); if (row.some(v => v !== '')) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift().map(h => h.trim());
  return rows.map(values => Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()])));
}

const money = n => `$${Number(n).toFixed(2)}`;
const pct = n => `${Math.round(n * 100)}%`;
const median = nums => { const a = nums.filter(Number.isFinite).sort((x,y)=>x-y); if (!a.length) return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
const fmtDate = value => { const date=new Date(value); return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date):'Date unavailable'; };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const groupBy = (arr, fn) => arr.reduce((m,x)=>{ const k=fn(x); (m[k] ||= []).push(x); return m; },{});
const OUTLIER_K = 2.75;
// Median absolute deviation, scaled to a standard-deviation equivalent (1.4826 for a normal).
const outlierFence = (positiveTotals,k=OUTLIER_K) => {
  if(!positiveTotals.length)return 0;
  const logs=positiveTotals.map(Math.log), mid=median(logs);
  const spread=median(logs.map(x=>Math.abs(x-mid)))*1.4826;
  return Math.exp(mid+k*spread);
};
const variation = nums => { const a=nums.filter(Number.isFinite); if(a.length<2)return 0; const mean=a.reduce((s,x)=>s+x,0)/a.length; if(!mean)return 0; return Math.sqrt(a.reduce((s,x)=>s+(x-mean)**2,0)/a.length)/mean; };
// Digits collapse so "attempt 1 of 18" and "attempt 2 of 18" read as the same content.
const normalize = text => String(text||'').toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
// A planned batch is recognisable from its shape: every request completed, nothing signaled, costs in a tight band.
const uniformCompletedBatch = records => records.length>=4 &&
  records.every(r=>r.request_status==='completed') &&
  records.every(r=>!r.content_signal||r.content_signal==='none') &&
  variation(records.map(r=>r.cost))<=0.4;

function analyze(inputRows) {
  const seen = new Set(), duplicates = [];
  const invalidRows=[];
  const usable=inputRows.filter(r=>{
    const cost=Number(r.estimated_cost_usd_per_request);
    const valid=!!r.request_id&&!!r.employee_id&&Number.isFinite(Date.parse(r.occurred_at))&&r.estimated_cost_usd_per_request!==''&&Number.isFinite(cost)&&cost>=0;
    if(!valid)invalidRows.push(r);
    return valid;
  });
  const rows = usable.filter(r => { if (seen.has(r.request_id)) { duplicates.push(r); return false; } seen.add(r.request_id); return true; }).map(r => ({...r, cost:+r.estimated_cost_usd_per_request, confidence:+r.content_detector_confidence||0, time:new Date(r.occurred_at).getTime()}));
  const sessions = Object.values(groupBy(rows,r=>`${r.employee_id}|${r.session_id || r.request_id}`));
  const sessionCosts=sessions.map((records,index)=>({index,employee:records[0].employee_id,department:records[0].department,total:records.reduce((sum,r)=>sum+r.cost,0)}));
  // Leave the episode being judged out of its own baseline; otherwise a spike can normalize itself.
  const typical=(current,field)=>{
    const peers=sessionCosts.filter(s=>s.index!==current.index&&(!field||s[field]===current[field])).map(s=>s.total).filter(x=>x>0);
    return peers.length?median(peers):0;
  };
  const baselines=current=>{
    const organization=typical(current,null)||0.01;
    const department=typical(current,'department')||organization;
    const employee=typical(current,'employee')||department;
    return {employee,department,organization,comparison:Math.max(employee,department)};
  };
  // Every threshold below is a multiple of this dataset's own costs, so the rules hold at any scale.
  const sortedTotals=sessionCosts.map(s=>s.total).filter(x=>x>0).sort((a,b)=>a-b);
  const orgTotal=rows.reduce((sum,r)=>sum+r.cost,0);
  // With no positive costs at all there is nothing to call unusual, and every comparison against 0 is true.
  const costsUsable=sortedTotals.length>0&&orgTotal>0;
  const scale={orgTotal,orgMedian:median(sortedTotals)||0,fence:outlierFence(sortedTotals),material:orgTotal*0.01,usable:costsUsable};
  const tagSessions=new Map();
  sessions.forEach(records=>{const key=`${records[0].employee_id}|${records[0].project_tag}`;tagSessions.set(key,(tagSessions.get(key)||0)+1);});
  const deptTotals=new Map();
  sessionCosts.forEach(s=>{if(s.total>0){if(!deptTotals.has(s.department))deptTotals.set(s.department,[]);deptTotals.get(s.department).push(s.total);}});
  const deptScale=new Map();
  for(const [dept,totals] of deptTotals){
    if(totals.length<8)continue; // too few sessions to describe a spread
    deptScale.set(dept,{fence:outlierFence(totals),material:totals.reduce((sum,x)=>sum+x,0)*0.01});
  }
  const localScale=dept=>deptScale.get(dept)||{fence:scale.fence,material:scale.material};
  const cases = [], decisions = [];

  for (const [index,records] of sessions.entries()) {
    records.sort((a,b)=>a.time-b.time);
    const first=records[0];
    const signaled=records.filter(r=>r.content_signal && r.content_signal!=='none');
    const sentSignals=signaled.filter(r=>r.request_status!=='blocked_before_sending');
    const blocked=records.filter(r=>r.request_status==='blocked_before_sending').length;
    const total=records.reduce((s,r)=>s+r.cost,0), failed=records.filter(r=>r.request_status==='failed').length;
    const duration=Number.isFinite(records.at(-1).time-records[0].time)?(records.at(-1).time-records[0].time)/60000:0;
    const base=baselines(sessionCosts[index]);
    const coherentProject=uniformCompletedBatch(records)&&(tagSessions.get(`${first.employee_id}|${first.project_tag}`)||0)>=3;
    const id=`${first.employee_id}-${first.session_id || first.request_id}`;

    if (signaled.length) {
      if (!sentSignals.length) {
        decisions.push({label:'Blocked sensitive attempts',detail:`${signaled.length} signaled request${signaled.length===1?' was':'s were'} stopped before sending. There is no evidence that this content reached the provider.`,outcome:'No review',records});
      } else if (sentSignals.some(r=>r.account_type==='personal'||r.account_type==='unknown')) {
        const personal=sentSignals.filter(r=>r.account_type==='personal').length;
        const unknown=sentSignals.filter(r=>r.account_type==='unknown').length;
        const missing=sentSignals.filter(r=>r.excerpt_status!=='available'||!r.input_excerpt).length;
        const highConfidence=sentSignals.some(r=>r.confidence>=0.8);
        // Escalate on corroboration, or on a single high-confidence hit. Both read fields, never prose.
        const strong=!unknown&&!missing&&(personal>=2||(personal>=1&&highConfidence));
        const signalKind=sentSignals.some(r=>r.content_signal==='possible_customer_data')?'customer data':sentSignals.some(r=>r.content_signal==='possible_personal_data')?'personal data':'sensitive content';
        const why=[`${sentSignals.length} request${sentSignals.length===1?'':'s'} not blocked before sending had ${signalKind} signals`,personal?`${personal} signaled request${personal===1?'':'s'} used a personal account`:'Account ownership could not be confirmed'];
        if(highConfidence)why.push(`The strongest signal was detected at ${pct(Math.max(...sentSignals.map(r=>r.confidence)))} confidence`);
        if(blocked)why.push(`${blocked} related request${blocked===1?' was':'s were'} blocked before sending and are not treated as exposure`);
        const unknowns=[];
        if(missing)unknowns.push(`${missing} signaled request${missing===1?' has':'s have'} no viewable excerpt`);
        if(unknown)unknowns.push(`The account type of ${unknown} signaled request${unknown===1?'':'s'} is unknown`);
        unknowns.push('Whether the content was approved for this account and what the provider retained');
        cases.push(makeCase({id,type:'sensitive',recommendation:strong?'Investigate':'Review',first,records,total,
          title:strong?`Possible ${signalKind} shared through a personal AI account`:'Possible sensitive data in partially observed activity',
          summary:strong?`${sentSignals.length} related request${sentSignals.length===1?'':'s'} carried ${signalKind} signals on a personal account.`:`${sentSignals.length} related request${sentSignals.length===1?'':'s'} carried sensitive-data signals, but content or account attribution is incomplete.`,
          what:`Over ${Math.max(1,Math.round(duration))} minutes, ${first.employee_id} made ${records.length} related request${records.length===1?'':'s'} in ${first.tool_name}. ${sentSignals.length} request${sentSignals.length===1?' not blocked before sending carried':'s not blocked before sending carried'} possible ${signalKind} signals${blocked?`; ${blocked} additional request${blocked===1?' was':'s were'} blocked before sending`:''}. The excerpts do not establish exactly what the provider received.`,
          why,unknown:unknowns,next:strong?'Confirm potential exposure':'Confirm missing context',
          nextCopy:strong?'Verify what content was sent, why a personal account was used, and whether security follow-up is needed.':'Verify the source content and account ownership before deciding whether to escalate.'}));
      } else decisions.push({label:'Managed-account sensitive signal',detail:`A sensitive-data signal was observed in managed activity without enough additional evidence to warrant a case.`,outcome:'Monitored'});
    }

    const relative=total/base.comparison;
    const aboveBothBaselines=(total/base.employee)>=8 && (total/base.department)>=8;
    const completed=records.at(-1).request_status==='completed';
    const failedCost=records.filter(r=>r.request_status==='failed').reduce((s,r)=>s+r.cost,0);
    // Relative distance measures unusualness; observed organization and department
    // spend determine whether the financial impact is material enough to review.
    const local=localScale(first.department);
    const materialRetry=failed>=2&&failedCost>=local.material&&failedCost>=8*base.department;
    const spendCandidate=scale.usable&&((total>=local.fence&&total>=local.material&&aboveBothBaselines)||materialRetry);
    // Failed attempts that repeat one request until it succeeds: same content, retried.
    const retryLoop=failed>=2&&completed&&new Set(records.map(r=>normalize(r.input_excerpt))).size<=2;
    // Completion explains the repetition, not the financial impact. Keep a modest
    // completed retry loop out of the queue, but surface one whose failed spend
    // is materially unusual against the same employee/department baselines.
    if (retryLoop && !spendCandidate) {
      decisions.push({type:'spend',label:'Completed retry loop',detail:`${failed} of ${records.length} attempts failed, incurring ${money(failedCost)}, but each was a retry of the same request and the workflow completed. Total cost was ${money(total)}.`,outcome:'No review',records});
    } else if (spendCandidate) {
      const sensitiveCase=cases.find(c=>c.id===id&&c.type==='sensitive');
      if(sensitiveCase)sensitiveCase.why.push(`${money(total)} session cost also exceeded typical spending`);
      else if(coherentProject) { /* Summarized with the full project below. */ }
      else if(failed>=2) cases.push(makeCase({id:`${id}-spend`,type:'spend',recommendation:'Review',fence:local.fence,first,records,total,title:'Repeated failures incurred material cost',summary:`${failed} of ${records.length} requests failed and incurred ${money(failedCost)}; this session cost ${money(total)}.`,what:`In ${Math.max(1,Math.round(duration))} minutes, ${first.employee_id} made ${records.length} requests in ${first.tool_name}. ${failed} failed while still incurring ${money(failedCost)}.`,why:[`${failed} of ${records.length} requests failed`,`${money(failedCost)} charged for failed requests`,`${money(total)} total session cost`,`${relative.toFixed(0)}× the higher of employee and department typical session cost`],unknown:['What caused the failed responses','Whether the workflow was time-sensitive or approved','Whether a less costly retry strategy was available'],next:'Confirm retry costs',nextCopy:'Check why the attempts failed, whether the spend was expected, and how to prevent repeat cost.'}));
      else cases.push(makeCase({id:`${id}-spend`,type:'spend',recommendation:'Review',fence:local.fence,first,records,total,title:'Unexplained high-cost session',summary:`This session cost ${money(total)}, well above the employee and department patterns. The available records do not explain the expense.`,what:`${first.employee_id} generated ${records.length} related request${records.length===1?'':'s'} totaling ${money(total)} in ${first.tool_name}. No clear project explanation appears in the available records.`,why:[`${money(total)} total session cost`,`${relative.toFixed(0)}× the higher of employee and department typical session cost`],unknown:['Whether the work belonged to an approved project','Whether a lower-cost workflow was available'],next:'Confirm spend context',nextCopy:'Check the business purpose and whether this level of spend was expected.'}));
    }
  }

  const projectGroups=Object.values(groupBy(sessions.filter(s=>s[0].project_tag&&!/^(routine|general|misc)( work| activity)?$/i.test(s[0].project_tag)),s=>`${s[0].employee_id}|${s[0].project_tag}`));
  for(const projectSessions of projectGroups){
    projectSessions.sort((a,b)=>a[0].time-b[0].time);
    const episodes=[];
    for(const session of projectSessions){
      const last=episodes.at(-1), previous=last?.at(-1)?.at(-1)?.time;
      if(!last||session[0].time-previous>7*86400000)episodes.push([session]);
      else last.push(session);
    }
    for(const episode of episodes){
      const projectRows=episode.flat().sort((a,b)=>a.time-b.time);
      const projectCost=projectRows.reduce((sum,r)=>sum+r.cost,0);
      const coherentBatch=scale.usable&&projectCost>=scale.material&&uniformCompletedBatch(projectRows);
      const projectIds=new Set(projectRows.map(r=>r.request_id));
      if(coherentBatch){
        for(let i=cases.length-1;i>=0;i--)if(cases[i].type==='spend'&&cases[i].records.some(r=>projectIds.has(r.request_id)))cases.splice(i,1);
        decisions.push({type:'spend',key:`${projectRows[0].employee_id}|${projectRows[0].project_tag}|${projectRows[0].request_id}`,label:'Large, coherent project spend',detail:`${money(projectCost)} across ${projectRows.length} requests under one project tag, every one completed, none signaled, with costs in a tight band. The spend was unusual but the shape is planned batch work.`,outcome:'No review',records:projectRows});
        continue;
      }
      if(!scale.usable||episode.length<3||projectCost<2*scale.material)continue;
      const first=projectRows[0];
      const ordinary=sessionCosts.filter(s=>!episode.includes(sessions[s.index]));
      if(ordinary.length<3)continue; // No independent normal history to compare this project with.
      const ordinaryDepartment=median(ordinary.filter(s=>s.department===first.department).map(s=>s.total).filter(x=>x>0))||median(ordinary.map(s=>s.total).filter(x=>x>0))||0.01;
      const ordinaryEmployee=median(ordinary.filter(s=>s.employee===first.employee_id).map(s=>s.total).filter(x=>x>0))||ordinaryDepartment;
      const projectTypical=Math.max(ordinaryEmployee,ordinaryDepartment);
      if(projectCost<20*projectTypical)continue;
      const average=projectCost/episode.length;
      if(average<4*projectTypical)continue;
      for(let i=cases.length-1;i>=0;i--)if(cases[i].type==='spend'&&cases[i].records.some(r=>projectIds.has(r.request_id)))cases.splice(i,1);
      if(cases.some(c=>c.type==='sensitive'&&c.records.some(r=>projectIds.has(r.request_id))))continue;
      cases.push(makeCase({id:`${first.employee_id}-${first.project_tag}-${first.request_id}-spend`,type:'spend',recommendation:'Review',fence:20*projectTypical,first,records:projectRows,total:projectCost,title:'Sustained project spend above baseline',summary:`${money(projectCost)} accumulated over ${episode.length} sessions of the same project, without a clear explanation in the records.`,what:`Across ${episode.length} sessions, ${first.employee_id} spent ${money(projectCost)} in ${first.tool_name} on ${first.project_tag}. The pattern was sustained, not a single costly request.`,why:[`${money(projectCost)} total across ${episode.length} related sessions`,`${money(average)} average session cost versus ${money(projectTypical)} typical session cost outside this project`],unknown:['Whether this project and budget were approved','Whether the repeated cost was expected for the work'],next:'Confirm project budget',nextCopy:'Check who owns the project budget and whether the sustained spend was expected.'}));
    }
  }

  const signaledSessions=new Set(rows.filter(r=>r.content_signal&&r.content_signal!=='none').map(r=>`${r.employee_id}|${r.session_id||r.request_id}`));
  const publicPersonal=rows.filter(r=>r.account_type==='personal'&&(!r.content_signal||r.content_signal==='none')&&!signaledSessions.has(`${r.employee_id}|${r.session_id||r.request_id}`));
  if(publicPersonal.length){
    const workflows=new Set(publicPersonal.map(r=>`${r.employee_id}|${r.project_tag||r.session_id}`));
    decisions.push({label:'Personal accounts, no signal',detail:`${publicPersonal.length} requests across ${workflows.size} workflow${workflows.size===1?'':'s'} ran on personal accounts in sessions where nothing was signaled. Personal-account use alone did not justify review.`,outcome:'No review',records:publicPersonal});
  }

  const templateKey=c=>{
    if(c.type!=='sensitive')return null;
    const sent=c.records.filter(r=>r.content_signal&&r.content_signal!=='none'&&r.request_status!=='blocked_before_sending');
    const prints=new Set(sent.map(r=>normalize(r.input_excerpt)).filter(Boolean));
    return prints.size===1?`${c.employee}|${[...prints][0]}`:null;
  };
  for(const group of Object.values(groupBy(cases.filter(templateKey),templateKey))){
    if(group.length<3)continue;
    const records=group.flatMap(c=>c.records);
    const sessionCount=new Set(records.map(r=>`${r.employee_id}|${r.session_id||r.request_id}`)).size;
    const lead=group[0];
    const sentAll=records.filter(r=>r.content_signal&&r.content_signal!=='none'&&r.request_status!=='blocked_before_sending');
    const personalAll=sentAll.filter(r=>r.account_type==='personal').length;
    const peakAll=sentAll.reduce((peak,r)=>Math.max(peak,Number(r.confidence)||0),0);
    const repeatedKind=sentAll.some(r=>r.content_signal==='possible_credentials')?'credential-shaped content':sentAll.some(r=>r.content_signal==='possible_customer_data')?'possible customer data':sentAll.some(r=>r.content_signal==='possible_personal_data')?'possible personal data':'sensitive-looking content';
    const mergedWhy=[
      `The same content repeated across ${sessionCount} separate sessions`,
      `${sentAll.length} signaled request${sentAll.length===1?' was':'s were'} not blocked before sending`,
      personalAll?`${personalAll} of them used a personal account`:'Account ownership could not be confirmed',
      peakAll?`The strongest signal was detected at ${pct(peakAll)} confidence`:''
    ].filter(Boolean);
    const merged={...lead,id:`${lead.employee}-template-${lead.records[0].request_id}`,records,
      total:records.reduce((sum,r)=>sum+r.cost,0),recommendation:'Review',
      title:`Repeated ${repeatedKind} on a ${lead.records.some(r=>r.account_type==='personal')?'personal':'company'} AI account`,
      summary:`${records.length} requests across ${sessionCount} sessions carried the same ${repeatedKind}, differing only by a number.`,
      what:`${lead.employee} made ${records.length} requests in ${lead.tool} whose content is identical apart from a changing index. The detector signalled each one, but repetition alone cannot distinguish sample material from a repeated disclosure.`,
      why:mergedWhy,
      unknown:['Whether this is templated or sample material, or the same disclosure repeated',...lead.unknown],
      next:'Determine whether the repeated content was real or sample material',
      nextCopy:'Verify whether this was templated or example content, or a repeated disclosure, and whether use of this account was approved.'};
    for(const c of group)cases.splice(cases.indexOf(c),1);
    cases.push(merged);
  }

  const spendExplained=new Set(decisions.filter(d=>d.type==='spend').flatMap(d=>(d.records||[]).map(r=>r.request_id)));
  const employeeRecords=groupBy(rows,r=>r.employee_id);
  const employeeTotals=new Map(Object.entries(employeeRecords).map(([emp,recs])=>[emp,recs.filter(r=>!spendExplained.has(r.request_id)).reduce((sum,r)=>sum+r.cost,0)]));
  const employeeValues=[...employeeTotals.values()].filter(x=>x>0);
  if(scale.usable&&employeeValues.length>=8){
    const peerTypical=median(employeeValues);
    // With a uniform peer group the fence collapses onto the median, so hold a floor of 4x.
    const employeeFence=Math.max(outlierFence(employeeValues),4*peerTypical);
    for(const [emp,unexplained] of employeeTotals){
      if(unexplained<employeeFence||unexplained<scale.material)continue;
      if(cases.some(c=>c.type==='spend'&&c.records.some(r=>r.employee_id===emp)))continue;
      const records=employeeRecords[emp].filter(r=>!spendExplained.has(r.request_id)).sort((a,b)=>b.cost-a.cost);
      if(!records.length)continue;
      const sessionCount=new Set(records.map(r=>r.session_id||r.request_id)).size;
      cases.push(makeCase({id:`${emp}-aggregate-spend`,type:'spend',recommendation:'Review',fence:employeeFence,first:records[0],records,total:unexplained,
        title:'Sustained spend well above peers',
        summary:`${money(unexplained)} across ${sessionCount} session${sessionCount===1?'':'s'}, against ${money(peerTypical)} for a typical employee. No single session stands out.`,
        what:`${emp} accounts for ${money(unexplained)} across ${sessionCount} session${sessionCount===1?'':'s'} that nothing else explains. Individually the sessions look ordinary; it is the total that separates them from peers.`,
        why:[`${money(unexplained)} in total, against ${money(peerTypical)} for a typical employee`,`Spread across ${sessionCount} session${sessionCount===1?'':'s'} rather than one spike`],
        unknown:['Whether this volume of work is expected for the role','Whether a cheaper model or workflow would do the same job'],
        next:'Confirm the workload is expected',
        nextCopy:'Check whether this level of ongoing use matches the role, and whether a cheaper setup would serve.'}));
    }
  }

  const unique = Array.from(new Map(cases.map(c=>[c.id,c])).values());
  // Sensitive before spend is a position, not an accident: exposure is irreversible, spend is recoverable.
  const typeRank={sensitive:0,spend:1};
  const severityOf=c=>{
    if(c.type==='spend')return c.fence>0?c.total/c.fence:c.total;
    const sent=c.records.filter(r=>r.content_signal&&r.content_signal!=='none'&&r.request_status!=='blocked_before_sending');
    // Count what was exposed, not how often. One template sent five times is one thing;
    // a request with no visible excerpt stays its own unknown, since we cannot rule it out.
    const visible=new Set(sent.map(r=>normalize(r.input_excerpt)).filter(Boolean)).size;
    const unseen=sent.filter(r=>!normalize(r.input_excerpt)).length;
    return (visible+unseen)*(sent.reduce((peak,r)=>Math.max(peak,Number(r.confidence)||0),0)||0.5);
  };
  const latestOf=c=>c.records.reduce((latest,r)=>Math.max(latest,r.time||0),0);
  unique.sort((a,b)=>
    (a.recommendation==='Investigate'?0:1)-(b.recommendation==='Investigate'?0:1)
    ||typeRank[a.type]-typeRank[b.type]
    ||severityOf(b)-severityOf(a)
    ||latestOf(b)-latestOf(a));
  return {rows,cases:unique,duplicates,invalidRows,decisions,scale,rawCount:inputRows.length};
}

function signalName(signal){ return ({possible_customer_data:'possible customer data',possible_personal_data:'possible personal data',possible_credentials:'credential-shaped content'}[signal]||signal.replaceAll('_',' ')); }
function makeCase(x){return {...x,employee:x.first.employee_id,department:x.first.department,tool:x.first.tool_name,status:'New',needsReview:true,resolution:null,activity:[{text:'Case created from assessed activity',time:'System assessment'}]};}

function datasetKey(rows){
  const fields=['request_id','occurred_at','employee_id','department','tool_name','account_type','session_id','project_tag','request_status','input_excerpt','excerpt_status','content_signal','content_detector_confidence','input_tokens','output_tokens','estimated_cost_usd_per_request'];
  const text=rows.map(r=>fields.map(field=>r[field]||'').join('\u001f')).sort().join('\n');
  let hash=2166136261;
  for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
  return (hash>>>0).toString(36);
}
function hydrateCases(cases,allowLegacy=false) {
  let saved={};
  try{saved=JSON.parse(localStorage.getItem(`air-case-state-${state.datasetKey}`)||(allowLegacy?localStorage.getItem('air-case-state'):null)||'{}');}catch{}
  return cases.map(c=>saved[c.id]?{...c,...saved[c.id],needsReview:saved[c.id].needsReview ?? saved[c.id].status==='New'}:c);
}
const decisionId=d=>d.key||d.records?.map(r=>r.request_id).join('|')||d.label;
function loadOverrides(){ try{return JSON.parse(localStorage.getItem(`air-overrides-${state.datasetKey}`)||'{}');}catch{return {};} }
function saveOverrides(){ try{localStorage.setItem(`air-overrides-${state.datasetKey}`,JSON.stringify(state.overrides||{}));}catch{} }
// A reviewer disagreeing with an automatic explanation produces a real case, not a flag.
function caseFromDecision(d){
  const records=d.records||[];if(!records.length)return null;
  const first=records[0],total=records.reduce((sum,r)=>sum+(Number(r.cost)||Number(r.estimated_cost_usd_per_request)||0),0);
  const c=makeCase({id:`reviewer-${decisionId(d)}`,type:d.type==='spend'?'spend':'sensitive',recommendation:'Review',first,records,total,
    title:`Reviewer opened: ${d.label}`,
    summary:d.detail,
    what:`The assessment explained this activity as “${d.label}” and kept it out of the queue. A reviewer disagreed and opened it.`,
    why:['A reviewer judged the automatic explanation insufficient',d.detail],
    unknown:['Whether the pattern the assessment relied on actually explains this activity'],
    next:'Check these records by hand',
    nextCopy:'Confirm whether the explanation holds once you read the records yourself, then resolve or escalate.'});
  c.activity=[{text:'Opened by reviewer from the assessment summary',time:'Reviewer'}];
  return c;
}
function applyPromotions(stats){
  const promoted=new Set(state.overrides.promoted||[]);if(!promoted.size)return;
  const extra=stats.decisions.filter(d=>d.outcome==='No review'&&promoted.has(decisionId(d))).map(caseFromDecision).filter(Boolean);
  if(extra.length)state.cases=[...hydrateCases(extra),...state.cases];
}
function persist(){ const out=Object.fromEntries(state.cases.map(c=>[c.id,{status:c.status,needsReview:c.needsReview,resolution:c.resolution,activity:c.activity,contextRequest:c.contextRequest}]));localStorage.setItem(`air-case-state-${state.datasetKey}`,JSON.stringify(out)); }

function caseIcon(type){return type==='sensitive'?'<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.26,47,25.53a8,8,0,0,0,4.2,0c1-.27,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z"/></svg>':'<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M152,120H136V56h8a32,32,0,0,1,32,32,8,8,0,0,0,16,0,48.05,48.05,0,0,0-48-48h-8V24a8,8,0,0,0-16,0V40h-8a48,48,0,0,0,0,96h8v64H104a32,32,0,0,1-32-32,8,8,0,0,0-16,0,48.05,48.05,0,0,0,48,48h16v16a8,8,0,0,0,16,0V216h16a48,48,0,0,0,0-96Zm-40,0a32,32,0,0,1,0-64h8v64Zm40,80H136V136h16a32,32,0,0,1,0,64Z"/></svg>';}
function casesForView(cases,view){return cases.filter(c=>c.status!=='Resolved'&&c.status!=='Dismissed'&&(view==='review'?(c.status==='New'||c.needsReview):(c.status!=='New'&&!c.needsReview)));}

function render(){
  const review=casesForView(state.cases,'review');
  const progress=casesForView(state.cases,'progress');
  document.querySelector('#review-count').textContent=review.length||'';
  document.querySelector('#progress-count').textContent=progress.length||'';
  const list=state.view==='review'?review:progress;
  document.querySelector('#view-title').textContent='Open cases';
  document.querySelector('#assessment-copy').textContent='Assessment summary';
  const q=document.querySelector('#queue');q.innerHTML=list.map(caseRow).join('');
  document.querySelector('#empty-state').classList.toggle('hidden',list.length>0);
  document.querySelector('#empty-copy').textContent=state.view==='review'?'No new cases or updates need review.':'No cases are currently in progress.';
  q.querySelectorAll('.case-row').forEach(b=>b.onclick=()=>{openCase(b.dataset.id);});
  document.querySelectorAll('.nav-button').forEach(b=>{const active=b.dataset.view===state.view;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
  document.querySelector('#cases-panel').setAttribute('aria-labelledby',`${state.view}-tab`);
}
function activityText(text){const oldRequest=String(text||'').match(/^Context request (?:prepared for (.+) · demo|recorded for (.+))$/);if(oldRequest)return `Context request sent to ${oldRequest[1]||oldRequest[2]}`;return ({'Employee context requested':'Marked as waiting for employee context','Expense context check started':'Marked as waiting for expense context'})[text]||text;}
function caseRow(c){const typeLabel=c.type==='sensitive'?'Sensitive data':'Spending';const latestUpdate=c.status==='New'?'':c.activity?.[0]?.text||c.status;return `<button class="case-row" data-id="${esc(c.id)}"><span class="signal-icon ${c.type}" aria-hidden="true">${caseIcon(c.type)}</span><span><span class="row-topline"><span class="case-type ${c.type}">${typeLabel}</span>${latestUpdate?`<span class="case-update">${esc(activityText(latestUpdate))}</span>`:''}</span><h2>${esc(c.title)}</h2><p>${esc(c.summary)}</p><span class="meta">${esc(c.employee)} · ${esc(c.department)} · ${esc(c.tool)} · ${c.records.length} related request${c.records.length>1?'s':''}</span></span><span class="row-arrow">›</span></button>`}

function caseHistory(activity,contextRequest){
  const entries=Array.isArray(activity)?activity:[];
  const visible=entries.slice(0,2), older=entries.slice(2);
  const item=a=>{const attached=contextRequest&&a.time===contextRequest.time&&/^Context request (prepared|recorded|sent)/.test(a.text);const detail=attached?'':String(a.detail||'').replace(/^No email sent\.\s*/,'');const prepared=attached?`<details class="prepared-request"><summary class="inline-toggle"><span class="when-closed">View prepared message</span><span class="when-open">Collapse prepared message</span></summary><div class="prepared-request-body"><strong>${esc(contextRequest.subject)}</strong><span>${esc(contextRequest.recipient)}</span><p>${esc(contextRequest.body)}</p></div></details>`:'';return `<div class="timeline-item"><span class="timeline-dot"></span><div class="timeline-content"><p>${esc(activityText(a.text))}${detail?`<span class="history-detail">${esc(detail)}</span>`:''}<time>${esc(a.time)}</time></p>${prepared}</div></div>`;};
  return `<section class="detail-section history-section"><h3>Case history</h3><div class="timeline">${visible.map(item).join('')||'<p class="history-empty">No updates yet.</p>'}</div>${older.length?`<details class="workflow-activity"><summary class="inline-toggle"><span class="when-closed">View ${older.length} earlier update${older.length===1?'':'s'}</span><span class="when-open">Collapse ${older.length} earlier update${older.length===1?'':'s'}</span></summary><div class="timeline">${older.map(item).join('')}</div></details>`:''}</section>`;
}

function supportingRecordOrder(c){
  const priority=r=>c.type==='sensitive'
    ?(r.content_signal&&r.content_signal!=='none'&&r.request_status!=='blocked_before_sending'?100:0)+(r.account_type==='personal'?10:0)+(r.excerpt_status==='available'&&r.input_excerpt?5:0)
    :(r.request_status==='failed'?100:0)+Number(r.cost||0);
  return [...c.records].sort((a,b)=>priority(b)-priority(a)||(a.time||0)-(b.time||0));
}
function nextStepForCase(c){
  if(c.status==='Awaiting response')return {next:'Review the response when it arrives',nextCopy:`Awaiting context from ${c.employee}. Record the response, then decide whether to escalate or resolve.`};
  if(c.status==='Waiting for context')return {next:'Review the requested context',nextCopy:'Record the response when it arrives, then decide whether to escalate or resolve.'};
  if(c.status==='In progress'&&c.activity?.[0]?.text==='Context received')return c.type==='spend'
    ?{next:'Assess the spend explanation',nextCopy:'Compare the response with the cost and retry pattern, then resolve or continue follow-up.'}
    :{next:'Assess the data-use explanation',nextCopy:'Compare the response with the account and content evidence, then resolve or escalate.'};
  return {next:c.next,nextCopy:c.nextCopy};
}

function caseStatusTone(c){return c.status==='Waiting for context'||c.status==='Awaiting response'?'waiting':c.status==='In progress'?'progress':c.status==='Resolved'?'resolved':'new';}
function caseStatusLabel(c){return c.status==='Resolved'&&c.resolution?`${c.status} · ${c.resolution}`:c.status;}

// The page has room for every record at once, so they go in a table you can read down a column.
function recordRow(r){
  const blocked=r.request_status==='blocked_before_sending';
  const signaled=r.content_signal&&r.content_signal!=='none';
  const statusTone=blocked?'tag-blocked':r.request_status==='failed'?'tag-failed':r.request_status==='completed'?'tag-completed':'';
  const accountTone=r.account_type==='personal'?'tag-personal':r.account_type==='company_managed'?'tag-managed':'tag-unknown';
  const statusLabel=blocked?'Blocked before sending':r.request_status==='failed'?'Failed':r.request_status==='completed'?'Completed':r.request_status.replaceAll('_',' ');
  const accountLabel=r.account_type==='personal'?'Personal':r.account_type==='company_managed'?'Managed':r.account_type==='unknown'?'Unknown':r.account_type.replaceAll('_',' ');
  return `<tr><td data-label="Request"><span class="record-id">${esc(r.request_id)}</span><span class="record-time">${fmtDate(r.occurred_at)}</span></td><td data-label="Excerpt" class="record-excerpt">${esc(r.input_excerpt||`Excerpt ${r.excerpt_status||'unavailable'}`)}</td><td data-label="Status"><span class="tiny-tag ${statusTone}">${esc(statusLabel)}</span></td><td data-label="Account"><span class="tiny-tag ${accountTone}">${esc(accountLabel)}</span></td><td data-label="Signal">${signaled?`<span class="tiny-tag tag-signal">${esc(signalName(r.content_signal))}${r.confidence?` · ${pct(r.confidence)}`:''}</span>`:'<span class="record-none">—</span>'}</td><td data-label="Cost" class="record-cost">${money(r.cost)}</td></tr>`;
}

function openCase(id){
  const original=state.cases.find(x=>x.id===id);if(!original)return;const c={...original,...nextStepForCase(original)};state.selected=id;
  const rankedRecords=supportingRecordOrder(c).slice(0,50);
  // The wider sheet fits the table, so every record is visible instead of behind an accordion.
  const supportingRecords=`<section class="detail-section evidence-section"><div class="section-heading"><h3>Supporting records <span class="section-count">${c.records.length}</span></h3>${rankedRecords.length<c.records.length?`<span class="record-count">${rankedRecords.length} of ${c.records.length} shown</span>`:''}</div><div class="record-table-wrap"><table class="record-table"><thead><tr><th>Request</th><th>Excerpt</th><th>Status</th><th>Account</th><th>Signal</th><th class="record-cost">Cost</th></tr></thead><tbody>${rankedRecords.map(recordRow).join('')}</tbody></table></div></section>`;
  const workflowActivity=caseHistory(c.activity,c.contextRequest);
  const statusTone=caseStatusTone(c);
  const statusLabel=caseStatusLabel(c);
  const sheet=document.querySelector('#detail-sheet');sheet.innerHTML=`<div class="sheet-inner"><header class="sheet-header"><span class="case-meta">${c.type==='sensitive'?'Sensitive data':'Spending'} · ${esc(c.employee)} · ${esc(c.department)} · ${esc(c.tool)}</span><button class="close-button" data-close aria-label="Close"><svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg></button></header><h2 class="case-title">${esc(c.title)}</h2><span class="workflow-pill ${statusTone}" aria-label="Current status: ${esc(statusLabel)}">${esc(statusLabel)}</span><section class="detail-section"><h3>What happened</h3><p>${esc(c.what)}</p></section><section class="detail-section"><h3>Why this evidence matters</h3><ul class="evidence-list">${c.why.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>${supportingRecords}<section class="detail-section"><h3>What we don’t know</h3><ul class="evidence-list unknown-list">${c.unknown.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section><section class="detail-section"><h3>Recommended next step</h3><div class="next-step"><strong>${esc(c.next)}</strong><p>${esc(c.nextCopy)}</p></div><div class="actions">${actionButtons(c)}</div><div id="case-action-form-slot"></div></section>${workflowActivity}</div>`;
  sheet.querySelector('[data-close]').onclick=closeSheets;
  sheet.querySelectorAll('[data-open-action]').forEach(b=>b.onclick=()=>openActionForm(b.dataset.openAction));
  const reopen=sheet.querySelector('[data-action="reopen"]');if(reopen)reopen.onclick=reopenCase;
  showSheet(sheet);
}
function actionButtons(c){
  if(c.status==='Resolved'||c.status==='Dismissed')return `<button class="action-button" data-action="reopen">Reopen case</button>`;
  return `${c.status==='Awaiting response'?'<span class="awaiting-inline-status" role="status">Awaiting response</span>':'<button class="action-button primary" data-open-action="context">Request context</button>'}<button class="action-button" data-open-action="update">Add case update</button><button class="action-button" data-open-action="resolve">Resolve case</button><button class="action-button" data-open-action="dismiss">Not worth review</button>`;
}
function logItem(r){
  const blocked=r.request_status==='blocked_before_sending';
  const signaled=r.content_signal&&r.content_signal!=='none';
  const statusTone=blocked?'tag-blocked':r.request_status==='failed'?'tag-failed':r.request_status==='completed'?'tag-completed':'';
  const accountTone=r.account_type==='personal'?'tag-personal':r.account_type==='company_managed'?'tag-managed':'tag-unknown';
  const statusLabel=blocked?'Blocked before sending':r.request_status==='failed'?'Failed':r.request_status==='completed'?'Completed':r.request_status.replaceAll('_',' ');
  const accountLabel=r.account_type==='personal'?'Personal account':r.account_type==='company_managed'?'Managed account':r.account_type==='unknown'?'Unknown account':r.account_type.replaceAll('_',' ');
  return `<div class="log-item"><div class="log-head"><span>${esc(r.request_id)} · ${fmtDate(r.occurred_at)}</span><span>${money(r.cost)}</span></div><p>${esc(r.input_excerpt || `Excerpt ${r.excerpt_status || 'unavailable'}`)}</p><div class="log-tags"><span class="tiny-tag ${statusTone}">${esc(statusLabel)}</span><span class="tiny-tag ${accountTone}">${esc(accountLabel)}</span>${signaled?`<span class="tiny-tag tag-signal">${esc(signalName(r.content_signal))}${r.confidence?` · ${pct(r.confidence)}`:''}</span>`:''}</div></div>`;
}

function actionForm(mode,c){
  if(mode==='dismiss')return `<form class="case-action-form" id="case-action-form"><h4>Not worth review</h4><p class="action-form-help">This takes the case out of the queue and records why. It stays listed in the assessment summary and can be reopened.</p><label for="case-action-detail">Why doesn’t this need review?</label><textarea id="case-action-detail" name="detail" required maxlength="500" rows="3" placeholder="What explains this activity?"></textarea><div class="action-form-buttons"><button type="submit" class="action-button primary">Dismiss case</button><button type="button" class="action-button" id="cancel-case-action">Cancel</button></div></form>`;
  const update=mode==='update';
  const caseSpecific=c?.type==='spend'?'<option value="spend_owner">Spend owner consulted outside this app</option>':'<option value="security_escalated">Escalated to security/privacy outside this app</option>';
  const choices=update?`<option value="" selected disabled>Select an update</option><option value="started">Review started</option><option value="requested">Context requested outside this app</option><option value="received">Context received</option>${caseSpecific}<option value="other">Other update</option>`:`<option value="" selected disabled>Select an outcome</option><option value="expected">Expected / approved activity</option><option value="noissue">No issue / false positive</option><option value="confirmed">Issue confirmed</option>`;
  return `<form class="case-action-form" id="case-action-form"><h4>${update?'Add case update':'Resolve case'}</h4><p class="action-form-help">${update?'Record what you did or learned.':'Choose the outcome and explain what the evidence supports.'}</p><label for="case-action-choice">${update?'What happened':'Outcome'}</label><select id="case-action-choice" name="choice" required>${choices}</select><label for="case-action-detail">${update?'Details':'Reason'}</label><textarea id="case-action-detail" name="detail" required maxlength="500" rows="3" placeholder="${update?'Briefly describe what you did or learned.':'What supports this outcome? Note any follow-up taken.'}"></textarea><div class="action-form-buttons"><button type="submit" class="action-button primary">${update?'Save update':'Resolve case'}</button><button type="button" class="action-button" id="cancel-case-action">Cancel</button></div></form>`;
}
function contextDraft(c){
  const first=c.records[0];
  const date=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'}).format(new Date(first.occurred_at));
  const recipient=`Employee ${c.employee} · ${c.department}`;
  const subject=`Context requested: ${c.type==='spend'?'AI spend':'AI data use'} on ${date}`;
  const greeting=`Hi ${c.employee},`;
  const message=c.type==='spend'
    ?`We are reviewing ${c.records.length} related AI requests in ${c.tool} on ${date}, totaling ${money(c.total)}. Could you confirm the business purpose, whether this spend was expected or approved, and whether there is project or budget context we should consider? ${c.records.some(r=>r.request_status==='failed')?'Some attempts failed while incurring cost; please also share what caused the retries and whether the issue is resolved.':''}`
    :`We are reviewing related AI activity in ${c.tool} on ${date}. Could you confirm the work purpose, which account was used, what categories of information were entered, and whether that use was approved? Please do not include customer details or other sensitive content in your reply.`;
  return {recipient,subject,body:`${greeting}\n\n${message}\n\nThanks,\nIT`};
}
function contextRequestForm(c){
  const draft=contextDraft(c);
  return `<form class="case-action-form context-request-form" id="case-action-form"><h4>Request context</h4><div class="draft-recipient"><span>To</span><strong>${esc(draft.recipient)}</strong></div><label for="context-subject">Subject</label><input id="context-subject" name="subject" required maxlength="150" value="${esc(draft.subject)}"><label for="context-body">Message</label><textarea id="context-body" name="body" required maxlength="2000" rows="8">${esc(draft.body)}</textarea><div class="action-form-buttons"><button type="submit" class="action-button primary">Send request</button><button type="button" class="action-button" id="cancel-case-action">Cancel</button></div></form>`;
}
function recordSimulatedContextRequest(c,subject,body,time){
  const cleanSubject=String(subject||'').trim(),cleanBody=String(body||'').trim();
  if(!cleanSubject||!cleanBody||c.status==='Resolved'||c.status==='Awaiting response')return false;
  c.contextRequest={recipient:contextDraft(c).recipient,subject:cleanSubject,body:cleanBody,time,simulated:true};
  c.status='Awaiting response';c.needsReview=false;c.resolution=null;
  c.activity=[{text:`Context request sent to ${c.employee}`,time},...c.activity];
  return true;
}
function openActionForm(mode){
  const c=state.cases.find(x=>x.id===state.selected);if(!c)return;
  const slot=document.querySelector('#case-action-form-slot');slot.innerHTML=mode==='context'?contextRequestForm(c):actionForm(mode,c);
  if(mode==='context'){
    const form=slot.querySelector('form');form.onsubmit=e=>{e.preventDefault();const data=new FormData(form),now=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date());if(!recordSimulatedContextRequest(c,data.get('subject'),data.get('body'),now))return;persist();state.view='progress';render();openCase(c.id);showToast('Request sent');};
    slot.querySelector('#cancel-case-action').onclick=()=>{slot.innerHTML='';};
    slot.querySelector('#context-subject').focus();return;
  }
  const form=slot.querySelector('form');form.onsubmit=e=>{e.preventDefault();const c=state.cases.find(x=>x.id===state.selected);if(!c)return;const data=new FormData(form),now=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date());if(!recordCaseAction(c,mode,data.get('choice'),data.get('detail'),now))return;persist();render();openCase(c.id);showToast(mode==='update'?'Case updated':mode==='dismiss'?'Case dismissed':'Case resolved');};
  slot.querySelector('#cancel-case-action').onclick=()=>{slot.innerHTML='';};
  (slot.querySelector('select')||slot.querySelector('textarea')).focus();
}
function recordCaseAction(c,mode,choice,detail,time){
  const note=String(detail||'').trim();if(!note||c.status==='Resolved')return false;
  if(mode==='dismiss'){c.status='Dismissed';c.needsReview=false;c.resolution='Not worth review';c.activity=[{text:'Dismissed as not worth review',detail:note,time},...c.activity];return true;}
  const updates={started:{text:'Review started',status:'In progress'},requested:{text:'Context requested outside this app',status:'Waiting for context'},received:{text:'Context received',status:'In progress'},security_escalated:{text:'Escalated to security/privacy outside this app',status:'In progress'},spend_owner:{text:'Spend owner consulted outside this app',status:'In progress'},other:{text:'Case updated',status:'In progress'}};
  const outcomes={expected:{text:'Resolved as expected / approved activity',resolution:'Expected / approved activity'},noissue:{text:'Resolved as no issue / false positive',resolution:'No issue / false positive'},confirmed:{text:'Resolved as issue confirmed',resolution:'Issue confirmed'}};
  if((choice==='security_escalated'&&c.type!=='sensitive')||(choice==='spend_owner'&&c.type!=='spend'))return false;
  const selected=mode==='update'?updates[choice]:mode==='resolve'?outcomes[choice]:null;if(!selected)return false;
  c.status=mode==='resolve'?'Resolved':selected.status;c.needsReview=false;c.resolution=mode==='resolve'?selected.resolution:null;
  c.activity=[{text:selected.text,detail:note,time},...c.activity];return true;
}
function reopenCase(){
  const c=state.cases.find(x=>x.id===state.selected);if(!c||(c.status!=='Resolved'&&c.status!=='Dismissed'))return;
  const now=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date());
  c.status='In progress';c.needsReview=false;c.resolution=null;c.activity=[{text:'Case reopened',time:now},...c.activity];persist();render();openCase(c.id);showToast('Case reopened');
}
function promoteDecision(id){
  const d=(state.stats?.decisions||[]).find(x=>x.outcome==='No review'&&decisionId(x)===id);if(!d)return;
  const c=caseFromDecision(d);if(!c||state.cases.some(x=>x.id===c.id))return;
  state.overrides.promoted=[...new Set([...(state.overrides.promoted||[]),id])];
  state.cases=[c,...state.cases];
  saveOverrides();persist();render();renderAssessment();showToast('Case opened for review');
}
function reopenCaseById(id){
  const c=state.cases.find(x=>x.id===id);if(!c)return;
  const now=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date());
  c.status='In progress';c.needsReview=true;c.resolution=null;c.activity=[{text:'Case reopened',time:now},...c.activity];
  persist();render();renderAssessment();showToast('Case reopened');
}
function renderAssessment(){
  if(!state.stats)return;
  const s=state.stats;
  const noReview=Array.from(new Map(s.decisions.filter(d=>d.outcome==='No review').map(d=>[decisionId(d),d])).values());
  const promoted=new Set(state.overrides?.promoted||[]);
  const dismissed=state.cases.filter(c=>c.status==='Dismissed');
  const sensitiveCases=s.cases.filter(c=>c.type==='sensitive').length;
  const spendCases=s.cases.filter(c=>c.type==='spend').length;
  const spendNotes=noReview.filter(d=>d.type==='spend');
  const otherNotes=noReview.filter(d=>d.type!=='spend');
  const keptOut=[...spendNotes,...otherNotes];
  const noteRows=notes=>notes.map(d=>{const records=d.records||[],first=records[0],requestLabel=`${records.length} request${records.length===1?'':'s'}`,previewCount=Math.min(5,records.length),moreCount=records.length-previewCount;return `<div class="decision-row"><strong>${esc(d.label)}</strong><p>${esc(d.detail)}</p><div class="decision-actions">${promoted.has(decisionId(d))?'<span class="decision-opened">Opened as a case</span>':`<button class="action-button" data-promote="${esc(decisionId(d))}">Open a case</button>`}</div>${first?`<span class="decision-meta">${esc(first.employee_id)} · ${esc(first.department)} · ${esc(first.tool_name)}</span><details class="decision-evidence"><summary class="inline-toggle"><span class="when-closed">View ${requestLabel}</span><span class="when-open">Collapse ${requestLabel}</span></summary><span class="request-progress request-progress-partial">${previewCount} of ${records.length} shown</span><span class="request-progress request-progress-complete">${records.length} of ${records.length} shown</span><div class="log-list">${records.slice(0,previewCount).map(logItem).join('')}</div>${moreCount>0?`<details class="more-records"><summary class="inline-toggle"><span class="when-closed">View ${moreCount} more request${moreCount===1?'':'s'}</span><span class="when-open">Collapse ${moreCount} request${moreCount===1?'':'s'}</span></summary><div class="log-list">${records.slice(previewCount).map(logItem).join('')}</div></details>`:''}</details>`:''}</div>`}).join('');
  document.querySelector('#assessment-content').innerHTML=`<div class="assessment-inner"><button class="assessment-back" id="back-to-cases" type="button">← Back to cases</button><h1>Assessment summary</h1><div class="summary-grid"><div class="summary-stat"><strong>${s.rawCount}</strong><span>Records assessed</span></div><div class="summary-stat"><strong>${s.rows.length}</strong><span>Unique valid requests</span></div><div class="summary-stat"><strong>${sensitiveCases}</strong><span>Sensitive-data cases surfaced</span></div><div class="summary-stat"><strong>${spendCases}</strong><span>Spend cases surfaced</span></div></div>${keptOut.length?`<section class="harmless-section" aria-labelledby="harmless-heading"><div class="harmless-section-header"><h2 id="harmless-heading">Harmless unusual activity</h2><span class="decision-badge">No review</span></div><div class="harmless-items">${noteRows(keptOut)}</div></section>`:''}${dismissed.length?`<section class="harmless-section dismissed-section" aria-labelledby="dismissed-heading"><div class="harmless-section-header"><h2 id="dismissed-heading">Dismissed by reviewer</h2><span class="decision-badge">${dismissed.length} case${dismissed.length===1?'':'s'}</span></div><div class="harmless-items">${dismissed.map(c=>`<div class="decision-row"><strong>${esc(c.title)}</strong><p>${esc(c.activity?.[0]?.detail||'No reason recorded.')}</p><span class="decision-meta">${esc(c.employee)} · ${esc(c.department)} · ${esc(c.tool)} · ${c.records.length} related request${c.records.length===1?'':'s'}</span><div class="decision-actions"><button class="action-button" data-reopen="${esc(c.id)}">Reopen case</button></div></div>`).join('')}</div></section>`:''}${s.duplicates.length||s.invalidRows.length?`<section class="quality-section" aria-labelledby="quality-heading"><h2 class="summary-label" id="quality-heading">Data quality</h2>${s.duplicates.length?`<div class="decision-row"><strong>Duplicate request IDs</strong><span class="decision-badge">${s.duplicates.length} removed</span></div>`:''}${s.invalidRows.length?`<div class="decision-row"><strong>Missing or invalid ID, employee, date, or cost</strong><span class="decision-badge">${s.invalidRows.length} excluded</span></div>`:''}</section>`:''}</div>`;
  document.querySelector('#back-to-cases').onclick=closeAssessment;
  document.querySelectorAll('[data-promote]').forEach(b=>b.onclick=()=>promoteDecision(b.dataset.promote));
  document.querySelectorAll('[data-reopen]').forEach(b=>b.onclick=()=>reopenCaseById(b.dataset.reopen));
  document.querySelector('#case-page').classList.add('hidden');
  document.querySelector('#case-page').setAttribute('aria-hidden','true');
  document.querySelector('#assessment-page').classList.remove('hidden');
  document.querySelector('#assessment-page').setAttribute('aria-hidden','false');
  document.title='Assessment summary · AI Activity Review';
  window.scrollTo(0,0);
}
function closeAssessment(){document.querySelector('#assessment-page').classList.add('hidden');document.querySelector('#assessment-page').setAttribute('aria-hidden','true');document.querySelector('#case-page').classList.remove('hidden');document.querySelector('#case-page').setAttribute('aria-hidden','false');document.title='AI Activity Review';window.scrollTo(0,0);}
function showSheet(sheet){document.querySelector('#overlay').classList.remove('hidden');sheet.classList.add('open');sheet.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';}
function closeSheets(){document.querySelector('#overlay').classList.add('hidden');document.querySelectorAll('.detail-sheet').forEach(s=>{s.classList.remove('open');s.setAttribute('aria-hidden','true')});document.body.style.overflow='';}
let toastTimer;function showToast(msg){const t=document.querySelector('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2400)}
async function loadText(text,name,bundled=false){try{const parsed=parseCSV(text);const required=['request_id','occurred_at','employee_id','department','tool_name','account_type','session_id','request_status','estimated_cost_usd_per_request'];const missing=required.filter(k=>!(k in (parsed[0]||{})));if(missing.length)throw new Error(`Missing columns: ${missing.join(', ')}`);const stats=analyze(parsed);state.stats=stats;state.rows=stats.rows;state.decisions=stats.decisions;state.datasetKey=datasetKey(stats.rows);state.cases=hydrateCases(stats.cases,bundled);state.overrides=loadOverrides();applyPromotions(stats);state.sourceName=name;state.view='review';state.selected=null;closeSheets();render();if(!document.querySelector('#assessment-page').classList.contains('hidden'))renderAssessment();showToast(`${stats.rows.length} unique requests assessed`);}catch(e){showToast(e.message||'Could not read this CSV');}}

document.querySelectorAll('.nav-button').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render()});document.querySelector('#assessment-pill').onclick=renderAssessment;document.querySelector('#overlay').onclick=closeSheets;document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!document.querySelector('#assessment-page').classList.contains('hidden'))closeAssessment();else closeSheets()}});document.querySelector('#file-input').onchange=e=>{const f=e.target.files[0];if(f){const reader=new FileReader();reader.onload=()=>loadText(reader.result,f.name);reader.readAsText(f)}};
fetch('assets/employee_ai_usage.csv').then(r=>{if(!r.ok)throw new Error();return r.text()}).then(t=>loadText(t,'employee_ai_usage.csv',true)).catch(()=>showToast('Sample CSV could not be loaded'));
