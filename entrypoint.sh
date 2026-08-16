#!/bin/sh
# ============================================================
# DSH Docker 移植版 — 容器入口
# 职责：
#   1. 初始化 ~/.dsh 数据目录（首次运行复制 profile + 插件）
#   2. 启动 dsh web 主服务（端口 8123，桌面 Web UI）
#   3. 启动客户端管理服务（端口 8124，同步引擎/管理 API/移动端 UI）
# ============================================================
set -e

export DSH_HOME="${DSH_HOME:-/data/.dsh}"
export DSH_WEB_PORT="${DSH_WEB_PORT:-8123}"
export DSH_MGMT_PORT="${DSH_MGMT_PORT:-8124}"
export DSH_PROFILE_DIR="${DSH_PROFILE_DIR:-/opt/dsh-profile}"

log() { echo "[entrypoint] $(date '+%F %T') $*"; }

# ---------- 1. 初始化数据目录 ----------
if [ ! -f "$DSH_HOME/profiles/web/package.json" ]; then
  log "首次运行：初始化 DSH 数据目录 → $DSH_HOME"
  mkdir -p "$DSH_HOME/profiles"
  # 复制预构建的 web profile（含全部插件 node_modules）
  cp -r "$DSH_PROFILE_DIR" "$DSH_HOME/profiles/web"
  # 客户端 v1.1.7 的 cordis patch（插件市场挂载）
  cat > "$DSH_HOME/profiles/web/cordis.patch.yml" << 'PATCH'
# dsh-plugin-marketplace: client-only plugin (no dsh.bundle), mounted via patch
- insert:
    - id: dsh-plugin-marketplace
      name: 'dsh-plugin-marketplace'
PATCH
  # 同步用 .gitignore（WebDAV/Git 同步时忽略大目录）
  cat > "$DSH_HOME/.gitignore" << 'GI'
node_modules/
profiles/*/node_modules/
*.log
.git/
.DS_Store
profiles/*/pnpm-lock.yaml
profiles/*/pnpm-workspace.yaml
GI
  # settings.yaml 初始配置
  if [ ! -f "$DSH_HOME/settings.yaml" ]; then
    cat > "$DSH_HOME/settings.yaml" << 'SET'
ui-onboarding:
  welcomeNoticeVersion: docker-1.0
SET
  fi
  log "✅ 数据目录初始化完成"
else
  log "数据目录已存在，跳过初始化"
fi

# 关键：把 profile 插件符号链接到 dsh 全局 node_modules，
# 使 cordis loader 能解析 @linxin666/* 等 bundle（与客户端本机机制一致）
log "建立插件符号链接..."
GLOBAL_NM="/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules"
PROFILE_NM="$DSH_HOME/profiles/web/node_modules"
if [ -d "$PROFILE_NM/@linxin666" ]; then
  mkdir -p "$GLOBAL_NM/@linxin666"
  for pkg in "$PROFILE_NM"/@linxin666/*; do
    [ -e "$pkg" ] && ln -sfn "$pkg" "$GLOBAL_NM/@linxin666/$(basename "$pkg")"
  done
  for pkg in dsh-chat-import dsh-plugin-marketplace; do
    if [ -d "$PROFILE_NM/$pkg" ]; then
      ln -sfn "$PROFILE_NM/$pkg" "$GLOBAL_NM/$pkg"
    fi
  done
  log "✅ 插件符号链接完成"
fi

# 确保权限
chmod -R u+rw "$DSH_HOME" 2>/dev/null || true

# ---------- 2. 启动 dsh web 主服务（后台） ----------
log "启动 dsh web 主服务 (端口 $DSH_WEB_PORT)..."
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1024}"
# dsh web 出于安全只允许 127.0.0.1（防远程代码执行）；
# 容器用 host 网络，127.0.0.1 即宿主 127.0.0.1，宿主 nginx 可直接反代
# --trusted-host：放行公网域名访问（浏览器信任检查，否则 403）
# 需包含带端口的完整 authority（浏览器 Origin 是 https://host:port）
TRUSTED_HOST=""
if [ -n "$DSH_TRUSTED_HOST" ]; then
  for h in $DSH_TRUSTED_HOST; do
    TRUSTED_HOST="$TRUSTED_HOST --trusted-host $h"
  done
fi
nohup dsh --profile web --port "$DSH_WEB_PORT" $TRUSTED_HOST > /data/dsh-web.log 2>&1 &
DSH_PID=$!
log "dsh web PID=$DSH_PID（日志: /data/dsh-web.log）"

# 等待主服务就绪（最长 120 秒）
log "等待主服务就绪..."
READY=0
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$DSH_WEB_PORT/"; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" = "1" ]; then
  log "✅ dsh web 就绪: http://0.0.0.0:$DSH_WEB_PORT"
else
  log "⚠️ dsh web 未在 120s 内就绪，查看日志: /data/dsh-web.log"
fi

# ---------- 3. 启动客户端管理服务（前台，保持容器存活） ----------
log "启动客户端管理服务 (端口 $DSH_MGMT_PORT)..."
exec node /app/server/server.js
