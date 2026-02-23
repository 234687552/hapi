# 简化工程计划：保留 web + hub，移除 Telegram/复杂加密

## 任务描述
简化当前工程代码，只保留：
- `web/`：移动端页面（功能不变）
- `hub/`：后端（路由、格式转换、调用CLI、简单token鉴权）

移除：Telegram集成、Push通知、Tunnel/Relay，将 JWT 鉴权简化为直接 token 鉴权。

---

## 验收标准
1. hub 启动后，web 页面所有功能正常（session列表、聊天、新建session、设置、文件、终端）
2. 鉴权：web 用 `CLI_API_TOKEN` 直接作为 Bearer token，hub 直接校验
3. 无 Telegram 相关代码
4. 无 Push 通知相关代码
5. 无 Tunnel/Relay 相关代码
6. `hub/package.json` 移除 `grammy`、`jose`、`web-push`、`qrcode` 依赖
7. TypeScript 编译无错误

---

## 实现步骤

### Step 1：删除 hub 中不需要的目录和文件
```
hub/src/telegram/          (bot.ts, callbacks.ts, renderer.ts, sessionView.ts)
hub/src/push/              (pushService.ts, pushNotificationChannel.ts)
hub/src/tunnel/            (tunnelManager.ts, tlsGate.ts, index.ts)
hub/src/web/telegramInitData.ts
hub/src/web/routes/bind.ts
hub/src/web/routes/push.ts
hub/src/config/jwtSecret.ts
hub/src/config/vapidKeys.ts
hub/src/store/userStore.ts
hub/src/store/users.ts
hub/src/store/pushStore.ts
hub/src/store/pushSubscriptions.ts
```

### Step 2：简化 hub 鉴权中间件
**文件：`hub/src/web/middleware/auth.ts`**

替换 JWT 验证为直接 token 校验：
```typescript
import type { MiddlewareHandler } from 'hono'
import { configuration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'

export type WebAppEnv = {
    Variables: {
        namespace: string
    }
}

export function createAuthMiddleware(): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
        const tokenFromQuery = c.req.path === '/api/events' ? c.req.query().token : undefined
        const raw = tokenFromHeader ?? tokenFromQuery

        if (!raw) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        const parsed = parseAccessToken(raw)
        if (!parsed || !constantTimeEquals(parsed.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        c.set('namespace', parsed.namespace)
        await next()
    }
}
```

### Step 3：简化 hub auth 路由
**文件：`hub/src/web/routes/auth.ts`**

移除 Telegram 和 JWT，改为直接 token 验证并返回用户信息：
```typescript
import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { constantTimeEquals } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { WebAppEnv } from '../middleware/auth'

const authBodySchema = z.object({ accessToken: z.string() })

export function createAuthRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.post('/auth', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = authBodySchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const parsedToken = parseAccessToken(parsed.data.accessToken)
        if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid access token' }, 401)
        }

        return c.json({
            token: parsed.data.accessToken,
            user: { id: 1, firstName: 'Web User' }
        })
    })
    return app
}
```

### Step 4：简化 hub socket server（移除 JWT，改用直接 token 校验）
**文件：`hub/src/socket/server.ts`**

- 移除 `import { jwtVerify } from 'jose'`
- 移除 `jwtPayloadSchema`
- 移除 `jwtSecret: Uint8Array` 参数（从 `SocketServerDeps` 中删除）
- 将 `/terminal` namespace 的 auth 中间件改为直接 token 校验：
  ```typescript
  // 替换 jwtVerify 逻辑为：
  const parsedToken = parseAccessToken(token)
  if (!parsedToken || !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)) {
      return next(new Error('Unauthorized'))
  }
  socket.data.namespace = parsedToken.namespace
  ```
- 移除 `jwtSecret` 从 `createSocketServer` 调用参数

### Step 5：简化 hub web server
**文件：`hub/src/web/server.ts`**

- 移除 `vapidPublicKey` 参数
- 移除 `createBindRoutes`、`createPushRoutes` 路由注册
- 简化 `createAuthMiddleware` 调用（不再传 `jwtSecret`）
- 移除 `relayMode`、`officialWebUrl` 参数（始终 serve 静态文件）
- 移除 relay mode 相关 HTML 响应逻辑

### Step 6：简化 hub store
**文件：`hub/src/store/index.ts`**

- 移除 `UserStore`、`PushStore` 导入和实例化
- 移除 `users`、`push_subscriptions` 表的 schema 创建
- 从 `REQUIRED_TABLES` 中移除 `'users'` 和 `'push_subscriptions'`
- 保持 `SCHEMA_VERSION` 不变（现有数据库有这些表无害，只是不再使用）

### Step 7：简化 hub configuration
**文件：`hub/src/configuration.ts`**

- 移除 `telegramBotToken`、`telegramEnabled`、`telegramNotification` 字段
- 移除 VAPID 相关配置
- 保留 `listenHost`、`listenPort`、`publicUrl`、`corsOrigins`、`cliApiToken`、`dataDir`、`dbPath`

**文件：`hub/src/config/serverSettings.ts`**

- 移除 `telegramBotToken`、`telegramNotification` 字段及其加载逻辑

### Step 8：简化 hub index.ts（主入口）
**文件：`hub/src/index.ts`**

- 移除 `HappyBot`、`TunnelManager`、`PushService`、`PushNotificationChannel`、`NotificationHub` 导入
- 移除 `getOrCreateJwtSecret`、`getOrCreateVapidKeys` 调用
- 移除 Telegram bot 初始化和启动
- 移除 tunnel 初始化和 QR code 生成
- 移除 `jwtSecret` 传递给 `startWebServer` 和 `createSocketServer`
- 保留 `NotificationHub` 但传入空 channels 数组（保留通知框架，只是无通知渠道）
  - 实际上直接删除 `NotificationHub` 更简洁，因为没有任何 channel

