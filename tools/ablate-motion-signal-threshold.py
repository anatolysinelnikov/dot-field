#!/usr/bin/env python3
"""Offline signal-threshold ablation for the v1 motion estimator.

This is diagnostic-only. The estimator loop is kept identical to the current
offline implementation; only MIN_SIGNAL is supplied by the ablation table.
"""
import gzip, json, math, os
from pathlib import Path
import numpy as np

_json_dumps = json.dumps
json.dumps = lambda obj, **kwargs: _json_dumps(obj, default=lambda value: value.item() if hasattr(value, "item") else str(value), **kwargs)

ROOT = Path(__file__).resolve().parents[1]; CURRENT = ROOT / "data/generated/current"
current = json.loads((CURRENT / "metadata.json").read_text()); gid = current["generation_id"]
GEN = ROOT / "data/generated" / os.environ.get("DOT_FIELD_GENERATION", gid)
m = json.loads((GEN / "metadata.json").read_text()); assert m["generation_id"] == gid
g = m["spatial_grid"]; W, H = g["width"], g["height"]; N = W * H
frames = [np.fromfile(GEN / a, dtype="<f4").reshape(H, W) for a in m["rain"]["frame_assets"]]
spacing = m["motion"]["grid_spacing_source_nodes"]; motion_paths = [GEN / a for a in m["motion"]["interval_assets"]]
thresholds = [0.08, 0.06, 0.04, 0.02]; strong = 5.0
bounds = (39.5, 42.5, 50.5, 52.3)
xmin, xmax = max(0, math.floor((bounds[0]-g["longitude_start"])/g["longitude_spacing"])), min(W-1, math.ceil((bounds[1]-g["longitude_start"])/g["longitude_spacing"]))
ymin, ymax = max(0, math.floor((bounds[2]-g["latitude_start"])/g["latitude_spacing"])), min(H-1, math.ceil((bounds[3]-g["latitude_start"])/g["latitude_spacing"]))

def components(a):
    seen=np.zeros((H,W),bool); out=[]
    for y in range(ymin,ymax+1):
        for x in range(xmin,xmax+1):
            if seen[y,x] or a[y,x] <= strong: continue
            q=[(y,x)]; seen[y,x]=1; cells=[]
            while q:
                cy,cx=q.pop(); cells.append((cy,cx))
                for dy in (-1,0,1):
                    for dx in (-1,0,1):
                        ny,nx=cy+dy,cx+dx
                        if (dx or dy) and ymin<=ny<=ymax and xmin<=nx<=xmax and not seen[ny,nx] and a[ny,nx]>strong:
                            seen[ny,nx]=1;q.append((ny,nx))
            weights=np.array([a[cy,cx]-strong for cy,cx in cells]); out.append({"x":sum(cx*w for (cy,cx),w in zip(cells,weights))/weights.sum(),"y":sum(cy*w for (cy,cx),w in zip(cells,weights))/weights.sum(),"peak":float(max(a[cy,cx] for cy,cx in cells)),"cells":len(cells)})
    return sorted(out,key=lambda z:z["peak"],reverse=True)
tracks=[]; prev=None
for a in frames:
    cs=components(a); chosen=cs[0] if prev is None else min(cs,key=lambda z:math.hypot(z["x"]-prev["x"],z["y"]-prev["y"])); tracks.append(chosen);prev=chosen

def estimate(source,target,signal_threshold):
    gh=math.ceil((W-1)/spacing)+1; gw=math.ceil((H-1)/spacing)+1; result=np.zeros((4,gh,gw),np.float32); reliable=np.zeros((gh,gw),bool); detail=[[None]*gw for _ in range(gh)]
    s=np.log1p(source.astype(np.float64)); t=np.log1p(target.astype(np.float64))
    for gy in range(gh):
        cy=min(H-1,gy*spacing)
        for gx in range(gw):
            cx=min(W-1,gx*spacing); x0,x1=max(0,cx-4),min(W,cx+5); y0,y1=max(0,cy-4),min(H,cy+5); block=s[y0:y1,x0:x1]; sig=float(block.mean()); var=float(block.var()); d={"signal":sig,"variance":var,"best":[0,0],"zero":None,"bestError":None,"improvement":None,"state":"zero","reason":None,"center":[cx,cy]}
            if sig < signal_threshold: d["reason"]="insufficient signal";detail[gy][gx]=d;continue
            if var < 0.0025: d["reason"]="insufficient variance";detail[gy][gx]=d;continue
            best=math.inf;zero=math.inf;bd=(0,0)
            for dy in range(-8,9):
                ty0,ty1=y0+dy,y1+dy
                if ty0<0 or ty1>H:continue
                for dx in range(-8,9):
                    tx0,tx1=x0+dx,x1+dx
                    if tx0<0 or tx1>W:continue
                    e=float(np.abs(block-t[ty0:ty1,tx0:tx1]).mean())
                    if dx==0 and dy==0:zero=e
                    if e<best:best=e;bd=(dx,dy)
            d.update(best=list(bd),zero=zero,bestError=best,improvement=(zero-best)/zero if zero else None)
            if not math.isfinite(best):d["reason"]="other explicit reliability condition"
            elif zero<=0 or (zero-best)/zero < 0.08:d["reason"]="insufficient improvement over zero displacement"
            else:result[0,gy,gx],result[1,gy,gx]=bd;result[2,gy,gx]=1;reliable[gy,gx]=1;d["state"]="direct";d["reason"]="accepted direct block match"
            detail[gy][gx]=d
    for gy in range(gh):
        for gx in range(gw):
            if reliable[gy,gx]:continue
            candidates=[]
            for oy in range(-4,5):
                for ox in range(-4,5):
                    ny,nx=gy+oy,gx+ox;dist=ox*ox+oy*oy
                    if dist and dist<=16 and 0<=ny<gh and 0<=nx<gw and reliable[ny,nx]:candidates.append((dist,ny,nx))
            if candidates:
                _,ny,nx=min(candidates);result[:2,gy,gx]=result[:2,ny,nx];detail[gy][gx]["state"]="filled";detail[gy][gx]["reason"]="filled from nearby reliable estimate"
            else:detail[gy][gx]["state"]="zero fallback"
    return result,detail

