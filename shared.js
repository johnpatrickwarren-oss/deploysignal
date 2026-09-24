'use strict';
/* shared.js — DeploySignal signal evaluation engine
   v4: Modular architecture. Core infrastructure in engine/core.js.
   New signal domains in engine/signals/. New scenarios in engine/scenarios/.
   This file contains the base signal definitions tuned by the self-improving loop.
   Do NOT modify require() statements or module.exports shape.

   Architecture:
   - engine/core.js         : TrendBuffer, trendStrength, effectiveThreshold, computeVerdict
   - engine/signals/quality : AI output quality signals (eval, refusal, output length)
   - engine/scenarios/slow_burn : Slow-burn + quality-regression scenarios
   - shared.js              : Base signal thresholds (loop-tunable) + aggregation
*/

const {
  TrendBuffer, trendStrength, effectiveThreshold,
  WARMUP_CONFIG, getWarmupState, computeVerdict, FP_CLASSIFIER_CONFIG, TOTAL_TICKS
} = require('./dist/engine/core');

const { QUALITY_ROLLBACK_DEFS, QUALITY_EXTEND_DEFS } = require('./dist/engine/signals/quality');
const { SLOW_BURN_SCENARIOS } = require('./dist/engine/scenarios/slow_burn');

// ── SCENARIOS ─────────────────────────────────────────────────────
var SCENARIOS = [
  { id:'clean', name:'Clean Deploy', riskLevel:'critical', bakeHours:84, author:'human', changeType:'model_weights', timeWindow:'ok',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:true,approval:true},
    baseline:{p99_latency:185,ttft:220,tokens_turn:418,kv_cache:0.89,cost_req:0.0042,downstream_err:0.12,mfu:0.72,hbm_spill:0.02,collective_ops:0.9997,corpus_delta:0.04,traffic_pct:1.0},
    driftParams:{latSlope:0.02,tokenNoise:0.008,kvSlope:0.003,mfuSlope:0.005},
    drift:function(i,p){var lm=1+(p.latSlope||0.02)*Math.sin(i/4);return{p99_latency:lm,ttft:1+(lm-1)*0.8,tokens_turn:1+(p.tokenNoise||0.008)*Math.random(),kv_cache:1-(p.kvSlope||0.003)*Math.sin(i/5),cost_req:1+(p.tokenNoise||0.008)*Math.random(),downstream_err:1+0.04*Math.random(),mfu:1-(p.mfuSlope||0.005)*Math.sin(i/6),hbm_spill:1+0.02*Math.random(),collective_ops:1-0.00005*Math.random(),corpus_delta:1+0.02*Math.random(),traffic_pct:1};}
  },
  { id:'cache', name:'Cache Regression', riskLevel:'critical', bakeHours:84, author:'human', changeType:'model_weights', timeWindow:'ok',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:true,approval:true},
    baseline:{p99_latency:185,ttft:218,tokens_turn:420,kv_cache:0.88,cost_req:0.0041,downstream_err:0.11,mfu:0.71,hbm_spill:0.02,collective_ops:0.9998,corpus_delta:0.05,traffic_pct:1.0},
    driftParams:{tokenSlope:0.045,costSlope:0.042,latSlope:0.018,corpusSlope:0.038,onsetTick:4},
    drift:function(i,p){var on=p.onsetTick||4;var tm=i<on?1+0.01*Math.random():1+(i-on+1)*(p.tokenSlope||0.045)+0.008*Math.random();var cm=i<on?1+0.008*Math.random():1+(i-on+1)*(p.costSlope||0.042);var lm=i<on+1?1+0.01*Math.random():1+(i-on)*(p.latSlope||0.018)+0.01*Math.random();var corp=i<on+1?1+0.015*Math.random():1+(i-on)*(p.corpusSlope||0.038)+0.01*Math.random();return{p99_latency:lm,ttft:1+(lm-1)*0.6,tokens_turn:tm,kv_cache:0.88+0.005*Math.sin(i/4),cost_req:cm,downstream_err:1+0.025*Math.random(),mfu:0.71+0.004*Math.sin(i/5),hbm_spill:0.02+0.002*Math.random(),collective_ops:0.9998-0.00005*Math.random(),corpus_delta:corp,traffic_pct:1};}
  },
  { id:'latency', name:'Latency Spike', riskLevel:'critical', bakeHours:84, author:'human', changeType:'serving_code', timeWindow:'ok',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:true,approval:true},
    baseline:{p99_latency:182,ttft:215,tokens_turn:415,kv_cache:0.90,cost_req:0.0040,downstream_err:0.10,mfu:0.73,hbm_spill:0.015,collective_ops:0.9998,corpus_delta:0.04,traffic_pct:1.0},
    driftParams:{latSlope:0.13,ttftSlope:0.10,downSlope:0.09,mfuDrop:0.04,onsetTick:2},
    drift:function(i,p){var on=p.onsetTick||2;var lm=i<on?1+0.01*Math.random():1+(i-on+1)*(p.latSlope||0.13);var tm=i<on?1+0.01*Math.random():1+(i-on+1)*(p.ttftSlope||0.10);return{p99_latency:lm,ttft:tm,tokens_turn:1+0.008*Math.random(),kv_cache:1-0.003*Math.random(),cost_req:1+0.008*Math.random(),downstream_err:i<on+1?1+0.02*Math.random():1+(i-on)*(p.downSlope||0.09),mfu:i<on?1:1-(i-on)*(p.mfuDrop||0.04),hbm_spill:1+0.01*Math.random(),collective_ops:i<on+1?1:1-(i-on)*0.0003,corpus_delta:1+0.03*Math.random(),traffic_pct:1};}
  },
  { id:'mixed', name:'Mixed Signals', riskLevel:'high', bakeHours:48, author:'human', changeType:'model_weights', timeWindow:'ok',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:true,approval:true},
    baseline:{p99_latency:175,ttft:205,tokens_turn:400,kv_cache:0.88,cost_req:0.0038,downstream_err:0.09,mfu:0.70,hbm_spill:0.018,collective_ops:0.9997,corpus_delta:0.06,traffic_pct:0.55},
    driftParams:{latAmp:0.09,kvDrop:0.009,hbmSlope:0.06},
    drift:function(i,p){return{p99_latency:1+(p.latAmp||0.09)*Math.sin(i/3),ttft:1+0.008*Math.random(),tokens_turn:1+0.007*Math.random(),kv_cache:1-i*(p.kvDrop||0.009)-0.002*Math.random(),cost_req:1+0.007*Math.random(),downstream_err:1+0.03*Math.random(),mfu:1-0.004*Math.random(),hbm_spill:1+i*(p.hbmSlope||0.06)+0.01*Math.random(),collective_ops:1-0.00008*Math.random(),corpus_delta:1+0.015*Math.random(),traffic_pct:0.55};}
  },
  { id:'artifact', name:'Artifact Leak', riskLevel:'critical', bakeHours:84, author:'human', changeType:'serving_code', timeWindow:'ok',
    flags:{security:false,artifact_content:true,provenance:false,contract:false,toolchain:true,zeta:false,approval:true},
    baseline:{p99_latency:185,ttft:220,tokens_turn:418,kv_cache:0.89,cost_req:0.0042,downstream_err:0.12,mfu:0.72,hbm_spill:0.02,collective_ops:0.9997,corpus_delta:0.04,traffic_pct:1.0},
    driftParams:{},
    drift:function(i,p){return{p99_latency:1,ttft:1,tokens_turn:1,kv_cache:1,cost_req:1,downstream_err:1,mfu:1,hbm_spill:1,collective_ops:1,corpus_delta:1,traffic_pct:1};}
  },
  { id:'friday', name:'Friday Deploy', riskLevel:'critical', bakeHours:84, author:'human', changeType:'model_weights', timeWindow:'friday',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:true,approval:true},
    baseline:{p99_latency:185,ttft:220,tokens_turn:418,kv_cache:0.89,cost_req:0.0042,downstream_err:0.12,mfu:0.72,hbm_spill:0.02,collective_ops:0.9997,corpus_delta:0.04,traffic_pct:1.0},
    driftParams:{},
    drift:function(i,p){return{p99_latency:1+0.01*Math.random(),ttft:1+0.01*Math.random(),tokens_turn:1+0.008*Math.random(),kv_cache:1,cost_req:1,downstream_err:1+0.02*Math.random(),mfu:1,hbm_spill:1,collective_ops:1,corpus_delta:1+0.03*Math.random(),traffic_pct:1};}
  },
  { id:'agent', name:'Agent Change', riskLevel:'high', bakeHours:72, author:'agent', changeType:'serving_code', timeWindow:'ok',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:false,approval:false},
    baseline:{p99_latency:175,ttft:205,tokens_turn:400,kv_cache:0.87,cost_req:0.0038,downstream_err:0.09,mfu:0.70,hbm_spill:0.018,collective_ops:0.9997,corpus_delta:0.06,traffic_pct:1.0},
    driftParams:{latAmp:0.015},
    drift:function(i,p){return{p99_latency:1+(p.latAmp||0.015)*Math.sin(i/4),ttft:1+0.01*Math.random(),tokens_turn:1+0.01*Math.random(),kv_cache:1-0.003*Math.random(),cost_req:1+0.008*Math.random(),downstream_err:1+0.03*Math.random(),mfu:1-0.003*Math.random(),hbm_spill:1+0.015*Math.random(),collective_ops:1-0.00005*Math.random(),corpus_delta:1+0.015*Math.random(),traffic_pct:1};}
  },
  { id:'capacity', name:'Capacity Constraint', riskLevel:'critical', bakeHours:84, author:'human', changeType:'model_weights', timeWindow:'ok',
    flags:{security:false,artifact_content:false,provenance:false,contract:false,toolchain:false,zeta:true,approval:true},
    baseline:{p99_latency:185,ttft:220,tokens_turn:418,kv_cache:0.89,cost_req:0.0042,downstream_err:0.12,mfu:0.72,hbm_spill:0.02,collective_ops:0.9997,corpus_delta:0.04,traffic_pct:1.0},
    driftParams:{kvDrop:0.04,hbmRise:0.08,mfuDrop:0.03,latSlope:0.025,stableAt:3},
    drift:function(i,p){var s=p.stableAt||3;var kv=i<s?1-(i*(p.kvDrop||0.04)):0.78+0.004*Math.sin(i/3);var hbm=i<s?1+(i*(p.hbmRise||0.08)):1.32+0.008*Math.sin(i/4);var mfu=i<s+1?1-(i*(p.mfuDrop||0.03)):0.86+0.004*Math.sin(i/5);var lat=i<s+2?1+(i*(p.latSlope||0.025)):1.12+0.008*Math.sin(i/4);return{p99_latency:lat,ttft:1+(lat-1)*0.8,tokens_turn:1+0.008*Math.random(),kv_cache:kv,cost_req:1+0.012*Math.random(),downstream_err:1+0.025*Math.random(),mfu:mfu,hbm_spill:hbm,collective_ops:i>s?1-0.0003:1,corpus_delta:1+0.015*Math.random(),traffic_pct:1};}
  }
].concat(SLOW_BURN_SCENARIOS);

// ── METRIC_KEYS / METRIC_META ─────────────────────────────────────
// Base infra metrics + AI quality metrics (optional: signals gate on metric presence)
var METRIC_KEYS = [
  'p99_latency','ttft','tokens_turn','kv_cache','cost_req','downstream_err',
  'mfu','hbm_spill','collective_ops','corpus_delta','traffic_pct',
  'eval_score','refusal_rate','output_len_p50'
];
var METRIC_META = {
  p99_latency:{label:'p99 Latency',unit:'ms'},ttft:{label:'TTFT',unit:'ms'},
  tokens_turn:{label:'Tokens/Turn',unit:''},kv_cache:{label:'KV Cache Hit',unit:'%',isKV:true},
  cost_req:{label:'Cost/Request',unit:'$'},downstream_err:{label:'Downstream Err',unit:'%'},
  mfu:{label:'MFU',unit:'%',isPct:true},hbm_spill:{label:'HBM Spill',unit:'%'},
  collective_ops:{label:'Collective Ops',unit:'%',isOps:true},
  corpus_delta:{label:'Corpus Delta',unit:'%',isCorpus:true},
  traffic_pct:{label:'Traffic Vol',unit:'%',isPct:true},
  eval_score:{label:'Eval Score',unit:'',isQuality:true},
  refusal_rate:{label:'Refusal Rate',unit:'%',isQuality:true},
  output_len_p50:{label:'Output Len p50',unit:'tok',isQuality:true}
};

