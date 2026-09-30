#!/usr/bin/env bash
# Раскатка «Гаража» на тот же VPS, где живёт бюджет ДИТ. Идемпотентно.
#
#   ./server/deploy.sh [root@IP] [домен]
#
# Пароль здесь не участвует: доступ по ssh-ключу, пароль сайта задаётся
# отдельно — node server/set-password.mjs
set -euo pipefail

TARGET="${1:-root@109.68.212.36}"
DOMAIN="${2:-bikes.severyanov.site}"
KEY="${SSH_KEY:-$HOME/.ssh/dit_vps_rsa}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$TARGET")
RSYNC_E="ssh -i $KEY -o StrictHostKeyChecking=accept-new"

echo "==> собираю и проверяю"
cd "$HERE"
python3 build.py
node test.js

echo "==> связь с $TARGET"
"${SSH[@]}" 'echo "  ок: $(hostname), node $(node -v 2>/dev/null || echo нет)"'

echo "==> место под приложение"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
id -u bikes >/dev/null 2>&1 || useradd --system --home /var/lib/bikes --shell /usr/sbin/nologin bikes
mkdir -p /opt/bikes/assets /var/lib/bikes/backups
chown -R bikes:bikes /var/lib/bikes
REMOTE

# Первая раскатка: переносим данные из Cloudflare, пока он ещё отвечает.
# Дальше сервер сам себе источник правды, и сюда мы больше не заглядываем.
if "${SSH[@]}" 'test -f /var/lib/bikes/state.json'; then
  echo "==> состояние на сервере уже есть, перенос пропускаю"
else
  echo "==> переношу данные из Cloudflare"
  SEED="$(mktemp)"
  if curl -fsS --max-time 25 https://bikes-sync.severyanov.workers.dev/doc \
       | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
           const d=JSON.parse(s);
           if(!d||typeof d.rev!=="number"||!d.doc) { console.error("в облаке пусто"); process.exit(1); }
           process.stdout.write(JSON.stringify({rev:d.rev,doc:d.doc}));
           console.error(`  ревизия ${d.rev}, событий ${(d.doc.events||[]).length}, отмеченных списков ${Object.keys(d.doc.checks||{}).length}`);
         })' > "$SEED"; then
    rsync -az -e "$RSYNC_E" "$SEED" "$TARGET:/var/lib/bikes/state.json"
    "${SSH[@]}" 'chown bikes:bikes /var/lib/bikes/state.json && chmod 600 /var/lib/bikes/state.json'
    echo "  перенесено"
  else
    echo "  !! Cloudflare недоступен — сайт поднимется пустым."
    echo "  !! Не входите и ничего не меняйте, пока данные не перенесены,"
    echo "  !! иначе пустой документ уедет поверх настоящего."
    rm -f "$SEED"; exit 1
  fi
  rm -f "$SEED"
fi

echo "==> заливаю приложение"
rsync -az -e "$RSYNC_E" "$HERE/index.html" "$HERE/server/server.js" "$TARGET:/opt/bikes/"
rsync -az -e "$RSYNC_E" "$HERE/assets/" "$TARGET:/opt/bikes/assets/"
# Права ставим на сервере, а не переносим с Мака: там файлы бывают 600, и
# сервис, работающий не от root, не может их прочитать — 23.09 сайт так уже
# падал. rsync --chmod не годится: системный rsync в macOS его не знает.
"${SSH[@]}" 'find /opt/bikes -type d -exec chmod 755 {} + && find /opt/bikes -type f -exec chmod 644 {} +'

echo "==> сервис и nginx"
"${SSH[@]}" DOMAIN="$DOMAIN" bash -s <<'REMOTE'
set -euo pipefail
chown -R root:root /opt/bikes

cat > /etc/systemd/system/bikes.service <<UNIT
[Unit]
Description=Гараж — велосипеды, ТО и затраты
After=network.target