def upsample(v,s):
    y,x=np.indices((H,W),dtype=float);mx,my=x/s,y/s;gx=np.minimum(v.shape[2]-2,np.floor(mx).astype(int));gy=np.minimum(v.shape[1]-2,np.floor(my).astype(int));fx,fy=mx-gx,my-gy;out=[]
    for a in v[:2]:
        lo=a[gy,gx]*(1-fx)+a[gy,gx+1]*fx;hi=a[gy+1,gx]*(1-fx)+a[gy+1,gx+1]*fx;out.append(lo*(1-fy)+hi*fy)
    return out
def transport(src,v,s):
    dx,dy=upsample(v,s); y,x=np.indices((H,W),dtype=float);xx=np.clip(x-dx,0,W-1.000001);yy=np.clip(y-dy,0,H-1.000001);x0=np.floor(xx).astype(int);y0=np.floor(yy).astype(int);fx=xx-x0;fy=yy-y0;lo=src[y0,x0]*(1-fx)+src[y0,x0+1]*fx;hi=src[y0+1,x0]*(1-fx)+src[y0+1,x0+1]*fx;return hi*fy+lo*(1-fy)
def align(src,tgt,v,s):
    p=transport(src,v,s);e=np.log1p(p)-np.log1p(tgt);b=np.log1p(src)-np.log1p(tgt);return float(np.abs(e).mean()),float(np.abs(b).mean()),float(100*(np.abs(b).mean()-np.abs(e).mean())/np.abs(b).mean()),float(np.sqrt((e*e).mean()))
def fss(a,b,threshold=1):
    def ii(v):
        z=(v>threshold).astype(np.int32);return np.pad(z.cumsum(0).cumsum(1),((1,0),(1,0)))
    A,B=ii(a),ii(b); y,x=np.indices((H,W));x0=np.maximum(x-2,0);y0=np.maximum(y-2,0);x1=np.minimum(x+3,W);y1=np.minimum(y+3,H);n=(x1-x0)*(y1-y0);pa=(A[y1,x1]-A[y0,x1]-A[y1,x0]+A[y0,x0])/n;pb=(B[y1,x1]-B[y0,x1]-B[y1,x0]+B[y0,x0])/n;den=((pa*pa)+(pb*pb)).sum();return float(1-(((pa-pb)**2).sum()/den)) if den else 1

