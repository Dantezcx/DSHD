# ============================================================
# DSH Docker 移植版 — 镜像构建
# 目标：完整复刻 DSH 客户端 v1.1.7 的功能（同步引擎/插件全家桶/
#       状态监控/双端 UI），以 Web 服务形态运行
# ============================================================
FROM node:22-alpine AS base

# ---- 基础工具（git 供同步引擎与插件安装、bash 供脚本）----
# node-pty 等原生模块需要编译工具链
RUN apk add --no-cache git bash curl tar openssh-client python3 make g++ linux-headers

# ---- npm 国内镜像加速 + 全局安装 dsh 核心 ----
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
RUN pnpm install --config.confirmModulesPurge=false --no-optional || pnpm install

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
