# dsh-mimo-credits

> **English:** Shows the remaining MiMo Token Plan credits as a progress bar at the left sidebar foot (above Settings; a centered percentage in the collapsed rail), driven by the official [credits-get API](https://mimo.mi.com/docs/zh-CN/api/asset/credits-get). The browser cannot call that API directly (no CORS headers), so the Host half queries it through DSH's authenticated same-origin `/api` channel; the API key stays in the DSH credential store and is entered under **Settings → General** (or via the `MIMO_API_KEY` environment variable). The widget refreshes every 5 minutes and on click, is cached 60 s on the Host, and is always visible. Full details below in Chinese.

在**左侧导航栏底部**（设置正上方）以**进度条**显示小米 MiMo Token Plan 套餐的剩余额度比例，数据来自官方 [查询套餐余量（credits-get）](https://mimo.mi.com/docs/zh-CN/api/asset/credits-get) 接口。

## 显示位置

- **左侧导航栏底部**（`sidebar.footer.action`，位于“设置”正上方，根作用域常驻——不打开会话也显示）：
  - **展开态**：整行 `MiMo 套餐额度` + 百分比 + 进度条，点击立即刷新；悬停查看明细（套餐标识、剩余/总额度、已用比例、计费周期）。
  - **收窄态**（56px 栏）：居中显示百分比，悬停查看明细。
  - 每 5 分钟自动刷新（页面隐藏时跳过，重新可见时立即刷新）；进度条颜色随剩余额度变化：≥50% 绿、≥20% 黄、<20% 红。
  - 未配置 API Key 显示 `—`；上游出错显示 `!`（数字旁红色感叹号），悬停可见原因；刷新中内容变淡提示进行中。
- **设置页录入 Key**：`设置 → 通用设置` 中的 “MiMo 套餐额度” 行，可录入 / 清除 Token Plan API Key，并显示当前 Key 来源。

## 配置 API Key（二选一）

1. **设置页录入（推荐）**：打开 `设置 → 通用设置`，在 “MiMo 套餐额度” 行粘贴 Token Plan 控制台的专属 API Key（`tp-` 开头）并保存。Key 存入 DSH 凭据存储（`mimo-credits/api-key` 记录），不写入配置文件、不进浏览器、不打印日志。
2. **环境变量**：在启动 DSH 的环境中导出 `MIMO_API_KEY=tp-...`。已保存的设置页 Key 优先于环境变量。

Token Plan 专属 Base URL 与 API Key 见 [Token Plan 控制台](https://platform.xiaomimimo.com/token-plan)。

### 可选：自定义上游地址

在 profile 的 `cordis.patch.yml` 中给本插件行加 `config`：

```yaml
- insert:
    - id: mimo-credits
      name: dsh-mimo-credits
      config:
        baseUrl: https://your-mimo-api-root.example.com
```

`baseUrl` 为 API 根地址，插件在其后拼接官方路径 `/v1/platform/token_plan`；缺省为 `https://token-plan-cn.xiaomimimo.com`。修改后重启 DSH 生效。

## 工作原理

- 官方接口**不返回 CORS 头**（实测预检请求 404、无 `Access-Control-Allow-Origin`），浏览器无法直连，因此由宿主半部代为请求。
- 宿主半部把 `GET/POST /api/mimo.quota` 注册到 DSH 自带的 `/api` 认证通道：先经过 Host/Origin 信任栅栏与签名浏览器 Cookie 认证，**仅 owner 会话可达**，未认证请求在到达本插件之前就被拒绝。
- 浏览器相对路径 `api/mimo.quota` 同源调用，携带会话 Cookie；API Key 只存在于宿主进程与凭据存储。
- 上游响应在宿主侧缓存 60 秒；请求超时 10 秒；错误以结构化错误码返回，界面显示本地化文案。
- 客户端通过 DSH 槽位系统渲染，主题色全部取自 `--dsw-alias-*` / `--dsw-*` 令牌，中英双语文案走 Client locale 服务。

## 限制

- 进度条位于左侧导航栏底部（设置上方），侧边栏收窄时仅显示百分比；悬停仍可查看完整明细。
- 未配置 Key、Key 被上游拒绝、网络不可达时显示占位符或红色感叹号，悬停给出原因；需到 `设置 → 通用设置` 处理。
- 插件不修改任何会话事件，不向除 MiMo 官方接口以外的地址发送数据。

## 卸载

从 profile 移除本 bundle 后，路由、槽位与文案随插件卸载自动清理；凭据存储中的 `mimo-credits/api-key` 记录如需删除，请在卸载前于设置页点击“清除”，或手动清理凭据存储。
