// سرور اپ: فایل‌های ایستا + ثبت‌نام + دسترسی به داده + پنل مدیر. بدون وابستگی؛ فقط Node 16 یا بالاتر.
//   اجرا:  ADMIN_PASSWORD='یک-رمز-قوی' node server.js     (پورت پیش‌فرض 8080؛ با PORT عوض می‌شود)
// بدون ADMIN_PASSWORD (حداقل ۸ کاراکتر) پنل مدیر غیرفعال است. رمز پیش‌فرض وجود ندارد.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";   // پشت nginx بهتر است HOST=127.0.0.1 باشد
const ROOT = __dirname;
const STORAGE = path.join(ROOT, "storage");
const USERS_FILE = path.join(STORAGE, "users.json");
const PICKS_FILE = path.join(STORAGE, "picks.json");
const BACKUPS = path.join(STORAGE, "backups");
const DATA_FILE = path.join(ROOT, "data", "listings.xlsx");        // فایل کامل (عنوان و لینک آگهی دارد): فقط برای مدیر
const PUBLIC_FILE = path.join(STORAGE, "public-data.json");        // نسخه‌ی پاک‌شده برای کاربران: بدون عنوان و لینک
const RENT_FILE = path.join(ROOT, "data", "rent.xlsx");             // داده‌ی اجاره: جدا از داده‌ی فروش بارگذاری می‌شود
const RENT_PUBLIC_FILE = path.join(STORAGE, "rent-public.json");   // نسخه‌ی پاک‌شده و مدل اجاره برای کاربران
const RENT_CLEAN_FILE = path.join(STORAGE, "rent-clean.json");     // ردیف‌های تمیزشده؛ با تغییر نرخ تبدیل، مدل از روی همین بدون خواندن دوباره‌ی اکسل ساخته می‌شود
const RENT_SETTINGS_FILE = path.join(STORAGE, "rent-settings.json");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_ON = ADMIN_PASSWORD.length >= 8;
const BOUNDS = { south: 36.10, north: 36.50, west: 59.35, east: 59.85 };   // باید با config.js یکی باشد
const CELL = 0.0025;                                                       // ≈ ۲۵۰ متر
const MAX_UPLOAD = 25 * 1024 * 1024;

const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",".webmanifest":"application/manifest+json",".png":"image/png",".svg":"image/svg+xml",
  ".woff2":"font/woff2",".ico":"image/x-icon"};
// این مسیرها هرگز مستقیم سرو نمی‌شوند. داده فقط از /api/data و با ثبت‌نام.
const BLOCKED = /^\/(storage|data|server\.js|package\.json|readme\.md|install\.sh|node_modules)(\/|$)|(^|\/)\.(?!well-known(\/|$))/i;   // پوشه‌های داخلی و هر فایل/پوشه‌ی نقطه‌دار (.git و...) به‌جز .well-known (assetlinks.json برای نسخه‌ی اندروید)

/* ---------- نرمال‌سازی و اعتبارسنجی (همان منطق سمت کاربر) ---------- */
const latinDigits = s => String(s).replace(/[۰-۹]/g,c=>"۰۱۲۳۴۵۶۷۸۹".indexOf(c)).replace(/[٠-٩]/g,c=>"٠١٢٣٤٥٦٧٨٩".indexOf(c));
function normMobile(v){
  let s = latinDigits(v).replace(/[\s\-()]/g,"");
  if(s.startsWith("+98")) s = "0"+s.slice(3);
  else if(s.startsWith("0098")) s = "0"+s.slice(4);
  else if(/^98\d{10}$/.test(s)) s = "0"+s.slice(2);
  else if(/^9\d{9}$/.test(s)) s = "0"+s;
  return s;
}
const normUser = v => latinDigits(String(v).normalize("NFKC")).replace(/[‌‏‎]/g,"").replace(/ي/g,"ی").replace(/ك/g,"ک").trim();
const MOBILE_RE = /^09\d{9}$/;
const USER_RE = /^[A-Za-z0-9_.ء-غف-يپچژکگی]{3,20}$/;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const tehranDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Tehran" });

/* ---------- ذخیره‌سازی ---------- */
function readJson(file, fallback){ try{ return JSON.parse(fs.readFileSync(file,"utf8")); }catch(e){ return fallback; } }
function writeJson(file, obj){ fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); const t=file+".tmp"; fs.writeFileSync(t, JSON.stringify(obj,null,1)); fs.renameSync(t,file); }
let users = readJson(USERS_FILE, []);
const byToken = new Map(); users.forEach(u=>{ if(u.th) byToken.set(u.th,u); });
let picks = readJson(PICKS_FILE, {cells:{}, daily:{}});
let picksDirty = false;
setInterval(()=>{ if(picksDirty){ try{ writeJson(PICKS_FILE,picks); picksDirty=false; }catch(e){ console.error("picks save failed:",e.message); } } }, 10000).unref();
function flush(){ if(picksDirty){ try{ writeJson(PICKS_FILE,picks); }catch(e){} } }
process.on("SIGINT",()=>{ flush(); process.exit(0); }); process.on("SIGTERM",()=>{ flush(); process.exit(0); });

