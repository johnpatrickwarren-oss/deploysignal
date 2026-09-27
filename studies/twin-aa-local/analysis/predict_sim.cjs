const g=require('/Users/johnwarren/concord/.worktrees/deploysignal/twin-aa-local/node_modules/@johnpatrickwarren-oss/deploysignal-engine/dist/per-shard/twin-gate.js');
let s=12345;const u=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return (s+0.5)/4294967296};
const nz=()=>Math.sqrt(-2*Math.log(u()))*Math.cos(2*Math.PI*u());
function p99(a){if(!a.length)return NaN;a.sort((x,y)=>x-y);return a[Math.ceil(0.99*a.length)-1]}
function cell(name,w,metrics,R,T,n,p,pc,lm){
 const cfg={canaryWeight:w,alphaRollback:.05,alphaProceed:1e-12,alphaSrm:.001,maxTicks:T,allowUnequalRateSplit:w!==0.5,metrics};
 let rb=0,ticks=[],dep={rollback:0,proceed:0,other:0},srm=0;
 for(let r=0;r<R;r++){let st=g.initTwinGate(cfg),dv=null;
  for(let t=0;t<T;t++){let c=0,k=0,bc=0,bk=0,lc=[],lk=[];
   for(let i=0;i<n;i++){const can=u()<w;const lat=Math.max(1,Math.round(8*Math.exp(0.5*nz())*(can?lm:1)))+0.3+0.2*Math.abs(nz());const bad=u()<(can?pc:p);
    if(can){c++;bc+=bad;lc.push(lat)}else{k++;bk+=bad;lk.push(lat)}}
   const obs={};for(const m of metrics){if(m.kind==='rate')obs[m.id]={canaryEvents:bc,canaryTotal:c,controlEvents:bk,controlTotal:k};else obs[m.id]={canary:p99(lc),control:p99(lk)}}
   const o=g.stepTwinGate(cfg,st,{canaryRequests:c,controlRequests:k,observations:obs});st=o.state;const d=o.decision;
   if(dv===null){if(d.srmE>=1000)dv='invalid';else if(d.metrics.some(m=>m.rollbackE>=m.rollbackThreshold))dv='rollback';else if(d.metrics.every(m=>m.proceedE>=20))dv='proceed';}
   if(d.verdict!=='extend'){if(d.verdict==='rollback'){rb++;ticks.push(t+1)} if(d.verdict==='invalid_experiment')srm++;break}}
  dep[dv==='rollback'?'rollback':dv==='proceed'?'proceed':'other']++;}
 ticks.sort((a,b)=>a-b);console.log(name,'rollback',rb/R,'median',ticks[Math.floor(ticks.length/2)],'srm',srm,'deployed',JSON.stringify(dep));}
const RATE={id:'http_5xx',kind:'rate',worse:'higher',tolerance:0.2},SIGN={id:'p99_latency_ms',kind:'sign',worse:'higher',tolerance:0.15};
cell('AA-w0.5',0.5,[RATE,SIGN],1000,100,500,.02,.02,1);
cell('AA-w0.1',0.1,[RATE],1000,100,500,.02,.02,1);
cell('AB-rate-x2',0.5,[RATE,SIGN],500,100,500,.02,.04,1);
cell('AB-lat-x1.2',0.5,[RATE,SIGN],500,100,500,.02,.02,1.2);
cell('AB-lat-x1.1',0.5,[RATE,SIGN],500,100,500,.02,.02,1.1);
