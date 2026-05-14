# openai-monitor2 VPS 一键命令

这个项目以后按“一个服务器对应一个 GitHub 项目”的方式部署。代码从 `openai-monitor2` 拉取，数据库单独复制到 VPS，不进 GitHub。

## 1. 新 VPS 一键部署

先确保 Cloudflare 里这些 DNS 已经指向 VPS IP：

```text
2人team.com        A  <VPS_IP>
www.2人team.com    A  <VPS_IP>
admin.2人team.com  A  <VPS_IP>
```

中文域名对应的 punycode：

```text
2人team.com        xn--2team-cd2h.com
www.2人team.com    www.xn--2team-cd2h.com
admin.2人team.com  admin.xn--2team-cd2h.com
```

在新 VPS 上运行：

```bash
curl -fsSL https://raw.githubusercontent.com/ppanjinfeng-afk/openai-monitor2/main/deploy/bootstrap-ubuntu.sh \
  | sudo env \
      PUBLIC_TUNNEL_ENABLED=true \
      ADMIN_BASIC_AUTH_ENABLED=true \
      ADMIN_BASIC_AUTH_USER=admin \
      ADMIN_BASIC_AUTH_PASS='CHANGE_THIS_ADMIN_PASSWORD' \
      CERTBOT_DOMAINS='xn--2team-cd2h.com,www.xn--2team-cd2h.com,admin.xn--2team-cd2h.com' \
      bash -s -- https://github.com/ppanjinfeng-afk/openai-monitor2.git /opt/openai-monitor
```

如果 `admin.2人team.com` 的 DNS 还没加好，先把 `CERTBOT_DOMAINS` 里的 `admin.xn--2team-cd2h.com` 删除，等 DNS 生效后再运行：

```bash
sudo certbot --nginx -d admin.xn--2team-cd2h.com --redirect
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
sudo systemctl daemon-reload
sudo nginx -t
sudo systemctl restart openai-monitor
sudo systemctl reload nginx
```

## 4. 检查状态

```bash
systemctl status openai-monitor --no-pager
systemctl status nginx --no-pager
systemctl status openai-monitor-healthcheck.timer --no-pager
systemctl status openai-monitor-cdk-expire.timer --no-pager
curl http://127.0.0.1:3000/api/checks/status
```

访问地址：

```text
购买页：https://2人team.com/buy
兑换页：https://2人team.com/join
后台：https://admin.2人team.com/
```
