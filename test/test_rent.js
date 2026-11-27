// تست ماژول اجاره: node test/test_rent.js [rent.xlsx]
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const XLSX = require("../vendor/xlsx.full.min.js"), Core = require("../rent-core.js"), P = require("../rent-pricing.js");
const C = {bounds:{south:36.10,north:36.50,west:59.35,east:59.85}};
let fails = 0; const ok = (c,m)=>{ if(c) console.log("  ✓",m); else { console.log("  ✗",m); fails++; } };

console.log("پارسر پول");
const M = Core.money;
ok(M("‏۲,۰۰۰,۰۰۰,۰۰۰ تومان")===2e9,"۲,۰۰۰,۰۰۰,۰۰۰ تومان");
ok(M("۱.۵۰۰ میلیارد")===1.5e9,"۱.۵۰۰ میلیارد");
ok(M("۶۵۰ میلیون")===6.5e8,"۶۵۰ میلیون");
ok(M("رایگان")===0,"رایگان");
ok(M("۱ میلیارد و ۵۰۰ میلیون")===1.5e9,"ترکیبی");
ok(M("")===null && M(null)===null,"خالی");
const d1 = Core.depRent("۱.۵۰۰ میلیارد / ۳ میلیون", null); ok(d1.dep===1.5e9 && d1.rent===3e6,"ودیعه / اجاره");
const d2 = Core.depRent("۳.۷۰۰ میلیارد / رایگان", null); ok(d2.dep===3.7e9 && d2.rent===0,"ودیعه / رایگان");
const d3 = Core.depRent("‏۲,۰۰۰,۰۰۰,۰۰۰ تومان","‏۸۹,۰۰۰,۰۰۰ تومان"); ok(d3.dep===2e9 && d3.rent===89e6,"دو ستون");

console.log("kNN شبکه‌ای در برابر brute-force");
{ let s=12345; const rnd=()=>(s=(s*1664525+1013904223)>>>0)/4294967296;
  const n=3000, xs=new Float64Array(n), ys=new Float64Array(n); for(let i=0;i<n;i++){ xs[i]=rnd()*20; ys[i]=rnd()*20; }
  const ix=P.makeIndex(xs,ys); let bad=0;
  for(let t=0;t<200;t++){ const qx=rnd()*24-2, qy=rnd()*24-2, k=[5,25,100][t%3], skip=t%2?Math.floor(rnd()*n):-1;
    const a=P.knn(ix,qx,qy,k,skip), all=[]; for(let i=0;i<n;i++) if(i!==skip) all.push(Math.hypot(xs[i]-qx,ys[i]-qy)); all.sort((p,q)=>p-q);
    for(let j=0;j<k;j++) if(Math.abs(a.d[j]-all[j])>1e-9){ bad++; break; } }
  ok(bad===0,"۲۰۰ پرسش (داخل و خارج از محدوده، با/بدون skip) دقیقاً برابر");
}

