#!/usr/bin/env bash
# ساخت .well-known/assetlinks.json از روی keystore (اثر انگشت SHA-256 گواهی امضا).
# استفاده:   tools/make-assetlinks.sh twa/injachande.keystore injachande ir.injachande.app
# بعد از اجرا فایل را روی سرور بگذارید و بررسی کنید:  curl -s https://injachande.ir/.well-known/assetlinks.json
# اگر برنامه را در بازار/پلی با «امضای خودِ فروشگاه» (Play App Signing) منتشر می‌کنید، اثر انگشت آن را هم با --extra اضافه کنید:
#   tools/make-assetlinks.sh KEYSTORE ALIAS PACKAGE --extra AA:BB:...:FF
set -euo pipefail
KS="${1:?مسیر keystore}"; ALIAS="${2:?alias}"; PKG="${3:?packageId}"; shift 3
EXTRA=()
while [ $# -gt 0 ]; do case "$1" in --extra) EXTRA+=("${2:?}"); shift 2;; *) echo "گزینه‌ی نامعتبر: $1" >&2; exit 2;; esac; done
command -v keytool >/dev/null || { echo "keytool پیدا نشد (JDK نصب کنید)" >&2; exit 1; }
FP=$(keytool -list -v -keystore "$KS" -alias "$ALIAS" 2>/dev/null | awk -F': ' '/SHA256:/{print $2; exit}' | tr -d '[:space:]')
[ -n "$FP" ] || { echo "اثر انگشت خوانده نشد؛ رمز keystore را در صورت درخواست وارد کنید یا alias را بررسی کنید." >&2; exit 1; }
ALL=("$FP" "${EXTRA[@]}")
OUT="$(cd "$(dirname "$0")/.." && pwd)/.well-known/assetlinks.json"
mkdir -p "$(dirname "$OUT")"
python3 - "$PKG" "$OUT" "${ALL[@]}" <<'PY'
import json,re,sys
pkg,out,*fps=sys.argv[1:]
for f in fps:
    if not re.fullmatch(r'([0-9A-F]{2}:){31}[0-9A-F]{2}',f.upper()): sys.exit('اثر انگشت نامعتبر: '+f)
json.dump([{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":pkg,"sha256_cert_fingerprints":[f.upper() for f in fps]}}],open(out,'w'),indent=2)
open(out,'a').write("\n"); print("نوشته شد:",out)
PY
cat "$OUT"