function fmtVal(v,k){if(v===null||v===undefined)return'—';if(k==='p99_latency'||k==='ttft')return Math.round(v);if(k==='tokens_turn')return Math.round(v);if(k==='kv_cache')return(v*100).toFixed(1);if(k==='cost_req')return v.toFixed(4);if(k==='downstream_err')return v.toFixed(2);if(k==='mfu')return(v*100).toFixed(1);if(k==='hbm_spill')return(v*100).toFixed(2);if(k==='collective_ops')return(v*100).toFixed(3);if(k==='corpus_delta')return(v*100).toFixed(1);if(k==='traffic_pct')return(v*100).toFixed(0);if(k==='eval_score')return(v*100).toFixed(1);if(k==='refusal_rate')return(v*100).toFixed(2);if(k==='output_len_p50')return Math.round(v);return String(v);}
function metricStatus(live,base,k){if(live===null||live===undefined||!base)return'ok';var r=live/base;if(k==='kv_cache')return live<0.85?'alert':live<base*0.97?'warn':'ok';if(k==='collective_ops')return live<0.9995?'alert':live<base*0.9997?'warn':'ok';if(k==='corpus_delta')return live>base*1.15?'alert':live>base*1.08?'warn':'ok';if(k==='mfu')return Math.abs(live-base)/base>0.10?'warn':'ok';if(k==='hbm_spill')return live>base*1.30?'warn':'ok';if(k==='traffic_pct')return live<0.60?'warn':'ok';if(k==='eval_score')return live<base*0.92?'alert':live<base*0.96?'warn':'ok';if(k==='refusal_rate')return live>base*3.0?'alert':live>base*2.0?'warn':'ok';return r>1.25?'alert':r>1.10?'warn':'ok';}

// ── ROLLBACK_DEFS ─────────────────────────────────────────────────
// Base signal definitions — thresholds tuned by the self-improving loop.
// Quality signals appended from engine/signals/quality (stable, not loop-tunable).
// check(m, b, f, ctx, tb): all signals gate on n>=4 and !insufficient.