const file = process.argv[2] || "/mnt/user-data/attachments/22735985-3637-5ba3-a938-af4f6790b9da/f7968e07-2divar_rent_ads_master.xlsx";
if(fs.existsSync(file)){
  console.log("فایل واقعی:",path.basename(file));
  const wb = XLSX.read(fs.readFileSync(file),{type:"buffer"}), rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:null,raw:true});
  ok(Core.missingColumns(rows).length===0,"ستون‌های لازم موجود");
  const {list,stats} = Core.buildRent(rows,C); console.log("  آمار:",JSON.stringify(stats));
  ok(stats.rows===159 && list.length===stats.ok,"ردیف‌ها ۱۵۹ و ok=طول فهرست");
  ok(stats.ok>=65 && stats.ok<=80,"قابل‌استفاده با مختصات ≈ ۷۳ (تحلیل پایتون: ۷۳ از ۱۳۷ ردیف تمیز): "+stats.ok);
  ok(stats.noGeo===76,"ردیف بدون مختصات کنار گذاشته می‌شود: "+stats.noGeo);
  ok(stats.placeholder>=10,"اجاره‌ی نمادین شناسایی شد: "+stats.placeholder);
  const t0=Date.now(); const {model,used,dropped} = P.fit(list,0.03); console.log("  fit:",Date.now()-t0,"ms | k =",model.k,"| medAPE(LOO) =",(model.cv.medAPE*100).toFixed(1)+"%","| n =",model.cv.n,"| حذف دورافتاده:",dropped);
  ok(dropped<=8,"دورافتاده‌ی حذف‌شده کم است");
  const prep = P.prepare(model,used), r = P.estimate(model,prep,{lat:36.297,lng:59.606,area:100,deposit:1e9});
  console.log("  مرکز مشهد ۱۰۰ متر، ودیعه ۱ میلیارد:",JSON.stringify({perM2:Math.round(r.perM2),total:Math.round(r.total),rent:Math.round(r.rent),full:Math.round(r.fullDeposit),conf:r.confidence}));
  ok(r.perM2>2e5 && r.perM2<8e5,"اجاره‌ی معادل هر متر در بازه‌ی معقول");
  ok(Math.abs(r.rent-(r.total-0.03*1e9))<1,"اجاره = اجاره‌ی معادل − نرخ×ودیعه");
  ok(Math.abs(r.fullDeposit*0.03-r.total)<1e-6,"رهن کامل × نرخ = اجاره‌ی معادل");
  const r2 = P.estimate(model,prep,{lat:36.297,lng:59.606,area:100,deposit:5e9}); ok(r2.rent===0 && r2.depositCoversAll,"ودیعه‌ی بیش از رهن کامل → اجاره صفر");
  const rr = P.estimate(model,prep,{lat:36.297,lng:59.606,area:100}); ok(rr.rent===undefined,"بدون ودیعه فقط اجاره‌ی معادل");
  // نرخ قابل تنظیم: نرخ دو برابر ⇒ اجاره‌ی معادل بزرگ‌تر
  const m4 = P.fit(list,0.04), p4 = P.prepare(m4.model,m4.used), r4 = P.estimate(m4.model,p4,{lat:36.297,lng:59.606,area:100});
  ok(r4.perM2>rr.perM2,"نرخ ۴٪ ⇒ اجاره‌ی معادل بیشتر از ۳٪ ("+Math.round(r4.perM2)+" > "+Math.round(rr.perM2)+")");
  // سازگاری تخمین کلاینت با LOO: تخمین در محل آگهی (بدون skip) به مقدار واقعی نزدیک‌تر از میانه‌ی کل نیست؛ فقط منطقی بودن
  const A1 = P.estimate(model,prep,{lat:36.297,lng:59.606,area:60}).perM2, A2 = P.estimate(model,prep,{lat:36.297,lng:59.606,area:180}).perM2;
  console.log("  اثر متراژ در یک نقطه: ۶۰ متر",Math.round(A1),"| ۱۸۰ متر",Math.round(A2));
}

console.log("ادغام بدون تکرار و ویژگی‌های اختیاری");
{ const idFor = rows => { const {get} = Core.makeGetter(rows); return r => Core.idOf(r,get); };
  const mk = (id,dep,rent,lat) => ({"شناسه":id,"عنوان":"آپارتمان "+id,"ردیف‌های صفحه (عنوان: مقدار)":"متراژ: ۹۰ / ۱۳۹۸","ودیعه (متن)":dep,"اجاره ماهانه (متن)":rent,"امکانات (مودال)":"آسانسور ندارد | پارکینگ",latitude:lat,longitude:59.6});
  const old = [mk("a1","۵۰۰ میلیون","۱۰ میلیون",36.3), mk("a2","۳۰۰ میلیون","۸ میلیون",36.31)];
  const inc = [mk("a2","۳۰۰ میلیون","۸ میلیون",36.31), mk("b1","۴۰۰ میلیون","۹ میلیون",36.32), mk("b1","۴۰۰ میلیون","۹ میلیون",36.32), {...mk("b2","۱ میلیارد","۵ میلیون",36.33), "ستون تازه":"x"}];
  const m = Core.mergeRows(old, inc, idFor), r = m.report;
  ok(r.added===2 && r.dupExisting===1 && r.inFileDup===1 && r.total===4, "ادغام: ۲ جدید، ۱ تکراری قبلی، ۱ تکراری داخل فایل "+JSON.stringify(r));
  ok(m.rows[0]===old[0] && m.rows.length===4, "ردیف‌های فعلی دست‌نخورده می‌مانند");
  ok(m.headers.includes("ستون تازه"), "ستون تازه به سرستون‌ها اضافه شد");
  const again = Core.mergeRows(m.rows, inc, idFor).report; ok(again.added===0, "ادغام دوباره‌ی همان فایل چیزی اضافه نمی‌کند");
  // نام ستون با ی/ک یا نیم‌فاصله متفاوت به ستون فعلی نگاشت می‌شود
  const alt = Core.mergeRows(old, [{"شناسه":"c1","عنوان":"x","ردیف های صفحه (عنوان: مقدار)":"متراژ: ۸۰ / ۱۴۰۰"}], idFor);
  ok(Object.keys(alt.rows[2]).includes("ردیف‌های صفحه (عنوان: مقدار)") && !alt.headers.includes("ردیف های صفحه (عنوان: مقدار)"), "ستون با فاصله/نیم‌فاصله‌ی متفاوت نگاشت شد");
  const b = Core.buildRent(old, C); ok(b.list[0].e===0 && b.list[0].p===1, "آسانسور ندارد ⇒ e=0 ، پارکینگ ⇒ p=1");
  // رفت‌وبرگشت xlsx
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.rows,{header:m.headers}), "S");
  const back = XLSX.utils.sheet_to_json(XLSX.read(XLSX.write(wb,{type:"buffer",bookType:"xlsx"}),{type:"buffer"}).Sheets.S,{defval:null,raw:true});
  ok(back.length===4 && back[3]["شناسه"]==="b2" && back[0].latitude===36.3, "ذخیره و خواندن دوباره‌ی xlsx ادغام‌شده سالم است");
}
{ const f = P.featAdj({feat:{names:[],year_ref:1405,mu:[0.5,0.3,0.2],g:[-0.2,-0.2,-0.2]}}, {});
  ok(f===0, "ویژگی نامشخص اثری ندارد");
  const m = {feat:{names:[],year_ref:1405,mu:[0.5,0.3,0.2],g:[-0.2,-0.2,-0.2]}};
  ok(P.featAdj(m,{year:1385})<P.featAdj(m,{year:1403}), "ساختمان قدیمی‌تر ارزان‌تر");
  ok(P.featAdj(m,{e:0})<P.featAdj(m,{e:1}), "بدون آسانسور ارزان‌تر"); }