/* ---------- محدودیت تعداد درخواست ---------- */
const buckets = new Map();
function limited(key, max, windowMs){
  const now = Date.now(), arr = (buckets.get(key)||[]).filter(t=>now-t<windowMs);
  arr.push(now); buckets.set(key,arr); return arr.length>max;
}
setInterval(()=>{ const now=Date.now(); for(const [k,v] of buckets) if(!v.length || now-v[v.length-1]>600000) buckets.delete(k); }, 60000).unref();

/* ---------- کمکی‌ها ---------- */
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://map.ir https://*.basemaps.cartocdn.com; "+
  "connect-src 'self' https://map.ir https://*.basemaps.cartocdn.com; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SEC = {"Content-Security-Policy":CSP,"X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer",
  "Permissions-Policy":"geolocation=(self), camera=(), microphone=()","Cross-Origin-Opener-Policy":"same-origin"};
const secHeaders = req => (req && isHttps(req)) ? {...SEC,"Strict-Transport-Security":"max-age=15552000"} : SEC;
function send(res, code, obj, headers){ res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...(headers||{})}); res.end(JSON.stringify(obj)); }
function noContent(res){ res.writeHead(204,{"Cache-Control":"no-store"}); res.end(); }
function readBody(req, limit){
  return new Promise((resolve,reject)=>{
    const chunks=[]; let n=0;
    req.on("data",c=>{ n+=c.length; if(n>limit){ reject(Object.assign(new Error("big"),{code:413})); req.destroy(); } else chunks.push(c); });
    req.on("end",()=>resolve(Buffer.concat(chunks))); req.on("error",reject);
  });
}
async function jsonBody(req, res){
  if(!/^application\/json/i.test(req.headers["content-type"]||"")){ send(res,415,{error:"درخواست نامعتبر است."}); return null; }
  try{ return JSON.parse((await readBody(req,4096)).toString("utf8")); }
  catch(e){ send(res, e.code===413?413:400, {error:"درخواست نامعتبر است."}); return null; }
}
// پشت nginx همه‌ی درخواست‌ها از 127.0.0.1 می‌آیند. فقط در این حالت IP واقعی از X-Real-IP خوانده می‌شود.
const ipOf = req => {
  const a = req.socket.remoteAddress || "?";
  if(/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(a)){ const x = req.headers["x-real-ip"]; if(x && /^[0-9a-fA-F:.]{3,45}$/.test(x)) return x; }
  return a;
};
const isHttps = req => !!req.socket.encrypted || req.headers["x-forwarded-proto"]==="https";
function cookies(req){ const o={}; (req.headers.cookie||"").split(";").forEach(p=>{ const i=p.indexOf("="); if(i>0) o[p.slice(0,i).trim()]=p.slice(i+1).trim(); }); return o; }

/* ---------- کاربر ---------- */
function userFrom(req){ const t=req.headers["x-user-token"]; return t ? byToken.get(sha(t)) || null : null; }
function publicUser(u){ return {id:u.id, mobile:u.mobile, username:u.username, createdAt:u.createdAt, blocked:!!u.blocked}; }

async function register(req,res){
  if(limited("reg:"+ipOf(req),30,600000)) return send(res,429,{error:"تعداد تلاش‌ها زیاد است. چند دقیقه بعد دوباره امتحان کنید."});
  const j = await jsonBody(req,res); if(!j) return;
  if(typeof j.mobile!=="string" || typeof j.username!=="string") return send(res,400,{error:"شماره موبایل و نام کاربری را وارد کنید."});
  const mobile = normMobile(j.mobile), username = normUser(j.username);
  if(!MOBILE_RE.test(mobile)) return send(res,400,{field:"mobile",error:"شماره موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد."});
  if(!USER_RE.test(username)) return send(res,400,{field:"username",error:"نام کاربری باید ۳ تا ۲۰ کاراکتر و فقط حروف، عدد، نقطه یا زیرخط باشد."});
  const key = username.toLowerCase();
  if(users.some(u=>u.mobile===mobile)) return send(res,409,{field:"mobile",error:"این شماره قبلاً ثبت‌نام کرده است."});
  if(users.some(u=>u.username.toLowerCase()===key)) return send(res,409,{field:"username",error:"این نام کاربری قبلاً گرفته شده است."});
  const token = crypto.randomBytes(24).toString("hex");
  const user = {id:crypto.randomUUID(), mobile, username, th:sha(token), createdAt:new Date().toISOString(), blocked:false};
  users.push(user);
  try{ writeJson(USERS_FILE,users); }catch(e){ users.pop(); console.error("save failed:",e.message); return send(res,500,{error:"ذخیره‌ی اطلاعات انجام نشد. دوباره تلاش کنید."}); }
  byToken.set(user.th,user);
  send(res,201,{id:user.id, username:user.username, token});
}

/* ---------- نسخه‌ی عمومی داده ----------
   فایل xlsx مدیر عنوان و لینک آگهی دارد. به کاربران فقط این نسخه‌ی پاک‌شده داده می‌شود:
   متراژ، سال ساخت، قیمت هر متر، مختصات (گردشده به ≈۱۱ متر) و نام معبر. عنوان و لینک هرگز از سرور خارج نمی‌شود. */