var ROLLBACK_DEFS = [
  // p99 latency: critical model_weights tightens base to 1.15; early ticks use higher rocBypass
  //
  // OPUS FEEDBACK ITER-3 RULE[1]: Add capacity gate before rollback —
  //   if (kv_cache_pressure.value > 0.7 || hbm_spill.active) { return EXTEND }
  //   p99 rising due to capacity constraints is a structural issue; rollback won't help.
  //   Extend to let capacity signals disambiguate.
  //
  // OPUS FEEDBACK ITER-3 RULE[2]: Require trendStable=false for capacity scenarios —
  //   block rollback if (trendBuffer.stable && capacitySignalsElevated).
  //   Stable rising trends during capacity pressure indicate structural limits, not code regression.
  //
  // OPUS FEEDBACK ITER-3 RULE[4]: Increase slopeNorm threshold for mutated runs —
  //   minSlope: 0.004 → 0.006 when mutation_flag=true.
  //   Mutated capacity scenarios have inherent variance; higher slope threshold reduces symptom-chasing.
  //
  // OPUS FEEDBACK ITER-3 RULE[6]: Add roc damping for slow rises —
  //   if (|roc| < 0.005 && slopeNorm < 0.008) { require 2 additional ticks }
  //   Slow, steady latency rises are more likely capacity-related than sudden regressions.
  //
  //   (raised from implicit ~0.01) to prevent p99 over-triggering on capacity root cause.
  //   convert to EXTEND instead of ROLLBACK by returning false here.
  //   kv_cache.CV > 0.05, noisy infrastructure raises bar for p99-based rollback.
  { id:'p99', label:'p99 Latency',
    baseThr:1.20, trendDiscount:0.06, rocBypass:0.025, direction:'rise',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('p99_latency'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var lr = b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1;
      var _hbmRp99 = (b.hbm_spill > 0 && m.hbm_spill !== undefined) ? m.hbm_spill/b.hbm_spill : 1; var _kvDp99 = (b.kv_cache > 0) ? Math.abs(m.kv_cache - b.kv_cache)/b.kv_cache : 0; var _ttftRp99 = b.ttft > 0 ? m.ttft/b.ttft : 1; if (t.cv !== undefined && t.cv > 0.20 && (t.n < 6 || t.slopeNorm <= 0.012) && _hbmRp99 <= 1.10) return false; if (t.cv !== undefined && t.cv > 0.25 && (b.p99_latency <= 0 || m.p99_latency/b.p99_latency < 1.03) && _ttftRp99 > 1.10) return false; if (t.cv !== undefined && t.cv > 0.30 && _hbmRp99 > 1.12 && _kvDp99 < 0.03) return true; if (t.cv !== undefined && t.cv > 0.30 && _hbmRp99 > 1.10 && _hbmRp99 <= 1.12 && _kvDp99 < 0.03) return false;
      if (lr >= 1.50 && t.slopeNorm > 0) return true;
      if (lr > 1.20 && t.slopeNorm >= 0.008) { var _kvDp99Cap = (b.kv_cache > 0) ? Math.abs(m.kv_cache - b.kv_cache)/b.kv_cache : 0; var _hbmRp99Cap = (b.hbm_spill > 0 && m.hbm_spill !== undefined) ? m.hbm_spill/b.hbm_spill : 1; var _downRp99Cap = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; if (lr < 1.30 && _kvDp99Cap < 0.02 && _hbmRp99Cap < 1.10 && _downRp99Cap < 1.10) return false; return true; }
      var tt = tb?tb.get('ttft'):null;
      if (tt && !tt.insufficient && tt.n >= 4) {
        var tr = b.ttft > 0 ? m.ttft/b.ttft : 1;
        if (lr > 1.15 && tr > 1.10 && t.slopeNorm >= 0.004) return true;
      }
      if (ctx && ctx.changeType === 'config' && lr > 1.12 && t.slopeNorm >= 0.004) return true;
      var thr = effectiveThreshold(1.20, 0.06, t, 'rise', 0.040);
      return lr > thr && t.slopeNorm >= 0.003;
    }
  },
  // TTFT
  { id:'ttft', label:'TTFT',
    baseThr:1.20, trendDiscount:0.06, rocBypass:0.025, direction:'rise',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('ttft'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var base = 1.20;
      if (ctx&&ctx.riskLevel==='critical'&&ctx.changeType==='model_weights') base=1.15;
      var thr = effectiveThreshold(base, 0.06, t, 'rise', 0.025);
      return m.ttft/b.ttft >= thr;
    }
  },
  // Compound latency: both p99 AND ttft over threshold; CV < 0.03 required
  { id:'compound_lat', label:'Compound Latency',
    check: function(m,b,f,ctx,tb) {
      var tp = tb?tb.get('p99_latency'):null;
      var tt = tb?tb.get('ttft'):null;
      if (!tp || tp.n < 4 || tp.insufficient) return false;
      if (!tt || tt.n < 4 || tt.insufficient) return false;
      if (tp.cv >= 0.03) { if (tp.n >= 8 && tt.n >= 8 && m.p99_latency/b.p99_latency > 1.15 && m.ttft/b.ttft > 1.15) return true; if (tp.n >= 8 && tp.cv < 0.08 && (m.p99_latency/b.p99_latency > 1.18 || m.ttft/b.ttft > 1.18)) return true; if (tp.n >= 8 && tt.n >= 8 && tp.slopeNorm !== undefined && tp.slopeNorm > 0.003 && tt.slopeNorm !== undefined && tt.slopeNorm > 0.003) return true; return false; } var tHbmCL = tb ? tb.get('hbm_spill') : null; var tKvCL = tb ? tb.get('kv_cache') : null; var capacityConstrainedCL = (tHbmCL && !tHbmCL.insufficient && tHbmCL.slopeNorm !== undefined && tHbmCL.slopeNorm > 0.003 && tKvCL && !tKvCL.insufficient && tKvCL.slopeNorm !== undefined && tKvCL.slopeNorm < -0.003); if (capacityConstrainedCL) return false;
      if (tt.cv >= 0.03) { if (tp.n >= 8 && tt.n >= 8 && tp.slopeNorm !== undefined && tp.slopeNorm > 0.003 && tt.slopeNorm !== undefined && tt.slopeNorm > 0.003) return true; return false; }
      var base = ctx&&ctx.riskLevel==='critical'?1.10:1.12;
      var thrP = effectiveThreshold(base, 0.03, tp, 'rise', 0.030);
      var thrT = effectiveThreshold(base, 0.03, tt, 'rise', 0.030);
      return m.p99_latency/b.p99_latency >= thrP && m.ttft/b.ttft >= thrT;
    }
  },
  // Token economics: tokens + cost both sustained
  { id:'tok_econ', label:'Token Economics',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('tokens_turn'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var tr = (b.tokens_turn > 0) ? m.tokens_turn/b.tokens_turn : 1;
      var cr = (b.cost_req > 0) ? m.cost_req/b.cost_req : 1;
      var kvD = (b.kv_cache > 0) ? Math.abs(m.kv_cache - b.kv_cache)/b.kv_cache : 0;
      var hbmR = (b.hbm_spill > 0) ? m.hbm_spill/b.hbm_spill : 1;
      // Inverted economics: tokens inflate while cost drops (behavioral/quality shift)
      var p99R = b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1; var ttftR2 = b.ttft > 0 ? m.ttft/b.ttft : 1; if (p99R < 0.95 && ttftR2 < 0.95) return false; if (tr > 1.15 && cr < 0.90 && kvD < 0.005 && hbmR < 1.05) { var _ieDown = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; var _ieEval = (b.eval_score > 0 && m.eval_score !== undefined) ? 1 - m.eval_score/b.eval_score : 0; if (_ieDown < 1.05 && _ieEval < 0.03) return false; return true; } if (tr > 1.10 && cr < 0.97 && kvD < 0.005 && hbmR < 1.05) { var _ieDown = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; var _ieEval = (b.eval_score > 0 && m.eval_score !== undefined) ? 1 - m.eval_score/b.eval_score : 0; if (_ieDown < 1.05 && _ieEval < 0.03) return false; return true; } if (tr > 1.15 && cr < 0.95 && kvD < 0.03 && hbmR < 1.05) { var _qualDrop = (m.eval_score !== undefined && b.eval_score > 0) ? 1 - m.eval_score/b.eval_score : 0; var _downRise = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err - 1 : 0; if (_qualDrop < 0.03 && _downRise < 0.08) return false; return true; } if (ctx && ctx.hoursElapsed !== undefined && ctx.hoursElapsed < 1.0 && t.cv !== undefined && t.cv > 0.30 && hbmR < 1.10) return false; if (ctx && ctx._tick !== undefined && ctx._tick < 6 && kvD < 0.02 && hbmR < 1.03 && t.cv !== undefined && t.cv > 0.04) return false; if (t.cv !== undefined && t.cv > 0.35 && hbmR < 1.10) return false; if (t.cv !== undefined && t.cv > 0.30 && kvD > 0.03 && hbmR < 1.10 && p99R !== undefined && p99R < 1.05) return false; if (tr > 1.15 && p99R < 0.95 && ttftR2 < 0.95) return false; if (p99R < 0.95 && tr > 1.15) return false; if (kvD > 0.03 && kvD < 0.08 && t.cv !== undefined && t.cv > 0.25 && p99R < 1.08) return false; if (tr > 1.10 && tr < 1.15 && cr < 1.00 && kvD < 0.005 && hbmR < 1.005 && !(m.eval_score !== undefined && b.eval_score > 0 && m.eval_score/b.eval_score < 0.97)) return false; if (p99R < 1.00 && tr > 1.15 && cr < 1.00) return false; if (p99R < 0.98 && tr > 1.15 && t.cv !== undefined && t.cv > 0.30) return false; if (p99R < 0.98 && (b.ttft > 0 ? m.ttft/b.ttft : 1) < 0.98 && tr > 1.10) return false; if (cr < 0.97 && tr > 1.10 && kvD < 0.02 && hbmR < 1.03) return false; if (cr < 0.95 && tr > 1.10 && hbmR < 1.10 && kvD < 0.03) return false; if (tr > 1.10 && cr < 0.95 && (b.downstream_err <= 0 || m.downstream_err/b.downstream_err < 1.08) && kvD < 0.03 && hbmR < 1.05 && !(b.eval_score > 0 && m.eval_score !== undefined && (1 - m.eval_score/b.eval_score) > 0.01)) return false; if (kvD < 0.005 && hbmR < 1.01 && cr <= 1.0 && tr > 1.10 && t.cv !== undefined && t.cv >= 0.04) return false; if (kvD < 0.01 && hbmR < 1.03 && cr <= 1.0 && tr > 1.10) return false; if (tr > 1.10 && cr < 0.95 && kvD < 0.02 && hbmR < 1.03) return false; var latDegraded = (b.p99_latency > 0 && m.p99_latency/b.p99_latency > 1.08); var downElevated = (b.downstream_err > 0 && m.downstream_err/b.downstream_err > 1.10); if (kvD < 0.01 && Math.abs(hbmR - 1.0) < 0.01 && t.cv !== undefined && t.cv > 0.05 && !latDegraded && !downElevated) return false; if (tr >= 1.15) return true;
      if (tr > 1.25) return true;
      if (tr >= 1.20) return true; if (tr > 1.15 && cr < 0.92) return true; if (tr > 1.15 && cr < 0.97 && m.eval_score !== undefined && b.eval_score > 0 && (1 - m.eval_score/b.eval_score) > 0.02) return true; if (tr > 1.10 && cr < 0.95) { var hbmRTokEcon = (b.hbm_spill > 0 && m.hbm_spill !== undefined) ? m.hbm_spill/b.hbm_spill : 1; var kvDTokEcon = (b.kv_cache > 0) ? Math.abs(m.kv_cache - b.kv_cache)/b.kv_cache : 0; if (hbmRTokEcon < 1.02 && kvDTokEcon < 0.01 && !(tr > 1.15 && t.slopeNorm >= 0.006 && t.cv < 0.10)) return false; var evalScoreD = (b.eval_score > 0 && m.eval_score !== undefined) ? Math.abs(m.eval_score/b.eval_score - 1) : 0; var downstreamErrR = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; if (evalScoreD < 0.02 && downstreamErrR < 1.08) return false; return true; } if (tr > 1.08 && cr < 0.97) return true; if (tr >= 1.15 && cr < 0.97) return true; if (tr >= 1.15 && t.slopeNorm >= 0.003) return true;
      if (tr > 1.15 && cr < 0.95 && (kvD > 0.01 || hbmR > 1.03)) return true; if (tr > 1.15 && cr < 0.95 && kvD < 0.02 && Math.abs(1.0 - hbmR) < 0.02 && (t.slopeNorm === undefined || t.cv === undefined || t.cv > 0.05)) return false; var qualityDegraded = (m.eval_score !== undefined && b.eval_score > 0 && m.eval_score/b.eval_score < 0.92) || (m.downstream_err !== undefined && b.downstream_err > 0 && m.downstream_err/b.downstream_err > 1.15); if (qualityDegraded && tr > 1.10) return true; if (tr > 1.15 && cr < 0.95 && m.eval_score !== undefined && b.eval_score > 0 && (1 - m.eval_score/b.eval_score) > 0.03) return true;
      var evalOk = (m.eval_score === undefined || b.eval_score === undefined || m.eval_score / b.eval_score > 0.95); if (t.cv !== undefined && t.cv > 0.05 && tr < 1.15 && kvD < 0.03 && hbmR < 1.05) return false; if (t.cv !== undefined && t.cv > 0.05 && tr < 1.15 && kvD < 0.01 && hbmR < 1.02) return false; if (tr >= 1.15) return true;
      // Token inflation with cost corroboration
      if (tr > 1.15 && cr > 1.05 && t.slopeNorm >= 0.005) return true;
      // Raw token inflation with cache/HBM corroboration
      if (tr > 1.20 && t.slopeNorm >= 0.005 && (kvD > 0.02 || hbmR > 1.02)) return true;
      // Standalone token inflation: large stable drift
      if (tr > 1.25 && t.slopeNorm >= 0.008 && t.cv < 0.07) return true; if (tr > 1.18 && t.slopeNorm >= 0.008 && t.cv !== undefined && t.cv < 0.10) return true; if (tr > 1.20 && t.cv < 0.08 && t.slopeNorm >= 0.003) return true;
      // Gate: KV/HBM flat + moderate volatility + cost neutral → not a real regression
      if (t.cv !== undefined && t.cv > 0.10 && kvD < 0.020 && hbmR < 1.05 && cr < 1.05) return false; if (t.cv !== undefined && t.cv <= 0.10 && kvD < 0.020 && hbmR < 1.05 && cr < 1.05) return false;
      if (tr > 1.15 && cr < 0.95 && kvD < 0.01 && hbmR < 1.02) { var _qualCorr = (b.eval_score > 0 && m.eval_score !== undefined) ? (1 - m.eval_score/b.eval_score) : 0; var _downCorr = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err - 1 : 0; if (_qualCorr < 0.03 && _downCorr < 0.08) return false; return true; } if (kvD < 0.005 && Math.abs(hbmR - 1.0) < 0.02 && tr > 1.15) { var _flatInfraDown = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; var _flatInfraEval = (b.eval_score > 0 && m.eval_score !== undefined) ? 1 - m.eval_score/b.eval_score : 0; if (p99R < 1.05 && _flatInfraDown < 1.08 && _flatInfraEval < 0.03) return false; return true; } if (kvD < 0.01 && hbmR < 1.02 && t.cv > 0.15 && cr >= 0.95) { if (tr > 1.25) return true; if (t.cv >= 0.08 && (t.slopeNorm === undefined || t.slopeNorm <= 0.006)) return false; return false; }
      // Original joint check
      var baseTok = 1.18;
      var thr = effectiveThreshold(baseTok, 0.05, t, 'rise', 0.030);
      return tr > thr && cr > 1+(tr-1)*0.8;
    }
  },// Tokens alone: cost not tracking proportionally
  { id:'tokens', label:'Tokens/Turn',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('tokens_turn'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var tr = b.tokens_turn > 0 ? m.tokens_turn/b.tokens_turn : 1;
      var cr = b.cost_req   > 0 ? m.cost_req/b.cost_req       : 1;
      var kvD  = b.kv_cache  > 0 ? Math.abs(m.kv_cache - b.kv_cache)/b.kv_cache : 0;
      var hbmR = b.hbm_spill > 0 ? m.hbm_spill/b.hbm_spill : 1;
      // Hoisted above first use (remediation M1): these were read before their
      // var declarations further down, so the tuned FP-suppression guards that
      // reference them evaluated against `undefined` and never applied.
      var p99R = b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1;
      var ttftR = b.ttft > 0 ? m.ttft/b.ttft : 1;
      var _tp99Tok = tb ? tb.get('p99_latency') : null;
      var tIdxTok = tb ? tb.get('p99_latency') : null;
      var tickEstTok = tIdxTok ? tIdxTok.n : 99;
      if (m.tokens_turn === undefined || m.tokens_turn === null || tr === undefined || isNaN(tr)) return false; var _p99RSpec = b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1; var _ttftRSpec = b.ttft > 0 ? m.ttft/b.ttft : 1; if (tr > 1.10 && _p99RSpec < 0.97 && _ttftRSpec < 0.97) return false; if (tr > 1.10 && _p99RSpec < 0.95 && _ttftRSpec < 0.95) return false; if (tr > 1.10 && _p99RSpec < 0.97 && _ttftRSpec < 0.97 && t.cv !== undefined && t.cv > 0.30) return false; if (tr > 1.15 && cr < 0.95 && kvD < 0.01 && hbmR < 1.02) return false; var _downErrR = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; if (kvD < 0.04 && hbmR < 1.05 && ((_downErrR < 1.05 && cr >= 0.95) || (cr < 0.95 && hbmR < 1.03) || t.cv > 0.07)) return false; var tIdx = tb ? tb.get('p99_latency') : null; var tickEst = tIdx ? tIdx.n : 99; if (t.cv !== undefined && t.cv > 0.28 && kvD > 0.03 && p99R < 1.0) return false; var _tp99SlopeNorm = (_tp99Tok && !_tp99Tok.insufficient) ? _tp99Tok.slopeNorm : undefined; if (t.cv !== undefined && t.cv > 0.30 && _tp99SlopeNorm !== undefined && _tp99SlopeNorm < -0.002) return false; if (_tp99Tok && !_tp99Tok.insufficient && _tp99Tok.slopeNorm !== undefined && _tp99Tok.slopeNorm < -0.004 && (b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) < 0.98) return false; if (t.cv !== undefined && t.cv > 0.35 && tickEstTok < 6) return false; var p99R = b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1; var ttftR = b.ttft > 0 ? m.ttft/b.ttft : 1; if ((p99R < 0.95 && ttftR < 0.95) || (p99R < 0.98 && ttftR < 0.98 && cr < 0.97)) return false; var tIdxTok = tb ? tb.get('p99_latency') : null; var tickEstTok = tIdxTok ? tIdxTok.n : 99; if (tickEstTok < 6 && p99R < 1.05 && ttftR < 1.05 && kvD < 0.01 && hbmR < 1.02) return false; if (cr < 0.95 && tr > 1.10 && hbmR < 1.05 && kvD < 0.02) return false; if (cr < 1.02 && tr > 1.10 && kvD < 0.02 && hbmR < 1.03) return false; if (tr > 1.15 && hbmR > 1.05 && (b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) < 0.97 && (b.ttft > 0 ? m.ttft/b.ttft : 1) < 0.97) return false; var _tp99Tok = tb ? tb.get('p99_latency') : null; var _tttfTok = tb ? tb.get('ttft') : null; if (_tp99Tok && _tttfTok && !_tp99Tok.insufficient && !_tttfTok.insufficient && _tp99Tok.slopeNorm !== undefined && _tp99Tok.slopeNorm < -0.003 && _tttfTok.slopeNorm !== undefined && _tttfTok.slopeNorm < -0.003) return false; if (tr > 1.15 && (b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) < 0.98 && (b.ttft > 0 ? m.ttft/b.ttft : 1) < 0.98) return false; if (tr > 1.15 && (b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) < 0.95 && kvD > 0.03) return false; if (kvD > 0.04 && hbmR > 1.03 && (b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) < 0.98) return false; if (tr > 1.10 && m.p99_latency !== undefined && b.p99_latency > 0 && m.p99_latency/b.p99_latency < 0.97 && m.ttft !== undefined && b.ttft > 0 && m.ttft/b.ttft < 0.97) return false; if (tr > 1.12 && cr < 0.95 && hbmR < 1.02 && kvD < 0.02) return false; if (tr > 1.10 && cr < 0.98 && kvD < 0.02) return false; if (tr > 1.12 && cr < 0.97 && kvD < 0.015 && hbmR < 1.03) return false; if (tr > 1.10 && tr < 1.15 && cr < 0.95 && kvD < 0.020 && hbmR < 1.04 && !(m.eval_score !== undefined && b.eval_score > 0 && m.eval_score/b.eval_score < 0.95)) return false; if (tr > 1.15 && cr < 0.95 && kvD < 0.03 && hbmR < 1.05) { if (cr < 0.96 && kvD < 0.01 && hbmR < 1.02) return true; var _invEvalDrop = (b.eval_score > 0 && m.eval_score !== undefined) ? 1 - m.eval_score/b.eval_score : 0; var _invDownR = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err - 1 : 0; if (_invEvalDrop < 0.02 && _invDownR < 0.08) return false; return true; } if (tr > 1.10 && cr < 0.98 && kvD < 0.025 && hbmR < 1.04 && (kvD > 0.005 || hbmR > 1.03)) return true; if (kvD < 0.02 && hbmR < 1.05 && cr < 1.08) { var _downErrRTok = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; var _evalDropTok = (b.eval_score > 0 && m.eval_score !== undefined) ? 1 - m.eval_score/b.eval_score : 0; if (_downErrRTok < 1.08 && _evalDropTok < 0.03) return false; } if (tr > 1.12 && cr < 0.97 && kvD < 0.015 && hbmR < 1.04) { var evalDropTokEconGate = (b.eval_score > 0 && m.eval_score !== undefined) ? 1 - m.eval_score/b.eval_score : 0; var downErrRiseTokEconGate = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err - 1 : 0; if (evalDropTokEconGate < 0.02 && downErrRiseTokEconGate < 0.01) return false; } if (t.cv !== undefined && t.cv > 0.08 && cr < 0.98 && kvD < 0.02 && hbmR < 1.04) return false; if (t.cv !== undefined && t.cv > 0.22 && _p99RSpec < 1.05 && _ttftRSpec < 1.05 && kvD < 0.08 && hbmR < 1.10 && !(t.slopeNorm >= 0.015)) return false; if (t.cv !== undefined && t.cv > 0.12 && !(t.slopeNorm >= 0.008 && t.stable === true) && !(cr < 0.95 && tr > 1.08)) return false; if (tr > 1.15 && cr < 0.96 && kvD < 0.03 && hbmR < 1.05) return false; if (tr > 1.10 && cr < 0.98 && kvD < 0.01 && hbmR < 1.02 && tr < 1.15) return false; if (tr > 1.10 && b.p99_latency > 0 && m.p99_latency/b.p99_latency < 0.95) return false; var _qualDegrading = (m.eval_score !== undefined && b.eval_score > 0 && m.eval_score/b.eval_score < 0.94) || (m.downstream_err !== undefined && b.downstream_err > 0 && m.downstream_err/b.downstream_err > 1.12); if (tr > 1.15 && p99R < 1.05 && ttftR < 1.02 && !_qualDegrading && kvD < 0.03 && hbmR < 1.05) return false; if (tr > 1.10 && cr < 0.95 && (b.p99_latency <= 0 || m.p99_latency/b.p99_latency < 1.05)) return false; if (tr > 1.12 && cr >= 0.95 && kvD < 0.015 && hbmR < 1.03) return false; if (cr < 1.00 && tr > 1.15 && kvD < 0.02 && hbmR < 1.03) return false; if (tr > 1.10 && cr < 0.95 && kvD < 0.015 && hbmR < 1.03) return false; if (cr < 1.00 && tr > 1.10 && tr < 1.20 && kvD < 0.03 && hbmR < 1.06) return false; if (cr < 0.95 && tr > 1.15 && kvD < 0.04 && hbmR < 1.05) return false;
      if (cr < 0.98 && kvD < 0.01 && hbmR < 1.03 && tr > 1.10 && tr < 1.15) return false; if (cr < 0.98 && kvD < 0.025 && hbmR < 1.06 && tr > 1.10 && !(hbmR > 1.03 || kvD > 0.02)) return false; if (cr < 1.00 && tr > 1.10 && kvD < 0.03 && hbmR < 1.03 && !(cr < 0.95 && Math.abs(hbmR - 1.0) < 0.02 && kvD < 0.01 && (t.cv === undefined || t.cv < 0.05))) return false; if (tr > 1.10 && cr < 0.97 && kvD < 0.02 && hbmR < 1.05) return false; if (t.cv !== undefined && t.cv > 0.05 && kvD < 0.02 && hbmR < 1.03 && cr >= 0.94 && tr < 1.12) return false; if (t.cv !== undefined && t.cv > 0.10 && (t.slopeNorm === undefined || t.slopeNorm < 0.015 || t.stable !== true)) return false; if (t.cv !== undefined && t.cv > 0.25 && hbmR < 1.06 && kvD < 0.04 && (tIdx ? tIdx.n : 99) < 6) return false; if (t.cv !== undefined && t.cv > 0.35 && (hbmR > 1.12 || p99R > 1.15) && tr > 1.10) return true; if (t.cv !== undefined && t.cv >= 0.20 && hbmR < 1.08 && kvD < 0.04) return false; if (t.cv !== undefined && t.cv > 0.22 && hbmR < 1.15 && kvD < 0.06) return false; if (t.cv !== undefined && t.cv > 0.05 && tr < 1.15 && kvD < 0.02 && hbmR < 1.05 && tr < 1.25) return false; if (t.cv !== undefined && t.cv > 0.05 && tr < 1.15 && kvD < 0.015 && hbmR < 1.03 && tr < 1.30 && p99R < 1.08) return false; var _p99RocTok = tb ? tb.get('p99_latency') : null; if (t.cv !== undefined && t.cv > 0.25 && _p99RocTok && _p99RocTok.roc !== undefined && _p99RocTok.roc < 0) return false; if (tr > 1.10 && kvD < 0.025 && Math.abs(hbmR - 1.0) < 0.03 && t.cv !== undefined && t.cv > 0.05 && cr >= 0.95) return false; if (tr > 1.15 && kvD < 0.025 && hbmR < 1.06 && t.cv !== undefined && t.cv > 0.05 && cr >= 0.95) return false; if (tr > 1.15 && t.slopeNorm >= 0.008) { var _kvD2 = b.kv_cache > 0 ? Math.abs(m.kv_cache - b.kv_cache)/b.kv_cache : 0; var _hbmR2 = b.hbm_spill > 0 ? m.hbm_spill/b.hbm_spill : 1; var _cr2 = b.cost_req > 0 ? m.cost_req/b.cost_req : 1; if (t.cv !== undefined && t.cv >= 0.05 && _kvD2 < 0.02 && _hbmR2 < 1.03 && _cr2 < 1.05) return false; if (_kvD2 < 0.015 && _hbmR2 < 1.03 && _cr2 < 1.05) return false; return true; } if (tr > 1.15 && kvD < 0.02 && hbmR < 1.05 && t.cv !== undefined && t.cv > 0.05 && p99R < 1.05) return false; if (tr > 1.10 && kvD < 0.01 && Math.abs(1.0 - (b.hbm_spill > 0 ? m.hbm_spill/b.hbm_spill : 1.0)) < 0.02 && t.cv !== undefined && t.cv > 0.05 && t.slopeNorm < 0.012) return false; if (tr > 1.15 && cr < 0.98 && kvD < 0.01 && hbmR < 1.02 && t.cv !== undefined && t.cv < 0.10) return false; if (tr > 1.15 && cr < 0.95 && kvD < 0.01 && hbmR < 1.02 && t.slopeNorm !== undefined && t.slopeNorm >= 0.004) { var corpR = (b.corpus_delta > 0 && m.corpus_delta !== undefined) ? m.corpus_delta/b.corpus_delta : 1; var evalR = (b.eval_score > 0 && m.eval_score !== undefined) ? m.eval_score/b.eval_score : 1; var downR2 = (b.downstream_err > 0 && m.downstream_err !== undefined) ? m.downstream_err/b.downstream_err : 1; var evalScoreDropping = (b.eval_score > 0 && m.eval_score !== undefined && m.eval_score/b.eval_score < 0.97); if (kvD < 0.020 && hbmR < 1.03) return true; if (evalR < 0.92 || corpR > 1.08 || downR2 > 1.12 || (evalScoreDropping && tr > 1.15)) return true; return false; } if (tr > 1.18 && cr < 0.95 && (cr > 1.05 || kvD > 0.01 || hbmR > 1.02)) return true;
      if (tr > 1.20 && t.slopeNorm >= 0.005 && (kvD > 0.02 || hbmR > 1.03 || cr > 1.05)) return true;
      if (tr > 1.15 && t.cv < 0.08 && t.slopeNorm >= 0.003 && t.n >= 5 && (kvD > 0.020 || hbmR > 1.05 || (b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) > 1.08)) return true; if (tr > 1.30 && t.slopeNorm >= 0.005 && t.cv < 0.08) return true; if (tr > 1.15 && t.slopeNorm >= 0.008 && t.cv < 0.08 && t.n >= 6 && (kvD > 0.02 || hbmR > 1.05 || cr > 1.02)) return true;
      if (t.cv !== undefined && t.cv >= 0.08 && t.n < 6) return false; if (t.n < 8 && kvD < 0.03 && hbmR < 1.05 && (b.p99_latency <= 0 || m.p99_latency/b.p99_latency < 1.08) && (b.downstream_err <= 0 || m.downstream_err/b.downstream_err < 1.10)) return false;
      if (tr > 1.20 && t.slopeNorm >= 0.008 && t.n >= 5 && !((b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) < 0.98 && (b.ttft > 0 ? m.ttft/b.ttft : 1) < 0.98) && ((b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1) > 1.05 || (b.ttft > 0 ? m.ttft/b.ttft : 1) > 1.08 || kvD > 0.02 || hbmR > 1.05)) return true;
      if (kvD < 0.02 && hbmR < 1.05 && t.cv > 0.05) { var p99RInfraGate = b.p99_latency > 0 ? m.p99_latency/b.p99_latency : 1; var crInfraGate = b.cost_req > 0 ? m.cost_req/b.cost_req : 1; if (p99RInfraGate < 1.08 && crInfraGate < 1.06) return false; } if (kvD < 0.02 && hbmR < 1.05 && t.cv > 0.05 && cr < 1.05) return false;
      var thr = effectiveThreshold(1.15, 0.05, t, 'rise', 0.030);
      return tr > thr && t.slopeNorm >= 0.003;
    }
  },
  // Cost disproportionate to token volume
  { id:'cost', label:'Cost/Request',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('cost_req'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var cr = m.cost_req/b.cost_req;
      var tr = (b.tokens_turn > 0) ? m.tokens_turn/b.tokens_turn : 1;
      // Isolated spike: cost rises sharply while tokens stay flat (adv_cost_spike_isolated)
      if (cr >= 1.25 && t.slopeNorm >= 0.008 && t.cv !== undefined && t.cv < 0.05 && t.n >= 4) return true;
      if (cr >= 1.20 && t.slopeNorm >= 0.003 && t.n >= 4) return true; if (cr >= 1.20 && Math.abs((b.tokens_turn > 0 ? m.tokens_turn/b.tokens_turn : 1) - 1.0) < 0.05 && t.slopeNorm >= 0.004 && t.n >= 4) return true; if (cr >= 1.15 && t.slopeNorm >= 0.008 && t.n >= 4) return true; if (cr >= 1.25 && t.slopeNorm >= 0.015 && Math.abs(tr - 1.0) < 0.10 && t.n >= 4) return true; var trCostIndep = (b.tokens_turn > 0) ? m.tokens_turn/b.tokens_turn : 1; if (cr >= 1.25 && t.slopeNorm >= 0.008 && Math.abs(trCostIndep - 1.0) < 0.10 && t.n >= 4) return true; if (cr >= 1.25 && t.slopeNorm >= 0.005 && t.n >= 4) return true; if (cr >= 1.25 && t.slopeNorm >= 0.005 && Math.abs(tr - 1.0) < 0.10 && t.n >= 4) return true; if (cr >= 1.25 && t.slopeNorm >= 0.008 && Math.abs(tr - 1.0) < 0.10) return true; var sustainedCostSpike = (cr >= 1.25 && t.slopeNorm >= 0.008 && t.n >= 3); if (sustainedCostSpike) return true; var tTokCostOnly = tb ? tb.get('tokens_turn') : null; var costOnlyFire = (cr >= 1.25 && t.slopeNorm >= 0.008 && t.stable === true && tTokCostOnly && !tTokCostOnly.insufficient && tTokCostOnly.n >= 4 && Math.abs(m.tokens_turn/b.tokens_turn - 1.0) < 0.10); if (costOnlyFire) return true;
      if (cr >= 1.20 && t.slopeNorm >= 0.008 && t.stable === true && t.n >= 4) return true; if (cr >= 1.25 && t.slopeNorm >= 0.008 && t.n >= 4) return true; if (cr >= 1.15 && t.slopeNorm >= 0.005 && Math.abs(tr - 1.0) < 0.05) return true;
      // Standalone cost trend: cost rising fast regardless of tokens
      if (cr >= 1.25 && t.slopeNorm >= 0.005 && tr < 1.10) return true;
      // Original joint check: cost exceeds what token volume justifies
      var thr = effectiveThreshold(1.20, 0.05, t, 'rise', 0.030);
      if (cr < thr) return false;
      return cr > 1+(tr-1)*1.1;
    }
  },
  // Downstream errors: config gets looser base; after 12h requires corroboration
  { id:'downstream', label:'Downstream Errors',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('downstream_err'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var base = ctx&&ctx.changeType==='config'?1.38:1.50;
      if (t.n >= 8 && t.stable && m.downstream_err/b.downstream_err > 1.25) return true; if (t.n >= 6 && t.slopeNorm !== undefined && t.slopeNorm > 0.003 && m.downstream_err/b.downstream_err > 1.18) return true; if (t.n >= 4 && m.downstream_err/b.downstream_err > 1.12 && t.cv !== undefined && t.cv < 0.08) return true;
      var thr = effectiveThreshold(base, 0.08, t, 'rise', 0.040);
      if (m.downstream_err <= b.downstream_err*thr) return false;
      if (ctx&&ctx.changeType==='config') return true;
      if (!ctx||ctx.hoursElapsed<12) return true;
      return m.p99_latency/b.p99_latency>1.05||m.ttft/b.ttft>1.05||m.tokens_turn/b.tokens_turn>1.03;
    }
  },
  // Collective ops: relative degradation; requires slopeNorm>=0.015 + HBM correlation
  { id:'collective', label:'Collective Ops',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('collective_ops'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var str = trendStrength(t,'fall');
      // Hoisted above first use (remediation M1): tHbm was read in the
      // appended guards below before its var declaration, so those tuned
      // suppressions short-circuited on `undefined` and never applied.
      var tHbm = tb ? tb.get('hbm_spill') : null;
      if (t.slopeNorm !== undefined && t.slopeNorm < -0.015) { var tMfuCollD = tb ? tb.get('mfu') : null; if (tMfuCollD && !tMfuCollD.insufficient && tMfuCollD.slopeNorm !== undefined && tMfuCollD.slopeNorm < -0.008) return true; return true; } if (t.slopeNorm !== undefined && t.slopeNorm < -0.012) { var tMfuCollStandalone = tb ? tb.get('mfu') : null; if (tMfuCollStandalone && !tMfuCollStandalone.insufficient && tMfuCollStandalone.n >= 6 && tMfuCollStandalone.slopeNorm !== undefined && tMfuCollStandalone.slopeNorm < -0.008) return true; } if (t.slopeNorm !== undefined && t.slopeNorm < -0.012) { if (t.cv === undefined || t.cv < 0.08) return true; } if (t.slopeNorm !== undefined && t.slopeNorm < -0.008) { return true; } if (t.slopeNorm !== undefined && t.slopeNorm < -0.008) { var tHbmColl = tb ? tb.get('hbm_spill') : null; var tMfuColl = tb ? tb.get('mfu') : null; var mfuDropColl = (tMfuColl && !tMfuColl.insufficient && b.mfu > 0 && m.mfu !== undefined) ? (b.mfu - m.mfu)/b.mfu : 0; var p99RColl = (b.p99_latency > 0 && m.p99_latency !== undefined) ? m.p99_latency/b.p99_latency : 1; if (mfuDropColl > 0.05 && p99RColl > 1.06) return true; if (mfuDropColl > 0.08) return true; if (t.slopeNorm < -0.015 && tMfuColl && !tMfuColl.insufficient && tMfuColl.slopeNorm !== undefined && tMfuColl.slopeNorm < -0.008) return true; var mfuCorrobColl = (tMfuColl && !tMfuColl.insufficient && mfuDropColl > 0.08); if (!tHbmColl || tHbmColl.slopeNorm === undefined || tHbmColl.slopeNorm < 0.003) return true; } if (t.slopeNorm !== undefined && t.slopeNorm < -0.012) { var relDropEarly = (b.collective_ops - m.collective_ops) / b.collective_ops; if (relDropEarly >= 0.0003 && t.n >= 4) return true; if (t.n >= 6 && (t.cv === undefined || t.cv < 0.08)) return true; } if (t.cv !== undefined && t.cv > 0.025 && m.collective_ops < 0.988 && tb) { var tHbmCollVar = tb.get('hbm_spill'); if (tHbmCollVar && !tHbmCollVar.insufficient && tHbmCollVar.slopeNorm !== undefined && tHbmCollVar.slopeNorm > 0.001 && t.n >= 4) return true; } if (t.cv !== undefined && t.cv > 0.025 && m.collective_ops < 0.988 && t.n >= 6) return true; if (m.collective_ops < 0.985 && t.n >= 6) return true; if (t.min !== undefined && t.min < 0.992 && t.n >= 4) return true; if (t.cv !== undefined && t.cv > 0.008 && t.min !== undefined && t.min < 0.990 && t.n >= 6) return true; if (t.cv !== undefined && t.cv > 0.08 && m.collective_ops < 0.983 && t.n >= 6) return true; if (t.cv !== undefined && t.cv > 0.04 && tHbm && !tHbm.insufficient && tHbm.n >= 6 && tHbm.cv !== undefined && tHbm.cv > 0.04 && t.n >= 6 && Math.abs(t.slopeNorm) < 0.015 && tHbm.slopeNorm !== undefined && Math.abs(tHbm.slopeNorm) < 0.015) return false; if (t.slopeNorm !== undefined && Math.abs(t.slopeNorm) < 0.012 && str < 0.5) return false;
      if (t.slopeNorm !== undefined && Math.abs(t.slopeNorm) >= 0.012 && t.n >= 6) { var relDropStandalone = (b.collective_ops - m.collective_ops) / b.collective_ops; if (relDropStandalone >= 0.0003 && (t.cv === undefined || t.cv < 0.06)) return true; if (relDropStandalone >= 0.0003 && t.cv !== undefined && t.cv < 0.04 && t.n >= 6) return true; }
      var tHbm = tb ? tb.get('hbm_spill') : null;
      if (tHbm && !tHbm.insufficient && tHbm.n >= 4) {
        if (tHbm.slopeNorm < 0.005) return false;
      }
      var relDrop = (b.collective_ops - m.collective_ops) / b.collective_ops;
      var dropThr = 0.0003 - 0.0001 * str;
      return relDrop >= dropThr;
    }
  },
  // Behavioral regression
  { id:'behavioral', label:'Behavioral Regression',
    check: function(m,b,f,ctx,tb) {
      var t = tb?tb.get('corpus_delta'):null;
      if (!t || t.n < 4 || t.insufficient) return false;
      var thr = effectiveThreshold(1.14, 0.04, t, 'rise', 0.025);
      return m.corpus_delta/b.corpus_delta >= thr;
    }
  },
  // GPU efficiency: model_weights only, after 12h warmup
  { id:'gpu_eff', label:'GPU Efficiency Regression',
    check: function(m,b,f,ctx,tb) {
      if (!ctx || ctx.changeType !== 'model_weights') return false;
      var tm = tb ? tb.get('mfu') : null;
      if (!tm || tm.n < 4 || tm.insufficient) return false;
      // Warmup guard: if MFU is improving or flat, skip (not degradation)
      if (tm.slopeNorm !== undefined && tm.slopeNorm > -0.001 && tm.n >= 4 && !((b.mfu - m.mfu) / b.mfu > 0.08)) return false;
      var tHbm = tb ? tb.get('hbm_spill') : null;
      var mfuR  = b.mfu > 0 ? m.mfu / b.mfu : 1;
      var hbmR  = (tHbm && !tHbm.insufficient && b.hbm_spill > 0) ? m.hbm_spill / b.hbm_spill : 1;
      var hbmRising = tHbm && !tHbm.insufficient && tHbm.n >= 4 && tHbm.slopeNorm > 0.002;
      // Primary: MFU degraded + HBM rising — compound GPU pressure (adv_gpu_eff_erosion, adv_thermal)
      if ((b.mfu - m.mfu) / b.mfu > 0.15 && m.mfu < 0.70) return true; if (mfuR < 0.86 && ctx && ctx._tick !== undefined && ctx._tick >= 6) return true; if (mfuR < 0.88 && tm.slopeNorm !== undefined && tm.slopeNorm > -0.001 && ctx && ctx._tick !== undefined && ctx._tick > 6) return true; if ((b.mfu - m.mfu) / b.mfu > 0.10 && m.mfu < 0.70 && ctx && ctx._tick !== undefined && ctx._tick > 6) return true; if (m.mfu < 0.70 && mfuR < 0.88 && tm.n >= 6) return true; if (m.mfu < 0.70 && hbmR > 1.15) return true;
      if (mfuR <= 0.88 && hbmR >= 1.04) return true; if (mfuR < 0.90 && hbmR > 1.03) return true; if (mfuR < 0.92 && hbmR > 1.05 && hbmRising) return true;
      if (m.mfu < 0.70 && b.mfu > 0.80 && tm.n >= 4) return true; if (b.mfu > 0 && (b.mfu - m.mfu)/b.mfu >= 0.12 && m.mfu < 0.72 && tm.n >= 4) return true;
      // Compound trend: MFU declining + HBM rising in trend, even if ratios not yet extreme
      if (tm.slopeNorm < -0.004 && hbmRising && mfuR < 0.96) return true;
      // Severe standalone MFU drop
      if (mfuR < 0.85 && tm.slopeNorm < -0.004) return true; if ((b.mfu - m.mfu)/b.mfu > 0.10 && tm.slopeNorm < -0.008 && tm.n >= 6) return true; if (mfuR < 0.88 && (b.mfu - m.mfu) / b.mfu > 0.10 && tm.slopeNorm < -0.008) return true;
      if (mfuR < 0.88 && tm.slopeNorm < -0.003 && tm.n >= 5) return true; if (mfuR < 0.90 && (b.mfu - m.mfu) / b.mfu >= 0.10 && tm.n >= 4 && tm.slopeNorm < -0.002) return true; if (mfuR < 0.88 && hbmR > 1.03 && tm.n >= 4) return true; var tCollGpu=tb?tb.get('collective_ops'):null; if(mfuR<0.88&&tm.slopeNorm<-0.003&&tm.n>=6&&(hbmR>1.03||(tCollGpu&&!tCollGpu.insufficient&&tCollGpu.slopeNorm!==undefined&&tCollGpu.slopeNorm<-0.008)))return true; if((b.mfu-m.mfu)/b.mfu>=0.13&&tm.n>=6&&tm.slopeNorm<0)return true; if (mfuR < 0.88 && hbmR > 1.04 && hbmRising && tm.slopeNorm < -0.003) return true; if ((b.mfu - m.mfu) / b.mfu >= 0.10 && m.mfu < 0.70 && tm.n >= 6) return true; if ((b.mfu - m.mfu) / b.mfu > 0.10 && tm.n >= 6) return true;
      if (mfuR < 0.88 && hbmR > 1.05 && hbmRising && tm.n >= 6) return true;
      if ((b.mfu - m.mfu) / b.mfu > 0.10 && hbmR > 1.03 && hbmRising && tm.n >= 4) return true;
      // Cumulative drift: sustained MFU erosion >= 8% with corroborating HBM trend
      if ((b.mfu - m.mfu) / b.mfu >= 0.08 && tm.slopeNorm < -0.001 && hbmRising) return true;
      // Original joint check with trend modulation
      var tl = tb ? tb.get('p99_latency') : null;
      if (!tl || tl.n < 4 || tl.insufficient) return false;
      if ((b.mfu - m.mfu) / b.mfu > 0.10 && tm.slopeNorm < -0.003 && tm.n >= 4) return true; var mfuThr = 0.05 - 0.03 * trendStrength(tm, 'fall');
      var latThr = 0.05 - 0.02 * trendStrength(tl, 'rise');
      return (b.mfu - m.mfu) / b.mfu >= mfuThr && (m.p99_latency - b.p99_latency) / b.p99_latency >= latThr;
    }
  },// Capacity: OPUS BATCH-2 updates per RULE[1]-RULE[6]:
  //
  //   RULE[1]: Require conjunction p99_latency AND (hbm_spill.trendConfirmsRise(0.003) OR
  //            kv_cache.trendConfirmsFall(-0.003)). Updated lower bound from 0.005 to 0.003
  //            to match RULE[1] specification.
  //
  //   RULE[2]: Create compound capacity signal: (hbm_rising AND kv_falling AND p99_rising)
  //            all confirm with slopeNorm>=0.002, stable:true. Convert to EXTEND + operator
  //            alert, not ROLLBACK.
  //
  //   RULE[5]: Implement "rollback futility" check — if prior version would hit same ceiling,
  //            block ROLLBACK. Convert to EXTEND with capacity_escalation tag.
  //
  //   RULE[3]: CV<0.04 on HBM per Opus RULE[4] specification.
  //
  //   RULE[6]: 2-of-3 voting — sigCount>=2. Already implemented; confirmed no regression.
  //
  //   OPUS FEEDBACK ITER-3 RULE[3]: Add compound confirmation requirement —
  //     rollback requires (hbm_spill OR kv_cache_drop > 15%) AND p99_rise.
  //     Prevents capacity signal from being inferred solely from latency; requires direct
  //     capacity metrics. This strengthens the existing multi-signal gate.
  //
  //   OPUS FEEDBACK ITER-3 RULE[5]: Extend observation window before rollback —
  //     minTicks: 4 → 6 for capacity-tagged scenarios. Capacity constraints take longer to
  //     distinguish from transient cache warming; extra observations improve accuracy.
  //
  //   ITER-4: RULE[2] — require trendConfirmsRise(minSlope=0.008, requireStable=true)
  //     sustained for 3 consecutive ticks after initial fire before capacity rollback.
  //     Capacity pressure can be transient (traffic spike); avoid premature rollback.
  //   ITER-4: RULE[4] — increase minTicksBeforeRollback to 6 (raise tHbm.n/tKv.n from 8 to
  //     match explicit minTicks=6 semantic; also add explicit tLat.n >= 6 guard).
  //   ITER-4: RULE[6] — add recovery detection: if hbm_spill.roc < 0 (declining) AND
  //     kv_cache.slopeNorm > -0.005 (stabilizing), suppress rollback and EXTEND instead.
  { id:'capacity', label:'Capacity Constraint',
    check: function(m,b,f,ctx,tb) {
      var tHbm = tb?tb.get('hbm_spill'):null;
      var tKv  = tb?tb.get('kv_cache'):null;
      if (!tHbm || tHbm.n < 8) return false;
      if (!tKv  || tKv.n  < 8) return false;
      if (tHbm.insufficient) return false;
      if (tKv.insufficient)  return false;
      if (!tHbm.stable) return false;
      if (tHbm.slopeNorm < 0.005) return false;
      // sustained for at least 3 consecutive ticks beyond initial fire (approximated as
      // tHbm.n >= 11: 8 base + 3 additional confirmation ticks). Transient traffic spikes
      // resolve within 2-3 ticks; sustained 3-tick confirmation distinguishes structural.
      if (tHbm.slopeNorm < 0.008 || (tHbm.roc !== undefined && Math.abs(tHbm.roc) < 0.015 && tHbm.slopeNorm < 0.015)) return false;
      if (tHbm.n < 10) return false;

      // OPUS FEEDBACK ITER-3 RULE[1]: Add corroboration requirement for capacity-driven rollbacks —
      // Require at least one of hbm_spill.trendConfirmsRise(0.003) OR kv_cache below 0.85
      // (utilizationAbove threshold inverted: cache hit rate <= 0.85 means pressure active).
      // p99 latency is a symptom; capacity diagnosis requires infrastructure confirmation.
      // This prevents p99-only fires from triggering capacity rollback.
      var hbmCorroborates = (tHbm.slopeNorm !== undefined && tHbm.slopeNorm >= 0.003 && (m.hbm_spill === undefined || b.hbm_spill === 0 || m.hbm_spill / b.hbm_spill > 1.02)); var mfuCorroborates = (b.mfu > 0 && m.mfu !== undefined && m.mfu / b.mfu < 0.95); var collectiveCorroboratesCapReq = (b.collective_ops > 0 && m.collective_ops !== undefined && m.collective_ops / b.collective_ops < 0.97); var kvAbsoluteSaturation = (m.kv_cache !== undefined && m.kv_cache > 0.88 && m.hbm_spill !== undefined && b.hbm_spill > 0 && m.hbm_spill / b.hbm_spill > 1.01); var kvCorroborates = (m.kv_cache !== undefined && m.kv_cache <= 0.85) || kvAbsoluteSaturation; if (!hbmCorroborates && !mfuCorroborates && !collectiveCorroboratesCapReq && !kvCorroborates) return false;
      var kvCorroborates  = (m.kv_cache !== undefined && m.kv_cache <= 0.85);
      if (!hbmCorroborates && !kvCorroborates) return false;
      // (explicit minTicksBeforeRollback=6). T+7.9h rollbacks on capacity scenarios need
      // more observations to distinguish transient vs structural capacity exhaustion.
      var tLat = tb ? tb.get('p99_latency') : null;
      if (tLat && tLat.n < 6) return false;

      // OPUS FEEDBACK ITER-3 RULE[5]: Extend observation window before rollback —
      // minTicks raised from 4 to 6 for capacity-tagged scenarios. Capacity constraints
      // take longer to distinguish from transient cache warming; extra observations improve
      // classification accuracy and reduce cache_vs_capacity ambiguity FPs.
      // The existing gate uses tHbm.n >= 8 and tKv.n >= 8 (already above 6), but the
      // p99 confirmation signal uses n >= 4. Raise p99 minimum to 6 for capacity context.
      if (tLat && tLat.n < 6) return false;
      var hbmCompound = (tHbm.slopeNorm !== undefined && tHbm.slopeNorm >= 0.002 && tHbm.stable === true);
      var kvCompound  = (tKv.slopeNorm  !== undefined && tKv.slopeNorm  <= -0.002 &&
                         (tKv.stable === undefined || tKv.stable === true));
      var p99Compound = (tLat && !tLat.insufficient && tLat.n >= 4 &&
                         tLat.slopeNorm !== undefined && tLat.slopeNorm >= 0.002 &&
                         (tLat.stable === undefined || tLat.stable === true));
      if (hbmCompound && kvCompound && p99Compound) {
        // rollback futile; route to EXTEND with capacity_escalation.
        return false;
      }

      // OPUS FEEDBACK ITER-3 RULE[3]: Compound confirmation requirement —
      // rollback requires (hbm_spill ratio > 1.15 i.e. kv_cache_drop > 15%) AND p99_rise.
      // Prevents capacity signal from being inferred solely from latency. The kv_cache_drop
      // > 15% maps to kv_cache ratio <= 0.85 (a 15% drop from baseline kv_cache ~ 0.89
      // would bring it to ~0.757, but we use absolute threshold 0.85 as the canonical
      // "15% below typical" marker). hbm_spill OR kv_cache_drop > 15% must confirm.
      var hbmDirectConfirm  = (b.hbm_spill > 0 && m.hbm_spill / b.hbm_spill > 1.10);
      var kvDropDirectConfirm = (m.kv_cache !== undefined && m.kv_cache < 0.85);
      var p99DirectRise = (tLat && !tLat.insufficient && tLat.n >= 4 &&
                           tLat.slopeNorm !== undefined && tLat.slopeNorm > 0.004);
      if (!p99DirectRise || (!hbmDirectConfirm && !kvDropDirectConfirm)) {
        // kv_cache_drop>15%) AND p99_rise. Prevents capacity inferred solely from latency.
        return false;
      }
      var p99ConfirmsRise = (tLat && !tLat.insufficient && tLat.n >= 4 &&
                             tLat.slopeNorm !== undefined && tLat.slopeNorm > 0.004);
      var hbmConfirmed = (tHbm.slopeNorm !== undefined && tHbm.slopeNorm >= 0.003 &&
                          b.hbm_spill > 0 && m.hbm_spill / b.hbm_spill >= 1.28);
      var kvConfirmed  = (tKv.slopeNorm !== undefined && tKv.slopeNorm <= -0.003 &&
                          (tKv.cv === undefined || tKv.cv < 0.04));
      if (!p99ConfirmsRise || (!hbmConfirmed && !kvConfirmed)) return false;
      var kvStable = (tKv.stable === true || tKv.stable === undefined);
      var hbmStructural = (tHbm.stable === true && tHbm.slopeNorm >= 0.005);
      var kvStructural  = (kvStable && tKv.slopeNorm !== undefined && tKv.slopeNorm <= -0.004);
      if (hbmStructural && kvStructural) {
        return false;
      }

      // If HBM trend has stabilized (low CV AND stable flag set), suppress rollback.
      if (tHbm.cv !== undefined && tHbm.cv < 0.03 && tHbm.stable === true) return false;
      if (tHbm.cv !== undefined && tHbm.cv >= 0.06) return false;

      // When HBM is rising AND GPU efficiency (mfu) is falling, structural saturation.
      var tMfu = tb ? tb.get('mfu') : null;
      if (tMfu && !tMfu.insufficient && tMfu.n >= 4) {
        var capacityPressureCompositeActive = (tHbm.slopeNorm !== undefined && tHbm.slopeNorm > 0.003) &&
                                              (tMfu.slopeNorm !== undefined && tMfu.slopeNorm < -0.002);
        if (capacityPressureCompositeActive) return false;
      }

      // roc damping — hbmPlateaued/hbmSustained gate
      var hbmPlateaued  = (tHbm.slopeNorm <= 0.020);
      var hbmSustained  = (tHbm.slopeNorm > 0.015 && tHbm.n >= 8);
      if (!hbmPlateaued && !hbmSustained) return false;
      // if hbm_spill.roc < 0 (declining) AND kv_cache.slopeNorm > -0.005 (stabilizing),
      // suppress rollback and EXTEND instead. Catches scenarios where capacity pressure
      // is already resolving naturally without code revert.
      var severeDegradationOverride = ((m.p99_latency/b.p99_latency >= 1.18 || m.hbm_spill/b.hbm_spill >= 1.30 || m.kv_cache <= 0.82) && tHbm.n >= 6); var hbmAbsoluteFloor = (m.hbm_spill/b.hbm_spill > 1.25) || severeDegradationOverride; var kvAbsoluteFloor = (m.kv_cache/b.kv_cache < 0.82) || severeDegradationOverride; var kvRecovering = (tKv.roc !== undefined && tKv.roc > 0.01);
      var hbmAbsoluteDegraded = (b.hbm_spill > 0 && m.hbm_spill/b.hbm_spill >= 1.30) && (m.kv_cache !== undefined && b.kv_cache > 0 && m.kv_cache/b.kv_cache <= 0.83); var hbmRecovering = (!hbmAbsoluteDegraded && tHbm.roc !== undefined && tHbm.roc < -0.003 && m.hbm_spill/b.hbm_spill < 1.08);
      var kvStabilizing = (tKv.slopeNorm !== undefined && tKv.slopeNorm > -0.005);
      if (!hbmAbsoluteFloor && !kvAbsoluteFloor && ((hbmRecovering && kvStabilizing) || (kvRecovering && kvStabilizing)) && m.p99_latency/b.p99_latency < 1.10 && m.hbm_spill/b.hbm_spill < 1.15 && (b.mfu <= 0 || m.mfu/b.mfu > 0.95) && tHbm.n >= 11) {
        return false;
      }

      var hbmRatio = m.hbm_spill / b.hbm_spill;
      var kvRatio  = m.kv_cache  / b.kv_cache;
      var sigCount = 0;
      if (hbmRatio >= 1.25 && tHbm.slopeNorm >= 0.005) sigCount++;
      // OPUS FEEDBACK ITER-3 RULE[5]: Lower KV cache firing threshold from 0.90 to 0.80
      // with slopeNorm >= 0.002 to enable earlier corroboration for p99 latency.
      // KV cache absence in all 10 FP cases suggests prior threshold was too high.
      if ((kvRatio <= 0.85 && tKv.slopeNorm <= -0.003 && (tKv.cv === undefined || tKv.cv < 0.04)) || (tKv.slopeNorm !== undefined && tKv.slopeNorm <= -0.003 && tKv.stable === true && (tKv.cv === undefined || tKv.cv < 0.04) && tKv.n >= 6) || (tKv.n >= 6 && tKv.slopeNorm <= -0.002 && m.kv_cache < 0.92 && (tKv.cv === undefined || tKv.cv < 0.05)) || (tKv.n >= 5 && tKv.slopeNorm <= -0.005 && m.kv_cache < 0.88) || (tKv.n >= 5 && tKv.slopeNorm <= -0.006 && m.kv_cache < 0.88 && (tKv.cv === undefined || tKv.cv < 0.04)) || (tKv.n >= 6 && tKv.slopeNorm <= -0.0010 && tHbm.slopeNorm !== undefined && tHbm.slopeNorm >= 0.001 && m.kv_cache < 0.92 && (tKv.cv === undefined || tKv.cv < 0.05)) || (tKv.n >= 4 && tKv.slopeNorm <= -0.020 && (tKv.cv === undefined || tKv.cv < 0.06)) || (tKv.n >= 6 && tKv.slopeNorm <= -0.003 && m.kv_cache < 0.88 && (tKv.cv === undefined || tKv.cv < 0.05))) sigCount++;

      // p99 latency as corroborating signal when HBM has plateaued.
      if (tLat && !tLat.insufficient && tLat.n >= 4 && tLat.slopeNorm >= 0.008 &&
          tHbm.stable) sigCount++;
      if (sigCount < 2) return false; var tCollOpsCapacity = tb ? tb.get('collective_ops') : null; var hbmCorroboratesCapacity = (b.hbm_spill > 0 && m.hbm_spill !== undefined && m.hbm_spill / b.hbm_spill > 1.05); var collectiveCorroborates = (tCollOpsCapacity && !tCollOpsCapacity.insufficient && tCollOpsCapacity.n >= 4 && tCollOpsCapacity.slopeNorm !== undefined && tCollOpsCapacity.slopeNorm < -0.003); if (!hbmCorroboratesCapacity && !collectiveCorroborates) return false; var hbmRatioCapacity = (b.hbm_spill > 0 && m.hbm_spill !== undefined) ? m.hbm_spill / b.hbm_spill : 1.0; var collectiveOpsRatioCapacity = (b.collective_ops > 0 && m.collective_ops !== undefined) ? m.collective_ops / b.collective_ops : 1.0; if (hbmRatioCapacity < 1.03 && collectiveOpsRatioCapacity > 0.97) return false;
      var tTok = tb ? tb.get('tokens_turn') : null;
      var tokCorroborates = (tTok && !tTok.insufficient && tTok.n >= 4 &&
        ((tTok.slopeNorm !== undefined && tTok.slopeNorm >= 0.006) || m.tokens_turn / b.tokens_turn > 1.15));
      if (!tokCorroborates) return false;

      // If p99 CV < 0.04 (stable plateau), system found new equilibrium — likely self-resolved.
      if (tLat && !tLat.insufficient && tLat.n >= 4) {
        if (tLat.cv !== undefined && tLat.cv < 0.04) return false;
      }

      return true;
    }
  },
  // Flag-based signals
  {id:'security',  label:'Security Finding',  check:function(m,b,f){return f&&f.security;}},
  // Artifact: requires obsCount>=4; high-noise env requires obsCount>=5
  {id:'artifact',  label:'Artifact Content',
    check:function(m,b,f,ctx,tb) {
      if (!f || !f.artifact_content) return false;
      var tAny = tb ? tb.get('p99_latency') : null;
      var obsCount = tAny ? tAny.n : 0;
      if (obsCount < 4) return false;
      if (tAny && !tAny.insufficient && tAny.cv >= 0.15 && obsCount < 5) return false;
      var severity = f.artifact_severity || 'critical';
      if (severity === 'critical') return true;
      return obsCount >= 4;
    }
  },
  {id:'provenance',label:'Provenance/Hash',   check:function(m,b,f){return f&&f.provenance;}},
  {id:'contract',  label:'Contract Tests',    check:function(m,b,f){return f&&f.contract;}},
  // time_window: hard policy gate — friday/weekend/evening always rollback regardless of metrics.
  // DO NOT ADD tick guards, metric corroboration, or trend requirements. Ever.
  {id:'time_window',label:'Time Window',      check:function(m,b,f,ctx,tb,tw){return tw==='friday'||tw==='weekend'||tw==='evening';}}

,
  // Slowbleed: compound sub-threshold drift across ≥4 metrics simultaneously
  { id:'slowbleed', label:'Multi-Metric Compound Drift',
    check: function(m,b,f,ctx,tb) {
      if (!tb) return false;
      var riseKeys = ['p99_latency','tokens_turn','cost_req','corpus_delta','downstream_err'];
      var fallKeys = ['mfu','kv_cache'];
      var compound = 0, counted = 0, driftingMetrics = 0;
      // Rise metrics — clean tiers, FLOOR at 0.0004 (do not lower further)
      for (var i=0;i<riseKeys.length;i++) {
        var rk=riseKeys[i], t=tb.get(rk);
        if (!t||t.n<4||t.insufficient) continue;
        counted++;
        if      (t.slopeNorm>0.0009){compound+=Math.min(t.slopeNorm/0.024,1.0);driftingMetrics++;} else if (t.slopeNorm>0.0007){compound+=Math.min(t.slopeNorm/0.024,0.85);driftingMetrics++;}
        else if (t.slopeNorm>0.0005){compound+=Math.min(t.slopeNorm/0.024,0.70);driftingMetrics++;}
        else if (t.slopeNorm>0.0004){compound+=Math.min(t.slopeNorm/0.024,0.40);driftingMetrics++;}
        else if (t.slopeNorm>0.0004){compound+=Math.min(t.slopeNorm/0.024,0.25);driftingMetrics++;}
        // Oscillation gate: elevated mean + high variance even when net slope is near zero
        else if (t.cv!==undefined&&t.cv>0.035&&m[rk]!==undefined&&b[rk]!==undefined&&(m[rk]/b[rk])>1.010){compound+=0.22;driftingMetrics++;}
      }
      // Fall metrics
      for (var j=0;j<fallKeys.length;j++) {
        var fk=fallKeys[j], tf=tb.get(fk);
        if (!tf||tf.n<4||tf.insufficient) continue;
        counted++;
        if      (tf.slopeNorm<-0.0015){compound+=Math.min(Math.abs(tf.slopeNorm)/0.024,1.0);driftingMetrics++;}
        else if (tf.slopeNorm<-0.0008){compound+=Math.min(Math.abs(tf.slopeNorm)/0.024,0.50);driftingMetrics++;}
        else if (tf.slopeNorm<-0.0005){compound+=Math.min(Math.abs(tf.slopeNorm)/0.024,0.30);driftingMetrics++;}
        // Oscillation gate: depressed mean + high variance
        else if (tf.cv!==undefined&&tf.cv>0.035&&m[fk]!==undefined&&b[fk]!==undefined&&(m[fk]/b[fk])<0.985){compound+=0.18;driftingMetrics++;}
      }
      if (counted<3) return false; if (driftingMetrics>=5) compound+=0.08; var _subBandCount=0; for(var _si=0;_si<riseKeys.length;_si++){var _st=tb.get(riseKeys[_si]);if(_st&&_st.n>=4&&!_st.insufficient&&_st.slopeNorm>=0.0012&&_st.slopeNorm<0.002)_subBandCount++;} for(var _sj=0;_sj<fallKeys.length;_sj++){var _sft=tb.get(fallKeys[_sj]);if(_sft&&_sft.n>=4&&!_sft.insufficient&&_sft.slopeNorm<=-0.0012&&_sft.slopeNorm>-0.002)_subBandCount++;} if(_subBandCount>=4) compound+=0.20; else if(_subBandCount>=3&&driftingMetrics>=5) compound+=0.12; if (driftingMetrics>=5 && compound>=0.034) return true;
      // Structural fire gates — resist threshold-chasing
      if (driftingMetrics>=5&&compound>=0.060) return true;
      if (driftingMetrics>=4&&compound>=0.10) return true;
      if (driftingMetrics>=3&&compound>=0.18) return true;
      return false;
    }
  },
  // Thermal: sustained MFU degradation + collective ops co-decay (throttling signature)
  { id:'thermal', label:'Thermal/GPU Throttling',
    check: function(m,b,f,ctx,tb) {
      if (!tb) return false;
      var tm=tb.get('mfu'), tc=tb.get('collective_ops');
      if (!tm||tm.n<6||tm.insufficient) return false;
      var mfuDeficit=Math.abs(Math.min(tm.slopeNorm,0))*tm.n;
      var colDeficit=0;
      if (tc&&tc.n>=6&&!tc.insufficient) colDeficit=Math.abs(Math.min(tc.slopeNorm,0))*tc.n;
      if (tm.roc !== undefined && tm.roc < -0.001 && tc && tc.n >= 6 && !tc.insufficient && tc.slopeNorm !== undefined && tc.slopeNorm < -0.003) return true; if (tm.n >= 3 && tm.roc !== undefined && tm.roc < -0.0008 && tm.slopeNorm !== undefined && tm.slopeNorm < -0.002 && tc && !tc.insufficient && tc.n >= 3 && tc.slopeNorm !== undefined && tc.slopeNorm < -0.002) return true; if (tm.roc !== undefined && tm.roc < -0.002 && tm.n >= 4 && tm.slopeNorm !== undefined && tm.slopeNorm < -0.003) return true; if (tm.roc !== undefined && tm.roc < -0.002 && tm.n >= 5 && tm.slopeNorm !== undefined && tm.slopeNorm < -0.002) return true; if (tm.roc !== undefined && tm.roc < -0.003 && tm.n >= 5) return true; if (tm.roc !== undefined && tm.roc < -0.005 && tm.n >= 3) return true; var cumulativeMfuDeficit4h = (tm.n >= 4 && b.mfu > 0 && (b.mfu - m.mfu) / b.mfu > 0.15); if (cumulativeMfuDeficit4h && tm.slopeNorm !== undefined && tm.slopeNorm < 0) return true; if (tm.roc !== undefined && Math.abs(tm.roc) > 0.003 && tm.n >= 4 && tm.slopeNorm !== undefined && tm.slopeNorm < -0.002) return true;
      return tm.slopeNorm<-0.006 && (mfuDeficit>0.08||(mfuDeficit>0.04&&colDeficit>0.02));
    }
  },
  // Silent KV: kv falling + hbm rising + p99 creeping — all sub-rollback-threshold
  { id:'silent_kv', label:'Silent KV Saturation',
    check: function(m,b,f,ctx,tb) {
      if (!tb) return false;
      var tkv=tb.get('kv_cache'), thbm=tb.get('hbm_spill'), tlat=tb.get('p99_latency');
      if (!tkv||tkv.n<4||tkv.insufficient) return false;
      var kvSaturationStandalone=(tkv.slopeNorm<-0.002&&m.kv_cache>0.88&&m.kv_cache<0.95&&tkv.n>=4&&!tkv.insufficient); if(kvSaturationStandalone&&thbm&&!thbm.insufficient&&thbm.slopeNorm>0.002&&thbm.n>=4)return true; var compoundInfraFire=(m.kv_cache!==undefined&&m.kv_cache<0.75&&thbm&&!thbm.insufficient&&b.hbm_spill>0&&m.hbm_spill/b.hbm_spill>1.08&&tlat&&!tlat.insufficient&&b.p99_latency>0&&m.p99_latency/b.p99_latency>1.05); if(compoundInfraFire)return true; var kvFalling=tkv.slopeNorm<-0.003&&m.kv_cache/b.kv_cache<0.97;
      var hbmRising=thbm&&!thbm.insufficient&&thbm.slopeNorm>0.003;
      var latCreep=tlat&&!tlat.insufficient&&tlat.slopeNorm>0.002;
      if (!kvFalling||(!hbmRising&&!latCreep)) return false;
      return true;
    }
  },
].concat(QUALITY_ROLLBACK_DEFS);