### Step 9：更新 hub package.json
**文件：`hub/package.json`**

移除依赖：`grammy`、`jose`、`web-push`、`qrcode`
移除 devDependencies：`@types/qrcode`、`@types/web-push`

### Step 10：简化 web 鉴权
**文件：`web/src/hooks/useAuth.ts`**

- 移除 JWT exchange 逻辑（不再调用 `/api/auth` 获取 JWT）
- 直接用 accessToken 作为 Bearer token
- 移除 token 刷新逻辑
- 简化为：
  ```typescript
  export function useAuth(authSource: AuthSource | null, baseUrl: string) {
      const token = authSource?.type === 'accessToken' ? authSource.token : null
      const api = useMemo(() => token
          ? new ApiClient(token, { baseUrl: baseUrl || undefined })
          : null,
          [token, baseUrl]
      )
      return { token, user: null, api, isLoading: false, error: null, needsBinding: false, bind: async () => {} }
  }
  ```

### Step 11：简化 web authSource
**文件：`web/src/hooks/useAuthSource.ts`**

- 移除 Telegram initData 检测（`getTelegramInitData`）
- 只保留 accessToken 路径（URL params 或 localStorage）
- 移除 `bind` 相关逻辑

### Step 12：简化 web main.tsx
**文件：`web/src/main.tsx`**

- 移除 `getTelegramWebApp`、`isTelegramEnvironment`、`loadTelegramSdk` 导入
- 移除 Telegram SDK 加载逻辑
- 移除 `getStartParam`、`getDeepLinkedSessionId`、`getInitialPath` 函数
- 移除 memory history 逻辑（始终使用默认 browser history）
- 简化 `bootstrap()` 函数

### Step 13：清理 web App.tsx
**文件：`web/src/App.tsx`**

- 移除 `getTelegramWebApp`、`isTelegramApp` 调用
- 移除 `usePushNotifications` hook 调用
- 移除 `needsBinding`、`bind` 相关 UI 逻辑（`LoginPrompt` 中的 binding 分支）
- 保留所有核心页面功能

### Step 14：清理 web router.tsx
**文件：`web/src/router.tsx`**

- 移除 `isTelegramApp` 导入和使用（back button 逻辑改为始终显示）

### Step 15：清理 web SessionHeader.tsx
**文件：`web/src/components/SessionHeader.tsx`**

- 移除 `isTelegramApp` 导入和使用

### Step 16：清理 web useTheme.ts
**文件：`web/src/hooks/useTheme.ts`**

- 移除 `getTelegramWebApp` 导入
- 将 `getColorScheme()` 改为只使用系统 `prefers-color-scheme`

### Step 17：清理 web usePlatform.ts
**文件：`web/src/hooks/usePlatform.ts`**

- 移除 `getTelegramWebApp`、`isTelegramApp` 导入
- 将 `isTelegram` 始终返回 `false`
- 移除 Telegram haptic feedback 逻辑

### Step 18：删除 web 不需要的 hooks
- 删除 `web/src/hooks/useTelegram.ts`
- 删除 `web/src/hooks/usePushNotifications.ts`

---

## 关键决策

1. **Push 通知**：完全移除（hub 和 web 两侧），包括 `pushStore.ts`、`pushSubscriptions.ts`
2. **NotificationHub**：完全移除（无任何 channel，保留无意义）
3. **Voice 功能**：保留（`hub/src/web/routes/voice.ts` 和 `web/src/api/voice.ts` 不变）
4. **store schema 版本**：`SCHEMA_VERSION` 保持不变，不做迁移（旧表存在无害）
5. **ownerId**：`hub/src/config/ownerId.ts` 可删除（auth 路由直接返回 `id: 1`）
6. **userId**：从 `WebAppEnv` 中移除，路由中无实际使用

---

## 风险与注意事项

1. **SSE events 鉴权**：`/api/events` 支持 query param `token`，简化后的中间件需保留此逻辑（已在 Step 2 中处理）
2. **namespace 支持**：保留 `token:namespace` 格式解析，多 namespace 功能不受影响
3. **web client.ts**：Push 相关 API 方法（`getPushVapidPublicKey` 等）保留为死代码，不影响编译

---

## 文件变更汇总

### 删除（hub）
- hub/src/telegram/ (4 files)
- hub/src/push/ (2 files)
- hub/src/tunnel/ (3 files)
- hub/src/web/telegramInitData.ts
- hub/src/web/routes/bind.ts
- hub/src/web/routes/push.ts
- hub/src/config/jwtSecret.ts
- hub/src/config/vapidKeys.ts
- hub/src/config/ownerId.ts
- hub/src/store/userStore.ts
- hub/src/store/users.ts
- hub/src/store/pushStore.ts
- hub/src/store/pushSubscriptions.ts
- hub/src/notifications/ (全部4个文件)

### 删除（web）
- web/src/hooks/useTelegram.ts
- web/src/hooks/usePushNotifications.ts

### 修改（hub）
- hub/src/web/middleware/auth.ts
- hub/src/web/routes/auth.ts
- hub/src/web/server.ts
- hub/src/socket/server.ts
- hub/src/index.ts
- hub/src/configuration.ts
- hub/src/config/serverSettings.ts
- hub/src/store/index.ts
- hub/package.json

### 修改（web）
- web/src/hooks/useAuth.ts
- web/src/hooks/useAuthSource.ts
- web/src/main.tsx
- web/src/App.tsx
- web/src/router.tsx
- web/src/components/SessionHeader.tsx
- web/src/hooks/useTheme.ts
- web/src/hooks/usePlatform.ts
