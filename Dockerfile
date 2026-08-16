# ============================================================
# DSH Docker 移植版 — 镜像构建
# 目标：完整复刻 DSH 客户端 v1.1.7 的功能（同步引擎/插件全家桶/
#       状态监控/双端 UI），以 Web 服务形态运行
# ============================================================
# 用 Debian slim（glibc）：node-addon-require-builtin 等原生模块
# 只有 gnu 预编译绑定，alpine(musl) 无法加载
FROM node:22-slim AS base

# ---- 基础工具（git 供同步引擎与插件安装、bash 供脚本）----
# node-pty 等原生模块需要编译工具链；apt 走清华源加速
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    apt-get update && apt-get install -y --no-install-recommends \
    git bash curl ca-certificates openssh-client python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# ---- npm 国内镜像加速 + 全局安装 dsh 核心 ----
# node-gyp 头文件走 npmmirror 镜像（nodejs.org 国内不通导致编译失败）
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_disturl=https://npmmirror.com/mirrors/node
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g @deepseek-ai/dsh@0.1.0-rc.6

# ---- 构建 web profile（插件全家桶：皮肤/SSH/任务看板/aionui 等）----
RUN mkdir -p /opt/dsh-profile && \
    npm install -g pnpm

# profile 声明文件：与客户端 v1.1.7 的 ~/.dsh/profiles/web 一致
COPY profile-web/package.json /opt/dsh-profile/package.json
COPY profile-web/pnpm-workspace.yaml /opt/dsh-profile/pnpm-workspace.yaml
COPY profile-web/.npmrc /opt/dsh-profile/.npmrc
WORKDIR /opt/dsh-profile
# pnpm install：先建完整 lockfile（含 optional），再安装；
# cloudflared 的 postinstall 联网下载被 ignore-scripts 跳过，
# 之后精确重建 ssh2/cpu-features 原生模块
RUN pnpm install --lockfile-only --ignore-scripts && \
    pnpm install --ignore-scripts && \
    pnpm rebuild cpu-features ssh2
# 手动补 cloudflared 二进制（GitHub 直连国内不通，走 ghproxy 镜像）
RUN mkdir -p /tmp/cf-dl && \
    (curl -sL --max-time 300 -o /tmp/cf-dl/cloudflared \
      https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/download/2024.6.1/cloudflared-linux-amd64 || \
     curl -sL --max-time 300 -o /tmp/cf-dl/cloudflared \
      https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/download/2024.6.1/cloudflared-linux-amd64 || \
     curl -sL --max-time 300 -o /tmp/cf-dl/cloudflared \
      https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/download/2024.6.1/cloudflared-linux-amd64) && \
    chmod +x /tmp/cf-dl/cloudflared && \
    mkdir -p node_modules/cloudflared/bin && \
    cp /tmp/cf-dl/cloudflared node_modules/cloudflared/bin/cloudflared && \
    rm -rf /tmp/cf-dl

# ---- 客户端服务（同步引擎 + 管理 API + 双端 UI 的宿主）----
WORKDIR /app
COPY server/ /app/server/
COPY web/ /app/web/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- 运行环境 ----
ENV DSH_HOME=/data/.dsh \
    NODE_ENV=production \
    DSH_WEB_PORT=8123 \
    DSH_MGMT_PORT=8124 \
    DSH_PROFILE_DIR=/opt/dsh-profile

EXPOSE 8123 8124

VOLUME ["/data"]

CMD ["/app/entrypoint.sh"]
