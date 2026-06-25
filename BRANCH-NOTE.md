# feat/multi-user-sandbox 分支说明

> 基于 `main`（V0 单密钥模式）开发，实现多用户系统与沙箱隔离。

## 功能概述

将 ccmobile 从 **单密钥访问** 升级为 **多用户认证 + 沙箱隔离** 架构。

## 核心改动

### 1. 多用户认证

| 特性 | 说明 |
|------|------|
| 登录方式 | 用户名 + 密码（bcryptjs 加密存储） |
| 角色模型 | 管理员 / 普通用户 |
| 会话管理 | Token 认证中间件，替代原 ACCESS_KEY |
| 管理界面 | 管理员可通过 Web UI 管理用户、审批权限 |

### 2. 沙箱隔离

- 基于 **bubblewrap (bwrap)** 实现进程级沙箱
- 每个用户独立的 `user-data/{username}/` 目录
- 沙箱内挂载用户专属 HOME、项目文件、Claude 配置
- 用户间文件系统完全隔离

### 3. 项目管理

- **私人项目**：存放于 `user-data/{username}/projects/`
- **共享项目**：存放于 `shared-projects/`，通过 `project_access` 表控制访问权限
- 项目访问需管理员审批授权

### 4. 数据库扩展

新增表：
- `users` — 用户账号与角色
- `shared_projects` — 共享项目注册
- `project_access` — 项目访问权限

## 改动文件

```
.gitignore                     +5    排除运行时数据目录
application/public/index.html  +536  多用户登录/管理 UI
config.js                      +7    新增用户数据与共享路径配置
package.json                   +1    新增 bcryptjs 依赖
server.js                      +871  认证、沙箱、权限核心逻辑
```

## 环境依赖

- Node.js 18+
- bubblewrap (`bwrap`) 已安装
- `.env` 中配置 `CCMOBILE_ADMIN_USER` / `CCMOBILE_ADMIN_PASS`

## 部署注意

1. 运行 `npm install` 安装新依赖
2. 首次启动需配置 `.env`（参考 `.env.example`）
3. `user-data/`、`projects/`、`shared-projects/` 由运行时自动创建，已加入 `.gitignore`