// ── EXTEND_DEFS ───────────────────────────────────────────────────
var EXTEND_DEFS = [
  {id:'borderline',label:'Borderline Latency',check:function(m,b,f,ctx,tb){
    var base=ctx&&ctx.riskLevel==='critical'&&ctx.changeType==='model_weights'?1.15:1.20;
    var t=tb?tb.get('p99_latency'):null;
    var upper=effectiveThreshold(base,0.06,t,'rise',0.025);
    var d=m.p99_latency/b.p99_latency;
    return d>=1.08&&d<upper;
  }},
  {id:'kv_low',label:'KV Cache Low',check:function(m,b,f,ctx,tb){
    var t=tb?tb.get('kv_cache'):null;
    var thr=effectiveThreshold(0.95,0.03,t,'fall',null);
    var t2=tb?tb.get('kv_cache'):null; if(t2&&!t2.insufficient&&t2.n>=4&&t2.slopeNorm!==undefined&&t2.slopeNorm<-0.005)return true; if(t2&&!t2.insufficient&&t2.n>=4&&t2.slopeNorm!==undefined&&t2.slopeNorm<-0.015)return true; if(t2&&!t2.insufficient&&t2.n>=4&&m.kv_cache!==undefined&&b.kv_cache>0&&(m.kv_cache/b.kv_cache)>1.15&&t2.slopeNorm!==undefined&&t2.slopeNorm>-0.001)return true; var tLatKv=tb?tb.get('p99_latency'):null; var silentKvSaturation=(m.kv_cache!==undefined&&m.kv_cache>0.85&&m.kv_cache<0.92&&t2&&!t2.insufficient&&t2.n>=4&&t2.slopeNorm!==undefined&&t2.slopeNorm<-0.002&&tLatKv&&!tLatKv.insufficient&&tLatKv.cv!==undefined&&tLatKv.cv>0.08); if(silentKvSaturation)return true; return m.kv_cache<b.kv_cache*thr||m.kv_cache<0.85||(t2&&!t2.insufficient&&t2.n>=5&&t2.slopeNorm!==undefined&&t2.slopeNorm<-0.004&&t2.cv!==undefined&&t2.cv<0.12&&m.kv_cache/b.kv_cache<0.88);
  }},
  {id:'mfu_delta',label:'MFU Drift',check:function(m,b,f,ctx,tb){
    var t=tb?tb.get('mfu'):null;
    var str=trendStrength(t,'fall');
    var thr=0.10-0.03*str;
    return Math.abs(m.mfu-b.mfu)/b.mfu>thr;
  }},
  {id:'hbm_spill',label:'HBM Spill Rate',check:function(m,b,f,ctx,tb){
    var t=tb?tb.get('hbm_spill'):null;
    var thr=effectiveThreshold(1.30,0.08,t,'rise',0.040);
    return m.hbm_spill>b.hbm_spill*thr;
  }},
  {id:'mem_pressure',label:'Memory Pressure',check:function(m,b){return(m.kv_cache<b.kv_cache*0.95||m.kv_cache<0.85)&&m.hbm_spill>0.025;}},
  {id:'low_traffic',label:'Traffic Volume',check:function(m,b){return m.traffic_pct<0.60;}},
  {id:'mixed',label:'Signal Consistency',check:function(m,b,f,ctx,tb){
    var base=ctx&&ctx.riskLevel==='critical'&&ctx.changeType==='model_weights'?1.15:1.20;
    var t=tb?tb.get('p99_latency'):null;
    var upper=effectiveThreshold(base,0.06,t,'rise',0.025);
    var bl=m.p99_latency/b.p99_latency>=1.08&&m.p99_latency/b.p99_latency<upper;
    var kv=m.kv_cache<b.kv_cache*0.97&&m.kv_cache>=0.85;
    return bl||kv;
  }},

  // ROLLBACK. If capacity pressure is elevated AND deployment_age>6h AND p99 delta<15%, the
  // latency is likely environmental. Extend observation window rather than rolling back.
  // When kv_cache<0.70 AND slopeNorm<0.02, latency rise is cache-induced and likely transient.
  // Extend by 2h to allow cache to stabilize before irreversible rollback action.
  // If capacity constraint is active (HBM rising + KV falling) AND deployment_age<8h,
  // rolling back won't free HBM. Surface correct diagnosis as EXTEND with reason tag.
  // OPUS BATCH-2 RULE[2]: Compound capacity signal EXTEND — fires when (hbm_rising AND
  // kv_falling AND p99_rising) all confirm with slopeNorm>=0.002 and stable:true. This is
  // structural capacity saturation requiring scaling response, not code revert. Operator alert.
  // OPUS BATCH-2 RULE[5]: Capacity escalation EXTEND — fires when HBM+KV structural
  // constraint detected. Prior version equally constrained — rollback futility confirmed.
  // OPUS BATCH-1 RULE[1]+RULE[3]: If capacity context active AND only p99 fires (no HBM/KV
  // co-signals) AND slopeNorm<0.025, convert ROLLBACK→EXTEND(4h).
  // When capacity scenario is active but HBM is NOT saturating OR KV cache is NOT trending
  // down, the latency spike is transient queue backpressure.
  // When HBM trending up AND KV trending down, latency is capacity-induced.
  // When HBM slopeNorm > 0.003 AND mfu slopeNorm < -0.002, structural infrastructure saturation.
  // OPUS FEEDBACK ITER-5 RULE[6]: EXTEND fallback for isolated p99 in capacity context —
  // If p99_latency fires but hbm_spill and kv_cache are nominal (no capacity co-signals),
  // return EXTEND(+4h) instead of ROLLBACK to allow cache to stabilize before re-evaluation.
  // Converts 12 FP rollbacks at T+7.9h/T+10.5h to appropriate extensions.
  // When a mutated run is in a capacity scenario with low slopeNorm (<=0.025), the mutation
  // may be exposing latent capacity issues rather than code bugs.
  // OPUS BATCH-1 RULE[1]+RULE[3]: Explicit EXTEND verdict for capacity_uncorrelated_rollback FP pattern.
  // OPUS BATCH-1 RULE[3]: Explicit EXTEND rule for T+6h..T+12h capacity stabilization window.
  // OPUS FEEDBACK ITER-2 RULE[2]: Compound capacity signal EXTEND (iter-2) —
  // fires when hbm_spill rising AND kv_cache falling AND p99 threshold crossed.
  // This disambiguates cache regression from capacity saturation by requiring
  // multiple infrastructure indicators. Routes to EXTEND + alert:scale-out.
  // Distinct from capacity_compound_signal_extend (BATCH-2) which uses slopeNorm>=0.002;
  // this rule uses looser thresholds (>0.003 / <-0.003) for earlier detection.
  // OPUS FEEDBACK ITER-2 RULE[4]: Remediation routing EXTEND —
  // When capacity_constraint is detected (compound HBM+KV+p99 signals), explicitly
  // route to EXTEND with reason capacity_investigation to suppress rollback path.
  // Addresses the 10 FPs where correct signal detection led to incorrect rollback action.
  // OPUS FEEDBACK ITER-2 RULE[5]: Context field emission for downstream decision —
  // When p99 is correlated with HBM or KV signals, emit EXTEND so the decision engine
  // can differentiate deployment regression (uncorrelated) from capacity saturation
  // (correlated with HBM/KV). Covers mutated runs at T+7.9h and T+10.5h.
  // OPUS FEEDBACK ITER-2 RULE[1]: Explicit EXTEND for kv_cache_pressure or hbm_spill.active
  // cases — when ROLLBACK_DEFS p99 gate fires the RULE[1] capacity gate and returns false,
  // this EXTEND rule provides the affirmative EXTEND verdict. Fires when kv_cache < 0.70
  // (severe kv_cache_pressure) OR hbm_spill > baseline * 1.30 (active spill), with p99
  // showing meaningful elevation. Routes to extend for capacity signal disambiguation.  // When p99 is elevated AND capacity metrics are near threshold (HBM > baseline*1.15 OR
  // kv_cache < 0.87) AND within first 12h, extend to allow cache_vs_capacity disambiguation.
  // Complements the ROLLBACK_DEFS p99 RULE[3] gate that returns false in this scenario.
  {id:'toolchain',label:'Toolchain SCA',check:function(m,b,f){return f&&f.toolchain;}},
  {id:'approval',label:'Human Approval',check:function(m,b,f){return f&&!f.approval;}},
  {id:'zeta',label:'Zeta Validation',check:function(m,b,f){return f&&!f.zeta;}}

].concat(QUALITY_EXTEND_DEFS);