let publicJson = null;
function loadConfig(){
  try{ const w={}; new Function("window", fs.readFileSync(path.join(ROOT,"config.js"),"utf8"))(w); if(w.APP_CONFIG && w.APP_CONFIG.bounds) return w.APP_CONFIG; }catch(e){ console.error("config.js خوانده نشد:",e.message); }
  return {bounds:BOUNDS, maxPriceMismatch:0.03};
}
function makePublic(buf){
  const XLSX = require("./vendor/xlsx.full.min.js"), Core = require("./listings-core.js");
  const wb = XLSX.read(buf,{type:"buffer"});
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:null,raw:true});
  const {list,stats} = Core.buildListings(rows, loadConfig());
  // v2: برای آپارتمان‌ها (t:1) ویژگی‌های مدل قیمت‌گذاری هم می‌آید. عنوان و لینک همچنان هرگز نمی‌آید.
  return {v:2, built:new Date().toISOString(), stats,
    list:list.map(l=>{ const o={a:l.area, y:l.year, p:l.per, la:+l.lat.toFixed(4), lo:+l.lng.toFixed(4), s:l.street||""};
      if(l.apt){ o.t=1; o.r=l.rooms; o.e=l.elev; o.k=l.park; if(l.corner) o.c=1; if(l.urgent) o.u=1; if(l.barter) o.b=1; }
      return o; })};
}
const zlib = require("zlib");
function mkPublic(pub){ const buf = Buffer.from(JSON.stringify(pub)); return {buf, gz:zlib.gzipSync(buf,{level:9}), stats:pub.stats, built:pub.built}; }
function commitPublic(pub){
  fs.mkdirSync(STORAGE,{recursive:true,mode:0o700});
  const t = PUBLIC_FILE+".tmp"; fs.writeFileSync(t, JSON.stringify(pub)); fs.renameSync(t, PUBLIC_FILE);
  publicJson = mkPublic(pub);
}
function initPublic(){
  try{
    const dm = fs.statSync(DATA_FILE).mtimeMs; let pm = 0; try{ pm = fs.statSync(PUBLIC_FILE).mtimeMs; }catch(e){}
    const pub = pm >= dm ? JSON.parse(fs.readFileSync(PUBLIC_FILE,"utf8")) : null;
    if(pub && pub.v===2){ publicJson = mkPublic(pub); }
    else commitPublic(makePublic(fs.readFileSync(DATA_FILE)));
  }catch(e){ if(e.code!=="ENOENT") console.error("نسخه‌ی عمومی داده ساخته نشد:",e.message); }
}
// ساخت نسخه‌ی عمومی بعد از بالا آمدن سرور انجام می‌شود (برای فایل‌های بزرگ چند ثانیه طول می‌کشد)


/* ---------- اجاره: پاک‌سازی خودکار + مدل + نرخ تبدیل قابل تنظیم (rent-core.js و rent-pricing.js) ----------
   فایل xlsx اجاره عنوان و لینک دارد و فقط برای مدیر است. به کاربران فقط {مختصات، متراژ، سال، ودیعه، اجاره} و پارامترهای مدل می‌رسد. */
