/*
 * مدل اجاره‌بها. هم در Node (کالیبراسیون هنگام بارگذاری داده) و هم در مرورگر (تخمین) اجرا می‌شود.
 *
 * اجاره‌ی معادل   Req = اجاره‌ی ماهانه + نرخ × ودیعه            (نرخ = سهم ماهانه‌ی ودیعه، مثلاً ۰٫۰۳ یعنی هر ۱ میلیارد ≈ ۳۰ میلیون)
 * مدل             ln(Req / متراژ) = S(مکان) + f(گروه متراژ)
 *   S: میانگین وزن‌دار (tricube) k همسایه‌ی نزدیک؛ f: ضریب گروه متراژ نسبت به ملک مرجع (۹۰ تا ۱۱۰ متر)؛ هر دو با backfitting
 * k از روی خود داده انتخاب می‌شود (leave-one-out) و بازه‌ی خطا (۸۰٪) از باقی‌مانده‌ها به تفکیک تراکم نمونه ساخته می‌شود.
 * شعاع ثابت وجود ندارد: پهنای همسایگی خودکار با k و تراکم داده تعیین می‌شود.
 */
(function(root,factory){ if(typeof module==="object"&&module.exports) module.exports=factory(); else root.RentPricing=factory(); })(typeof self!=="undefined"?self:this,function(){
"use strict";
const AREA_EDGES = [25,50,70,90,110,130,160,200,400];        // گروه‌های (lo,hi]
const REF_BIN = 3;                                          // (۹۰,۱۱۰] = ملک مرجع
const K_GRID = [10,15,25,40,60,100,150];
const HARD_REQ = [3e4, 1e7];                                // اجاره‌ی معادل هر متر در ماه (تومان): خارج از این بازه خطای داده است
const MAD_K = 4.5, RIDGE = 3, MIN_N = 30, CELL_KM = 1;
const median = a => { const s = Float64Array.from(a).sort(); const n = s.length; return n ? (n%2 ? s[(n-1)>>1] : (s[n/2-1]+s[n/2])/2) : NaN; };
const quant = (a,q) => { const s = Float64Array.from(a).sort(); if(!s.length) return NaN; const p = (s.length-1)*q, i = Math.floor(p); return s[i] + (s[Math.min(i+1,s.length-1)]-s[i])*(p-i); };

function binOf(area){ for(let b=0;b<AREA_EDGES.length-1;b++) if(area<=AREA_EDGES[b+1]) return b; return AREA_EDGES.length-2; }
function toXY(proj, lat, lng){ return [(lng-proj.lng0)*111.32*Math.cos(proj.lat0*Math.PI/180), (lat-proj.lat0)*110.57]; }
const eqRent = (l, rate) => l.rent + rate*l.dep;

/* ---------- ویژگی‌های اختیاری (از آزمون اعتبارسنجی متقابل روی داده‌ی واقعی: سن بنا، بدون آسانسور، بدون پارکینگ) ----------
   نامشخص = ۰ بعد از مرکزی‌سازی، یعنی اثری ندارد. سن: به‌ازای ۱۰ سال (۰ تا ۴۰ سال). */
const NF = 3, FEAT_NAMES = ["age10","no_elevator","no_parking"], AGE_CAP = 40;
function persianYear(d){ d = d||new Date(); const g = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate(); return g - 621 - ((m<2 || (m===2 && day<21)) ? 1 : 0); }
/** مقدار خام ویژگی‌ها؛ NaN = نامشخص. l.e و l.p: ۱ دارد، ۰ ندارد */
function featRaw(l, yr){
  const y = l.year!=null ? l.year : l.y;
  return [ y>=1300 && y<=yr+1 ? Math.min(Math.max(yr-y,0),AGE_CAP)/10 : NaN,
           l.e===0 ? 1 : l.e===1 ? 0 : NaN,
           l.p===0 ? 1 : l.p===1 ? 0 : NaN ];
}
const featCentered = (raw, mu) => raw.map((v,j)=> isNaN(v) ? 0 : v-mu[j]);

/* ---------- شاخص شبکه‌ای برای k نزدیک‌ترین همسایه (دقیق، بدون مرتب‌کردن کل داده) ---------- */
function makeIndex(xs, ys){
  const n = xs.length; let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
  for(let i=0;i<n;i++){ if(xs[i]<x0) x0=xs[i]; if(xs[i]>x1) x1=xs[i]; if(ys[i]<y0) y0=ys[i]; if(ys[i]>y1) y1=ys[i]; }
  const W = Math.max(1, Math.floor((x1-x0)/CELL_KM)+1), H = Math.max(1, Math.floor((y1-y0)/CELL_KM)+1);
  const cellOf = new Int32Array(n), start = new Int32Array(W*H+1);
  for(let i=0;i<n;i++){ const c = Math.floor((ys[i]-y0)/CELL_KM)*W + Math.floor((xs[i]-x0)/CELL_KM); cellOf[i]=c; start[c+1]++; }
  for(let c=0;c<W*H;c++) start[c+1]+=start[c];
  const fill = start.slice(0,W*H), items = new Int32Array(n);
  for(let i=0;i<n;i++) items[fill[cellOf[i]]++] = i;
  return {xs, ys, x0, y0, W, H, start, items};
}
/** k نزدیک‌ترین نقطه به (qx,qy)؛ skip = اندیس حذف‌شونده (برای leave-one-out). خروجی: {idx:Int32Array, d:Float64Array} مرتب‌شده */
function knn(ix, qx, qy, k, skip){
  const {xs, ys, x0, y0, W, H, start, items} = ix;
  const cx = Math.floor((qx-x0)/CELL_KM), cy = Math.floor((qy-y0)/CELL_KM);
  const ci = [], cd = [];
  const maxR = W + H + Math.abs(cx) + Math.abs(cy) + 2;
  const addCell = (gx,gy)=>{ if(gx<0||gy<0||gx>=W||gy>=H) return; const c = gy*W+gx;
    for(let p=start[c]; p<start[c+1]; p++){ const i = items[p]; if(i===skip) continue; const dx=xs[i]-qx, dy=ys[i]-qy; ci.push(i); cd.push(Math.sqrt(dx*dx+dy*dy)); } };
  for(let r=0; r<=maxR; r++){
    if(r===0) addCell(cx,cy);
    else{ for(let gx=cx-r; gx<=cx+r; gx++){ addCell(gx,cy-r); addCell(gx,cy+r); } for(let gy=cy-r+1; gy<=cy+r-1; gy++){ addCell(cx-r,gy); addCell(cx+r,gy); } }
    if(ci.length>=k){                                            // همه‌ی نقاط تا فاصله‌ی r×CELL از q دیده شده‌اند
      const sorted = Float64Array.from(cd).sort();
      if(sorted[k-1] <= r*CELL_KM) break;
    }
  }
  const m = ci.length, order = Array.from({length:m},(_,i)=>i).sort((a,b)=>cd[a]-cd[b]), kk = Math.min(k,m);
  const idx = new Int32Array(kk), d = new Float64Array(kk);
  for(let j=0;j<kk;j++){ idx[j]=ci[order[j]]; d[j]=cd[order[j]]; }
  return {idx, d};
}
/** وزن‌های tricube برای همسایه‌های مرتب‌شده (مثل ماژول فروش: dmax = فاصله‌ی k‌ام) */
function weights(d){
  const kk = d.length, dmax = d[kk-1]*1.0001 + 1e-9, w = new Float64Array(kk);
  for(let j=0;j<kk;j++){ let v = Math.pow(1-Math.pow(d[j]/dmax,3),3); if(!(v>0)) v = 1e-6; w[j]=v; }
  return {w, dmax};
}
const minNeighbours = k => Math.max(5, Math.floor(k/3));

/* ---------- حداقل مربعات با ریج برای ضرایب گروه متراژ ---------- */
function solve(A, b){                                        // حذف گاوسی با محور جزئی؛ ماتریس کوچک (≤ ۹×۹)
  const n = b.length, M = A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<n;c++){
    let p=c; for(let r=c+1;r<n;r++) if(Math.abs(M[r][c])>Math.abs(M[p][c])) p=r;
    [M[c],M[p]]=[M[p],M[c]]; const d = M[c][c] || 1e-12;
    for(let r=c+1;r<n;r++){ const f = M[r][c]/d; for(let j=c;j<=n;j++) M[r][j]-=f*M[c][j]; }
  }
  const x = new Array(n).fill(0);
  for(let r=n-1;r>=0;r--){ let s=M[r][n]; for(let j=r+1;j<n;j++) s-=M[r][j]*x[j]; x[r]=s/(M[r][r]||1e-12); }
  return x;
}
function fitTerms(res, bins, valid, X){                      // res = y − S ؛ بازگشت: beta هر گروه متراژ (مرجع = ۰) و ضرایب ویژگی‌ها g
  const B = AREA_EDGES.length-1, cols = []; for(let b=0;b<B;b++) if(b!==REF_BIN) cols.push(b);
  const m = cols.length+1+NF, A = Array.from({length:m},()=>new Float64Array(m)), rhs = new Float64Array(m);
  for(let i=0;i<res.length;i++){
    if(!valid[i]) continue;
    const row = new Float64Array(m); row[0]=1; const ci = cols.indexOf(bins[i]); if(ci>=0) row[ci+1]=1;
    for(let j=0;j<NF;j++) row[cols.length+1+j] = X[i*NF+j];
    for(let a=0;a<m;a++){ if(!row[a]) continue; rhs[a]+=row[a]*res[i]; for(let c=0;c<m;c++) if(row[c]) A[a][c]+=row[a]*row[c]; }
  }
  for(let a=1;a<m;a++) A[a][a]+=RIDGE;
  const x = solve(A.map(r=>Array.from(r)), Array.from(rhs)), beta = new Array(B).fill(0);
  cols.forEach((b,j)=>beta[b]=x[j+1]);
  return {beta, g:x.slice(cols.length+1)};
}

/** آماده‌سازی: حذف دورافتاده‌ها، تبدیل به y = ln(Req/متراژ) */
function prepareList(list, rate){
  const rows = [];
  for(const l of list){ const req = eqRent(l,rate)/l.area; if(req>=HARD_REQ[0] && req<=HARD_REQ[1]) rows.push({l, y:Math.log(req)}); }
  const med = median(rows.map(r=>r.y)), mad = median(rows.map(r=>Math.abs(r.y-med)))*1.4826 || 0.3;
  const kept = rows.filter(r=>Math.abs(r.y-med) <= MAD_K*mad);
  return {kept, dropped:list.length-kept.length};
}

/** کالیبراسیون کامل. rate = سهم ماهانه‌ی ودیعه (مثلاً ۰٫۰۳). */
function fit(list, rate, opts){
  opts = opts || {};
  if(!(rate>0 && rate<=0.2)) throw new Error("نرخ تبدیل نامعتبر است");
  const {kept, dropped} = prepareList(list, rate), n = kept.length;
  if(n<MIN_N) throw new Error("آگهی قابل استفاده برای مدل اجاره کم است ("+n+" از حداقل "+MIN_N+")");
  const lat0 = kept.reduce((s,r)=>s+r.l.lat,0)/n, lng0 = kept.reduce((s,r)=>s+r.l.lng,0)/n, proj = {lat0, lng0};
  const xs = new Float64Array(n), ys = new Float64Array(n), y = new Float64Array(n), bin = new Int32Array(n);
  kept.forEach((r,i)=>{ const p = toXY(proj,r.l.lat,r.l.lng); xs[i]=p[0]; ys[i]=p[1]; y[i]=r.y; bin[i]=binOf(r.l.area); });
  const ix = makeIndex(xs,ys);
  const yr = persianYear(), raw = kept.map(r=>featRaw(r.l,yr)), mu = [0,1,2].map(j=>{ const v = raw.map(r=>r[j]).filter(x=>!isNaN(x)); return v.length ? v.reduce((s,x)=>s+x,0)/v.length : 0; });
  const X = new Float64Array(n*NF); raw.forEach((r,i)=>{ const c = featCentered(r,mu); for(let j=0;j<NF;j++) X[i*NF+j]=c[j]; });
  const nKnown = [0,1,2].map(j=>raw.filter(r=>!isNaN(r[j])).length);
  const gx = i => { let s=0; for(let j=0;j<NF;j++) s+=g[j]*X[i*NF+j]; return s; };
  const ks = K_GRID.filter(k=>k<=Math.floor(n*0.6) && k>=8); if(!ks.length) ks.push(Math.max(3, Math.floor(n/2)));
  const B = AREA_EDGES.length-1;
  let f = new Array(B).fill(0), g = new Array(NF).fill(0);

  // همسایه‌های leave-one-out برای هر k یک‌بار حساب می‌شوند؛ تکرارهای backfitting فقط جمع وزن‌دار می‌گیرند
  function neighbours(k){
    const NB = new Array(n), mn = minNeighbours(k);
    for(let i=0;i<n;i++){ const {idx,d} = knn(ix,xs[i],ys[i],k,i); if(idx.length>=mn){ const {w,dmax} = weights(d); NB[i] = {idx,w,dmax}; } else NB[i] = null; }
    return NB;
  }
  function backfit(NB, iters){
    const z = new Float64Array(n), S = new Float64Array(n), valid = new Uint8Array(n), res = new Float64Array(n);
    for(let it=0; it<iters; it++){
      for(let i=0;i<n;i++) z[i] = y[i]-f[bin[i]]-gx(i);
      for(let i=0;i<n;i++){ const nb = NB[i]; if(!nb){ S[i]=NaN; valid[i]=0; continue; }
        let sw=0, sv=0; for(let j=0;j<nb.idx.length;j++){ sw+=nb.w[j]; sv+=nb.w[j]*z[nb.idx[j]]; } S[i]=sv/sw; valid[i]=1; res[i]=y[i]-S[i]; }
      const t = fitTerms(res,bin,valid,X); f = t.beta; g = t.g;
    }
    for(let i=0;i<n;i++) z[i] = y[i]-f[bin[i]]-gx(i);
    for(let i=0;i<n;i++){ const nb = NB[i]; if(!nb){ S[i]=NaN; continue; } let sw=0, sv=0; for(let j=0;j<nb.idx.length;j++){ sw+=nb.w[j]; sv+=nb.w[j]*z[nb.idx[j]]; } S[i]=sv/sw; }
    return S;
  }
  const medAPE = (S)=>{ const e=[]; for(let i=0;i<n;i++) if(isFinite(S[i])) e.push(Math.abs(Math.exp(S[i]+f[bin[i]]+gx(i)-y[i])-1)); return median(e); };

  const table = [];
  for(const k of ks){ const NB = neighbours(k), S = backfit(NB, table.length ? 3 : 5); table.push({k, medAPE:medAPE(S), f:f.slice(), g:g.slice(), NB, S}); }
  let best = Math.min(...table.map(t=>t.medAPE));
  let pick = table.filter(t=>t.medAPE<=best*1.01).pop();      // بزرگ‌ترین k که حداکثر ۱٪ از بهترین بدتر است: هموارتر و پایدارتر
  if(opts.k){ pick = table.find(t=>t.k===opts.k) || pick; }
  f = pick.f.slice(); g = pick.g.slice();
  const S = backfit(pick.NB, 3);                                 // ضرایب نهایی با همان k
  const e = [], dm = [];
  for(let i=0;i<n;i++) if(isFinite(S[i])){ e.push(y[i]-(S[i]+f[bin[i]]+gx(i))); dm.push(pick.NB[i].dmax); }
  const t1 = quant(dm,1/3), t2 = quant(dm,2/3), t90 = quant(dm,.9);
  const band = arr => arr.length>=30 ? {q10:quant(arr,.1), q90:quant(arr,.9)} : null;
  const all = band(e) || {q10:-0.3,q90:0.3};
  const byClass = {dense:[],mid:[],sparse:[]};
  e.forEach((v,i)=>byClass[dm[i]<=t1?"dense":dm[i]<=t2?"mid":"sparse"].push(v));
  const model = {
    v:2, built:new Date().toISOString(), rate, k:pick.k, proj,
    area_bins: f.map((beta,b)=>({lo:AREA_EDGES[b], hi:AREA_EDGES[b+1], beta_log:beta})), ref_bin:REF_BIN,
    feat:{names:FEAT_NAMES, year_ref:yr, mu, g, known:nKnown, age_cap:AGE_CAP},
    valid_area:[AREA_EDGES[0], AREA_EDGES[AREA_EDGES.length-1]],
    density:{dense_km:t1, mid_km:t2, low_confidence_km:Math.max(t90, 3)},
    interval:{dense:band(byClass.dense)||all, mid:band(byClass.mid)||all, sparse:band(byClass.sparse)||all},
    cv:{n, medAPE:pick.medAPE, rmse_log:Math.sqrt(e.reduce((s,v)=>s+v*v,0)/e.length), q10:all.q10, q90:all.q90,
        table:table.map(t=>({k:t.k, medAPE:t.medAPE}))}
  };
  return {model, used:kept.map(r=>r.l), dropped};
}

/* ---------- تخمین (سمت کاربر) ---------- */
/** اثر ویژگی‌های اختیاری روی ln(قیمت هر متر)؛ ویژگی نامشخص اثری ندارد. مدل نسخه‌ی ۱ ویژگی ندارد. */
function featAdj(model, o){
  const F = model.feat; if(!F) return 0;
  const c = featCentered(featRaw(o, F.year_ref), F.mu); let s = 0; for(let j=0;j<NF;j++) s += F.g[j]*c[j]; return s;
}
function prepare(model, list){
  const n = list.length, xs = new Float64Array(n), ys = new Float64Array(n), vals = new Float64Array(n);
  for(let i=0;i<n;i++){ const l = list[i], p = toXY(model.proj,l.lat,l.lng); xs[i]=p[0]; ys[i]=p[1];
    vals[i] = Math.log(eqRent(l,model.rate)/l.area) - model.area_bins[binOf(l.area)].beta_log - featAdj(model, l); }
  return {ix:makeIndex(xs,ys), vals, n};
}
function smoothAt(model, prep, lat, lng){
  const q = toXY(model.proj,lat,lng), k = Math.min(model.k, prep.n), {idx,d} = knn(prep.ix,q[0],q[1],k,-1);
  if(idx.length<minNeighbours(model.k)) return {value:NaN, dmax:NaN, k:idx.length};
  const {w,dmax} = weights(d); let sw=0, sv=0; for(let j=0;j<idx.length;j++){ sw+=w[j]; sv+=w[j]*prep.vals[idx[j]]; }
  return {value:sv/sw, dmax:d[d.length-1], k:idx.length};
}
/** input: {lat,lng,area,deposit?, year?(سال ساخت شمسی), elevator?, parking?(true/false؛ نامشخص = حذف)}  → اجاره‌ی معادل (بدون ودیعه) و اجاره با ودیعه‌ی داده‌شده، رهن کامل معادل، بازه‌ی ۸۰٪ */
function estimate(model, prep, input, smoothed){
  const s = smoothed || smoothAt(model,prep,input.lat,input.lng);
  if(!isFinite(s.value)) return {error:"NOT_ENOUGH_LISTINGS"};
  const area = input.area, warnings = [];
  if(!(area>=model.valid_area[0] && area<=model.valid_area[1])) warnings.push("area_out_of_range");
  const fa = featAdj(model, {year:input.year, e:input.elevator==null?undefined:(input.elevator?1:0), p:input.parking==null?undefined:(input.parking?1:0)});
  const lp = s.value + model.area_bins[binOf(Math.min(Math.max(area,model.valid_area[0]),model.valid_area[1]))].beta_log + fa;
  const cls = s.dmax<=model.density.dense_km ? "dense" : s.dmax<=model.density.mid_km ? "mid" : "sparse", band = model.interval[cls];
  if(s.dmax>model.density.low_confidence_km) warnings.push("few_nearby");
  const rate = model.rate, perM2 = Math.exp(lp), total = perM2*area, low = Math.exp(lp+band.q10)*area, high = Math.exp(lp+band.q90)*area;
  const out = {perM2, total, low, high, fullDeposit:total/rate, fullDepositLow:low/rate, fullDepositHigh:high/rate, rate, confidence:cls, dmaxKm:s.dmax, neighbours:s.k, warnings};
  const dep = input.deposit;
  if(dep>=0){
    const cut = rate*dep;
    out.deposit = dep; out.rent = Math.max(0,total-cut); out.rentLow = Math.max(0,low-cut); out.rentHigh = Math.max(0,high-cut);
    out.depositCoversAll = cut>=total;                          // ودیعه از رهن کامل معادل بیشتر است
  }
  return out;
}

return {fit, featAdj, featRaw, persianYear, prepare, estimate, smoothAt, prepareList, makeIndex, knn, weights, binOf, toXY, AREA_EDGES, REF_BIN, K_GRID, HARD_REQ};
});
