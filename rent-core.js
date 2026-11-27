// خواندن و پاک‌سازی خودکار آگهی‌های اجاره (خروجی اسکرپر دیوار). هم سرور، هم پنل مدیر از همین استفاده می‌کنند.
// ورودی هر چه باشد (متن فارسی، «۱.۵۰۰ میلیارد / ۳ میلیون»، «رایگان»، اجاره‌ی نمادین) به ودیعه و اجاره‌ی ماهانه به تومان تبدیل می‌شود.
(function(root,factory){ if(typeof module==="object"&&module.exports) module.exports=factory(); else root.RentCore=factory(); })(typeof self!=="undefined"?self:this,function(){
"use strict";
const FA = "۰۱۲۳۴۵۶۷۸۹", AR = "٠١٢٣٤٥٦٧٨٩";
const norm = s => String(s==null?"":s).replace(/[۰-۹]/g,c=>FA.indexOf(c)).replace(/[٠-٩]/g,c=>AR.indexOf(c))
  .replace(/[٬،]/g,",").replace(/٫/g,".").replace(/[‌‎‏‪-‮]/g," ").replace(/ي/g,"ی").replace(/ك/g,"ک").replace(/\s+/g," ").trim();
const empty = v => v==null || norm(v)==="" || /^(nan|null|undefined|n\/a)$/i.test(norm(v));

const AREA_RANGE = [25,400];            // مثل مدل فروش: فقط آپارتمان
const PLACEHOLDER_RENT = 1e6;            // اجاره‌ی زیر ۱ میلیون تومان در دیوار عدد نمادین است («رهن کامل» با اجاره‌ی ۱۰۰ هزار و…)
const MAX_DEP = 1e11, MAX_RENT = 1e9;    // سقف عقل سلیم؛ ودیعه‌ی ۸۰۰ میلیارد و مانند آن خطای تایپ است
// ملک غیرآپارتمان: ویلا، خانه، مغازه، هتل، چندواحدی، ... («انباری» در امکانات آپارتمان است و حذف نمی‌شود)
const NON_APT = /زمین|باغ|ویلا|خانه|منزل|کلنگی|مغازه|تجاری|اداری|مشاغل|هتل|سوئیت|سویت|یکجا|کارگاه|سالن|دفتر|مطب|انبار(?!ی)|\d\s*واحد(?!ی)|برج ها|برج‌ها/;

const UNIT = {"میلیارد":1e9,"میلیون":1e6,"هزار":1e3};
/** یک مقدار پولی → تومان. «رایگان» = ۰. غیرقابل خواندن = null */
function money(t){
  t = norm(t);
  if(!t || /^(nan|null)$/i.test(t)) return null;
  if(t.includes("رایگان")) return 0;
  let sum = 0, hit = false, m;
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(میلیارد|میلیون|هزار)/g;      // «۱.۵۰۰ میلیارد»، «۱ میلیارد و ۵۰۰ میلیون»
  while((m = re.exec(t))){ sum += parseFloat(m[1].replace(/,/g,"")) * UNIT[m[2]]; hit = true; }
  if(hit) return sum;
  m = t.match(/\d[\d,.]*/);                                           // «۲,۰۰۰,۰۰۰,۰۰۰ تومان»: نقطه و ویرگول جداکننده‌ی هزارگان است
  if(!m) return null;
  const v = Number(m[0].replace(/[,.]/g,""));
  return isFinite(v) ? v : null;
}
/** ستون «ودیعه» گاهی «ودیعه / اجاره» است. اجاره اگر نبود از ستون اجاره خوانده می‌شود. */
function depRent(depTxt, rentTxt){
  const d = norm(depTxt);
  if(d.includes("/")){ const i = d.indexOf("/"); return {dep:money(d.slice(0,i)), rent:money(d.slice(i+1))}; }
  return {dep:money(d), rent:money(rentTxt)};
}
/** «عنوان: مقدار | عنوان: مقدار» → شیء */
function kvRow(s){
  const o = {};
  norm(s).split("|").forEach(p=>{ const i = p.indexOf(":"); if(i>0) o[p.slice(0,i).trim()] = p.slice(i+1).trim(); });
  return o;
}
function areaYear(kv){
  const t = kv["متراژ"] || "";
  const nums = (t.match(/\d+(?:\.\d+)?/g)||[]).map(Number);
  const area = nums[0], y = nums[1];
  return {area, year:(y>=1300 && y<=1450) ? y : null};
}

// نام ستون‌ها (چند نام ممکن؛ بدون حساسیت به نیم‌فاصله و ی/ک عربی)
const COLS = {
  id:["شناسه","id","token"], url:["url"], title:["عنوان","title"],
  page:["ردیف‌های صفحه (عنوان: مقدار)","ردیف های صفحه (عنوان: مقدار)"],
  depTxt:["ودیعه (متن)"], rentTxt:["اجاره ماهانه (متن)","اجاره‌ی ماهانه (متن)"],
  depNum:["ودیعه (تومان)"], rentNum:["اجاره ماهانه (تومان)","اجاره‌ی ماهانه (تومان)"],
  amen:["امکانات (مودال)","امکانات"], lat:["latitude","lat"], lng:["longitude","lng","lon"], area:["متراژ"], year:["سال ساخت","ساخت"]
};
const REQUIRED = [["ودیعه",["depTxt","depNum"]],["اجاره",["rentTxt","rentNum"]],["latitude",["lat"]],["longitude",["lng"]],["متراژ (ردیف‌های صفحه)",["page","area"]]];

/** امکانات («آسانسور | پارکینگ ندارد | …») → {e, p}: ۱ دارد، ۰ ندارد، undefined نامشخص */
function amenities(t){
  const items = norm(t).split("|").map(x=>x.trim()), o = {};
  for(const [k,name] of [["e","آسانسور"],["p","پارکینگ"]]){
    if(items.includes(name+" ندارد")) o[k] = 0; else if(items.includes(name)) o[k] = 1;
  }
  return o;
}
/** شناسه‌ی آگهی: ستون شناسه، وگرنه آخرین بخش URL */
function idOf(r, get){
  const rawId = get(r,"id"), url = get(r,"url");
  return !empty(rawId) ? String(rawId) : (!empty(url) ? String(url).split("/").pop() : null);
}

function makeGetter(rows){
  const keys = {}; if(rows.length) for(const k of Object.keys(rows[0])) keys[norm(k).toLowerCase()] = k;
  const col = {}; for(const n in COLS){ for(const c of COLS[n]){ const k = keys[norm(c).toLowerCase()]; if(k!==undefined){ col[n] = k; break; } } }
  return {col, get:(r,n)=> col[n]===undefined ? undefined : r[col[n]]};
}
function missingColumns(rows){
  const {col} = makeGetter(rows);
  return REQUIRED.filter(([,names])=>!names.some(n=>col[n]!==undefined)).map(x=>x[0]);
}

function buildRent(rows, C){
  const st = {rows:rows.length, ok:0, dup:0, noGeo:0, outside:0, noArea:0, areaRange:0, noPrice:0, nonApt:0, outlier:0, fullDeposit:0, mixed:0, placeholder:0};
  const {get} = makeGetter(rows), B = C.bounds, out = [];
  const seenId = new Set(), seenContent = new Set();
  for(const r of rows){
    const id = idOf(r, get);
    if(id){ if(seenId.has(id)){ st.dup++; continue; } seenId.add(id); }
    const lat = Number(get(r,"lat")), lng = Number(get(r,"lng"));
    if(empty(get(r,"lat")) || empty(get(r,"lng")) || !isFinite(lat) || !isFinite(lng)){ st.noGeo++; continue; }
    if(lat<B.south || lat>B.north || lng<B.west || lng>B.east){ st.outside++; continue; }
    // متراژ و سال ساخت
    let area, year = null;
    if(get(r,"page")!==undefined && !empty(get(r,"page"))){ const ay = areaYear(kvRow(get(r,"page"))); area = ay.area; year = ay.year; }
    if(!(area>0) && !empty(get(r,"area"))) area = Number(norm(get(r,"area")).replace(/[^\d.]/g,""));
    if(year==null && !empty(get(r,"year"))){ const y = Number(norm(get(r,"year")).replace(/[^\d]/g,"")); if(y>=1300&&y<=1450) year = y; }
    if(!(area>0)){ st.noArea++; continue; }
    // ودیعه و اجاره
    let {dep, rent} = depRent(get(r,"depTxt"), get(r,"rentTxt"));
    if(dep==null && !empty(get(r,"depNum"))) dep = Number(get(r,"depNum"));
    if(rent==null && !empty(get(r,"rentNum")) && !/\//.test(norm(get(r,"depTxt")))) rent = Number(get(r,"rentNum"));
    if(!(dep>=0) || !(rent>=0) || !isFinite(dep) || !isFinite(rent) || (dep===0 && rent===0)){ st.noPrice++; continue; }
    if(dep>MAX_DEP || rent>MAX_RENT){ st.outlier++; continue; }
    const title = empty(get(r,"title")) ? "" : norm(get(r,"title"));
    if(NON_APT.test(title)){ st.nonApt++; continue; }
    if(area<AREA_RANGE[0] || area>AREA_RANGE[1]){ st.areaRange++; continue; }
    if(rent>0 && rent<PLACEHOLDER_RENT){ rent = 0; st.placeholder++; }       // «رهن کامل» با اجاره‌ی نمادین
    const ck = title+"|"+dep+"|"+rent+"|"+area;
    if(seenContent.has(ck)){ st.dup++; continue; } seenContent.add(ck);
    if(rent===0) st.fullDeposit++; else st.mixed++;
    const am = empty(get(r,"amen")) ? {} : amenities(get(r,"amen"));
    const item = {id, area, year, dep, rent, lat, lng};
    if(am.e!==undefined) item.e = am.e;
    if(am.p!==undefined) item.p = am.p;
    out.push(item);
  }
  st.ok = out.length;
  return {list:out, stats:st};
}

/** ادغام بدون تکرار: ردیف‌های فایل جدید که شناسه‌شان (یا توکن لینک) در داده‌ی فعلی یا در خود فایل جدید قبلاً آمده اضافه نمی‌شود.
 *  idFor(rows) تابع «ردیف → شناسه یا null» را برای همان مجموعه می‌سازد (نام ستون‌ها در دو فایل می‌تواند فرق کند). ردیف بدون شناسه همیشه جدید است
 *  (تکراری بودن محتوایی‌اش بعداً در پاک‌سازی گرفته می‌شود). ردیف‌های فعلی هرگز تغییر یا حذف نمی‌شوند. */
function mergeRows(oldRows, newRows, idFor){
  const oid = idFor(oldRows), nid = idFor(newRows), seen = new Set(), oldIds = new Set();
  for(const r of oldRows){ const i = oid(r); if(i!=null){ seen.add(i); oldIds.add(i); } }
  const headers = oldRows.length ? Object.keys(oldRows[0]) : [], hmap = {};
  headers.forEach(h=>{ hmap[norm(h).toLowerCase()] = h; });
  const rep = {fileRows:newRows.length, existing:oldRows.length, dupExisting:0, inFileDup:0, added:0, total:0};
  const added = [];
  for(const r of newRows){
    const i = nid(r);
    if(i!=null){
      if(oldIds.has(i)){ rep.dupExisting++; continue; }
      if(seen.has(i)){ rep.inFileDup++; continue; }
      seen.add(i);
    }
    const o = {};                                          // نام ستون‌های فایل جدید به نام ستون‌های فایل فعلی نگاشت می‌شود
    for(const k of Object.keys(r)){
      const nk = norm(k).toLowerCase(); let t = hmap[nk];
      if(t===undefined){ t = k; hmap[nk] = k; headers.push(k); }
      o[t] = r[k];
    }
    added.push(o);
  }
  rep.added = added.length; rep.total = oldRows.length + added.length;
  return {rows:oldRows.concat(added), headers, report:rep};
}

async function readRows(buf, name, XLSX){
  if(/\.json$/i.test(name)){ const j = JSON.parse(new TextDecoder().decode(buf)); return Array.isArray(j) ? j : (j.rows||j.data||[]); }
  const wb = XLSX.read(buf,{type:"array"});
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:null,raw:true});
}

return {buildRent, mergeRows, idOf, makeGetter, amenities, readRows, missingColumns, money, depRent, norm, AREA_RANGE, PLACEHOLDER_RENT};
});