const { Worker } = require("worker_threads");
const DEFAULT_RENT_RATE = 0.03;                               // سهم ماهانه‌ی ودیعه: ۳٪ = هر ۱ میلیارد ودیعه ≈ ۳۰ میلیون اجاره
let rentSettings = readJson(RENT_SETTINGS_FILE, {rate:DEFAULT_RENT_RATE});
if(!(rentSettings.rate>=0.005 && rentSettings.rate<=0.1)) rentSettings = {rate:DEFAULT_RENT_RATE};
let rentJson = null, rentBusy = false;
function fitInWorker(list, rate){                             // کالیبراسیون چند ثانیه (برای ۱۰ هزار ردیف ≈ ۱۰ ثانیه) طول می‌کشد؛ در thread جدا تا سرور برای کاربران قفل نشود
  return new Promise((resolve,reject)=>{
    const w = new Worker("const {parentPort,workerData:d}=require('worker_threads');try{parentPort.postMessage({ok:require(d.mod).fit(d.list,d.rate)})}catch(e){parentPort.postMessage({err:e.message})}",
      {eval:true, workerData:{mod:path.join(ROOT,"rent-pricing.js"), list, rate}});
    w.once("message",m=>m.err ? reject(new Error(m.err)) : resolve(m.ok)); w.once("error",reject);
  });
}
async function makeRentPublic(clean, stats, rate){
  const {model, used, dropped} = await fitInWorker(clean, rate);
  return {v:2, built:new Date().toISOString(), rate, model,
    stats:{...stats, outlier:stats.outlier+dropped, ok:used.length},
    list:used.map(l=>({la:+l.lat.toFixed(4), lo:+l.lng.toFixed(4), a:l.area, y:l.year||0, d:Math.round(l.dep), r:Math.round(l.rent), ...(l.e!==undefined?{e:l.e}:{}), ...(l.p!==undefined?{p:l.p}:{})}))};
}
function commitRent(pub, clean){
  fs.mkdirSync(STORAGE,{recursive:true,mode:0o700});
  const w = (f,o)=>{ const t=f+".tmp"; fs.writeFileSync(t,JSON.stringify(o)); fs.renameSync(t,f); };
  w(RENT_PUBLIC_FILE,pub); if(clean) w(RENT_CLEAN_FILE,clean);
  rentJson = mkPublic(pub);
}
const rentSummary = pub => pub ? {built:pub.built, rate:pub.rate, stats:pub.stats, k:pub.model.k, cv:pub.model.cv, area_bins:pub.model.area_bins, interval:pub.model.interval} : null;
const XLSXlib = () => require("./vendor/xlsx.full.min.js");
const sheetRows = buf => { const X = XLSXlib(), wb = X.read(buf,{type:"buffer"}); return {rows:X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:null,raw:true}), name:wb.SheetNames[0]}; };
const rowsToBuf = (rows, headers, name) => { const X = XLSXlib(), wb = X.utils.book_new(); X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows,{header:headers}), name||"Sheet1"); return X.write(wb,{type:"buffer",bookType:"xlsx"}); };
const rentIdFor = rows => { const Core = require("./rent-core.js"), {get} = Core.makeGetter(rows); return r => Core.idOf(r,get); };
async function rentFromRows(rows, rate){
  const Core = require("./rent-core.js");
  const {list,stats} = Core.buildRent(rows, loadConfig());
  if(!list.length) throw Object.assign(new Error("هیچ ردیف قابل استفاده‌ای در داده نیست (مختصات، متراژ و ودیعه/اجاره لازم است). تغییری داده نشد."),{user:true});
  const pub = await makeRentPublic(list, stats, rate).catch(e=>{ throw Object.assign(e,{user:true}); });
  return {pub, clean:{stats, list}};
}
async function rentFromBuffer(buf, rate){ return rentFromRows(sheetRows(buf).rows, rate); }
/** فایل بارگذاری‌شده را با داده‌ی فعلی ادغام می‌کند (mode=merge) یا جایگزین می‌کند (replace). بدون نوشتن چیزی؛ نتیجه برای ثبت یا پیش‌نمایش. */
function planRentUpload(buf, mode){
  const Core = require("./rent-core.js"), C = loadConfig();
  const {rows:inc, name} = sheetRows(buf);
  const miss = Core.missingColumns(inc); if(miss.length) throw Object.assign(new Error("ستون‌های لازم در فایل نیست: "+miss.join("، ")),{user:true});
  const fileStats = Core.buildRent(inc, C).stats;
  let old = []; if(mode==="merge" && fs.existsSync(RENT_FILE)){ try{ old = sheetRows(fs.readFileSync(RENT_FILE)).rows; }catch(e){ throw Object.assign(new Error("داده‌ی فعلی خوانده نشد؛ حالت «جایگزینی» را بزنید."),{user:true}); } }
  const usableBefore = old.length ? Core.buildRent(old, C).stats.ok : 0;
  const m = Core.mergeRows(old, inc, rentIdFor);
  const rep = {...m.report, mode, fileUsable:fileStats.ok, fileStats, usableBefore};
  const merged = Core.buildRent(m.rows, C).stats; rep.usableAfter = merged.ok; rep.addedUsable = merged.ok - usableBefore; rep.stats = merged;
  return {rows:m.rows, headers:m.headers, name, report:rep};
}
async function initRent(){
  try{
    const dm = fs.statSync(RENT_FILE).mtimeMs; let pm = 0; try{ pm = fs.statSync(RENT_PUBLIC_FILE).mtimeMs; }catch(e){}
    const pub = pm >= dm ? readJson(RENT_PUBLIC_FILE,null) : null;
    if(pub && pub.v===2 && pub.rate===rentSettings.rate){ rentJson = mkPublic(pub); return; }
    const {pub:p, clean} = await rentFromBuffer(fs.readFileSync(RENT_FILE), rentSettings.rate); commitRent(p, clean);
  }catch(e){ if(e.code!=="ENOENT") console.error("داده‌ی اجاره ساخته نشد:",e.message); }
}
function serveRentData(req,res){
  const admin = isAdmin(req), u = userFrom(req);
  if(!admin){
    if(!u) return send(res,401,{error:"ابتدا ثبت‌نام کنید.",code:"unregistered"});
    if(u.blocked) return send(res,403,{error:"دسترسی حساب شما بسته شده است.",code:"blocked"});
    if(limited("data:"+u.id,20,60000)) return send(res,429,{error:"درخواست زیاد است. کمی بعد دوباره امتحان کنید."});
  }
  if(!rentJson){ if(fs.existsSync(RENT_FILE)) return send(res,503,{error:"داده در حال آماده‌سازی است."}); return send(res,404,{error:"داده‌ی اجاره هنوز بارگذاری نشده است."}); }
  const gz = /\bgzip\b/.test(req.headers["accept-encoding"]||"");
  res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Vary":"Accept-Encoding",...(gz?{"Content-Encoding":"gzip"}:{})}); res.end(gz?rentJson.gz:rentJson.buf);
}

