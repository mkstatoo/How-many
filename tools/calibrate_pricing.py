#!/usr/bin/env python3
"""
Calibrate the property-pricing adjustment model from Divar listings (listings.xlsx).

Usage:  python3 calibrate_pricing.py listings.xlsx out_dir [--current-year 1405] [--k 40] [--boot 120]

Model (log scale, per m2):   log(price_m2_i) = S(location_i) + X_i . beta + noise
  S(.)   : smooth local price level of a *reference* property (tricube-weighted mean of the k nearest
           listings' residuals, leave-one-out), estimated by backfitting together with beta.
  beta   : multiplicative adjustments (area band, age band, rooms, elevator, parking, corner).
Outputs: pricing_model.json, coefficients.csv, cv_metrics.csv, test_vectors.json
Every number comes from the input file; nothing is hard-coded except the model specification.
"""
import sys, re, json, argparse, datetime
import numpy as np, pandas as pd
from scipy.spatial import cKDTree
from sklearn.model_selection import KFold

AREA_BINS=[0,60,75,90,110,130,160,200,401]; AREA_LAB=['<=60','60-75','75-90','90-110','110-130','130-160','160-200','200+']
AGE_BINS=[-1,0,2,5,10,20,100];               AGE_LAB=['0','1-2','3-5','6-10','11-20','21+']
LAT0,LNG0=36.30,59.55
META={}
FA=str.maketrans('۰۱۲۳۴۵۶۷۸۹٫٬','0123456789.,')
num=lambda s: str(s).translate(FA)

# ------------------------------------------------------------------ 1) load + clean
def load_clean(path, current_year):
    log=[]
    raw=pd.read_excel(path); raw.columns=['id','url','title','loc','info','locstr','price','col8','feat','extra','text','road','ocr','lat','lng']
    log.append(('rows in file',len(raw)))
    df=raw.copy(); df['tok']=df.url.str.extract(r'/v/.*/([^/]+)$')[0]
    df=df.drop_duplicates('tok'); log.append(('unique listings (by URL token)',len(df)))
    pp=df.price.map(lambda s:[int(re.sub(r'[^\d]','',num(p)) or 0) for p in str(s).split('|')] if pd.notna(s) else [])
    df['price_total']=[p[0] if len(p)>0 and p[0]>0 else np.nan for p in pp]; df['price_m2_divar']=[p[1] if len(p)>1 and p[1]>0 else np.nan for p in pp]
    def pinfo(s):
        if pd.isna(s): return None
        p=[x.strip() for x in str(s).split('|')]
        if len(p)<5: return None
        a=re.sub(r'[^\d]','',num(p[0])); rest=p[3:]
        yr=p[1]; yv=1369 if yr.startswith('قبل از') else (float(re.sub(r'[^\d]','',num(yr))) if re.sub(r'[^\d]','',num(yr)) else np.nan)
        rm=0.0 if 'بدون' in p[2] else (float(re.sub(r'[^\d]','',num(p[2]))) if re.sub(r'[^\d]','',num(p[2])) else np.nan)
        return dict(area=float(a) if a else np.nan,year=yv,rooms=rm,has_elev_field=int(any(x.startswith('آسانسور') for x in rest)),
                    elevator=int(any(x=='آسانسور' for x in rest)),parking=int(any(x=='پارکینگ' for x in rest)),storage=int(any(x=='انباری' for x in rest)))
    ii=df['info'].map(pinfo); ok=ii.notna(); df=df.join(pd.DataFrame(list(ii[ok]),index=ii[ok].index))
    d=df[df.has_elev_field==1].copy(); log.append(('apartments (elevator field present)',len(d)))
    t=d.title.fillna('').map(num).str.replace('‌',' ',regex=False).str.replace('ي','ی').str.replace('ك','ک')
    bad=r'زمین|باغ|ویلایی|ویلا\b|خانه|منزل|کلنگی|مغازه|تجاری|اداری|سوئیت|سویت|عرصه|پلاک|هوایی|سفت\s*کاری|سفتکاری|پیش\s*فروش|پیش‌فروش|پیشفروش'
    mb=t.str.contains(bad,regex=True); d=d[~mb.values].copy(); t=t[~mb.values]; log.append(('after dropping land/villa/shell/presale titles',len(d)))
    d['tnorm']=t; d=d.dropna(subset=['price_total','area','year','rooms']).copy(); log.append(('complete numeric fields',len(d)))
    d['price_m2']=d.price_total/d.area
    d=d[(d.price_m2/d.price_m2_divar).between(0.97,1.03)].copy(); log.append(('per-m2 consistent with Divar value',len(d)))
    d=d[d.area.between(25,400)].copy(); log.append(('area 25-400 m2',len(d)))
    lp=np.log(d.price_m2); q1,q99=lp.quantile([.01,.99]); d=d[(lp>=q1)&(lp<=q99)].copy(); META['price_per_m2']=[float(np.exp(q1)),float(np.exp(q99))]; log.append((f'trim 1st/99th percentile of price/m2 ({np.exp(q1)/1e6:.0f}-{np.exp(q99)/1e6:.0f} M toman kept)',len(d)))
    d['age']=(current_year-d.year).clip(lower=0); d=d.drop_duplicates(['title','price_total','area','year']).copy(); log.append(('content duplicates removed',len(d)))
    T=d.tnorm
    d['corner']=T.str.contains(r'نبش').astype(int)
    d['urgent']=T.str.contains(r'زیر\s*فی|زیرفی|فوری|پول\s*لازم|قربانی').astype(int)
    d['barter']=T.str.contains(r'تهاتر|معاوضه').astype(int)
    d=d.dropna(subset=['lat','lng']).copy(); log.append(('with coordinates',len(d)))
    xy=to_xy(d.lat.values,d.lng.values); c=np.median(xy,0); d=d[np.hypot(*(xy-c).T)<=25].copy(); log.append(('within 25 km of median centre',len(d)))
    return d,log

