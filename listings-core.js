// منطق مشترک خواندن و اعتبارسنجی آگهی‌ها؛ هم اپ، هم پنل مدیر، هم تست‌ها از همین استفاده می‌کنند.
(function(root,factory){ if(typeof module==="object"&&module.exports) module.exports=factory(); else root.ListingsCore=factory(); })(typeof self!=="undefined"?self:this,function(){
"use strict";
const digits = s => String(s).replace(/[۰-۹]/g,c=>"۰۱۲۳۴۵۶۷۸۹".indexOf(c)).replace(/[٠-٩]/g,c=>"٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/[٬،]/g,",");
const clean = s => String(s==null?"":s).replace(/[‌‏‎]/g,"").replace(/ي/g,"ی").replace(/ك/g,"ک").trim();
const empty = v => v==null || clean(v)==="" || clean(v).toUpperCase()==="N/A";
const nums = s => (digits(s).match(/\d[\d,]*(?:\.\d+)?/g)||[]).map(x=>Number(x.replace(/,/g,"")));

// طبقه‌بندی آپارتمان و ویژگی‌های مدل قیمت‌گذاری. باید با calibrate_pricing.py یکی بماند.
const normTitle = s => String(s==null?"":s).replace(/[۰-۹]/g,c=>"۰۱۲۳۴۵۶۷۸۹".indexOf(c)).replace(/[\u200c]/g," ").replace(/ي/g,"ی").replace(/ك/g,"ک");
const NON_APT = /زمین|باغ|ویلایی|ویلا(?![\u0600-\u06FFA-Za-z0-9_])|خانه|منزل|کلنگی|مغازه|تجاری|اداری|سوئیت|سویت|عرصه|پلاک|هوایی|سفت\s*کاری|سفتکاری|پیش\s*فروش|پیش‌فروش|پیشفروش/;
const RE_CORNER = /نبش/, RE_URGENT = /زیر\s*فی|زیرفی|فوری|پول\s*لازم|قربانی/, RE_BARTER = /تهاتر|معاوضه/;
const POOL_AREA = [25,400];

const COL = { url:"url", title:"عنوان", info:"اطلاعات", price:"قیمت", street:"نزدیک‌ترین معبر", lat:"latitude", lng:"longitude" };

function buildListings(rows, C){
  const stats = {rows:rows.length, ok:0, noGeo:0, noYear:0, noPrice:0, mismatch:0, outside:0, dup:0};
  const keyMap = {};
  if(rows.length){ for(const k of Object.keys(rows[0])) keyMap[clean(k).toLowerCase()] = k; }
  const g = (r,name) => r[ keyMap[clean(name).toLowerCase()] ];
  const seen = new Set(), contentSeen = new Set(), tokSeen = new Set(), out = [];
  const B = C.bounds;
  for(const r of rows){
    const url = g(r,COL.url);
    const id = empty(url) ? null : String(url);
    // برای مدل قیمت‌گذاری: همان آگهی با اسلاگ متفاوت (توکن انتهای لینک یکی) فقط یک‌بار شمرده می‌شود؛ مثل calibrate_pricing.py
    const tok = id ? id.split("/").pop() : null, firstTok = !tok || !tokSeen.has(tok); if(tok) tokSeen.add(tok);
    if(id){ if(seen.has(id)){stats.dup++; continue;} seen.add(id); }
    const info = g(r,COL.info), pr = g(r,COL.price);
    const lat = Number(g(r,COL.lat)), lng = Number(g(r,COL.lng));
    if(empty(g(r,COL.lat)) || empty(g(r,COL.lng)) || !isFinite(lat) || !isFinite(lng)){ stats.noGeo++; continue; }
    if(lat<B.south||lat>B.north||lng<B.west||lng>B.east){ stats.outside++; continue; }
    if(empty(info)){ stats.noYear++; continue; }               // زمین و آگهی‌های بدون سال ساخت
    const parts = digits(info).split("|").map(x=>x.trim());
    const area = nums(parts[0])[0], year = nums(parts[1]||"")[0];
    if(!(area>=10&&area<=5000) || !(year>=1300&&year<=1450)){ stats.noYear++; continue; }
    if(empty(pr)){ stats.noPrice++; continue; }
    const pn = nums(pr); const total = pn[0], per = pn[1];
    if(!(total>0) || !(per>0)){ stats.noPrice++; continue; }
    if(Math.abs(total/area/per-1) > C.maxPriceMismatch){ stats.mismatch++; continue; }
    const st = g(r,COL.street);
    // --- ویژگی‌های مدل قیمت‌گذاری (فقط آپارتمان‌ها: ستون اطلاعات فیلد آسانسور دارد)
    const rest = parts.slice(3), hasElev = parts.length>=5 && rest.some(x=>x.startsWith("آسانسور"));
    const rawTitle = g(r,COL.title), tn = normTitle(empty(rawTitle)?"":rawTitle);
    const roomTok = parts[2]||"", rooms = roomTok.includes("بدون") ? 0 : nums(roomTok)[0];
    let apt = firstTok && hasElev && !NON_APT.test(tn) && isFinite(rooms) && area>=POOL_AREA[0] && area<=POOL_AREA[1];
    if(apt){ const ck = tn+"|"+total+"|"+area+"|"+year; if(contentSeen.has(ck)) apt=false; else contentSeen.add(ck); }
    const L = {id,url:id,title:clean(rawTitle),area,year,total,per,lat,lng,street:empty(st)?"":clean(st)};
    if(apt){ L.apt=1; L.rooms=rooms; L.elev=rest.includes("آسانسور")?1:0; L.park=rest.includes("پارکینگ")?1:0;
      L.corner=RE_CORNER.test(tn)?1:0; L.urgent=RE_URGENT.test(tn)?1:0; L.barter=RE_BARTER.test(tn)?1:0; }
    out.push(L);
    stats.ok++;
  }
  return {list:out, stats};
}

async function readRows(buf, name, XLSX){
  if(/\.json$/i.test(name)){
    const j = JSON.parse(new TextDecoder().decode(buf));
    return Array.isArray(j) ? j : (j.rows||j.data||[]);
  }
  const wb = XLSX.read(buf,{type:"array"});
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:null,raw:true});
}


return {buildListings, readRows, clean, digits, nums, empty};
});