[Service]
Type=simple
User=bikes
WorkingDirectory=/opt/bikes
Environment=APP_DIR=/opt/bikes
Environment=DATA_DIR=/var/lib/bikes
Environment=PORT=8788
# минус: пока пароль не задан, файла нет, и сервис всё равно должен подняться —
# сайт будет открыт на чтение, вход отдаст 503
EnvironmentFile=-/etc/bikes.env
ExecStart=/usr/bin/node /opt/bikes/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/bikes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable bikes >/dev/null 2>&1
# именно restart: enable --now не перезапускает работающий сервис
systemctl restart bikes
sleep 2
systemctl is-active --quiet bikes && echo "  сервис запущен" || { journalctl -u bikes -n 30 --no-pager; exit 1; }

# Главный адрес сайта — https://${DOMAIN}:8443, а 443 и 80 только отправляют
# туда. Причина: домашний провайдер владельца (SkyNet, Петербург) с 26.09
# периодически глушит порт 443 этого сервера — TCP-рукопожатие проходит, а
# первый пакет с данными пропадает по дороге, при любом имени сайта. Порт 80
# и 8443 в это время проходят. Один главный адрес, а не два равноправных:
# браузер считает :443 и :8443 разными сайтами, и вход с настройками пришлось
# бы делать дважды.
#
# Редирект 302, а не 301: 301 браузер запоминает навсегда, и если провайдер
# перестанет глушить 443, вернуть стандартный адрес было бы нельзя.
# Внутри location, а не на уровне server: certbot при продлении вставляет
# точное location для проверки домена, и оно должно выигрывать.
CERT=/etc/letsencrypt/live/${DOMAIN}
if [ -f "$CERT/fullchain.pem" ]; then
  [ -f "$CERT/shortchain.pem" ] || /usr/local/bin/dit-trim-chain
cat > /etc/nginx/sites-available/bikes <<NGINX
server {
    listen 8443 ssl;
    listen [::]:8443 ssl;
    server_name ${DOMAIN};
    ssl_certificate ${CERT}/shortchain.pem;
    ssl_certificate_key ${CERT}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # документ вместе с фотографиями
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_http_version 1.1;
        proxy_read_timeout 30s;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN};
    ssl_certificate ${CERT}/shortchain.pem;
    ssl_certificate_key ${CERT}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    location / { return 302 https://${DOMAIN}:8443\$request_uri; }
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location / { return 302 https://${DOMAIN}:8443\$request_uri; }
}
NGINX
  echo "  nginx: главный адрес — :8443, порты 443 и 80 отправляют туда"
else
# Сертификата ещё нет: временный конфиг на 80, чтобы certbot смог выпустить.
cat > /etc/nginx/sites-available/bikes <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    client_max_body_size 12m;
    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_http_version 1.1;
        proxy_read_timeout 30s;
    }
}
NGINX
  echo "  nginx: сертификата нет — временный конфиг на 80; выпустите сертификат и запустите раскатку ещё раз"
fi
ufw allow 8443/tcp >/dev/null 2>&1 || true

# Ссылка называется zz-bikes нарочно: sites-enabled подключается по маске и
# сортируется по алфавиту, а первый блок становится сервером по умолчанию для
# запросов с незнакомым Host. «bikes» встал бы раньше «dit-budget» и молча
# перехватил бы эту роль у бюджета.
rm -f /etc/nginx/sites-enabled/bikes
ln -sf /etc/nginx/sites-available/bikes /etc/nginx/sites-enabled/zz-bikes
nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo "  nginx перезагружен"

# Чистка старых копий состояния — сервер кладёт по одной в день.
cat > /etc/cron.daily/bikes-backup-prune <<'CRON'
#!/bin/sh
find /var/lib/bikes/backups -name 'state-*.json' -mtime +30 -delete
CRON
chmod +x /etc/cron.daily/bikes-backup-prune
REMOTE

echo "==> проверка"
"${SSH[@]}" 'curl -fsS http://127.0.0.1:8788/healthz && echo " — сервер отвечает"'
"${SSH[@]}" 'echo -n "  ревизия на сервере: "; curl -fsS http://127.0.0.1:8788/api/doc | node -e "let s=\"\";process.stdin.on(\"data\",c=>s+=c).on(\"end\",()=>console.log(JSON.parse(s).rev))"'

echo
echo "==> готово. Дальше, когда домен уже смотрит на сервер:"
echo "    ssh -i $KEY $TARGET \"certbot certonly --nginx -d $DOMAIN --agree-tos -m danilseveryanov@gmail.com -n\""
echo "    node server/set-password.mjs $TARGET"
