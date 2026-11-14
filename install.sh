#!/usr/bin/env bash
# نصب اپ قیمت متر روی Debian 12 / Ubuntu (با دسترسی root).
#   bash install.sh <دامنه> <رمز-مدیر> <ایمیل> [کلید-mapir]
#   bash install.sh -  <رمز-مدیر>  [-]  [کلید-mapir]      ← بدون دامنه (فقط با IP و HTTP)
# نمونه‌ها:
#   bash install.sh price.example.ir 'Admin_Pass-2026' me@example.com
#   bash install.sh - 'Admin_Pass-2026'
# در حالت بدون دامنه، صفحه‌ی مدیر از اینترنت بسته است و فقط با تونل SSH باز می‌شود
# (برای باز کردن عمومی، قبل از اجرا ALLOW_PUBLIC_ADMIN=1 بگذارید؛ توصیه نمی‌شود).
# دوباره اجرا کردنش امن است: کاربران (storage) و فایل داده (data) را بازنویسی نمی‌کند.
set -euo pipefail

die(){ echo "خطا: $*" >&2; exit 1; }
say(){ echo; echo "==> $*"; }

[ "$(id -u)" = 0 ] || die "با کاربر root اجرا کنید (یا با sudo)."
DOMAIN="${1:-}"; PASS="${2:-}"; EMAIL="${3:-}"; MAPKEY="${4:-}"
[ "$EMAIL" = "-" ] && EMAIL=""
[ "$MAPKEY" = "-" ] && MAPKEY=""
[ -n "$DOMAIN" ] && [ -n "$PASS" ] || die "نحوه‌ی اجرا: bash install.sh <دامنه یا -> <رمز-مدیر> [ایمیل] [کلید-mapir]"
MODE=domain; [ "$DOMAIN" = "-" ] && MODE=ip
if [ "$MODE" = domain ]; then
  [ -n "$EMAIL" ] || die "برای حالت دامنه ایمیل هم لازم است (برای هشدار انقضای گواهی)."
  [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "دامنه معتبر نیست (مثل price.example.ir، بدون http)."
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "ایمیل معتبر نیست."
fi
[[ "$PASS" =~ ^[A-Za-z0-9._@%+=:,!~^-]{8,64}$ ]] || die "رمز مدیر باید ۸ تا ۶۴ کاراکتر باشد و فقط شامل حروف لاتین، عدد و این نمادها: . _ @ % + = : , ! ~ ^ -"
if [ -n "$MAPKEY" ]; then [[ "$MAPKEY" =~ ^[A-Za-z0-9._-]+$ ]] || die "کلید map.ir شکل نامعتبر دارد."; fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/arzesh-app
[ -f "$SRC/server.js" ] && [ -f "$SRC/index.html" ] || die "این اسکریپت باید کنار server.js و index.html اجرا شود."

say "نصب بسته‌ها"
export DEBIAN_FRONTEND=noninteractive
PKGS="nodejs nginx rsync curl ca-certificates"
[ "$MODE" = domain ] && PKGS="$PKGS certbot python3-certbot-nginx"
apt-get update -y
# shellcheck disable=SC2086
apt-get install -y $PKGS
NODEV="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODEV" -ge 16 ] || die "نسخه‌ی Node ($(node -v)) قدیمی است؛ ۱۶ یا بالاتر لازم است."

say "کپی اپ در $APP"
id arzesh >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin arzesh
mkdir -p "$APP"
if [ "$SRC" != "$APP" ]; then
  rsync -a --exclude 'storage/' --exclude 'data/' --exclude 'install.sh' --exclude '.git' --exclude '.gitignore' "$SRC"/ "$APP"/
  if [ ! -f "$APP/data/listings.xlsx" ]; then mkdir -p "$APP/data"; cp -a "$SRC"/data/. "$APP/data/" 2>/dev/null || true; fi
fi
mkdir -p "$APP/storage"
if [ -n "$MAPKEY" ]; then
  sed -i "s|mapirKey: \"[^\"]*\"|mapirKey: \"$MAPKEY\"|" "$APP/config.js"
  grep -q "mapirKey: \"$MAPKEY\"" "$APP/config.js" || die "نشد کلید map.ir را در config.js بنویسم."
fi
chown -R arzesh:arzesh "$APP"
chmod 700 "$APP/storage"   # شماره‌ی موبایل کاربران اینجاست؛ فقط خود سرویس بخواند
chmod 750 "$APP/data"

say "رمز مدیر و سرویس systemd"
umask 077
printf 'ADMIN_PASSWORD=%s\n' "$PASS" > /etc/arzesh.env
chmod 600 /etc/arzesh.env
umask 022
cat > /etc/systemd/system/arzesh.service <<EOF
[Unit]
Description=Arzesh app
After=network.target