// داده فقط برای کاربر ثبت‌نام‌شده و غیرمسدود (یا مدیر)؛ و فقط نسخه‌ی پاک‌شده
function serveData(req,res){
  const admin = isAdmin(req), u = userFrom(req);
  if(!admin){
    if(!u) return send(res,401,{error:"ابتدا ثبت‌نام کنید.",code:"unregistered"});
    if(u.blocked) return send(res,403,{error:"دسترسی حساب شما بسته شده است.",code:"blocked"});
    if(limited("data:"+u.id,20,60000)) return send(res,429,{error:"درخواست زیاد است. کمی بعد دوباره امتحان کنید."});
  }
  if(!publicJson){ if(fs.existsSync(DATA_FILE)) return send(res,503,{error:"داده در حال آماده‌سازی است."}); return send(res,404,{error:"فایل داده هنوز بارگذاری نشده است."}); }
  const gz = /\bgzip\b/.test(req.headers["accept-encoding"]||"");
  res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Vary":"Accept-Encoding",...(gz?{"Content-Encoding":"gzip"}:{})}); res.end(gz?publicJson.gz:publicJson.buf);
}

// شمارش ناشناس نقاط انتخابی: فقط خانه‌ی ≈۲۵۰ متری ذخیره می‌شود، نه کاربر و نه مختصات دقیق
async function pick(req,res){
  const u = userFrom(req);
  if(!u) return send(res,401,{error:"unregistered"});
  if(u.blocked) return send(res,403,{error:"blocked"});
  if(limited("pick:"+u.id,60,60000)) return send(res,429,{error:"rate"});
  const j = await jsonBody(req,res); if(!j) return;
  const lat=Number(j.lat), lng=Number(j.lng), found=Number(j.found);
  if(!isFinite(lat)||!isFinite(lng)||lat<BOUNDS.south||lat>BOUNDS.north||lng<BOUNDS.west||lng>BOUNDS.east) return send(res,400,{error:"bad"});
  const cl = (Math.round(lat/CELL)*CELL).toFixed(4), cg = (Math.round(lng/CELL)*CELL).toFixed(4), key = cl+","+cg;
  let c = picks.cells[key];
  if(!c){ if(Object.keys(picks.cells).length>=20000) return noContent(res); c = picks.cells[key] = {lat:Number(cl), lng:Number(cg), n:0, low:0, last:""}; }
  c.n++; if(!(found>=Number(j.min||3))) c.low++; c.last = new Date().toISOString();
  const d = tehranDay(); picks.daily[d] = (picks.daily[d]||0) + 1;
  picksDirty = true;
  noContent(res);
}

/* حذف حساب: توسط خود کاربر (با کد دسترسی) یا مدیر. کاربر مسدود خودش نمی‌تواند حذف کند (دور زدن مسدودی) */
function removeUser(u){
  const i = users.indexOf(u); if(i<0) return false;
  users.splice(i,1);
  try{ writeJson(USERS_FILE,users); }catch(e){ users.splice(i,0,u); console.error("save failed:",e.message); return false; }
  byToken.delete(u.th); return true;
}
async function deleteMe(req,res){
  const u = userFrom(req);
  if(!u) return send(res,401,{error:"unregistered"});
  if(u.blocked) return send(res,403,{error:"حساب شما مسدود است؛ برای حذف با مدیر تماس بگیرید."});
  if(limited("del:"+u.id,5,600000)) return send(res,429,{error:"rate"});
  if(!removeUser(u)) return send(res,500,{error:"حذف انجام نشد. دوباره تلاش کنید."});
  send(res,200,{ok:true});
}

/* ---------- مدیر ---------- */
const sessions = new Map();   // توکن نشست → زمان انقضا
function isAdmin(req){
  const t = cookies(req).admin; if(!t) return false;
  const exp = sessions.get(sha(t)); if(!exp) return false;
  if(exp<Date.now()){ sessions.delete(sha(t)); return false; }
  return true;
}
function eqSecret(a,b){ return crypto.timingSafeEqual(Buffer.from(sha(a)),Buffer.from(sha(b))); }

async function adminLogin(req,res){
  if(!ADMIN_ON) return send(res,503,{error:"پنل مدیر غیرفعال است. هنگام اجرای سرور ADMIN_PASSWORD (حداقل ۸ کاراکتر) را تنظیم کنید."});
  if(limited("login:"+ipOf(req),5,600000)) return send(res,429,{error:"تلاش‌های ناموفق زیاد بود. ۱۰ دقیقه بعد دوباره امتحان کنید."});
  const j = await jsonBody(req,res); if(!j) return;
  if(typeof j.password!=="string" || !eqSecret(j.password, ADMIN_PASSWORD)){ console.log("admin login failed from",ipOf(req)); return send(res,401,{error:"رمز اشتباه است."}); }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(sha(token), Date.now()+8*3600*1000);
  send(res,200,{ok:true},{"Set-Cookie":`admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${isHttps(req)?"; Secure":""}`});
}

function lastDays(map, n){
  const out=[]; for(let i=n-1;i>=0;i--){ const d=tehranDay(new Date(Date.now()-i*86400000)); out.push({d, n:map[d]||0}); } return out;
}

