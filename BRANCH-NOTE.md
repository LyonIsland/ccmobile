# feat/multi-user-sandbox 分支说明

> 基于 `main`（V0 单密钥模式）开发，实现多用户系统与沙箱隔离。

## 功能概述

将 ccmobile 从 **单密钥访问** 升级为 **多用户认证 + 沙箱隔离** 架构。

## 提交记录

| Commit | 日期 | 说明 |
|--------|------|------|
| `c1d9aeb` | 06-25 09:55 | 多用户认证与权限管理、bubblewrap 沙箱隔离、用户独立工作空间、共享项目支持 |
| `dc4d41d` | 06-25 11:44 | 沙箱挂载完整 userHome、自动刷新过期 OAuth 凭证 |
| `c025178` | 06-25 15:34 | Markdown 渲染（marked.js + highlight.js）、消息/代码块复制按钮、per-user 会话路径隔离 |
| `dc43331` | 06-25 17:53 | Cookie 免登录、Token 持久化到 DB、项目自动恢复最近会话、主题绑定账户 |

## 核心改动

### 1. 多用户认证

| 特性 | 说明 |
|------|------|
| 登录方式 | 用户名 + 密码（bcryptjs 加密存储） |
| 角色模型 | 管理员 / 普通用户 |
| Token 持久化 | auth_tokens 表存 DB，服务重启后登录态不丢失 |
| Cookie 免登录 | httpOnly cookie 自动认证，7 天有效期 |
| 管理界面 | 管理员可通过 Web UI 管理用户、审批权限（Projects 页顶部工具栏入口） |

### 2. 沙箱隔离

- 基于 **bubblewrap (bwrap)** 实现进程级沙箱
- 每个用户独立的 `user-data/{username}/` 目录
- 沙箱内挂载用户专属 HOME、项目文件、Claude 配置
- 用户间文件系统完全隔离
- 自动刷新过期 OAuth 凭证

### 3. 项目管理

- **私人项目**：存放于 `user-data/{username}/projects/`
- **共享项目**：存放于 `shared-projects/`，通过 `project_access` 表控制访问权限
- 项目访问需管理员审批授权
- 进入项目时自动恢复最近会话，聊天页提供快捷新建按钮

### 4. 前端增强

| 特性 | 说明 |
|------|------|
| Markdown 渲染 | marked.js 解析 + highlight.js 代码高亮（14 种语言） |
| 复制按钮 | 消息级复制 + 代码块独立复制，点击反馈 |
| 主题切换 | 亮色/深色主题，绑定用户账户，首次默认亮色，☀/☽ 图标切换 |
| 模型选择 | 支持前端选择 Opus/Sonnet 模型 |
| 输入框 Bug 修复 | 修复服务重启后首次输入文字消失的问题 |

### 5. 数据库扩展

新增表：
- `users` — 用户账号与角色（含 theme、has_onboarded 字段）
- `shared_projects` — 共享项目注册
- `project_access` — 项目访问权限
- `auth_tokens` — 持久化登录 Token
- `system_logs` / `chat_logs` — 系统与聊天日志

## 改动文件

```
.gitignore                     +5    排除运行时数据目录
application/public/index.html  +700  多用户 UI、Markdown 渲染、复制按钮、主题切换
config.js                      +8    新增用户数据/共享路径/模型配置
package.json                   +2    新增 bcryptjs、cookie-parser 依赖
server.js                      +950  认证、沙箱、权限、Token 持久化、主题 API
```

## 环境依赖

- Node.js 18+
- bubblewrap (`bwrap`) 已安装
- `.env` 中配置 `CCMOBILE_ADMIN_USER` / `CCMOBILE_ADMIN_PASS`

## 部署注意

1. 运行 `npm install` 安装新依赖（bcryptjs、cookie-parser）
2. 首次启动需配置 `.env`（参考 `.env.example`）
3. `user-data/`、`projects/`、`shared-projects/` 由运行时自动创建，已加入 `.gitignore`