[Service]
User=arzesh
WorkingDirectory=$APP
EnvironmentFile=/etc/arzesh.env
Environment=PORT=8080
Environment=HOST=127.0.0.1
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$APP

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable arzesh >/dev/null
systemctl restart arzesh
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS -o /dev/null http://127.0.0.1:8080/index.html && break
  sleep 1
  [ "$i" = 10 ] && { journalctl -u arzesh -n 30 --no-pager; die "سرویس بالا نیامد."; }
done
echo "سرویس اپ روی 127.0.0.1:8080 بالا آمد."

say "nginx"
LISTEN_EXTRA=""; SNAME="$DOMAIN"; ADMIN_BLOCK=""
if [ "$MODE" = ip ]; then
  # بدون دامنه: این سایت پیش‌فرض پورت ۸۰ می‌شود و سایت نمونه‌ی خود nginx کنار گذاشته می‌شود.
  rm -f /etc/nginx/sites-enabled/default
  LISTEN_EXTRA=" default_server"; SNAME="_"
  if [ "${ALLOW_PUBLIC_ADMIN:-0}" != 1 ]; then
    ADMIN_BLOCK="    location = /admin.html { return 404; }
    location ^~ /api/admin/ { return 404; }"
  fi
fi
cat > /etc/nginx/sites-available/arzesh <<EOF
server {
    listen 80$LISTEN_EXTRA;
    listen [::]:80$LISTEN_EXTRA;
    server_name $SNAME;
    client_max_body_size 30m;
$ADMIN_BLOCK
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/arzesh /etc/nginx/sites-enabled/arzesh
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx

PROTO=http
if [ "$MODE" = domain ]; then
  say "گواهی HTTPS (Let's Encrypt)"
  if getent hosts "$DOMAIN" >/dev/null; then
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
      PROTO=https
    else
      echo "هشدار: گرفتن گواهی HTTPS انجام نشد. اپ فعلاً روی HTTP کار می‌کند (نصب روی گوشی و امنیت رمز مدیر به HTTPS نیاز دارد)."
      echo "بررسی کنید: رکورد A دامنه روی IP همین سرور باشد و پورت ۸۰ از بیرون باز باشد. بعد دوباره همین اسکریپت را اجرا کنید."
    fi
  else
    echo "هشدار: دامنه‌ی $DOMAIN هنوز به IP نرسیده (DNS). رکورد A را بسازید، چند دقیقه صبر کنید و دوباره این اسکریپت را اجرا کنید."
  fi
else
  DOMAIN="$(curl -4 -fsS --max-time 8 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
fi

say "پشتیبان‌گیری روزانه"
cat > /etc/cron.d/arzesh-backup <<'EOF'
0 3 * * * root umask 077; tar czf /var/backups/arzesh-$(date +\%F).tgz -C /opt/arzesh-app storage data && find /var/backups -name 'arzesh-*.tgz' -mtime +14 -delete
EOF
chmod 644 /etc/cron.d/arzesh-backup
chmod 600 /var/backups/arzesh-*.tgz 2>/dev/null || true   # پشتیبان‌های قبلی هم فقط برای root

say "تمام شد"
echo "اپ کاربر:   $PROTO://$DOMAIN/"
if [ "$MODE" = ip ] && [ "${ALLOW_PUBLIC_ADMIN:-0}" != 1 ]; then
  echo "پنل مدیر:   از اینترنت بسته است (چون HTTPS ندارید). از کامپیوتر خودتان یک تونل SSH باز کنید:"
  echo "     ssh -L 8081:127.0.0.1:8080 root@$DOMAIN"
  echo "   و تا وقتی آن پنجره باز است در مرورگر بزنید: http://localhost:8081/admin.html"
else
  echo "پنل مدیر:   $PROTO://$DOMAIN/admin.html   (رمز همان است که دادید)"
fi
if [ "$MODE" = ip ]; then
  echo "هشدار: بدون HTTPS شماره‌ی موبایل و توکن کاربران بدون رمزنگاری عبور می‌کند؛ فقط برای تست."
  echo "وقتی دامنه آماده شد: bash install.sh <دامنه> <رمز> <ایمیل>"
fi
echo "وضعیت سرویس: systemctl status arzesh      لاگ: journalctl -u arzesh -f"
echo "پشتیبان‌ها: /var/backups/arzesh-*.tgz (۱۴ روز اخیر)"
[ -n "$MAPKEY" ] || echo "یادآوری: کلید map.ir را در $APP/config.js (mapirKey) بگذارید، بعد: systemctl restart arzesh"
