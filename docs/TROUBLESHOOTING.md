# 故障排查指南 (Troubleshooting)

本文整理了安装或使用 Context Lens（含 `ContextLensBar.app`）时的常见环境问题及解决方法。

---

## 1. 提示“agy CLI 未登录或登录已过期” / 未找到 `agy`

- **检查 CLI 是否安装**：确认 `~/.local/bin/agy` 存在且可执行：
  ```bash
  agy --version
  ```
- **完成 CLI 登录**：在终端直接启动一次交互式 `agy`，确认右上角账号已登录（**建议与 Antigravity 桌面端登录同一个账号**），然后输入 `/exit` 退出：
  ```bash
  agy
  ```
- 回到菜单栏点击右上角刷新按钮 `↻`，即可看到顶部状态变为绿色「云端已同步」。

---

## 2. 提示“连接 Google 配额服务超时”或“代理连接失败”

`ContextLensBar.app` 会在后台通过 `agy` 请求 Google 配额服务，按以下优先级读取代理：
1. 在面板内手动配置（点击底部「**设置与自启 → 同步代理设置**」），填写本地 HTTP / SOCKS5 代理地址（如 `http://127.0.0.1:7890` 或简写 `:7890`），点击「**保存并同步**」；
2. 命令行环境变量（`HTTPS_PROXY`、`ALL_PROXY` 等）；
3. macOS **系统设置 → 网络 → 代理** 中启用的 HTTPS / HTTP / SOCKS 代理（自动通过 `scutil --proxy` 读取）。

> **排查提示**：如果你开启了代理软件但只启用了“终端代理命令 / TUN 混合模式”，系统代理为空时后台独立子进程可能无法自动走代理，在面板里填一次代理地址即可一劳永逸解决。

---

## 3. macOS 提示“无法打开 ContextLensBar，因为无法验证开发者”

开源自编译版本及 GitHub Release 安装包使用 `ad-hoc` 本地签名，尚未经过 Apple 公证（Notarization）。如果通过浏览器下载 zip 解压，macOS 会附加 `com.apple.quarantine` 隔离属性。

在终端执行一次以下命令解除隔离并启动即可：
```bash
xattr -cr ~/Applications/ContextLensBar.app
open -a ~/Applications/ContextLensBar.app
```

---

## 4. 提示“Node.js 版本过低”或“未找到 Node.js”

Context Lens 使用了 Node 内置 `node:sqlite` 模块，**要求 Node.js `>= 22.5.0`**（零第三方依赖）。

- **推荐升级方式**（macOS Homebrew）：
  ```bash
  brew install node
  node -v
  ```
- 如果你使用 `nvm` / `fnm` / `volta` / `mise` / `asdf` 管理版本：`ContextLensBar.app` 已内置常见版本管理器的路径自动发现（如 `~/.nvm/versions/node/v*/bin/node` 优先选择最高版本）。如果仍未命中，可通过自定义环境变量 `CL_NODE_BIN` 指向你的 `node >= 22.5` 路径。

---

## 5. 提示“macOS 钥匙串已锁定”

`agy` CLI 将 OAuth Token 安全存储在 macOS 系统钥匙串中。若系统刚休眠唤醒或 SSH 无界面会话下钥匙串被锁：
- 打开 macOS 桌面「钥匙串访问（Keychain Access）」解锁「登录（login）」钥匙串，或在弹出授权框时选择「**始终允许**」`agy` 访问即可。

---

## 6. 插件 Sidecar 右侧面板入口没有出现

1. 确认插件已正确安装：
   ```bash
   agy plugin list
   ```
   （若从 GitHub 克隆源码但未通过 `agy plugin install` 安装，请重新执行 `agy plugin install .`）
2. 在 Antigravity 内打开 **Customizations → Installed → Context Lens**，确认右侧 **Sidecar** 开关已打开。
3. 开启后在对话右上角 `+` 菜单中即可看到 **Context Lens**。

---

## 7. 如何完整卸载

在仓库目录下运行一键卸载脚本：
```bash
bash install.sh --uninstall
```
这将停止 `ContextLensBar` 进程、移除开机自启项 `~/Library/LaunchAgents/dev.contextlens.menubar.plist`、删除 `~/Applications/ContextLensBar.app` 并卸载 `context-lens` 插件。

> 本地配置与官方缓存目录 `~/.gemini/antigravity/plugin_data/context-lens` 默认保留；如需彻底清空，手动删除该目录即可。
