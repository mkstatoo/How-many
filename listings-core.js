// منطق مشترک خواندن و اعتبارسنجی آگهی‌ها؛ هم اپ، هم پنل مدیر، هم تست‌ها از همین استفاده می‌کنند.
(function(root,factory){ if(typeof module==="object"&&module.exports) module.exports=factory(); else root.ListingsCore=factory(); })(typeof self!=="undefined"?self:this,function(){
"use strict";
const digits = s => String(s).replace(/[۰-۹]/g,c=>"۰۱۲۳۴۵۶۷۸۹".indexOf(c)).replace(/[٠-٩]/g,c=>"٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/[٬،]/g,",");
const clean = s => String(s==null?"":s).replace(/[‌‏‎]/g,"").replace(/ي/g,"ی").replace(/ك/g,"ک").trim();
const empty = v => v==null || clean(v)==="" || clean(v).toUpperCase()==="N/A";
const nums = s => (digits(s).match(/\d[\d,]*(?:\.\d+)?/g)||[]).map(x=>Number(x.replace(/,/g,"")));

const COL = { url:"url", title:"عنوان", info:"اطلاعات", price:"قیمت", street:"نزدیک‌ترین معبر", lat:"latitude", lng:"longitude" };

function buildListings(rows, C){
  const stats = {rows:rows.length, ok:0, noGeo:0, noYear:0, noPrice:0, mismatch:0, outside:0, dup:0};
  const keyMap = {};
  if(rows.length){ for(const k of Object.keys(rows[0])) keyMap[clean(k).toLowerCase()] = k; }
  const g = (r,name) => r[ keyMap[clean(name).toLowerCase()] ];
  const seen = new Set(), out = [];
  const B = C.bounds;
  for(const r of rows){
    const url = g(r,COL.url);
    const id = empty(url) ? null : String(url);
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
    out.push({id,url:id,title:clean(g(r,COL.title)),area,year,total,per,lat,lng,street:empty(st)?"":clean(st)});
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
