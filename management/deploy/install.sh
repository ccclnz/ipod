#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
site=/var/www/laposabulb-ipod
state=/var/lib/ipod-manager
app=/opt/ipod-manager
# Preserve catalog edits, owner credentials, and existing public assets on redeploy.
getent passwd ipod-manager >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin ipod-manager
install -d -m 755 "$app/deploy" /var/www/ipod-manager-acme
install -d -m 755 -o ipod-manager -g www-data "$state" "$state/audio"
install -m 644 management/server.py management/admin.* "$app/"
install -m 644 management/deploy/nginx-https.conf "$app/deploy/"
install -m 755 management/deploy/activate-https "$app/deploy/"
if [ ! -e "$state/catalog.json" ]; then
    install -m 644 -o ipod-manager -g www-data dist/catalog.json "$state/catalog.json"
fi
if [ ! -e /root/ipod-manager-password ]; then
    (umask 077; openssl rand -hex 24 > /root/ipod-manager-password)
fi
hash=$(openssl passwd -6 -stdin < /root/ipod-manager-password)
install -m 640 -g www-data /dev/null /etc/nginx/ipod-manager.htpasswd
printf 'admin:%s\n' "$hash" > /etc/nginx/ipod-manager.htpasswd
install -m 644 management/deploy/ipod-manager*.service management/deploy/ipod-manager-https.timer /etc/systemd/system/
install -m 644 management/deploy/nginx-http.conf /etc/nginx/sites-enabled/ipod-manager-http
nginx -t
systemctl daemon-reload
systemctl enable ipod-manager.service
systemctl restart ipod-manager.service
systemctl reload nginx
if [ ! -e /etc/nginx/sites-enabled/ipod-manager-https ]; then
    systemctl enable --now ipod-manager-https.timer
fi
for pair in "catalog.json catalog.json" "audio uploaded-audio"; do
    read -r source target <<< "$pair"
    if [ ! -L "$site/$target" ]; then ln -s "$state/$source" "$site/$target"; fi
done
install -m 644 dist/band.js "$site/band.js.new"
mv "$site/band.js.new" "$site/band.js"
install -m 644 dist/style.css "$site/style.css.new"
mv "$site/style.css.new" "$site/style.css"
sed -i -E 's@band\.js\?v=[A-Za-z0-9_-]+@band.js?v=catalog-7@g; s@style\.css\?v=[A-Za-z0-9_-]+@style.css?v=catalog-4@g' "$site/index.html"