async function adminApi(req,res,url,qs){
  if(!ADMIN_ON) return send(res,503,{error:"پنل مدیر غیرفعال است."});
  if(url==="/api/admin/login" && req.method==="POST") return adminLogin(req,res);
  if(!isAdmin(req)) return send(res,401,{error:"ورود لازم است."});
  if(req.method!=="GET" && req.headers["x-admin"]!=="1") return send(res,403,{error:"درخواست نامعتبر است."});

  if(url==="/api/admin/session") return send(res,200,{ok:true});
  if(url==="/api/admin/logout" && req.method==="POST"){
    const t=cookies(req).admin; if(t) sessions.delete(sha(t));
    return send(res,200,{ok:true},{"Set-Cookie":"admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"});
  }
  if(url==="/api/admin/stats"){
    const today = tehranDay(), regByDay={}; users.forEach(u=>{ const d=tehranDay(new Date(u.createdAt)); regByDay[d]=(regByDay[d]||0)+1; });
    const cells = Object.values(picks.cells), total = cells.reduce((s,c)=>s+c.n,0), low = cells.reduce((s,c)=>s+c.low,0);
    return send(res,200,{users:users.length, today:regByDay[today]||0, blocked:users.filter(u=>u.blocked).length,
      reg30:lastDays(regByDay,30), picks30:lastDays(picks.daily,30), picksTotal:total, picksLow:low, cells:cells.length});
  }
  if(url==="/api/admin/users" && req.method==="GET"){
    const q = normUser(qs.get("q")||"").toLowerCase();
    let list = users.map(publicUser);
    if(q) list = list.filter(u=>u.username.toLowerCase().includes(q) || u.mobile.includes(latinDigits(q)));
    list.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return send(res,200,{total:users.length, users:list.slice(0,5000)});
  }
  if(url==="/api/admin/users/block" && req.method==="POST"){
    const j = await jsonBody(req,res); if(!j) return;
    const u = users.find(x=>x.id===j.id); if(!u) return send(res,404,{error:"کاربر پیدا نشد."});
    const prev = !!u.blocked; u.blocked = !!j.blocked;
    try{ writeJson(USERS_FILE,users); }catch(e){ u.blocked=prev; return send(res,500,{error:"ذخیره انجام نشد."}); }
    return send(res,200,{ok:true,user:publicUser(u)});
  }
  if(url==="/api/admin/users/delete" && req.method==="POST"){
    const j = await jsonBody(req,res); if(!j) return;
    const u = users.find(x=>x.id===j.id); if(!u) return send(res,404,{error:"کاربر پیدا نشد."});
    if(!removeUser(u)) return send(res,500,{error:"حذف انجام نشد."});
    return send(res,200,{ok:true});
  }
  if(url==="/api/admin/picks"){
    const cells = Object.values(picks.cells).sort((a,b)=>b.n-a.n).slice(0,500);
    return send(res,200,{cells});
  }
  if(url==="/api/admin/data-info"){
    let info = {exists:false}; try{ const st=fs.statSync(DATA_FILE); info={exists:true,size:st.size,mtime:st.mtime.toISOString()}; }catch(e){}
    let backups=[]; try{ backups = fs.readdirSync(BACKUPS).filter(f=>/^listings-.*\.xlsx$/.test(f)).sort().reverse().map(f=>({name:f,size:fs.statSync(path.join(BACKUPS,f)).size})); }catch(e){}
    return send(res,200,{...info,backups,usable:publicJson?publicJson.stats.ok:0,rows:publicJson?publicJson.stats.rows:0});
  }
  if(url==="/api/admin/data-file" && req.method==="GET"){
    return fs.readFile(DATA_FILE,(err,buf)=>{ if(err) return send(res,404,{error:"فایل داده هنوز بارگذاری نشده است."});
      res.writeHead(200,{"Content-Type":"application/octet-stream","Cache-Control":"no-store"}); res.end(buf); });
  }
  if(url==="/api/admin/data" && req.method==="POST"){
    let buf; try{ buf = await readBody(req,MAX_UPLOAD); }catch(e){ return send(res,413,{error:"حجم فایل بیش از ۲۵ مگابایت است."}); }
    if(buf.length<100 || buf.readUInt32LE(0)!==0x04034b50) return send(res,400,{error:"فایل xlsx معتبر نیست."});
    let pub; try{ pub = makePublic(buf); }catch(e){ console.error("parse failed:",e.message); return send(res,400,{error:"این فایل خوانده نشد؛ xlsx سالم نیست."}); }
    if(!pub.stats.ok) return send(res,400,{error:"هیچ ردیف قابل استفاده‌ای در این فایل نیست. جایگزین نشد."});
    try{
      fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true}); fs.mkdirSync(BACKUPS,{recursive:true,mode:0o700});
      if(fs.existsSync(DATA_FILE)){
        fs.copyFileSync(DATA_FILE, path.join(BACKUPS,"listings-"+new Date().toISOString().replace(/[:.]/g,"-")+".xlsx"));
        fs.readdirSync(BACKUPS).filter(f=>/^listings-.*\.xlsx$/.test(f)).sort().reverse().slice(5).forEach(f=>fs.unlinkSync(path.join(BACKUPS,f)));
      }
      const t=DATA_FILE+".tmp"; fs.writeFileSync(t,buf); fs.renameSync(t,DATA_FILE);
      commitPublic(pub);
    }catch(e){ console.error("upload failed:",e.message); return send(res,500,{error:"ذخیره‌ی فایل انجام نشد."}); }
    return send(res,200,{ok:true,size:buf.length,usable:pub.stats.ok,rows:pub.stats.rows});
  }
  if(url==="/api/admin/rent-info"){
    let info = {exists:false}; try{ const st=fs.statSync(RENT_FILE); info={exists:true,size:st.size,mtime:st.mtime.toISOString()}; }catch(e){}
    let backups=[]; try{ backups = fs.readdirSync(BACKUPS).filter(f=>/^rent-.*\.xlsx$/.test(f)).sort().reverse().map(f=>({name:f,size:fs.statSync(path.join(BACKUPS,f)).size})); }catch(e){}
    let summary = null; try{ summary = rentSummary(readJson(RENT_PUBLIC_FILE,null)); }catch(e){}
    return send(res,200,{...info,backups,rate:rentSettings.rate,busy:rentBusy,preparing:info.exists&&!rentJson,summary});
  }
  if(url==="/api/admin/rent-file" && req.method==="GET"){
    return fs.readFile(RENT_FILE,(err,buf)=>{ if(err) return send(res,404,{error:"فایل داده‌ی اجاره هنوز بارگذاری نشده است."});
      res.writeHead(200,{"Content-Type":"application/octet-stream","Cache-Control":"no-store"}); res.end(buf); });
  }
  if(url==="/api/admin/rent" && req.method==="POST"){
    if(rentBusy) return send(res,409,{error:"پردازش قبلی هنوز تمام نشده است. چند ثانیه بعد دوباره امتحان کنید."});
    const q = new URL(req.url,"http://x").searchParams, mode = q.get("mode")==="replace" ? "replace" : "merge", dry = q.get("dry")==="1";
    let buf; try{ buf = await readBody(req,MAX_UPLOAD); }catch(e){ return send(res,413,{error:"حجم فایل بیش از ۲۵ مگابایت است."}); }
    if(buf.length<100 || buf.readUInt32LE(0)!==0x04034b50) return send(res,400,{error:"فایل xlsx معتبر نیست."});
    rentBusy = true;
    try{
      let plan; try{ plan = planRentUpload(buf, mode); }catch(e){ console.error("rent parse failed:",e.message); return send(res,400,{error:e.user?e.message:"این فایل خوانده نشد؛ xlsx سالم نیست."}); }
      const rep = plan.report;
      if(dry) return send(res,200,{ok:true,dry:true,report:rep});
      if(mode==="merge" && rep.added===0 && fs.existsSync(RENT_FILE))               // چیزی جدید نیست: فایل و مدل دست نمی‌خورد
        return send(res,200,{ok:true,nothingNew:true,report:rep,summary:rentSummary(readJson(RENT_PUBLIC_FILE,null))});
      let r; try{ r = await rentFromRows(plan.rows, rentSettings.rate); }catch(e){ console.error("rent fit failed:",e.message); return send(res,400,{error:e.user?e.message:"مدل اجاره ساخته نشد."}); }
      try{
        fs.mkdirSync(path.dirname(RENT_FILE),{recursive:true}); fs.mkdirSync(BACKUPS,{recursive:true,mode:0o700});
        const out = mode==="replace" ? buf : rowsToBuf(plan.rows, plan.headers, plan.name);
        if(fs.existsSync(RENT_FILE)){
          fs.copyFileSync(RENT_FILE, path.join(BACKUPS,"rent-"+new Date().toISOString().replace(/[:.]/g,"-")+".xlsx"));
          fs.readdirSync(BACKUPS).filter(f=>/^rent-.*\.xlsx$/.test(f)).sort().reverse().slice(5).forEach(f=>fs.unlinkSync(path.join(BACKUPS,f)));
        }
        const t=RENT_FILE+".tmp"; fs.writeFileSync(t,out); fs.renameSync(t,RENT_FILE);
        commitRent(r.pub, r.clean);
      }catch(e){ console.error("rent upload failed:",e.message); return send(res,500,{error:"ذخیره‌ی فایل انجام نشد."}); }
      return send(res,200,{ok:true,report:rep,summary:rentSummary(r.pub)});
    } finally { rentBusy = false; }
  }
  if(url==="/api/admin/rent-settings" && req.method==="POST"){
    const j = await jsonBody(req,res); if(!j) return;
    const pct = Number(j.percent), rate = pct/100;
    if(!(pct>=0.5 && pct<=10)) return send(res,400,{error:"نرخ باید بین ۰٫۵ تا ۱۰ درصد در ماه باشد."});
    if(rentBusy) return send(res,409,{error:"پردازش قبلی هنوز تمام نشده است. چند ثانیه بعد دوباره امتحان کنید."});
    const prev = rentSettings;
    const save = ()=>{ writeJson(RENT_SETTINGS_FILE,{rate}); rentSettings = {rate}; };
    if(!fs.existsSync(RENT_FILE)){ try{ save(); }catch(e){ return send(res,500,{error:"ذخیره انجام نشد."}); } return send(res,200,{ok:true,rate,summary:null}); }
    rentBusy = true;
    try{
      const clean = readJson(RENT_CLEAN_FILE,null); let pub;
      try{
        if(clean && clean.list) pub = await makeRentPublic(clean.list, clean.stats, rate);
        else{ const r = await rentFromBuffer(fs.readFileSync(RENT_FILE), rate); pub = r.pub; commitRent(pub, r.clean); }
      }catch(e){ console.error("rent refit failed:",e.message); return send(res,400,{error:"با این نرخ مدل ساخته نشد: "+e.message}); }
      try{ save(); commitRent(pub, null); }catch(e){ rentSettings = prev; return send(res,500,{error:"ذخیره انجام نشد."}); }
      return send(res,200,{ok:true,rate,summary:rentSummary(pub)});
    } finally { rentBusy = false; }
  }
  send(res,404,{error:"پیدا نشد."});
}

