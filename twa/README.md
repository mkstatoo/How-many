# نسخه‌ی اندروید injachande (TWA) برای کافه‌بازار و مایکت

برنامه‌ی اندروید همان سایت `https://injachande.ir` است که با Bubblewrap داخل یک APK بسته‌بندی می‌شود (Trusted Web Activity). کد برنامه یک‌بار در سرور نوشته می‌شود و با هر دیپلوی، نسخه‌ی اندروید هم به‌روز می‌شود؛ فقط تغییر آیکن/نام/نسخه‌ی بسته به ساخت دوباره‌ی APK نیاز دارد.

> این مراحل را روی **کامپیوتر خودتان** انجام دهید (نه روی سرور): ساخت APK به JDK و Android SDK نیاز دارد و کلید امضا نباید جایی غیر از دست شما باشد.

## پیش‌نیازها
- Node.js 18 یا بالاتر
- JDK 17 (باید دستور `keytool` کار کند)
- `npm i -g @bubblewrap/cli` (در اولین اجرا خودش Android SDK را دانلود می‌کند)

## ۱. ساخت کلید امضا (فقط یک‌بار)
```bash
keytool -genkeypair -v -keystore injachande.keystore -alias injachande \
  -keyalg RSA -keysize 2048 -validity 10000
```
- رمزها را یادداشت کنید و از `injachande.keystore` **دست‌کم دو نسخه‌ی پشتیبان** در جاهای جدا نگه دارید. با گم شدن آن نمی‌توانید نسخه‌ی جدید روی همان صفحه‌ی برنامه بگذارید.
- این فایل در `.gitignore` هست و نباید در گیت برود.

## ۲. ساخت APK
```bash
mkdir injachande-android && cd injachande-android
cp /مسیر/How-many/twa/twa-manifest.json .      # مقادیر مرجع این پروژه
cp /مسیر/injachande.keystore .
bubblewrap init --manifest=https://injachande.ir/manifest.webmanifest
```
در پرسش‌ها همان مقادیر `twa-manifest.json` را بدهید:

| پرسش | مقدار |
|---|---|
| Application ID | `ir.injachande.app` (بعد از انتشار قابل تغییر نیست) |
| App name / Launcher name | `injachande` |
| Start URL | `/index.html` |
| Display | `standalone` · Orientation: `portrait` |
| Theme / Background color | `#0a1a21` |
| Signing key | همان `injachande.keystore` با alias `injachande` |

سپس:
```bash
bubblewrap build
```
خروجی: `app-release-signed.apk` (برای نصب مستقیم و آپلود در بازار) و `app-release-bundle.aab`.

## ۳. فایل assetlinks (برای تمام‌صفحه شدن، بدون نوار آدرس مرورگر)
بدون این مرحله برنامه با نوار آدرس مرورگر باز می‌شود.
```bash
cd /مسیر/How-many
tools/make-assetlinks.sh /مسیر/injachande.keystore injachande ir.injachande.app
```
این اسکریپت اثر انگشت SHA-256 کلید شما را می‌خواند و `.well-known/assetlinks.json` را می‌نویسد. فایل را کامیت و دیپلوی کنید (یا فقط روی سرور در `/opt/arzesh-app/.well-known/assetlinks.json` بگذارید، سپس `chown arzesh:arzesh`). بررسی:
```bash
curl -s https://injachande.ir/.well-known/assetlinks.json
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://injachande.ir&relation=delegate_permission/common.handle_all_urls"
```
اگر فروشگاه APK را با کلید خودش دوباره امضا کند، اثر انگشت جدیدش را هم اضافه کنید:
`tools/make-assetlinks.sh KEYSTORE ALIAS ir.injachande.app --extra AA:BB:…:FF`

## ۴. آزمایش روی گوشی
```bash
adb install app-release-signed.apk
```
باید برنامه تمام‌صفحه و بدون نوار آدرس باز شود. اگر نوار آدرس دیده شد، assetlinks یا اثر انگشت درست نیست.

## ۵. فهرست انتشار در بازار
- APK امضاشده (و در صورت درخواست AAB)
- آیکن ۵۱۲×۵۱۲: `icons/icon-512.png`
- اسکرین‌شات‌ها: `screenshots/start.png` + عکس تازه از برگه‌ی نتیجه (بعد از دیپلوی آخرین نسخه بگیرید)
- لینک حریم خصوصی: `https://injachande.ir/privacy.html` (در `config.js` سرور مقدار `contact` را با ایمیل یا آیدی پشتیبانی پر کنید تا در صفحه دیده شود)
- توضیح فارسی: «میانگین قیمت هر متر مربع ملک و تخمین قیمت در مشهد، از روی آگهی‌ها»
- هشدار روشن: قیمت‌ها برآوردی و بر پایه‌ی قیمت پیشنهادی آگهی است، نه قیمت معامله
- شرایط و فیلدهای فعلی پنل توسعه‌دهنده‌ی بازار (احراز هویت، رده‌ی سنی و…) را از خود پنل بخوانید؛ این‌ها تغییر می‌کنند.

## ۶. نسخه‌ی بعدی
در `twa-manifest.json` مقدار `appVersionCode` را یکی زیاد کنید (و `appVersionName`)، سپس `bubblewrap update` و `bubblewrap build`، و APK جدید را در پنل بارگذاری کنید.

## محدودیت‌ها
- TWA به Chrome روی گوشی نیاز دارد؛ اگر نصب نباشد، برنامه در مرورگر دیگری باز می‌شود (`fallbackType: customtabs`). اگر بخش بزرگی از کاربران شما بدون Chrome هستند، بسته‌بندی با Capacitor (وب‌ویو داخلی) را در نظر بگیرید.
- ثبت‌نام با شماره موبایل است؛ بازارها ممکن است برای برنامه‌هایی که حساب کاربری می‌سازند راه حذف حساب بخواهند. این راه آماده است: صفحه‌ی `privacy.html` دکمه‌ی «حذف حساب من» دارد.
