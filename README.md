# 钉正 · 学习工作台

[![tests](https://github.com/ISMAEL-math/dingzheng/actions/workflows/test.yml/badge.svg)](https://github.com/ISMAEL-math/dingzheng/actions/workflows/test.yml)

![主页](docs/screenshot-home.png)

**钉正**是一个自托管的学习工作台：拍照批改作业、错题本、知识库讲解、教材核验与错题组卷。自带 API Key 即可使用，学习数据保存在你自己的设备上。

## 功能

- **作业批改** — 上传一张或多张作业照片，由视觉语言模型识别题目与手写作答，再逐题批改；每题保留对应的原照片。
- **错题本** — 自定义科目、多本错题簿与标签；按科目、标签、掌握状态、关键词组合筛选；可编辑题干与答案、更换关联照片并拖动裁题；支持屏幕重做与自动批改。
- **知识库（对话讲解）** — 导入 PDF，支持本机文字提取与 MinerU 在线解析（扫描件、公式、复杂版面）两种方式；自动切分、向量化并构建混合检索（BM25 + 向量 RRF）；聊天时引用资料回答，答案标注来源页码。
- **教材库（批改核验）** — 导入教材 PDF，服务端后台调用 MinerU 解析出章节、页码与候选题目；只有人工核验过题干、选项、答案与页码的题目才能发布，参与精确同题匹配与客观题判分，杜绝凭题号瞎判。
- **错题组卷** — 从错题本选题生成 A4 练习卷（按题型分节、解答题留白可调、答案与解析另页），直接打印或保存 PDF。
- **模型自由** — 支持硅基流动 API 或 Codex/ChatGPT 套餐；可在设置中拉取并选择聊天、视觉、embedding 模型。

## 快速开始

要求 Node.js **22.5 及以上**（用到了 `node:sqlite`）。

```sh
git clone https://github.com/ISMAEL-math/dingzheng.git
cd dingzheng
npm install

# 配置密钥（也可以启动后在网页设置里填写，浏览器内保存的 Key 优先）
cp .env.example .env
# 编辑 .env，填入 SILICONFLOW_API_KEY

npm start
```

打开 http://localhost:4173 即可使用。

### 密钥说明

- `SILICONFLOW_API_KEY` — 必需，用于题目识别、批改与对话。可在 [.env](.env.example) 配置，或在网页设置页填写（保存在本机浏览器，不上传）。
- `MINERU_API_KEY` — 可选。未配置时使用 MinerU 免密服务（单份 PDF 限 10 MB / 20 页）；配置后支持 200 MB / 200 页。
- 密钥只保存在你自己的设备上，不会进入代码仓库或导出备份。

## 手机 / 局域网使用

本机模式默认只监听 `127.0.0.1`。想让手机等设备访问，用托管模式启动并创建邀请账号（无自助注册）：

```sh
APP_MODE=hosted npm start
# 另开终端，创建账号（密码经标准输入输入）
node scripts/accounts.mjs create aline
```

手机连同一网络访问 `http://<电脑IP>:4173` 登录即可；配合 Tailscale 等组网工具可在任何网络下访问家庭实例。公网部署请务必走 HTTPS（见下），摄像头取景等能力依赖安全上下文。

## Docker 部署

```sh
cd deploy
cp .env.example .env   # 配置密钥与端口
docker compose up -d
```

`deploy/` 内含 Caddyfile（自动 HTTPS），配置好域名后即可对外提供服务。完整的上线、账号、备份与恢复流程见 [docs/上线与备份.md](docs/上线与备份.md)。

## 备份与恢复

- 应用内：「个人账户 → 导出本地备份 / 清除本地数据」。
- 整机备份（含账号、密钥、教材原件）：`npm run backup -- create <数据目录> <备份目录>`，支持校验与恢复，详见脚本内说明。

## 数据与隐私

- 学习记录、照片与教材保存在服务端数据目录（默认 `.local/`），浏览器仅作缓存与迁移源；`RAW_DATA`、密钥等敏感内容均不入库不上传。
- 批改与对话请求经由本地 Node 服务转发到模型服务商（硅基流动 / MinerU），不经过任何第三方中转。
- 清空浏览器数据不会删除服务端数据；导入备份为整份替换，操作前会校验并保留原数据。

## 开发

```sh
npm test            # 回归测试（不调用真实模型）
npm run build:markdown   # 重新打包聊天 Markdown 渲染器（esbuild）
```

技术栈：Node ESM + 原生 Web Components 式前端（无框架、无构建产物依赖）、SQLite（`node:sqlite`）、pdf.js、LlamaIndex.js、KaTeX。

## License

[MIT](LICENSE)
