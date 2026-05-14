# openai-monitor2 VPS 一键命令

这个项目以后按“一个服务器对应一个 GitHub 项目”的方式部署。代码从 `openai-monitor2` 拉取，数据库单独复制到 VPS，不进 GitHub。

## 1. 新 VPS 一键部署

先确保 Cloudflare 里这些 DNS 已经指向 VPS IP：

```text
2人team.com          A  <VPS_IP>
www.2人team.com      A  <VPS_IP>
activate.2人team.com A  <VPS_IP>
admin.2人team.com    A  <VPS_IP>
```

中文域名对应的 punycode：

```text
2人team.com          xn--2team-cd2h.com
www.2人team.com      www.xn--2team-cd2h.com
activate.2人team.com activate.xn--2team-cd2h.com
admin.2人team.com    admin.xn--2team-cd2h.com
```

在新 VPS 上运行这一段。以后开新服务器就按这个格式改域名和仓库，密码会在终端里输入：

```bash
read -rsp "后台密码: " ADMIN_PASS; echo
curl -fsSL https://raw.githubusercontent.com/ppanjinfeng-afk/openai-monitor2/main/deploy/bootstrap-ubuntu.sh \
  | sudo env \
      PUBLIC_TUNNEL_ENABLED=true \
      PUBLIC_BASE_URL='https://xn--2team-cd2h.com' \
      ADMIN_BASIC_AUTH_ENABLED=true \
      ADMIN_BASIC_AUTH_USER='派大星' \
      ADMIN_BASIC_AUTH_PASS="$ADMIN_PASS" \
      CERTBOT_DOMAINS='xn--2team-cd2h.com,www.xn--2team-cd2h.com,activate.xn--2team-cd2h.com,admin.xn--2team-cd2h.com' \
      bash -s -- https://github.com/ppanjinfeng-afk/openai-monitor2.git /opt/openai-monitor
unset ADMIN_PASS
```

如果某个子域名 DNS 还没加好，先从 `CERTBOT_DOMAINS` 里删掉那个域名，等 DNS 生效后再补签。例如后台域名：

```bash
sudo certbot --nginx -d admin.xn--2team-cd2h.com --redirect
sudo systemctl reload nginx
```

激活域名补签：

```bash
sudo certbot --nginx -d activate.xn--2team-cd2h.com --redirect
sudo systemctl reload nginx
```

## 2. 上传旧数据库

在本地电脑运行，把旧库传到 VPS：

```bash
scp ./data/monitor.db ubuntu@<VPS_IP>:/tmp/monitor.db
```

在 VPS 上运行：

```bash
sudo install -o ubuntu -g ubuntu -m 0644 /tmp/monitor.db /opt/openai-monitor/data/monitor.db
sudo rm -f /tmp/monitor.db
sudo systemctl restart openai-monitor
```

如果旧库里购买页开关是维护状态，再打开一次：

```bash
cd /opt/openai-monitor
sudo node - <<'NODE'
const db = require('./db');
db.prepare(`
  INSERT INTO settings (key, value)
  VALUES ('public_tunnel_enabled', 'true')
  ON CONFLICT(key) DO UPDATE SET value = 'true'
`).run();
NODE
sudo systemctl restart openai-monitor
```

## 3. 以后更新代码

```bash
cd /opt/openai-monitor
git pull --ff-only
npm ci --omit=dev
sudo cp deploy/systemd/openai-monitor.service /etc/systemd/system/openai-monitor.service
sudo cp deploy/systemd/openai-monitor-healthcheck.service /etc/systemd/system/openai-monitor-healthcheck.service
sudo cp deploy/systemd/openai-monitor-healthcheck.timer /etc/systemd/system/openai-monitor-healthcheck.timer
sudo cp deploy/systemd/openai-monitor-cdk-expire.service /etc/systemd/system/openai-monitor-cdk-expire.service
sudo cp deploy/systemd/openai-monitor-cdk-expire.timer /etc/systemd/system/openai-monitor-cdk-expire.timer
sudo cp deploy/nginx/openai-monitor.conf /etc/nginx/sites-available/openai-monitor.conf
sudo mkdir -p /etc/systemd/system/openai-monitor.service.d
printf '[Service]\nEnvironment=PUPPETEER_CACHE_DIR=/home/ubuntu/.cache/puppeteer\nEnvironment=PUBLIC_BASE_URL=https://xn--2team-cd2h.com\n' | sudo tee /etc/systemd/system/openai-monitor.service.d/runtime.conf >/dev/null
sudo systemctl daemon-reload
sudo nginx -t
sudo certbot --nginx --non-interactive --agree-tos --redirect --register-unsafely-without-email -d xn--2team-cd2h.com -d www.xn--2team-cd2h.com
sudo certbot --nginx --non-interactive --agree-tos --redirect --register-unsafely-without-email -d activate.xn--2team-cd2h.com
sudo certbot --nginx --non-interactive --agree-tos --redirect --register-unsafely-without-email -d admin.xn--2team-cd2h.com
sudo nginx -t
sudo systemctl restart openai-monitor
sudo systemctl reload nginx
```

注意：`deploy/nginx/openai-monitor.conf` 是基础 HTTP 配置；每次复制它之后都要重跑上面的 `certbot` 三条命令，把 HTTPS 配置重新写回 nginx。

## 4. 设置后台账号密码

在 VPS 上运行。中文用户名也支持：

```bash
read -rsp "后台密码: " ADMIN_PASS; echo
cd /opt/openai-monitor
sudo env \
  ADMIN_BASIC_AUTH_ENABLED=true \
  ADMIN_BASIC_AUTH_USER='派大星' \
  ADMIN_BASIC_AUTH_PASS="$ADMIN_PASS" \
  node deploy/scripts/configure-admin-auth.js
unset ADMIN_PASS
sudo rm -f /etc/systemd/system/openai-monitor.service.d/admin-auth.conf
sudo rm -f /etc/systemd/system/openai-monitor.service.d/zz-admin-auth.conf
sudo systemctl daemon-reload
sudo systemctl restart openai-monitor
```

后台密码只在当前 VPS 终端输入，不写进 GitHub，也不会留在文档里。

## 5. 当前站点分工

```text
购买页：https://2人team.com/buy
购买域名加入页：https://2人team.com/join
只有激活页：https://activate.2人team.com/
只有激活页备用路径：https://activate.2人team.com/join
后台：https://admin.2人team.com/
```

激活域名的限制：

```text
https://activate.2人team.com/      -> 激活页
https://activate.2人team.com/join  -> 激活页
https://activate.2人team.com/buy   -> 跳回 /
https://activate.2人team.com/admin-login -> 404
```

## 6. 检查状态

```bash
systemctl status openai-monitor --no-pager
systemctl status nginx --no-pager
systemctl status openai-monitor-healthcheck.timer --no-pager
systemctl status openai-monitor-cdk-expire.timer --no-pager
curl http://127.0.0.1:3000/api/checks/status
```
