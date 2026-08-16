# DSH Docker 移植版 - 部署验证清单（服务器恢复后逐项执行）

## 阶段一：系统恢复确认
- [ ] `uptime`（load < 2）
- [ ] `free -h`（可用 > 2G）
- [ ] `docker ps`（容器状态正常）

## 阶段二：部署（执行 _tmp_recover.sh 一键脚本）
- [ ] 停止非关键容器（kavita/omniroute/heimdall/qd）释放内存
- [ ] 启动 DSH 容器（mem_limit 2g 已配置）
- [ ] 双服务就绪（8123 HTTP 200 + 8124 HTTP 200）

## 阶段三：功能验证（全部通过才算交付）
### 1. 主界面（桌面 UI）
- [ ] http://127.0.0.1:8123/ 返回 200，页面含 DSH GUI 元素
- [ ] HTTPS https://game.dantezcx.vip:58123/ 可访问（宿主 nginx 反代）
### 2. 管理服务
- [ ] http://127.0.0.1:8124/ 桌面管理页 200
- [ ] http://127.0.0.1:8124/m 移动端 UI 200
### 3. API 端点（curl 逐项）
- [ ] GET /api/status → {online:true, ...}
- [ ] GET /api/sync/get-config → {}（初始）
- [ ] POST /api/sync/save-config（Git/WebDAV 配置保存）
- [ ] POST /api/sync/test（连接测试）
- [ ] GET /api/backup/list
- [ ] GET /api/plugins/search（GitHub 搜索）
- [ ] GET /api/rules/scan
- [ ] GET /api/archive/list
### 4. 数据持久化
- [ ] docker compose restart 后数据仍在（/data 卷）
### 5. 同步功能（需 API Key 配置后）
- [ ] Git 同步到远程仓库
- [ ] WebDAV 同步
