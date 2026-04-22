# Multi-Page Automation (HeroSMS Fork)

一个用于批量跑通 ChatGPT OAuth 注册/登录流程的 Chrome 扩展。

当前版本基于侧边栏控制，支持单步执行、整套自动执行、停止当前流程、保存常用配置，以及通过 HeroSMS / DuckDuckGo / QQ / 163 / Inbucket / Hotmail 协助获取验证码。

## 当前能力

- **HeroSMS 集成**：支持自动化手机号购买与接码，解决注册过程中的 `add-phone` 强制验证问题。支持动态调价重试与号码复用。
- **163 邮箱深度优化**：针对 163 邮箱 SPA 架构与 iframe 内容加载进行了深度适配。支持“点击阅读”模式，精准提取隐藏在邮件正文中的 6 位验证码。
- **智能过滤**：支持秒级时间戳过滤与验证码去重，确保在高频运行时不误抓旧邮件。
- 从 CPA 面板自动获取 OpenAI OAuth 授权链接。
- 自动打开 OpenAI 注册页并点击 `Sign up / Register`。
- 自动填写邮箱与密码，支持自定义密码或自动生成强密码。
- 自动获取注册验证码与登录验证码。
- 支持 `Hotmail`、`2925`、`QQ Mail`、`163 Mail`、`Inbucket mailbox`。
- 支持从 DuckDuckGo Email Protection 自动生成新的 `@duck.com` 地址。
- 支持基于 Cloudflare 自定义域名自动生成随机邮箱前缀。
- Step 5 同时兼容 `birthday` 与 `age` 两种页面模式，并支持自动勾选“同意协议”。
- 支持 `Auto` 多轮运行与中途 `Stop`。
- 支持通过侧边栏查看完整的运行历史与错误记录。

## 环境要求

- Chrome 浏览器
- 打开扩展开发者模式
- 你自己的 CPA 管理面板，且页面结构与当前脚本适配
- 至少准备一种验证码接收方式（如 163、QQ 或 Hotmail）
- 如果需要自动化处理手机验证，需准备 HeroSMS `api_key`

## 安装

1. 打开 `chrome://extensions/`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择本项目目录
5. 打开扩展侧边栏

## 快速开始

### 方案：HeroSMS + 163 邮箱

1. 在侧边栏 `HeroSMS 手机验证` 部分填入你的 `api_key`。
2. 将 `国家 ID` 设为 `52` (泰国) 或其他支持的国家，`服务代码` 设为 `dr` (OpenAI)。
3. `Mail` 选择 `163 Mail`，并确保浏览器已登录 163 邮箱页面。
4. 点击 `Auto` 开始全自动注册。

## 详细步骤说明 (主要更新)

### HeroSMS (Step 8 扩展)

当流程遇到 `https://auth.openai.com/add-phone` 时，插件会自动：
1. 调用 HeroSMS 获取当前最低价。
2. 购买新号码并填入页面。
3. 轮询 HeroSMS 短信接口。
4. 提取验证码并完成验证。
5. **智能重试**：如果价格发生波动（WRONG_MAX_PRICE），会自动按建议价尝试第二次购买。

### 163 邮箱协调器 (Step 4 & Step 8)

针对 163 邮箱的特殊结构，本版本实现了以下逻辑：
- **跨 Frame 扫描**：主窗口与邮件正文 iframe 同步扫描，解决由于跨域策略导致的验证码“看不见”问题。
- **强制等待 (Patience Delay)**：登录验证时强制等待 10 秒，确保 NetEase 后端已完成数据推送，防止抓取上一轮的旧码。
- **状态重置**：每次轮询开始前自动返回收件箱列表并刷新，保证 DOM 环境纯净。

## 项目结构

```txt
background.js              后台主控，编排流程、状态管理
hero-sms-utils.js          HeroSMS API 封装
background/phone-verify-flow.js  HeroSMS 自动化流程控制
content/mail-163.js        163 邮箱深度适配脚本（协调器模式）
content/signup-page.js     OpenAI 注册/登录页自动化逻辑
Sidepanel/                 侧边栏 UI 与配置管理
```

## 安全说明

- 本工具仅供学习与自动化测试使用。
- 所有 API Key 与 密码仅保存在浏览器本地，不会上传至任何第三方服务器。
- 请遵守 OpenAI 的服务条款。

## 许可证

本项目采用 GPLv3 许可证。
