# 服务器 OOM 恢复预案（DSH Docker 部署）

## 背景
2026-08-16 16:00 前后，启动 DSH 容器（dsh-docker:1.0.0）时，
服务器 10G 内存被吃满触发 OOM，系统级僵死（所有用户态无响应，
仅内核网络栈存活，SSH/Web 全部不可达）。

## 症状确认
- SSH (55822): TCP 通但握手被拒
- 80/443/58123/5700/5701/5000: TCP 通但 HTTP 000
- 判断：swap thrashing / OOM，Linux 可能数小时不恢复

## 恢复步骤（SSH 恢复后立即执行）
1. **确认系统状态**：`uptime; free -h; dmesg | grep -i oom | tail`
2. **停掉 DSH 容器**：`docker stop dsh`（释放内存）
3. **清理残留**：`docker rm -f dsh`
4. **检查内存占用**：`docker stats --no-stream | sort -k4 -h`
5. **应用防 OOM 修复**（已推送到 GitHub）：
   - docker-compose.yml 已加 `mem_limit: 2g` + `cpus: "4"` + `NODE_OPTIONS=--max-old-space-size=1024`
   - entrypoint.sh 已加 Node 堆内存控制
6. **重新启动**：`docker compose up -d`
7. **验证**：`curl 127.0.0.1:8123` / `curl 127.0.0.1:8124` / HTTPS 58123

## 根本原因
DSH 容器无内存限制 + 已有 7 容器（omniroute 1.8G、kavita 0.5G、
qinglong 1G 等）→ 10G 内存耗尽 → OOM。

## 长期建议
- [ ] 停用不需要的容器（如 omniroute 若不再用可停）
- [ ] 考虑扩内存或加 swap
- [ ] 监控：`watch free -h`
