# DSH Docker 移植版

把 **DSH 客户端 v1.1.7** 完整移植到 Docker，保留全部独有能力：
**同步引擎（Git/WebDAV）**、**插件全家桶**、**状态监控**、**备份恢复**，并提供**双端 Web UI**。

## ✨ 功能清单

### 核心服务
| 服务 | 端口 | 说明 |
|---|---|---|
| DSH 主界面 | 58123 | HTTPS 公网访问（nginx 反代 → 容器 8123） |
| 管理服务 | 58124 | HTTPS 桌面管理页 + 移动端 UI（nginx 反代 → 容器 8124） |

### 公网访问地址
```
https://game.dantezcx.vip:58123   # DSH 主界面（Agent 对话）
https://game.dantezcx.vip:58124   # 桌面管理页（同步/备份/插件/规则）
https://game.dantezcx.vip:58124/m # 移动端 UI
```

### ⚠️ nginx 反代关键配置（403 问题）
DSH 的 `/api` 有浏览器信任检查（browser-trust fence）：
- `settings.describe` 等**特权 API 只允许 loopback**（Host=127.0.0.1）
- 所有 `/api` 要求 **Origin.host === Host.host**
- **因此反代必须把 Host 和 Origin 都伪装为 `127.0.0.1:8123`**，否则浏览器经域名访问全部 403
- 完整配置见 `nginx/nginx.conf`（含 58123 + 58124 两个 server 块）

### 保留的客户端独有能力
- 🔄 **同步引擎**：Git 同步 / WebDAV 双向同步 / 云端恢复 / 自动定时同步
- 💾 **备份包**：tar.gz 快照上传 WebDAV，保留最近 10 份，可列表/恢复
- 🧩 **插件市场**：GitHub 搜索 / README / 一键安装（npm + Git 镜像加速）/ AI 翻译
- 📊 **状态监控**：服务状态 / 会话数 / 插件数 / DeepSeek 余额
- 📖 **规则继承**：扫描 Claude/Cursor/Gemini/Codex/Copilot 规则 → AI 精简导入
- 📁 **归档管理**：归档会话列表 / 取消归档

### 双端 UI
- **桌面管理页** `http://IP:8124/`：深色主题、侧边栏导航、完整管理功能
- **移动端 UI** `http://IP:8124/m`：手机优化（底部导航、触控大按钮、安全区适配、沉浸式深色）

## 🚀 快速开始

### 1. 准备证书
把 HTTPS 证书放入 `certs/`：
```
certs/fullchain.pem   # 证书链
certs/privkey.pem     # 私钥（已被 git 忽略）
```

### 2. 构建并启动
```bash
docker compose up -d --build
```

### 3. 访问
```
https://game.dantezcx.vip:58123   # DSH 主界面（HTTPS）
http://IP:8124/                   # 桌面管理页
http://IP:8124/m                  # 移动端 UI
```

## ⚙️ 配置说明

### API 密钥
首次运行后，把 DeepSeek API Key 放入数据卷：
```bash
docker exec -it dsh sh
cat > /data/.dsh/.credentials.yaml << 'EOF'
api_key: sk-xxxxx
EOF
```
或在容器内 `dsh` 设置界面配置（设置 → API Key）。

### 数据持久化
所有数据存于 Docker 卷 `dsh-data`（映射容器 `/data`）：
- 会话数据：`/data/.dsh/sessions/`
- 配置：`/data/.dsh/settings.yaml`、`client-config.json`
- 插件：`/data/.dsh/profiles/web/`

备份/迁移：`docker run --rm -v dsh-data:/data -v $(pwd):/backup alpine tar czf /backup/dsh-data.tar.gz /data`

### 同步配置
1. 打开管理页 `http://IP:8124/` → 「数据同步」
2. 选择 Git 或 WebDAV，填写地址/账号
3. 选择同步内容（会话/API 密钥/设置），可开启自动同步
4. 「立即同步」测试；「从云端恢复」还原数据

## ⚠️ 部署注意事项（重要）

### 内存管理（防 OOM）
DSH 全家桶（dsh web + 插件 + 管理服务）内存峰值可达 2-3G。**在内存紧张（如 10G）的服务器上**：
- ✅ compose 已内置 `mem_limit: 2g` + `cpus: "4"` + Node 堆 1G 限制
- ⚠️ 若服务器还有其他大容器（如 omniroute/kavita），**建议先停用非关键容器**再启动 DSH，否则可能触发 OOM 系统僵死
- 📝 可用 `docker stats` 监控内存，`free -h` 查看系统内存

### 容器管理
```bash
# 停止非关键容器释放内存（部署 DSH 前）
docker stop kavita omniroute heimdall qd

# 启动 DSH
docker compose up -d

# 查看状态
docker compose ps
```

### 代码热更新
`entrypoint.sh`、`server/`、`web/` 已通过 volume 挂载，修改后 `docker compose restart dsh` 即可生效，无需重建镜像。

## 🔧 常用命令
```bash
docker compose logs -f dsh      # 查看主服务日志
docker compose logs -f nginx    # 查看反代日志
docker compose restart dsh      # 重启
docker compose down             # 停止
```

## 📁 项目结构
```
DSH-docker/
├── Dockerfile           # 镜像构建（node:20-alpine + dsh + 插件）
├── docker-compose.yml   # dsh + nginx 编排
├── entrypoint.sh        # 容器入口（初始化 + 启动双服务）
├── profile-web/         # web profile 声明（插件全家桶清单）
├── server/server.js     # 管理服务（同步/备份/插件/状态 API）
├── web/                 # 双端 UI
│   ├── desktop.html     # 桌面管理页
│   └── mobile.html      # 移动端 UI
├── nginx/nginx.conf     # HTTPS 反代配置
└── certs/               # HTTPS 证书（git 忽略）
```

## 📝 版本说明
- 移植自：DSH 客户端 v1.1.7（Electron 壳）+ `@deepseek-ai/dsh@0.1.0-rc.6` + `@linxin666` 插件全家桶 0.1.12
- 兼容：Docker 25+ / Docker Compose v2
