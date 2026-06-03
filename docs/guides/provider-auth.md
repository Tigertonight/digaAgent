# Provider/Auth Guide

> **状态**：v0 指南
> **适用范围**：mini-pi-web / Diga Agent 的模型授权、Provider 配置、OpenAI API Key 与 ChatGPT/Codex OAuth 区分

---

## 0. TL;DR

mini-pi-web 自己不直接保存“模型账号会话”，而是复用 `@earendil-works/pi-coding-agent` SDK 的两套本地配置：

| 文件 | 用途 |
|---|---|
| `~/.pi/auth.json` | API Key / OAuth token 凭证 |
| `~/.pi/agent/models.json` | 自定义 provider、baseUrl、headers、模型参数 |

模型请求链路：

```text
UI 选择 provider/model
  → /api/agent/new
  → ModelRegistry.find(provider, modelId)
  → AuthStorage.getApiKey(provider)
  → AgentSession.prompt()
  → pi-ai provider adapter
  → 模型厂商 API
```

---

## 1. 三种常见接入方式

### 1.1 OpenAI API Key

适合：

- 你有 OpenAI Platform API Key
- 想走标准 OpenAI API
- 需要可控 billing、quota、项目 key

配置位置：

- UI: Auth 面板保存 `openai` API Key
- 文件：`~/.pi/auth.json`
- 环境变量：`OPENAI_API_KEY`

调用方式：

```text
provider = openai
api = openai-responses
target = api.openai.com 或 models.json 里的 baseUrl
credential = API Key
```

这条路不是 ChatGPT 登录授权，而是标准 API Key。

### 1.2 ChatGPT/Codex OAuth

适合：

- 你想使用 ChatGPT Plus/Pro/Codex subscription 通道
- 你愿意在浏览器完成 OpenAI OAuth 登录
- 你理解它和标准 OpenAI API Key 是两条不同通道

配置位置：

- UI: Auth 面板里对 `openai-codex` 执行 OAuth login
- 文件：`~/.pi/auth.json`

调用方式：

```text
provider = openai-codex
api = openai-codex-responses
target = chatgpt.com/backend-api
credential = OAuth access token + chatgpt account id
```

SDK 会在 token 过期时用 refresh token 自动刷新。

### 1.3 OpenAI-compatible Custom Endpoint

适合：

- OpenRouter
- LiteLLM
- 本地兼容 OpenAI 的模型服务
- 公司内部 gateway

配置位置：

- UI: Models Config 面板
- 文件：`~/.pi/agent/models.json`

典型配置：

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-responses",
      "apiKey": "env:MY_GATEWAY_API_KEY",
      "models": [
        {
          "id": "my-model",
          "name": "My Model",
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

---

## 2. 凭证优先级

SDK 取凭证时大致按下面顺序：

1. Runtime override（CLI / 运行时传入）
2. `~/.pi/auth.json` 里的 API Key
3. `~/.pi/auth.json` 里的 OAuth token（过期则刷新）
4. 环境变量，例如 `OPENAI_API_KEY`
5. `models.json` 自定义 provider 的 `apiKey` / command fallback

产品 UI 应该把“当前凭证来自哪里”告诉用户，例如：

```text
auth via environment (OPENAI_API_KEY)
auth via auth.json (api_key)
auth via auth.json (oauth)
auth via models_json_key
```

---

## 3. Provider 名称不要混用

| 你想做的事 | provider |
|---|---|
| 使用 OpenAI API Key | `openai` |
| 使用 ChatGPT/Codex OAuth | `openai-codex` |
| 使用 Anthropic / Claude | `anthropic` |
| 使用 Google Gemini | `google` 或 SDK 注册名 |
| 使用自定义网关 | 你在 `models.json` 里定义的 key |

`openai` 和 `openai-codex` 最容易混。前者是标准 API Key，后者是 ChatGPT/Codex 授权通道。

---

## 4. 当前产品缺口

当前代码已经具备：

- API Key 保存/删除
- OAuth login SSE 流程
- provider/model 列表
- `models.json` 编辑
- 自定义 model test

但 v0 还缺：

- 首次启动向导
- 保存 API Key 后自动验证
- OpenAI API Key 与 Codex OAuth 的清晰分流
- provider 失败原因的分级提示
- AuthPanel / ModelsConfigPanel 的复杂度收敛

这些是 RFC-4 Phase A 的工作范围。

---

## 5. 故障排查

### Q1: 为什么我登录了 ChatGPT，`openai` 还是没有 auth？

ChatGPT/Codex OAuth 对应的是 `openai-codex`，不是 `openai`。`openai` 需要 OpenAI Platform API Key。

### Q2: 为什么 provider 显示有 auth，但模型调用失败？

常见原因：

- key 没有访问该模型的权限
- quota 用尽
- `models.json` 的 model id 写错
- baseUrl 不通
- OAuth token 过期且 refresh 失败

### Q3: 自定义 endpoint 的 key 应该放哪里？

两种都可以：

- 放 `models.json` 的 provider `apiKey`
- 放环境变量，然后 `apiKey` 写成 `env:YOUR_ENV_NAME`

推荐后者，避免把 key 写进可同步的配置文件。

### Q4: OAuth token 存在哪里？

存到 `~/.pi/auth.json`。不要把这个文件提交到 Git。

