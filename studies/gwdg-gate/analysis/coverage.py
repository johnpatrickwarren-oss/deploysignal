import csv, sys, glob, os, json, collections
from datetime import datetime
D='/Users/johnwarren/concord/tessera/runs/gwdg-data/gwdg-gpu-node-telemetry-gpu-detachment-failures-2025-2026-v1.0.0'
METRICS=['DCGM_FI_DEV_GPU_TEMP','DCGM_FI_DEV_MEMORY_TEMP','DCGM_FI_DEV_POWER_USAGE','DCGM_FI_DEV_GPU_UTIL','DCGM_FI_DEV_FB_USED','DCGM_FI_DEV_MEM_COPY_UTIL','DCGM_FI_DEV_SM_CLOCK','DCGM_FI_DEV_MEM_CLOCK','DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL','DCGM_FI_DEV_PCIE_REPLAY_COUNTER','DCGM_FI_DEV_XID_ERRORS','node_load1','up','scrape_duration_seconds','scrape_samples_scraped']
out={}
for f in sorted(glob.glob(D+'/telemetry/ggpu*_tidy.csv')):
    name=os.path.basename(f)
    cov=collections.defaultdict(lambda: {'n':0,'first':None,'last':None,'ts':set()})
    allts=set(); gpus=set()
    with open(f) as fh:
        r=csv.reader(fh); hdr=next(r)
        ci={h:i for i,h in enumerate(hdr)}
        for row in r:
            m=row[ci['metric']]
            if m not in METRICS: continue
            t=row[ci['timeUtc']]; g=row[ci['gpu']] or '-'
            allts.add(t)
            if m.startswith('DCGM'): gpus.add(g)
            k=(m,g); c=cov[k]; c['n']+=1; c['ts'].add(t)
            if c['first'] is None or t<c['first']: c['first']=t
            if c['last'] is None or t>c['last']: c['last']=t
    ts=sorted(allts)
    # cadence
    def mins(a,b): return (datetime.fromisoformat(b)-datetime.fromisoformat(a)).total_seconds()/60
    deltas=collections.Counter(round(mins(ts[i],ts[i+1])) for i in range(min(len(ts)-1,5000)))
    summary={'gpus':sorted(gpus),'ts_first':ts[0] if ts else None,'ts_last':ts[-1] if ts else None,'n_ts':len(ts),'cadence_top':deltas.most_common(3),
             'metrics':{}}
    for (m,g),c in sorted(cov.items()):
        summary['metrics'][f'{m}|{g}']={'n':c['n'],'first':c['first'],'last':c['last']}
    out[name]=summary
    print(name, 'gpus', summary['gpus'], 'ts', summary['ts_first'], summary['ts_last'], 'n_ts', summary['n_ts'], 'cadence', summary['cadence_top'], flush=True)
    for m in METRICS:
        row=[(g, cov[(m,g)]['n']) for g in (sorted(gpus) if m.startswith('DCGM') else ['-']) if (m,g) in cov]
        if row: print('   ', m, row, flush=True)
json.dump(out, open('/private/tmp/claude-501/-Users-johnwarren-concord-deploysignal/32c19e1c-e923-422f-9e4f-f252ddf76e50/scratchpad/gwdg/coverage.json','w'), indent=1)