def to_xy(lat,lng): return np.c_[(lng-LNG0)*111.32*np.cos(np.radians(LAT0)),(lat-LAT0)*110.57]

# ------------------------------------------------------------------ 2) design matrix
def design(d):
    ab=pd.cut(d.area,AREA_BINS,labels=AREA_LAB).astype(str); ag=pd.cut(d.age,AGE_BINS,labels=AGE_LAB).astype(str); X=pd.DataFrame(index=d.index)
    for l in AREA_LAB:
        if l!='90-110': X['area_'+l]=(ab==l).astype(float)
    for l in AGE_LAB:
        if l!='0': X['age_'+l]=(ag==l).astype(float)
    r=d.rooms.clip(0,4); X['rooms_le1']=(r<=1).astype(float); X['rooms_3']=(r==3).astype(float); X['rooms_4']=(r==4).astype(float)
    X['no_elevator']=1.0-d.elevator; X['no_parking']=1.0-d.parking; X['corner']=d.corner.astype(float)
    X['ctl_urgent']=d.urgent.astype(float); X['ctl_barter']=d.barter.astype(float)
    return X

# ------------------------------------------------------------------ 3) spatial smoother + backfitting
def smooth(tree,pool,xyq,k,self_idx=None,buffer_km=0.0):
    kq=k*6+1 if buffer_km>0 else (k+1 if self_idx is not None else k)
    dist,ii=tree.query(xyq,k=min(kq,tree.n))
    if self_idx is not None:
        m=(ii!=self_idx[:,None]); a=m.all(1); m[a,-1]=False
    else: m=np.ones_like(ii,bool)
    if buffer_km>0: m&=dist>buffer_km
    out=np.full(len(xyq),np.nan); dm_=np.full(len(xyq),np.nan)
    for j in range(len(xyq)):
        idx=np.flatnonzero(m[j])[:k]
        if len(idx)<max(5,k//3): continue
        dj=dist[j,idx]; dm=dj.max()*1.0001+1e-9; w=(1-(dj/dm)**3)**3; w=np.where(w<=0,1e-6,w)
        out[j]=(w*pool[ii[j,idx]]).sum()/w.sum(); dm_[j]=dm
    return out,dm_
def backfit(X,y,xy,k,iters=40,tol=1e-5):
    tree=cKDTree(xy); sid=np.arange(len(y)); Xv=X.values; beta=np.zeros(Xv.shape[1])
    for it in range(iters):
        s,_=smooth(tree,y-Xv@beta,xy,k,sid); ok=~np.isnan(s)
        coef,*_=np.linalg.lstsq(np.c_[np.ones(ok.sum()),Xv[ok]],(y-s)[ok],rcond=None); nb=coef[1:]
        done=np.max(np.abs(nb-beta))<tol; beta=nb
        if done: break
    return beta,it+1
def metrics(yt,yp):
    ok=~np.isnan(yp); e=np.exp(yp[ok]-yt[ok])-1; a=np.abs(e)
    return dict(n=int(ok.sum()),coverage=float(ok.mean()),median_APE=float(np.median(a)),MAPE=float(a.mean()),within10=float((a<=.10).mean()),
                within15=float((a<=.15).mean()),within20=float((a<=.20).mean()),bias_median=float(np.median(e)),
                R2_log=float(1-((yt[ok]-yp[ok])**2).sum()/((yt[ok]-yt[ok].mean())**2).sum()))

# ------------------------------------------------------------------ 4) main
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('xlsx'); ap.add_argument('out'); ap.add_argument('--current-year',type=int,default=1405)
    ap.add_argument('--k',type=int,default=40); ap.add_argument('--boot',type=int,default=120); a=ap.parse_args()
    import os; os.makedirs(a.out,exist_ok=True)
    d,log=load_clean(a.xlsx,a.current_year)
    for l in log: print(f'{l[1]:>7}  {l[0]}')
    xy=to_xy(d.lat.values,d.lng.values); y=np.log(d.price_m2.values); X=design(d); Xv=X.values; K=a.k; cols=list(X.columns)
    beta,its=backfit(X,y,xy,K); print('backfit iterations',its)
    # cluster bootstrap on 1 km cells
    cell=np.floor(xy[:,0]).astype(int)*1000+np.floor(xy[:,1]).astype(int); cells=np.unique(cell); grp={g:np.flatnonzero(cell==g) for g in cells}; rng=np.random.default_rng(7); bs=[]
    for _ in range(a.boot):
        idx=np.concatenate([grp[g] for g in rng.choice(cells,len(cells),replace=True)]); bb,_=backfit(X.iloc[idx],y[idx],xy[idx],K,iters=10,tol=1e-4); bs.append(bb)
    bs=np.array(bs); lo,hi=np.percentile(bs,[2.5,97.5],axis=0)
    coef=pd.DataFrame({'beta_log':beta,'se':bs.std(0),'ci_lo':lo,'ci_hi':hi},index=cols)
    for c_,n_ in [('beta_log','pct'),('ci_lo','pct_lo'),('ci_hi','pct_hi')]: coef[n_]=(np.exp(coef[c_])-1)*100
    coef['significant']=(coef.ci_lo>0)|(coef.ci_hi<0); coef.round(4).to_csv(f'{a.out}/coefficients.csv'); print(coef.round(3).to_string())
    # cross-validation: 5-fold; base for each held-out listing computed only from training listings
    kf=KFold(5,shuffle=True,random_state=3); P={n:np.full(len(d),np.nan) for n in ['A_normalised_base','A_buffer150m','A_buffer300m','B_raw_base','current_app_naive']}; dens=np.full(len(d),np.nan); price=d.price_m2.values
    for tr,te in kf.split(xy):
        b,_=backfit(X.iloc[tr],y[tr],xy[tr],K); tree=cKDTree(xy[tr]); r=y[tr]-Xv[tr]@b
        s,h=smooth(tree,r,xy[te],K); P['A_normalised_base'][te]=s+Xv[te]@b; dens[te]=h
        for nm,bf in [('A_buffer150m',.15),('A_buffer300m',.30)]: s2,_=smooth(tree,r,xy[te],K,buffer_km=bf); P[nm][te]=s2+Xv[te]@b
        sa,_=smooth(tree,price[tr],xy[te],K); P['current_app_naive'][te]=np.log(sa)                          # arithmetic neighbour mean = what the app shows today
        sa_tr,_=smooth(tree,price[tr],xy[tr],K,np.arange(len(tr))); off=np.nanmedian(y[tr]-np.log(sa_tr)-Xv[tr]@b)    # offset learnt on training only
        P['B_raw_base'][te]=np.log(sa)+Xv[te]@b+off
    M={k_:metrics(y,v) for k_,v in P.items()}; tab=pd.DataFrame(M).T; tab.round(4).to_csv(f'{a.out}/cv_metrics.csv'); print(tab.round(3).to_string())
    def band(e,h):
        ok=~np.isnan(e); t=pd.qcut(h[ok],3,labels=['dense','mid','sparse']); out={}
        for n_ in ['dense','mid','sparse']:
            ee=e[ok][t==n_]; out[n_]=dict(q10=float(np.percentile(ee,10)),q90=float(np.percentile(ee,90)),max_dk_km=float(h[ok][t==n_].max()),n=int(len(ee)))
        qq=np.percentile(e[ok],[10,90]); out['all']=dict(q10=float(qq[0]),q90=float(qq[1]),coverage80=float(np.mean((e[ok]>=qq[0])&(e[ok]<=qq[1]))))
        return out
    bandA=band(y-P['A_normalised_base'],dens); bandB=band(y-P['B_raw_base'],dens)
    # final mode-B offset on full data
    tree=cKDTree(xy); sa_all,_=smooth(tree,price,xy,K,np.arange(len(d))); offB=float(np.nanmedian(y-np.log(sa_all)-Xv@beta))
    # ---------- model json
    def eff(name): return dict(beta_log=float(coef.loc[name,'beta_log']),pct=float(coef.loc[name,'pct']),ci_pct=[float(coef.loc[name,'pct_lo']),float(coef.loc[name,'pct_hi'])])
    model=dict(version=1,created=datetime.date.today().isoformat(),source='Divar asking prices (listings file)',price_unit='toman per m2 (asking price)',
      calibration=dict(n_rows=int(len(d)),current_persian_year=a.current_year,pipeline=[dict(step=l[0],rows=l[1]) for l in log],
                       caution='asking prices, not transaction prices; level inherits the asking-price premium'),
      reference_property=dict(area_m2_band='90-110',age_years=0,rooms=2,elevator=True,parking=True,corner=False,
                              note='S(location) is the price/m2 of this reference property. Adjustment = exp(sum of beta for every feature that differs).'),
      smoother=dict(k=K,kernel='tricube',weight='(1-(d/dmax)^3)^3',dmax='distance of k-th neighbour *1.0001',projection=dict(lat0=LAT0,lng0=LNG0,formula='x=(lng-lng0)*111.32*cos(lat0), y=(lat-lat0)*110.57 (km)'),
                    leave_one_out_for_listings_in_pool=True),
      area_bins=[dict(label=l,lo=AREA_BINS[i],hi=AREA_BINS[i+1],beta_log=(0.0 if l=='90-110' else float(coef.loc['area_'+l,'beta_log']))) for i,l in enumerate(AREA_LAB)],
      age_bins=[dict(label=l,lo=AGE_BINS[i]+1,hi=AGE_BINS[i+1],beta_log=(0.0 if l=='0' else float(coef.loc['age_'+l,'beta_log']))) for i,l in enumerate(AGE_LAB)],
      rooms=dict(le1=eff('rooms_le1'),r2=dict(beta_log=0.0,pct=0.0),r3=eff('rooms_3'),r4plus=eff('rooms_4')),
      features=dict(no_elevator=eff('no_elevator'),no_parking=eff('no_parking'),corner=eff('corner')),
      listing_controls=dict(urgent_sale=eff('ctl_urgent'),barter=eff('ctl_barter'),note='used only to clean neighbour listings (urgent/barter titles); not user inputs'),
      effects_pct={n:eff(n) for n in cols},
      interval_log_residual_A=bandA,interval_log_residual_B=bandB,mode_B_log_offset=offB,
      validation={k_:{kk:round(vv,4) for kk,vv in v.items()} for k_,v in M.items()},
      confidence_rules=dict(dense_km=bandA['dense']['max_dk_km'],mid_km=bandA['mid']['max_dk_km'],low_confidence_if_dmax_km_above=2.0),
      valid_input_range=dict(area_m2=[25,400],price_per_m2_pool=META['price_per_m2']),
      ask_to_deal_factor=1.0)
    json.dump(model,open(f'{a.out}/pricing_model.json','w'),ensure_ascii=False,indent=1)
    # ---------- test vectors for the JS port (Python reference prediction using pool = all rows, LOO)
    s_all,dk=smooth(tree,y-Xv@beta,xy,K,np.arange(len(d)))
    rng=np.random.default_rng(11); pick=rng.choice(len(d),250,replace=False)
    lst=lambda i: dict(lat=float(d.lat.iloc[i]),lng=float(d.lng.iloc[i]),pricePerM2=float(price[i]),area=float(d.area.iloc[i]),age=int(d.age.iloc[i]),rooms=int(d.rooms.iloc[i]),
                       elevator=int(d.elevator.iloc[i]),parking=int(d.parking.iloc[i]),corner=int(d.corner.iloc[i]),urgent=int(d.urgent.iloc[i]),barter=int(d.barter.iloc[i]))
    pool=[lst(i) for i in range(len(d))]
    tv=dict(pool=pool,cases=[dict(index=int(i),expected_log_base=float(s_all[i]),expected_log_pred=float(s_all[i]+Xv[i]@beta),expected_dmax_km=float(dk[i])) for i in pick])
    json.dump(tv,open(f'{a.out}/test_vectors.json','w'))
    print('wrote',a.out)
main()
