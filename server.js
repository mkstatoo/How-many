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
const DATA_FILE = path.join(ROOT, "data", "listings.xlsx");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_ON = ADMIN_PASSWORD.length >= 8;
const BOUNDS = { south: 36.10, north: 36.50, west: 59.35, east: 59.85 };   // باید با config.js یکی باشد
const CELL = 0.0025;                                                       // ≈ ۲۵۰ متر
const MAX_UPLOAD = 25 * 1024 * 1024;

const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",".webmanifest":"application/manifest+json",".png":"image/png",".svg":"image/svg+xml",
  ".woff2":"font/woff2",".ico":"image/x-icon"};
// این مسیرها هرگز مستقیم سرو نمی‌شوند. داده فقط از /api/data و با ثبت‌نام.
const BLOCKED = /^\/(storage|data|server\.js|package\.json|readme\.md)(\/|$)/i;

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
function writeJson(file, obj){ fs.mkdirSync(path.dirname(file),{recursive:true}); const t=file+".tmp"; fs.writeFileSync(t, JSON.stringify(obj,null,1)); fs.renameSync(t,file); }
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

// داده فقط برای کاربر ثبت‌نام‌شده و غیرمسدود (یا مدیر)
function serveData(req,res){
  const admin = isAdmin(req), u = userFrom(req);
  if(!admin){
    if(!u) return send(res,401,{error:"ابتدا ثبت‌نام کنید.",code:"unregistered"});
    if(u.blocked) return send(res,403,{error:"دسترسی حساب شما بسته شده است.",code:"blocked"});
  }
  fs.readFile(DATA_FILE,(err,buf)=>{
    if(err) return send(res,404,{error:"فایل داده هنوز بارگذاری نشده است."});
    res.writeHead(200,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Cache-Control":"no-store"}); res.end(buf);
  });
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
  if(url==="/api/admin/picks"){
    const cells = Object.values(picks.cells).sort((a,b)=>b.n-a.n).slice(0,500);
    return send(res,200,{cells});
  }
  if(url==="/api/admin/data-info"){
    let info = {exists:false}; try{ const st=fs.statSync(DATA_FILE); info={exists:true,size:st.size,mtime:st.mtime.toISOString()}; }catch(e){}
    let backups=[]; try{ backups = fs.readdirSync(BACKUPS).filter(f=>f.endsWith(".xlsx")).sort().reverse().map(f=>({name:f,size:fs.statSync(path.join(BACKUPS,f)).size})); }catch(e){}
    return send(res,200,{...info,backups});
  }
  if(url==="/api/admin/data" && req.method==="POST"){
    let buf; try{ buf = await readBody(req,MAX_UPLOAD); }catch(e){ return send(res,413,{error:"حجم فایل بیش از ۲۵ مگابایت است."}); }
    if(buf.length<100 || buf.readUInt32LE(0)!==0x04034b50) return send(res,400,{error:"فایل xlsx معتبر نیست."});
    try{
      fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true}); fs.mkdirSync(BACKUPS,{recursive:true});
      if(fs.existsSync(DATA_FILE)){
        fs.copyFileSync(DATA_FILE, path.join(BACKUPS,"listings-"+new Date().toISOString().replace(/[:.]/g,"-")+".xlsx"));
        fs.readdirSync(BACKUPS).filter(f=>f.endsWith(".xlsx")).sort().reverse().slice(5).forEach(f=>fs.unlinkSync(path.join(BACKUPS,f)));
      }
      const t=DATA_FILE+".tmp"; fs.writeFileSync(t,buf); fs.renameSync(t,DATA_FILE);
    }catch(e){ console.error("upload failed:",e.message); return send(res,500,{error:"ذخیره‌ی فایل انجام نشد."}); }
    return send(res,200,{ok:true,size:buf.length});
  }
  send(res,404,{error:"پیدا نشد."});
}

/* ---------- فایل‌های ایستا ---------- */
function serveStatic(req,res){
  let p; try{ p = decodeURIComponent(new URL(req.url,"http://x").pathname); }catch(e){ res.writeHead(400); return res.end(); }
  if(p.endsWith("/")) p += "index.html";
  if(BLOCKED.test(p) || p.includes("\0")){ res.writeHead(404); return res.end("Not found"); }
  const file = path.normalize(path.join(ROOT,p));
  if(!file.startsWith(ROOT+path.sep)){ res.writeHead(404); return res.end("Not found"); }
  fs.readFile(file,(err,buf)=>{
    if(err){ res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200,{"Content-Type":MIME[ext]||"application/octet-stream","Cache-Control":/\.(html|js|webmanifest)$/.test(ext)?"no-cache":"public, max-age=86400","X-Content-Type-Options":"nosniff"});
    res.end(buf);
  });
}

http.createServer(async (req,res)=>{
  try{
    const u = new URL(req.url,"http://x"), url = u.pathname;
    if(url==="/api/register"){ if(req.method==="POST") return await register(req,res); res.writeHead(405,{Allow:"POST"}); return res.end(); }
    if(url==="/api/data"){ if(req.method==="GET") return serveData(req,res); res.writeHead(405,{Allow:"GET"}); return res.end(); }
    if(url==="/api/pick"){ if(req.method==="POST") return await pick(req,res); res.writeHead(405,{Allow:"POST"}); return res.end(); }
    if(url.startsWith("/api/admin/")) return await adminApi(req,res,url,u.searchParams);
    if(req.method!=="GET" && req.method!=="HEAD"){ res.writeHead(405); return res.end(); }
    serveStatic(req,res);
  }catch(e){ console.error(e); if(!res.headersSent) send(res,500,{error:"خطای سرور"}); else res.end(); }
}).listen(PORT,HOST,()=>{
  console.log("http://"+HOST+":"+PORT);
  console.log(ADMIN_ON ? "پنل مدیر: /admin.html" : "هشدار: ADMIN_PASSWORD (حداقل ۸ کاراکتر) تنظیم نشده؛ پنل مدیر غیرفعال است.");
});