results={}
for st in thresholds:
    allv=[];details_all=[]; target=[]; fmae=[]; bmae=[]; fbase=[]; bbase=[]; fimp=[]; bimp=[]; frms=[]; brms=[]; held=[]
    for i,(a,b) in enumerate(zip(frames[:-1],frames[1:])):
        f,fd=estimate(a,b,st);bb,bd=estimate(b,a,st);allv.extend((f,bb));details_all.extend((fd,bd)); A,B=tracks[i],tracks[i+1]
        def rel(ds,cx,cy):
            gx,gy=cx/spacing,cy/spacing;x0=min(len(ds[0])-2,max(0,math.floor(gx)));y0=min(len(ds)-2,max(0,math.floor(gy)));return [ds[y][x] for y in range(y0,y0+2) for x in range(x0,x0+2)]
        rf,rb=rel(fd,(A["x"]+B["x"])/2,(A["y"]+B["y"])/2),rel(bd,(A["x"]+B["x"])/2,(A["y"]+B["y"])/2)
        target.append({"interval":i,"from":m["time"]["timestamps"][i],"to":m["time"]["timestamps"][i+1],"observed":[B["x"]-A["x"],B["y"]-A["y"]],"forward":{ "direct":sum(x["state"]=="direct" for x in rf),"filled":sum(x["state"]=="filled" for x in rf),"zero":sum(x["state"]=="zero fallback" for x in rf),"effective":[float(np.mean([x["best"][0] for x in rf if x["state"]!="zero fallback"] or [0])),float(np.mean([x["best"][1] for x in rf if x["state"]!="zero fallback"] or [0]))]},"backward":{"direct":sum(x["state"]=="direct" for x in rb),"filled":sum(x["state"]=="filled" for x in rb),"zero":sum(x["state"]=="zero fallback" for x in rb),"effective":[float(np.mean([x["best"][0] for x in rb if x["state"]!="zero fallback"] or [0])),float(np.mean([x["best"][1] for x in rb if x["state"]!="zero fallback"] or [0]))]}})
        fa=align(a,b,f,spacing);ba=align(b,a,bb,spacing);fmae.append(fa[0]);bmae.append(ba[0]);fbase.append(fa[1]);bbase.append(ba[1]);fimp.append(fa[2]);bimp.append(ba[2]);frms.append(fa[3]);brms.append(ba[3])
        if i<len(frames)-2:
            c=frames[i+2]; f_ac,_=estimate(a,c,st); p=transport(a,f_ac,spacing); # endpoint blend at half interval, matching production trace semantics
            back,_=estimate(c,a,st); p2=transport(c,back,spacing); pred=(p+p2)/2; truth=b; held.append((pred,truth))
    mags=np.concatenate([np.hypot(v[0],v[1]).ravel() for v in allv]); vars=np.concatenate([np.hypot(np.diff(v[0],axis=1),np.diff(v[1],axis=1)).ravel() for v in allv]); counts={s:sum(d["state"]==s for ds in details_all for row in ds for d in row) for s in ("direct","filled","zero fallback")}; total=len(details_all)*len(details_all[0])*len(details_all[0][0]); nonzero=counts["direct"]+counts["filled"]
    if held:
        lma=[];mma=[];ll=[];ml=[];lf=[];mf=[]
        for pred,t in held:
            linear=(frames[len(lma)]+frames[len(lma)+2])/2; lma.append(float(np.abs(linear-t).mean()));mma.append(float(np.abs(pred-t).mean()));ll.append(float(np.abs(np.log1p(linear)-np.log1p(t)).mean()));ml.append(float(np.abs(np.log1p(pred)-np.log1p(t)).mean()));lf.append(fss(linear,t));mf.append(fss(pred,t))
        heldout={"linearMAE":float(np.mean(lma)),"motionMAE":float(np.mean(mma)),"linearLogMAE":float(np.mean(ll)),"motionLogMAE":float(np.mean(ml)),"linearFSS":float(np.mean(lf)),"motionFSS":float(np.mean(mf))}
    results[str(st)]={"target":target,"wholeAlignment":{"forward":{"transportedLogMAE":float(np.mean(fmae)),"baselineLogMAE":float(np.mean(fbase)),"improvementPct":float(np.mean(fimp)),"rmse":float(np.mean(frms))},"backward":{"transportedLogMAE":float(np.mean(bmae)),"baselineLogMAE":float(np.mean(bbase)),"improvementPct":float(np.mean(bimp)),"rmse":float(np.mean(brms))}},"field":{"counts":counts,"directFraction":counts["direct"]/total,"filledFraction":counts["filled"]/total,"zeroFraction":counts["zero fallback"]/total,"nonzeroFraction":nonzero/total,"magnitudeMedian":float(np.median(mags)),"magnitudeP95":float(np.percentile(mags,95)),"magnitudeP99":float(np.percentile(mags,99)),"magnitudeMax":float(mags.max()),"neighborVariationP95":float(np.percentile(vars,95))},"heldout":heldout}
raw=sum(p.stat().st_size for p in motion_paths);gz=sum(len(gzip.compress(p.read_bytes(),9)) for p in motion_paths)
print(json.dumps({"frozenGeneration":{"id":gid,"path":str(GEN),"source":m["source"].get("filename"),"sequenceStart":m["time"]["timestamps"][0],"sequenceEnd":m["time"]["timestamps"][-1],"frameCount":len(frames),"sourceGrid":[W,H],"motionGrid":[m["motion"]["grid_width"],m["motion"]["grid_height"]]},"parameters":{"spacing":spacing,"blockRadius":4,"searchRadius":8,"varianceThreshold":0.0025,"improvementThreshold":0.08,"fillRadius":4,"strongCellThreshold":strong},"trajectory":[{"timestamp":m["time"]["timestamps"][i],"lon":float(g["longitude_start"]+t["x"]*g["longitude_spacing"]),"lat":float(g["latitude_start"]+t["y"]*g["latitude_spacing"]),"peak":float(t["peak"]),"cells":int(t["cells"])} for i,t in enumerate(tracks)],"results":results,"assets":{"rawBytes":raw,"gzipBytes":gz,"supportAssetUnchanged":True}},indent=2))
