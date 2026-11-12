// تنظیمات اپ ارزش املاک — فقط همین فایل را روی سرور ویرایش کنید.
window.APP_CONFIG = {
  // مسیر فایل داده روی سرور (xlsx یا csv یا json). فایل هر بار هنگام باز شدن اپ خوانده می‌شود.
  dataUrl: "api/data",      // فایل داده فقط برای کاربر ثبت‌نام‌شده سرو می‌شود. فایل خودش در data/listings.xlsx روی سرور است.

  // کلید map.ir. اگر خالی باشد نقشه‌ی OpenStreetMap نمایش داده می‌شود و نام معبر پیدا نمی‌شود.
  // کلید را در پنل map.ir به دامنه‌ی همین اپ محدود کنید.
  mapirKey: "",

  // طبق مستندات map.ir کلید در هدر x-api-key فرستاده می‌شود (mapirKeyMode: "header").
  // اگر مرورگر یا سرور هدر را نپذیرد، اپ خودکار به حالت "query" (کلید در URL) می‌رود.
  mapirKeyMode: "header",
  mapirTileUrl: "https://map.ir/shiveh/xyz/1.0.0/Shiveh:Shiveh@EPSG:3857@png/{z}/{x}/{y}.png",
  mapirTileUrlQuery: "https://map.ir/shiveh/xyz/1.0.0/Shiveh:Shiveh@EPSG:3857@png/{z}/{x}/{y}.png?x-api-key={key}",
  osmTileUrl: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",  // نقشه‌ی پایه‌ی جایگزین بدون کلید (OSM مستقیم، درخواست بدون Referer را مسدود می‌کند)

  // آدرس‌یابی معکوس map.ir برای نمایش نام معبر نقطه‌ی انتخاب‌شده
  mapirReverseUrl: "https://map.ir/reverse",

  // آدرس ثبت‌نام روی سرور (server.js همراه پروژه). اگر خالی باشد ثبت‌نام فقط در همین دستگاه ذخیره می‌شود (فقط برای آزمایش).
  registerUrl: "api/register",
  pickUrl: "api/pick",         // شمارش ناشناس نقطه‌های انتخابی برای پنل مدیر. خالی = غیرفعال

  defaultYear: 1405,          // سال ساخت پیش‌فرض
  yearTolerance: 3,           // پهنای بازه وقتی گزینه‌ی «±۳ سال» روشن است
  radiiMeters: [300, 600, 1000, 2000], // شعاع‌هایی که به‌ترتیب امتحان می‌شوند
  minListings: 3,             // کمترین تعداد آگهی برای نتیجه‌ی «قابل اتکا»
  maxPriceMismatch: 0.03,     // اگر قیمت هر متر با کل‌قیمت÷متراژ بیش از این اختلاف داشت، ردیف کنار گذاشته می‌شود

  center: [36.297, 59.606],   // مرکز نقشه (مشهد)
  zoom: 12,
  bounds: { south: 36.10, north: 36.50, west: 59.35, east: 59.85 } // مختصات خارج از این محدوده نامعتبر است
};