console.log("داده‌ی مصنوعی ۱۰ هزار ردیف (زمان و پایداری)");
{ let s=777; const rnd=()=>(s=(s*1664525+1013904223)>>>0)/4294967296, g=()=>{ let u=0; for(let i=0;i<6;i++) u+=rnd(); return (u-3)/Math.sqrt(.5); };
  const f = {2:0,3:0}; const list=[];
  for(let i=0;i<10000;i++){ const lat=36.297+g()*0.04, lng=59.606+g()*0.05, area=Math.round(40+rnd()*160), loc=Math.exp(12.6+0.8*(lng-59.606)*8+g()*0.12), req=loc*(1+0.002*(area-100))*Math.exp(g()*0.18);
    const full=rnd()<.35, tot=req*area; let dep, rent; if(full){ dep=Math.round(tot/0.03/1e7)*1e7; rent=0; } else { const fr=0.1+rnd()*0.7; dep=Math.round(tot*fr/0.03/1e7)*1e7; rent=Math.max(1e6,tot-0.03*dep); } list.push({id:"s"+i,area,year:1395,dep,rent,lat,lng}); }
  list.push({id:"bad1",area:80,year:1400,dep:8e11,rent:4e6,lat:36.3,lng:59.6}); list.push({id:"bad2",area:90,year:1400,dep:1e9,rent:9e8,lat:36.3,lng:59.6});
  const t0=Date.now(), out=P.fit(list,0.03), ms=Date.now()-t0;
  console.log("  fit ۱۰k:",ms,"ms | k =",out.model.k,"| medAPE =",(out.model.cv.medAPE*100).toFixed(1)+"%","| جدول k:",out.model.cv.table.map(t=>t.k+":"+(t.medAPE*100).toFixed(1)).join(" "));
  ok(ms<30000,"کالیبراسیون ۱۰ هزار ردیف زیر ۳۰ ثانیه");
  ok(out.dropped>=2,"دورافتاده‌های کاشته‌شده حذف شدند ("+out.dropped+")");
  const b = out.model.area_bins.map(x=>x.beta_log); console.log("  ضرایب متراژ:",b.map(v=>v.toFixed(2)).join(","),"(مقدار واقعی تقریبی: -0.30 ... +0.17 از گروه کوچک به بزرگ)");
  ok(b[0]<b[2] && b[2]<b[4] && b[4]<b[6],"backfitting جهت درست اثر متراژ را بازیابی کرد");
  const prep=P.prepare(out.model,out.used); const t1=Date.now(); for(let i=0;i<200;i++) P.estimate(out.model,prep,{lat:36.28+i*1e-4,lng:59.6,area:100}); const q=(Date.now()-t1)/200;
  console.log("  هر تخمین:",q.toFixed(2),"ms"); ok(q<20,"تخمین سمت کاربر سریع است");
}
console.log(fails? "\nشکست: "+fails : "\nهمه‌ی آزمون‌ها گذشت"); process.exit(fails?1:0);
