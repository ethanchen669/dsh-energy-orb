# ADR-0003：显示偏好住 client localStorage，host 只留 `enabled`

## Context

显示偏好有五个值：visible / size / anchor / offset（拖拽位置）。要求：拖拽立即生效并记住；
用户能一键关掉整个球；**不许出现双份真相**（两个存储源不一致是自找的失败面）。
Host 侧有 cordis Config（升级存活、设置面现成），client 侧有 localStorage（即时、随 origin）。

## Options

1. **全部 client localStorage**：拖拽/显隐/大小即时生效；cordis Config 只留 `enabled` 插件开关。
   代价：换浏览器不同步显示偏好。
2. **全部 host 持久化**（dsh-pet 的 pet.json 模式，加写路由）：跨浏览器一致。
   代价：每个多出一条写路由 + 校验 + 失败回滚逻辑；拖拽期间 host 不可达就记不住位置。
3. **混合双通道**（host 管一部分、client 管一部分、互相同步）：无 ——这就是双份真相。

## Decision & Why

选 **1**。装饰品的位置和大小不值得一条写路由和它的错误模型；拖拽是纯 client 交互，
不该依赖 host 可达性；`enabled` 留在 Config 是因为「关掉插件」本来就该走配置面（patch 层升级存活）。
选项 3 明确禁止。

**错了代价**：用户换浏览器后球的位置/大小回到默认，损失一次「重新拖一下」；
若用户强烈要求跨设备同步，回退路径是加一条写路由（选项 2），接口是增量不是破坏。

## Consequences

- 简单：整个插件只有一条 GET 路由；显示偏好的错误模型只剩「localStorage 不可写 → 用内存值」。
- 变难：跨浏览器一致性（明确不承诺）。
- 被排除：host 侧显示偏好持久化、双通道同步。

## Revisit trigger

- 用户实际提出跨设备同步诉求；
- 显示偏好开始承载非装饰语义（如按会话分球的绑定关系——那属于状态，不属于显示偏好）。