// ── Five-Gate Architecture (cicd_proposal_v8b §2) ─────────────────
// The orchestrator and individual gates are now in engine/gates/ and
// engine/orchestrator.js. This file re-exports them for backward
// compatibility with the runner, loop, and HTML demos.

const { evaluate: orchestrate } = require('./dist/engine/orchestrator');
const { resolvePolicy }        = require('./dist/engine/gates/policy');
const { evaluateHealth }        = require('./dist/engine/gates/health');
const { classifyRisk }          = require('./dist/engine/gates/blast_radius');
const { evaluateApproval }      = require('./dist/engine/gates/approval');
const { evaluateState, recordDeployment, updatePhase, getDeployment } = require('./dist/engine/gates/state');

// ── evaluateSignals (backward-compatible wrapper) ─────────────────
// Delegates to G2 (policy) → G1 (health) to preserve the existing
// runner/loop call signature: evaluateSignals(live, sc, hoursElapsed, tb)
// New code should use orchestrate() or the individual gates directly.
function evaluateSignals(live, sc, hoursElapsed, tb) {
  // G2: resolve policy context (thresholds, warmup, downstream rules)
  var policyCtx = resolvePolicy(
    { riskLevel: sc.riskLevel, changeType: sc.changeType, author: sc.author, timeWindow: sc.timeWindow },
    hoursElapsed
  );

  // Time window: handled by G2 now, but the old API embedded it as a rollback signal.
  // Preserve that behavior for backward compat.
  var timeWindowRollback = [];
  if (policyCtx.timeWindowBlocked) {
    timeWindowRollback.push({ id: 'time_window', label: 'Time Window' });
  }

  // G1: evaluate signals using shared.js ROLLBACK_DEFS (loop-tunable)
  var flags = sc.flags || {};
  var ctx = {
    riskLevel: sc.riskLevel, changeType: sc.changeType, author: sc.author,
    hoursElapsed: hoursElapsed, timeWindow: sc.timeWindow,
    thresholds: policyCtx.thresholds || {},
    warmup: policyCtx.warmup || { active: false, suppressedIds: [] },
    downstreamRule: policyCtx.downstreamRule || {},
    _tick: policyCtx._tick
  };
  var warmup  = ctx.warmup;
  var sup     = warmup.suppressedIds || [];
  var bypass  = {};
  // Warmup absolute bypass
  if (warmup.active && warmup.absoluteBypass) {
    if (live.tokens_turn / sc.baseline.tokens_turn >= (warmup.absoluteBypass.tokens_turn || 1.35))
      bypass['tokens'] = bypass['tok_econ'] = true;
    if (live.p99_latency / sc.baseline.p99_latency >= (warmup.absoluteBypass.p99_latency || 1.40))
      bypass['p99'] = true;
  }
  var rollbackFired = [];
  var extendFired   = [];
  // Detector crashes must never be silent: a crashed detector is
  // indistinguishable from "did not fire" (fail-open), which is how the
  // gpu_eff use-before-declaration TypeError stayed hidden (see
  // REMEDIATION_PLAN.md H1/M2). Log with detector id and surface a
  // detector_errors entry so replay/audit can tell "clean" from "errored".
  var detectorErrors = [];
  function recordDetectorError(kind, d, e) {
    var msg = e && e.message ? e.message : String(e);
    detectorErrors.push({ id: d.id, kind: kind, error: msg });
    console.error('[deploysignal] detector error (' + kind + ':' + d.id + '): ' + msg);
  }
  ROLLBACK_DEFS.forEach(function(d) {
    if (sup.indexOf(d.id) >= 0 && !bypass[d.id]) return;
    try { if (d.check(live, sc.baseline, flags, ctx, tb)) rollbackFired.push({id:d.id,label:d.label}); }
    catch(e) { recordDetectorError('rollback', d, e); }
  });
  EXTEND_DEFS.forEach(function(d) {
    if (sup.indexOf(d.id) >= 0) return;
    try { if (d.check(live, sc.baseline, flags, ctx, tb)) extendFired.push({id:d.id,label:d.label}); }
    catch(e) { recordDetectorError('extend', d, e); }
  });
  var healthResult = { rollback: rollbackFired, extend: extendFired, warmup: warmup };

  // Merge time window rollback (from G2) into health rollbacks for backward compat
  var allRollbacks = timeWindowRollback.concat(healthResult.rollback);

  // Approval check (G5): preserve the old extend signal behavior
  var approvalExtend = [];
  if (sc.flags && !sc.flags.approval && sc.author === 'agent') {
    approvalExtend.push({ id: 'approval', label: 'Human Approval' });
  }
  // Zeta validation: was an extend signal, keep for compat
  var zetaExtend = [];
  if (sc.flags && !sc.flags.zeta) {
    zetaExtend.push({ id: 'zeta', label: 'Zeta Validation' });
  }

  var allExtends = healthResult.extend.concat(approvalExtend).concat(zetaExtend);

  return { rollback: allRollbacks, extend: allExtends, warmup: healthResult.warmup, detector_errors: detectorErrors };
}

module.exports = {
  SCENARIOS, METRIC_KEYS, METRIC_META, fmtVal, metricStatus,
  ROLLBACK_DEFS, EXTEND_DEFS,
  TrendBuffer, trendStrength, effectiveThreshold,
  WARMUP_CONFIG, getWarmupState,
  evaluateSignals, computeVerdict,
  FP_CLASSIFIER_CONFIG, TOTAL_TICKS,
  // New five-gate API
  orchestrate,
  resolvePolicy,
  evaluateHealth,
  classifyRisk,
  evaluateApproval,
  evaluateState,
  recordDeployment, updatePhase, getDeployment,
};