/* ---------- فایل‌های ایستا ---------- */
const STATIC_CACHE = new Map();
function serveStatic(req,res){
  let p; try{ p = decodeURIComponent(new URL(req.url,"http://x").pathname); }catch(e){ res.writeHead(400); return res.end(); }
  if(p.endsWith("/")) p += "index.html";
  if(BLOCKED.test(p) || p.includes("\0")){ res.writeHead(404); return res.end("Not found"); }
  const file = path.normalize(path.join(ROOT,p));
  if(!file.startsWith(ROOT+path.sep)){ res.writeHead(404); return res.end("Not found"); }
  fs.stat(file,(e0,st)=>{
    if(e0 || !st.isFile()){ res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase(), gzOk = /\.(html|js|css|json|svg|webmanifest)$/.test(ext) && /\bgzip\b/.test(req.headers["accept-encoding"]||"");
    const hit = STATIC_CACHE.get(file);
    const finish = (buf,gz)=>{
      res.writeHead(200,{"Content-Type":MIME[ext]||"application/octet-stream","Cache-Control":(/\.(html|js|webmanifest)$/.test(ext)||p.startsWith("/.well-known/"))?"no-cache":"public, max-age=86400","X-Content-Type-Options":"nosniff","Vary":"Accept-Encoding",...(gz?{"Content-Encoding":"gzip"}:{})});
      res.end(buf);
    };
    if(hit && hit.m===st.mtimeMs){ const useGz = gzOk && hit.gz!==hit.raw; return finish(useGz?hit.gz:hit.raw, useGz); }
    fs.readFile(file,(err,buf)=>{
      if(err){ res.writeHead(404); return res.end("Not found"); }
      const gz = buf.length>1024 && /\.(html|js|css|json|svg|webmanifest)$/.test(ext) ? zlib.gzipSync(buf,{level:9}) : buf;
      if(buf.length<=8e6) STATIC_CACHE.set(file,{m:st.mtimeMs,raw:buf,gz});
      const useGz = gzOk && gz!==buf; finish(useGz?gz:buf, useGz);   // فایل کوچک فشرده نمی‌شود؛ هدر gzip فقط وقتی که بدنه واقعاً فشرده است
    });
  });
}

http.createServer(async (req,res)=>{
  try{
    const sh = secHeaders(req); for(const k in sh) res.setHeader(k, sh[k]);
    const u = new URL(req.url,"http://x"), url = u.pathname;
    if(url==="/api/register"){ if(req.method==="POST") return await register(req,res); res.writeHead(405,{Allow:"POST"}); return res.end(); }
    if(url==="/api/data"){ if(req.method==="GET") return serveData(req,res); res.writeHead(405,{Allow:"GET"}); return res.end(); }
    if(url==="/api/rent-data"){ if(req.method==="GET") return serveRentData(req,res); res.writeHead(405,{Allow:"GET"}); return res.end(); }
    if(url==="/api/me/delete"){ if(req.method==="POST") return await deleteMe(req,res); res.writeHead(405,{Allow:"POST"}); return res.end(); }
    if(url==="/api/pick"){ if(req.method==="POST") return await pick(req,res); res.writeHead(405,{Allow:"POST"}); return res.end(); }
    if(url.startsWith("/api/admin/")) return await adminApi(req,res,url,u.searchParams);
    if(req.method!=="GET" && req.method!=="HEAD"){ res.writeHead(405); return res.end(); }
    serveStatic(req,res);
  }catch(e){ console.error(e); if(!res.headersSent) send(res,500,{error:"خطای سرور"}); else res.end(); }
}).listen(PORT,HOST,()=>{
  // پیش‌گرم‌کردن کش فشرده‌ی فایل‌های ایستا تا اولین کاربران منتظر فشرده‌سازی نمانند
  try{ const warm = d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{ const f=path.join(d,e.name);
      if(e.isDirectory()){ if(/^(vendor)$/.test(e.name)) warm(f); return; }
      if(!/\.(html|js|css|json|svg|webmanifest)$/i.test(e.name) || BLOCKED.test("/"+path.relative(ROOT,f).split(path.sep).join("/"))) return;
      const st=fs.statSync(f), buf=fs.readFileSync(f); if(buf.length>1024 && buf.length<=8e6) STATIC_CACHE.set(f,{m:st.mtimeMs,raw:buf,gz:zlib.gzipSync(buf,{level:9})}); });
    warm(ROOT); }catch(e){}
  console.log("http://"+HOST+":"+PORT);
  setImmediate(initPublic);
  setImmediate(initRent);
  console.log(ADMIN_ON ? "پنل مدیر: /admin.html" : "هشدار: ADMIN_PASSWORD (حداقل ۸ کاراکتر) تنظیم نشده؛ پنل مدیر غیرفعال است.");
});
