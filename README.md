# DeskNest · 桌面收纳 + 美化（Electron 版）

把 Windows 桌面图标收进「手机式文件夹」：圆角九宫格缩略图、点开铺满网格、半透明遮罩、可拖拽可搜索，
桌面只剩几个干净的文件夹。常驻型小工具，按「空闲近 0 开销」的标准来做。

- 技术栈：Electron 33 + 原生 HTML/CSS/JS（**无前端框架、无构建步骤**）
- 平台：Windows 10/11 x64
- 运行形态：无边框透明圆角悬浮窗，单实例，关闭即退出，**不装服务、不写驱动、不注入 explorer、不联网**

---

## 1. 目录结构

```
desknest/
├─ package.json            # 入口 main.js / scripts: start·check·dist
├─ main.js                 # 主进程：桌面扫描、图标提取与缓存、系统调用、窗口与快捷键
├─ preload.js              # contextBridge 白名单（渲染层唯一能力入口）
├─ src/
│  ├─ index.html           # 骨架（CSP 已收紧：script-src 'self'；图标走 nest-icon: 协议）
│  ├─ styles.css           # 视觉系统 v3：白色毛玻璃 + 分页桌面 + 只做小面积模糊
│  ├─ catalog.js           # 关键词智能分类（主进程/自测共用，纯函数无依赖）
│  └─ renderer.js          # 渲染层：分页渲染、九宫格预览、主色提取、拖拽换页、设置抽屉、搜索
├─ assets/
│  ├─ desknest.ico         # 应用图标（tools/make-icon.js 生成）
│  └─ desknest-256.png     # 图标预览图
├─ launch.vbs              # 快捷方式用的静默启动器（无控制台 + 清污染变量）
└─ tools/
   ├─ icon-extract.ps1     # 真·系统图标导出：Shell 图像列表 256px → PNG（批量一次调用）
   ├─ make-icon.js         # 零依赖生成 .ico / .png（手写 PNG 编码 + 超采样）
   ├─ shot-v4.js           # v3 视觉/交互回归：7 项断言 + 5 张截图（含"测试不改桌面图标显隐"安全检查）
   ├─ click-test.js        # 真鼠标事件回归（CDP Input 注入，走命中测试）：收起按钮位置/可点、圆钮可点、拖动区不误触
   ├─ front-probe.mjs      # 把窗口提到最前（测试需要，最大化窗口会遮住它）+ 打印真实屏幕坐标
   ├─ glass-probe.js       # 毛玻璃探针：把提亮层压到 0.10 alpha，判断系统虚化到底有没有生效
   ├─ win-probe.mjs        # 打印窗口可见性 / 几何（判断 setBounds 是否被忽略）
   ├─ dbg-cycle.mjs        # 连续 expand/collapse 6 次，验证窗口几何不漂移、不掉进最小化态
   ├─ cdp-check.js         # 早期 CDP 自检脚本（v2 时期，保留作参考）
   ├─ shot.js              # 早期视觉回归（v2 时期，保留作参考）
   ├─ probe-icons.js       # 图标指纹分组（确认每个项目图标各不相同）
   ├─ verify-clean.js      # 校验遗留插件是否已从收纳库消失
   ├─ uninstall-legacy.ps1 # 需管理员：静默卸载 Rainmeter / Winstep Nexus 并清理残留
   └─ idle-measure.ps1     # 静置采样：进程数 / 内存 / CPU（CSV 输出）
```

数据落盘位置（`app.getPath('userData')`，默认 `C:\Users\<你>\AppData\Roaming\DeskNest\`）：

| 文件 | 内容 |
| --- | --- |
| `desknest-config.json` | 文件夹结构、主题色、分类归属、窗口位置、置顶开关、桌面图标显隐状态 |
| `iconcache\<hash>.png` | **真实系统图标 PNG（最高 256×256）**，哈希 = `路径+mtime+size`，命中即零成本复用 |
| `desknest-icon-cache.json` | 仅作回退：Shell 导出失败时的 `getFileIcon` dataURL 缓存，上限 800 条 LRU |

纯 JSON，不建数据库、不写注册表（除「隐藏桌面图标」这一个可一键恢复的开关）。

---

## 2. 启动方式

```powershell
cd desknest
npm install            # 首次：拉 electron（约 115MB，见下方「安装排坑」）
npm start              # 或 npm run check 先做语法自检
```

**安装排坑（本机真实踩到过，直接照抄）**

1. npm 直连失败时换镜像：
   ```powershell
   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
   npm install --registry=https://registry.npmmirror.com
   ```
2. 若报 `Electron failed to install correctly`（zip 下好了但解压中断），手动解压一次即可：
   ```powershell
   $zip = "$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v33.4.11-win32-x64.zip"
   $dist = "node_modules\electron\dist"
   Remove-Item $dist -Recurse -Force; New-Item -ItemType Directory $dist | Out-Null
   tar -xf $zip -C $dist
   Set-Content node_modules\electron\path.txt -Value "electron.exe" -NoNewline
   ```
3. 某些终端环境预设了 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 以纯 Node 启动并报
   `Cannot read properties of undefined (reading 'getPath')`。启动前清掉即可：
   ```powershell
   Remove-Item Env:ELECTRON_RUN_AS_NODE
   ```

打包（可选）：`npm i -D electron-builder && npm run dist`，产物为 7z/NSIS 安装包；
不装 builder 也能直接 `npm start` 跑。

### 桌面快捷方式 + 应用图标（不用命令行也能开）

```
assets/desknest.ico        ← 应用图标（256/48/32/16 四档，Blue→Cyan 渐变圆角方 + 九宫格白点）
assets/desknest-256.png    ← 同一张图的预览版
launch.vbs                 ← 静默启动器（无控制台窗口，且会清掉 ELECTRON_RUN_AS_NODE 等污染变量）
```

- 图标由 `node tools/make-icon.js` 生成：**零依赖手写 PNG 编码器**（zlib + CRC32）+ 4 倍超采样抗锯齿，再打进 PNG-in-ICO 容器；
- `node tools/make-icon.js` 可随时重画（改 `BRAND` 两个色值即可换配色）；
- 已在**桌面**和**开始菜单**创建 `DeskNest.lnk`（目标 = `launch.vbs`，图标 = `assets/desknest.ico`，工作目录 = 本目录）；
- 窗口本体也带上了这个图标（`new BrowserWindow({ icon })` + `setAppUserModelId('DeskNest')`），
  任务栏/固定到任务栏显示的是我们自己的图标，不是 Electron 默认图标。

> 为什么要绕一层 `launch.vbs`：某些工具链会在环境里预设 `ELECTRON_RUN_AS_NODE=1`，
> 那样双击快捷方式会"毫无反应"（electron.exe 以 Node 模式跑完就退）。启动器会先 `set ELECTRON_RUN_AS_NODE=`
> 再启动，本机已用**污染环境**实测：快捷方式照样起 3 个进程。
> 注意 `launch.vbs` 必须保持 **ASCII**（WSH 按 ANSI 读 .vbs，中文串会直接语法报错）。

---

## 3. 功能与交互

### 3.1 两个形态：桌面上的白色圆钮 ↔ 分页主界面

| 形态 | 长什么样 | 怎么切 |
| --- | --- | --- |
| **收起态（启动默认）** | 桌面底部偏上、屏幕水平居中，一颗 **54px 白色毛玻璃小圆钮**（窗口 124×124，含 20px 投影边），里面只有一个**向上的箭头**；圆钮本体也是毛玻璃：内部 14px 模糊的桌面缩略图 + 圆形裁切 | 单击圆钮 → 展开；按住圆钮外面那一圈透明区域可拖动它；**Win+D / 显示桌面 只最小化别的窗口，圆钮会留在桌面上**（收起态不给自己"最小化框"，所以被系统跳过） |
| **展开态** | 同一个窗口原地长大到 960×680（`easeOutCubic` 320ms 形变动画，窗外再留 20px 透明边放投影），露出分页主界面；**收起按钮在面板底部正中**（页码圆点下面那颗 30px 圆钮，与桌面圆钮同一条竖线） | 点底部正中那颗 `⌄` 收起；设置里也有「收起」；`Esc` 关面板 |

> 圆钮的三层质感：`linear-gradient` 上亮下沉 + `inset 0 -8px 14px` 球面内阴影 + 上半个球面高光弧，
> hover 时上浮 3px、箭头变品牌蓝并加一圈 `rgba(47,124,255,.22)` 外发光；收起态下 `body.collapsed` 会把
> 面板本身切成 `border-radius:50%` 并关掉 `.glass` 提亮层，保证投影是圆的而不是方盒子。
>
> **窗口默认不置顶**（v3 定稿）：桌面小部件只在桌面出现，不去压你正在用的窗口；需要它始终浮在
> 最上面时，到设置 → 窗口 → 打开「窗口置顶」。

### 3.2 手机式分页（**不是**一堆文件夹卡片）

- 每一页就是一张「手机桌面页」：图标网格 `auto-fill minmax(96px,1fr)`，一页放得下就一页，放不下可纵向滚动。
- **侧边框左右两个圆形小箭头**翻页（到首页/末页自动淡出），底部是页码圆点（当前页拉长成胶囊），鼠标可直接在空白处横向拖拽翻页（手机上划页的手感，松手回弹或翻页）。
- 页面名 **就地可改**：顶栏那个大标题就是输入框（回车/失焦保存）；右键空白处或设置面板里也能重命名。
- 「新建页面」→ 起名（如「编程」「学习」「游戏」）→ 从设置里的「添加应用」把人拉进当前页，或把别页的图标拖到页码圆点/箭头上直接搬过去。
- 翻到哪一页会被记住（`ui.pageIndex`）。

### 3.3 设置齿轮（原来那排工具栏按钮全收进这里）

顶栏右上角一个齿轮 → 底部升起白色毛玻璃抽屉，分组如下：

| 分组 | 项目 |
| --- | --- |
| 页面 | 新建页面 / 重命名当前页 / 当前页配色（8 色，同时决定这颗"文件夹"的底部光晕）/ 删除当前页（页内应用自动并入第一页，最后一页不允许删） |
| 应用 | 添加应用（多选 .lnk/.exe/.url/目录，加入**当前页**）/ 重新扫描桌面 |
| 桌面 | 隐藏 / 恢复桌面图标（开关带真实状态回显） |
| 窗口 | 窗口置顶 / 收起为桌面文件夹 / 最小化到后台（`Ctrl+Alt+D` 全局显隐）/ 退出 |
| 数据 | 配置与图标缓存路径、渲染层 JS 堆占用与图标数 |

### 3.4 其余能力（沿用并保持）

| 功能 | 说明 |
| --- | --- |
| 自动扫描 | 启动扫描「当前用户桌面 + 公共桌面」，识别 `.lnk / .url / .exe / .appref-ms` 与桌面文件夹；同名以用户桌面优先 |
| 真实图标 | Shell 图像列表 256×256（jumbo）真图标：解析 `.lnk` 的 `IconLocation`/目标路径、`.url` 的 `IconFile`，导出 PNG 到 `iconcache/`；失败才回退 `app.getFileIcon`（见第 4 节） |
| 智能分类 | 关键词打分归入 编程开发 / 桌面文件夹 / 办公学习 / 社交通讯 / 影音娱乐 / 游戏 / 设计创作 / 浏览器 / 系统工具 / 其他 → **直接就是前 10 页**（第 1 页=编程开发，第 2 页=桌面文件夹）；你可以随便改名、加页、搬图标 |
| 右键菜单 | 图标：打开 / 在资源管理器中定位 / 复制完整路径 / 移到「某页」/ 从本页移除；空白处：新建页面 / 重命名 / 添加应用 / 设置；收起的文件夹上：打开 / 添加应用 / 重扫 / 隐藏桌面图标 / 退出 |
| 双击启动 | 双击启动程序、打开文件夹、打开 `.url` 网址（`.url` 走 `openExternal`） |
| 搜索 | 顶栏搜索框实时筛选（110ms 去抖），结果显示为单张「搜索结果」页，清空即回到分页；`Ctrl+F` 聚焦，`Esc` 清空 |
| 键盘 | `←/→` 翻页，`Esc` 关面板/清搜索，`Ctrl+Alt+D` 全局显隐，页面名输入框回车保存 |
| 窗口 | 无边框透明圆角、玻璃面板外留 20px 透明边（专门用来渲染投影，所以看着是「浮在桌面上」）、可拖动、可缩放（收起态锁尺寸）、置顶开关、关闭即退出 |
| 反馈 | 底部 Toast + 设置里的资源占用回显 + 拖动时顶部提示条 |

---

## 3.5 视觉系统 v3（白色毛玻璃，按图 3 的质感重做）

**美术方向**：亮色磨砂玻璃。不是「白卡片」，是**半透明的白玻璃浮在桌面上** —— 背后壁纸/窗口要能隐约透过来。

| 层 | 做法 | 为什么好看 |
| --- | --- | --- |
| 玻璃本体 | `.glass` 两层叠加：左上 `radial-gradient` 白色 0.94→0.46 提亮 + 自上而下 `linear-gradient` 白 0.50→0.44 冷白罩 | 左上角"亮"、右下角"沉"，玻璃才有体积感 |
| 磨砂颗粒 | 一层 SVG `feTurbulence` 噪点（180px 平铺、`opacity:.30`、`mix-blend-mode:overlay`） | 真正的毛玻璃不是纯平滑的，颗粒是"磨砂"这两个字的来源 |
| 边缘 | `inset 0 1px 0 rgba(255,255,255,.92)` 顶高光 + `inset 0 0 0 1px rgba(118,142,184,.12)` 冷色描边 | 1px 的冷色 hairline 让白玻璃和白背景分得开 |
| 外投影 | 窗口比面板大 20px（`WINDOW_PAD`），那圈透明区域专门承载 `0 10px 24px rgba(16,30,60,.26)` | 卡片"浮"起来的关键；窗口内阴影不会被裁掉 |
| 图标托盘 | 每个图标站在 62px 白色圆角托盘上（`#fff .96 → .70` 竖向渐变 + 内高光 + 双层投影） | 图标不再和别的图标糊在一起 |
| 主色光晕 | 渲染层把图标画到 24×24 canvas，过滤白/黑/灰后求均值 → HSL（饱和度下限 58%、亮度 56%）→ `--tint`，用作托盘底的径向柔光 + hover 时的彩色外发光 | 每个图标自带品牌色氛围光，颜色永远"够艳不过曝" |
| 磁性动效 | 全部只动 `transform/opacity`：图标 hover 上浮 3px、托盘缩放、页面切换 `.42s cubic-bezier(.16,1.02,.36,1)`、窗口形变 `easeOutCubic`；零常驻 `requestAnimationFrame` | 丝滑 = 只让合成器干活 |
| 模糊克制 | `backdrop-filter` 只出现在小面积浮层（设置抽屉 / 右键菜单 / Toast / 确认框），主界面靠 `.glass` 提亮层，**不做大面积实时模糊** | 好看不能拿 CPU 换 |
| 字体 | HarmonyOS Sans SC / MiSans / 苹方 / 微软雅黑 依次回退；三级灰阶 `#16203a / #4e5c78 / #8390a8` | 亮底上最容易翻车的是对比度，全部按 WCAG 反推过 |

**本机实测结论（重要）**：这台机器上 Electron 的 `backgroundMaterial:'acrylic'` **不生效** —— 探针把提亮层压到 0.10 alpha 后，窗口区域直接透出了后面的 IDE 窗口（说明既没有 acrylic 也没有任何系统虚化）。所以最终形态是
`transparent:true + 纯 CSS 玻璃`（`NEST_GLASS=0`），"毛玻璃"质感由「高透白 + 噪点 + 边缘高光 + 投影」四件套给出来，见 `artifacts/v7-chip-onscreen.png`（真·桌面截图，背后壁纸能透出来）。
想切换形态：`NEST_GLASS=1`（acrylic+透明窗口）、`NEST_GLASS=2`（acrylic+不透明窗口），仅用于在支持的系统上对比。

**踩过的三个纯视觉/工程 bug（已修，可复现）**

1. `.move-bar` 声明了 `display:flex`，把 `hidden` 属性顶掉 → 提示条常驻显脏。修法：`.move-bar[hidden]{display:none!important}`。
2. **窗口被最大化窗口遮挡时，Chromium 把 `setTimeout` 节流到秒级** → 渲染层的搜索去抖/配置落盘都不按时触发，表现为"搜索没反应"。修法：测试脚本先把窗口置顶再断言（`tools/shot-v4.js` 开头就 `setAlwaysOnTop(true)`），产品逻辑本身没问题。
3. `src/catalog.js` 末尾裸写 `module.exports`，在渲染进程 `<script>` 里会抛 `ReferenceError: module is not defined`。修法：`if (typeof module !== 'undefined' && module.exports)` 包一层。

### 3.6 真·毛玻璃：为什么不是 backdrop-filter，也不是系统 acrylic

结论先说：**在这台 Windows 11 机器上，透明无边框 Electron 窗口拿不到任何系统层模糊**，所以毛玻璃是"自己抓背景 + 自己模糊"做出来的。

| 尝试 | 实测结果 |
| --- | --- |
| CSS `backdrop-filter: blur()` | 只能模糊**窗口内**的元素；窗口是 `transparent:true` 的独立层，桌面不在里面 → 模糊不到桌面 |
| `backgroundMaterial: 'acrylic'`（`transparent:false`） | 窗口变成**纯色平面**：边缘能量从原始的 3.92 掉到 **0.000**（完全均匀 = 没有背景、也不是模糊） |
| `SetWindowCompositionAttribute(ACCENT_ENABLE_ACRYLICBLURBEHIND)` + `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE=3)` | 调用返回 `swca=1 dwm=0`（成功），但画面**零变化**：边缘能量 3.542 vs 原始 3.65 |
| `desktopCapturer.getSources()`（主进程） | **直接把主进程卡死**：窗口再也 show 不出来、`/json/list` 无响应（僵尸进程还占着单例锁，导致后续几次启动都静默退出） |

最终方案（`main.js` + `styles.css`）：

1. `tools/grab-backdrop.ps1`：**一次性**抓主屏 → 双三次缩到 **96×60**（约 17KB）；
2. 触发时机只有三个，全是事件驱动、**没有轮询、没有常驻流**：启动（此刻窗口还没 show，抓到的背景最干净）、每次收起（窗口只有 144px 圆钮，几乎不留自己的影子）、展开时用缓存；
3. 渲染层 `.frost` 层：`background-image: var(--backdrop)` + `filter: blur(32px) saturate(1.65)` + `scale(1.08)`（放大避免模糊后边缘发虚）；`.glass` 白雾 alpha 压到 0.66/0.34/0.30，让真模糊透上来；
4. 拿不到背景图时（`body:not(.has-backdrop)`）自动退回厚白玻璃，界面不会"穿帮"；
5. 窗口形变那 300ms 走 `body.morphing` 把模糊降到 16px，保丝滑；`html.simple` 降到 20px。

**取证**（`CopyFromScreen` 系统级截图 + 像素判据，不是 CDP 截图）：面板后面能读出被模糊的浏览器文字（"为什么我们无法复制成功的东西"），视觉桥判定为 *translucent … over a blurred background*。
4. **`setResizable(false)` 会让 Windows 立刻按"当时的 min 尺寸"把窗口夹大**：收起动画结束时调用它，
   144×144 的白色圆钮被撑成 700×460（= 展开态的 min 尺寸），而且位置连续 3 次向右漂移 207px。
   修法：`applyCollapsedWindow()` 里严格按 `setMinimumSize → setMaximizable → setBounds → setResizable` 的顺序，
   且动画结束之后再调用；连续 expand/collapse 3 轮零漂移（见 §7）。
5. **被最大化窗口遮挡时 `requestAnimationFrame` 会被 Chromium 停掉** → 设置抽屉/确认框的 `rAF(() => classList.add('show'))`
   永远不执行（表现为"齿轮点了没反应"）。修法：`layer.hidden=false; void layer.offsetWidth; layer.classList.add('show')`，
   用强制重排代替 rAF。
6. **拖动区会把按钮的点击吃掉**：顶栏 `.bar` 是 `-webkit-app-region: drag`，原先放在顶栏里的收起按钮 `⌄`
   直接成了拖动区的一部分 —— 点它只会拖窗口，表现就是"按钮不管用"。修法两处：所有 `.ibtn` / `.collapse-btn`
   显式 `-webkit-app-region: no-drag`；同时把收起按钮**移到面板底部正中**（`.foot` 里那颗 30px 圆钮），
   与桌面圆钮在同一条竖线上，收起时视觉上是"原地缩回去"。
   回归脚本 `tools/click-test.js` 用 CDP `Input.dispatchMouseEvent` 打**真鼠标事件**（走浏览器命中测试，
   不是 DOM `.click()`），所以这类"被拖动区吃掉"的问题以后再出现会被直接测出来。
7. **Windows 上 `setBounds` 只对可缩放窗口生效**：展开动画开始时窗口还是 `resizable:false`（收起态锁死的），
   于是动画中途失效、窗口卡在 266×226 这种中间尺寸。修法：动画前先 `setResizable(true)`，动画结束再按形态收紧；
   同时 `animateBounds` 里加 `ms+500` 兜底，无论中间发生什么都会落到目标尺寸。

---

## 4. 性能设计：硬性要求逐条落地

| 要求 | 实现方式 | 代码位置 |
| --- | --- | --- |
| 无定时轮询 / 无 fs 监听 | 全项目零 `setInterval`、零 `fs.watch`、零 `chokidar`；扫描只在启动与手动点击时发生 | `main.js` `scanDesktop()` |
| 图标只提取一次 | 哈希 `路径+mtime+size → iconcache\<hash>.png`，命中直接复用；缺失的才批量交给一次 PowerShell | `main.js ensureIcons()` |
| 图标不进 IPC | 真实图标存盘，渲染层用 `nest-icon://icon/<hash>.png` 自定义协议按需读取（带 CORS 头，供取色用）；IPC 负载从 ~200KB/64 项降到 ~6KB | `main.js protocol.handle()` |
| 隐藏即彻底停摆 | 主进程 `hide/minimize` 事件 → 渲染层根元素挂 `.paused`：`animation-play-state: paused`、`transition: none`、丢弃 blur 合成层、清空待执行的分批渲染任务 | `main.js sendWinState()` / `renderer.js setPaused()` |
| 启动快 | 第二次启动 first-paint **644ms**，扫描 **89ms**（64 项） | 实测见 §7 |
| 动画全 CSS | 悬停上浮、拖拽高亮、面板弹性缩放全部 `transform/opacity` + `cubic-bezier`；**零 `requestAnimationFrame`** | `styles.css` |
| 分批渲染 | 每批 48 个节点，`setTimeout(0)` 让出主线程；隐藏时取消未完成批次 | `renderer.js mountChunked()` |
| 无侵入 | 不装驱动、不注入 explorer、不挂钩 API；唯一系统写操作是 `HideIcons` 注册表值（可一键恢复） | `main.js applyDesktopIconsVisible()` |
| 无后台驻留 | 单实例锁；`window-all-closed → app.quit()`；无托盘、无服务、无自动更新、无网络请求 | `main.js` 生命周期段 |
| 避免大面模糊 | 玻璃质感用「多层半透明 + 内高光 + SVG 噪点」伪造，**不用大面积 `backdrop-filter`**（真实模糊会每帧重采样桌面画面） | `styles.css` `.app` / `.noise` |
| 安全模型 | `contextIsolation: true`、`nodeIntegration: false`、preload 白名单化、CSP `script-src 'self'` | `preload.js` / `index.html` |

### 「隐藏桌面图标」是怎么做的（本机实测有效）

不是重启 explorer、不是注入，而是**等价于右键菜单点「显示桌面图标」**：

1. 写 `HKCU\...\Explorer\Advanced\HideIcons`（保证重启 explorer / 下次登录状态一致）；
2. 用 `EnumWindows`（本机 `FindWindow("Progman")` 取不到句柄，已改成枚举）找到 `SHELLDLL_DefView`，
   发 `WM_COMMAND 0x7402` → 立即生效；
3. 回读注册表确认真实状态（explorer 自己也会同步该键，所以可当作真状态读）。

实测证据：连续两次切换，注册表 `0x1 → 0x0 → 0x1`，同时桌面左上角 700×600 区域像素差异
**103329 / 92082 像素**（图标显隐造成的画面变化），说明真的生效而不是只改了注册表。

### 「真·系统图标」是怎么拿到的（这一版最大的视觉提升）

`app.getFileIcon()` 在本机实测**只能拿到 32px 的通用图标**：48 个 `.lnk` 全部返回同一张快捷方式占位图，
文件夹也只有一张 32px 通用文件夹图 —— 64 个项目只有 4 种图标，放大到大图标尺寸就是糊的。

改成走 Windows Shell 图像列表：

1. `.lnk` 用 `WScript.Shell.CreateShortcut()` 读 `IconLocation`，其次读 `TargetPath`（`%VAR%` 展开）；
   `.url` 正则读 `IconFile` → 拿到"真正的图标来源"（如 `原神.lnk → YuanShen.exe`）；
2. `SHGetFileInfo(SHGFI_SYSICONINDEX)` 取图标索引 → `SHGetImageList(SHIL_JUMBO)` → `IImageList.GetIcon` 拿 256×256 HICON
   （拿不到 256 就退 `SHIL_EXTRALARGE` 48px），`Icon.ToBitmap()` 保留 alpha → 存 PNG；
3. 整个过程**一次 PowerShell 批量处理 64 项**（首次 2.3s，之后 0ms），文件落在 `iconcache/`，按 `路径+mtime+size` 哈希失效；
4. 任何一项失败自动回退 `getFileIcon` dataURL，**绝不留空白图标**。

实测：64 个项目 → **64 张互不相同的 256×256 真图标**（`node tools/probe-icons.js`：`distinct: 64`），
对比修复前 `distinct: 4`。

> 坑：PowerShell 5.1 的 `Get-Content` 默认按 ANSI 读无 BOM 文件，Node 写出的 UTF-8 中文路径会被读花
> → 提取脚本里显式 `-Encoding UTF8` 读入、`.NET UTF8Encoding($false)` 无 BOM 写出。

---

## 5. 自检与复现（可直接跑）

```powershell
# 1) 启动时打开调试端口
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:NEST_DEV="1"; $env:NEST_TIMING="1"
Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList ".","--remote-debugging-port=9222"

# 2) v3 视觉/交互回归（6 项断言）+ 自动截图到 artifacts/
node tools/shot-v4.js
#    断言：收起态=白圆钮+向上箭头 / 展开态=分页主界面 / 侧边右箭头翻页 / 设置齿轮抽屉 / 搜索过滤 / 收起回圆钮
#    注意：脚本刻意不置顶、不抢焦点（用户在看屏幕）；代价是被遮挡时定时器被节流，所以等待按秒留足

# 3) 真·桌面外观取证（CDP 截图看不到系统层，要用系统截图；这一步会让窗口动一下，按需再跑）
node tools/front-probe.mjs raise      # 把窗口提到最前并打印屏幕坐标
#    然后用 .NET CopyFromScreen 按坐标截图 → artifacts/*-onscreen.png

# 4) 静置采样 CPU / 内存（CSV 落到 artifacts/）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\idle-measure.ps1 -Minutes 4 -IntervalSec 15 -Out ..\artifacts\idle-v4.csv
```

`tools/shot-v4.js` 覆盖：收起态九宫格预览与徽标、展开后页面数/图标数/页码圆点/箭头状态、
侧边框右箭头翻到第 2 页（`translateX` 位移 + 页面名切换）、设置抽屉 13 行 + 8 色色板、
搜索过滤（标题变「搜索结果」）、收起回圆钮（窗口回到 144×144）。

### 验收清单与本机证据（全部实跑过）

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 白色毛玻璃（按图 3 的质感） | ✅ | `artifacts/v7-chip-onscreen.png`、`v8-main-onscreen.png`（**系统级截图**，能看见背后壁纸/文档透过玻璃；CDP 截图看不到系统层，所以专门做了系统截图取证） |
| 启动即在桌面下方偏上出现白圆钮 | ✅ | 启动强制 `collapsed=true`，窗口 144×144（74px 圆钮 + 20px 投影边）水平居中、距工作区底部 14px；断言 `win=[144,144]`、`border-radius:50%`、箭头 SVG 2 条 path |
| 点开 = 收纳主界面，且是手机式分页 | ✅ | 断言 `pages=10 / tiles=64 / dots=10`；侧边小箭头翻页，`translateX(0%)→(-100%)`，底部圆点当前页拉长 |
| 主界面不是一堆文件夹卡片 | ✅ | 页面 = `grid-template-columns: repeat(auto-fill, minmax(96px,1fr))` 的图标网格，一页一屏纵向可滚 |
| 第一页可自行命名 + 自主添加软件 | ✅ | 顶栏标题就是可编辑输入框（`ui.pageIndex`/页名持久化）；「添加应用」多选后**加入当前页**（`moveSilently` 到当前 page id） |
| 原来那排按钮收进设置齿轮 | ✅ | 断言设置抽屉 13 行：页面 4 项 / 应用 2 项 / 桌面 1 项 / 窗口 4 项 / 数据 2 项；顶栏只剩 `⌄`、页名、搜索、齿轮 |
| 64 个真图标（无占位图） | ✅ | 断言 `broken=0`（所有 `img.naturalWidth>0`）；九宫格预览混合全库前 9 个图标 |
| 动画丝滑、空闲近 0 | ✅ | 见 §7；全部动效只走 `transform/opacity`，零常驻 `rAF`，模糊只在小浮层 |
| 无轮询 / 无 fs 监听 / 无联网 / 无托盘 | ✅ | 代码内零 `setInterval`/`fs.watch`/`fetch`；唯一的一次性 `setTimeout` 是窗口形变动画与"没显示就兜底 show" |
| 关闭即退出 | ✅ | `Stop-Process` 后 `Get-Process electron` 计数 = 0 |

`artifacts/` 里的实测产物：`v4-chip.png`（收起态）、`v4-main.png`（分页主界面）、`v4-page2.png`（翻页后）、
`v4-settings.png`（设置抽屉）、`v4-search.png`（搜索）、`v7-chip-onscreen.png` / `v8-main-onscreen.png`（**系统截图**）、
`icon-sheet.png`（64 张真图标接触印相表，一眼看出没有占位图）、`idle-v4.csv`（v3 静置原始数据）、
`idle-samples*.csv`（v2 时期 10 分钟默认/轻量模式原始数据）。

---

## 6. 方案对比：Electron vs Tauri vs C# WPF

| 维度 | Electron（本实现） | Tauri 2 | C# WPF / WinUI |
| --- | --- | --- | --- |
| 安装包/磁盘 | ~220MB（Electron 运行时） | **~5–10MB**（用系统 WebView2） | ~2–15MB（依赖 .NET 运行时） |
| 空闲内存（3 个自绘窗口级进程） | 约 150–260MB（本机实测见 §7） | **约 40–90MB** | 约 60–120MB |
| 启动 | 0.6–1.2s（本机二次启动 644ms） | 0.3–0.8s | **0.2–0.6s** |
| 系统图标提取 | `app.getFileIcon()` 一行可得，但**只有 32px 通用图标**（本机实测 64 项仅 4 种），要真图标同样得自己调 Shell 图像列表 | 需 `SHGetFileInfo` + Windows crate 手写 | `SHGetFileInfo` 原生最顺 |
| CSS 视觉表现力（玻璃/渐变/弹性动画） | **最强，改样式即改效果** | 同等（同样是 WebView） | 较弱，要手写 Effect/Storyboard |
| 拖拽、毛玻璃、字体可控性 | 高 | 高 | 中 |
| 跨平台 | Win/mac/Linux 全一致 | Win/mac/Linux（各平台 WebView 有差异） | 仅 Windows |
| 工程复杂度 | **低（无构建步骤，改完即跑）** | 中（Rust 工具链 + 前端构建） | 中高（XAML + 数据绑定） |
| 反作弊/杀软误报 | 无 | 无 | 无 |

**结论**：这个工具本质是「一张漂亮的自绘桌面面板 + 一次性的文件扫描」，
视觉要求高、系统调用少（只有图标提取与 ShellExecute），
Electron 是最省事且效果最好的选择（本实现零构建步骤、零依赖）；
若你的首要目标是**极致轻量与体积**，Tauri 2 能把它压到 10MB 安装包 + 50MB 内存，
UI 代码几乎可以照搬本项目的 `index.html/styles.css/renderer.js`（只需把 `window.nest` 换成 `invoke` 封装）；
若追求原生最稳、最省内存且有 C# 经验，WPF 是次选，但玻璃拟态与弹性动画的开发成本会显著上升。

---

## 7. 实测数据（本机：Windows 11，16 逻辑核心，64 个桌面项目 → 10 个分类文件夹）

启动耗时（`NEST_TIMING=1` 打点，从主进程加载到首帧）：

| 场景 | first-paint | 桌面扫描 | init 完成 |
| --- | --- | --- | --- |
| 首次启动（刚解压完 Electron，被杀软/系统冷启动拖慢） | 11696ms | 143ms | 11782ms |
| **二次启动（日常真实情况）** | **604–644ms** | **89–96ms** | **644–703ms** |
| 换成真·系统图标后的首次启动（64 项一次性导出 256px PNG） | **565ms** | 2300–2800ms（一次性，之后走缓存） | 2811ms |
| **图标缓存命中后的启动（历史常态）** | **572ms** | **28ms** | **517ms** |

扫描 64 个桌面项目、提取 64 个系统图标的总耗时 = 89–96ms（图标走 dataURL 缓存），
换真图标后缓存命中为 **28ms**；只有第一次见到某个图标时才会花 2.3s 导出 256px PNG，
远低于「启动 2 秒」的要求（首帧 565–644ms 已经可见，图标是随后补上的）；
网络服务已并入主进程（`NetworkServiceInProcess2`），常驻进程数从 4 降到 **3**（main + gpu + renderer）。

渲染层占用（状态栏实时显示，渲染层 JS 堆 **9.5MB**）。

**静置实测（v3 白色毛玻璃 + 10 页分页版）**

| 指标 | 首次采样 | 末次采样 | 全程均值 | 峰值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 专用工作集（优化前：直接挂 10 页 64 张 256px 图标） | 234.4MB | 226.6MB | **231.8MB** | 250.1MB | 4 分钟 14 次采样；增长 −7.8MB（无泄漏，但底座偏高） |
| 专用工作集（优化后：`loading="lazy"` + 复用一张取色 canvas） | 190.5MB | 178.1MB | **185.4MB** | 190.5MB | 3 分钟 11 次采样；**均值降 46MB（−20%）**，末次 178MB，增长 −12.4MB |
| 工作集（含共享/驱动映射，3 进程合计，优化后） | 439.2MB | 411.9MB | 423.0MB | 439.2MB | 优化前 470.2MB → 降 47MB |
| CPU（按 16 核归一，优化后） | 0% | 0% | **0.015%** | 0.138% | 优化前同口径 0.065% |

> 「优化后」那两处改动很小但很值：
> ① `.item img` 加 `loading="lazy" decoding="async"` —— 不在视口里的页先不解码 256px 位图；
> ② 取色不再每个图标新建 canvas，改全局复用同一张 24×24（`willReadFrequently:true`），
> 避免 Chrome 留下几十个 GPU-backed canvas 等 GC。

**轻量模式（v3 build，`npm run start:lite` = `--disable-gpu`，2 分钟 7 次采样）**

| 指标 | 首次 | 末次 | 均值 | 峰值 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 专用工作集 | 89.6MB | 83.6MB | **86.2MB** | 89.6MB | **≤150MB 硬指标达标**（且增长 −6MB） |
| 工作集合计 | 339MB | 333.5MB | 335.7MB | 339MB | GPU 进程消失后回落 |
| CPU | 0% | 0% | 0.009% | 0.018% | 仍然近 0 |
| 进程数 | 3 | 3 | 3 | 3 | main + gpu(空壳) + renderer |

**窗口形态稳定性（v3 回归，`node tools/dbg-cycle.mjs`）**

```
start    {"x":817,"y":798,"w":144,"h":144}   collapsed（74px 圆钮 + 20px 投影边）
expand   {"x":460,"y":418,"w":1000,"h":720}  ← 底部居中 + 20px 投影边
collapse {"x":817,"y":798,"w":144,"h":144}   ← 连续 expand/collapse 3 轮零漂移、零最小化
```

**静置实测（v2 时期，供对照）**（新版本 4 分钟采样 14 次 / 每 15 秒，进程数恒为 3：main + gpu + renderer）

| 指标 | 首次采样 | 末次采样 | 全程均值 | 峰值 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 专用工作集（新版本，256px 真图标） | 177.2MB | 171.6MB | **172.5MB** | 177.2MB | 净减少 5.6MB，**换真图标没有带来内存上涨** |
| CPU（新版本） | 0.006% | 0.006% | **0.007%** | 0.042% | 与旧版一致，仍在噪声级 |

**静置 10 分钟实测**（16 逻辑核，采样 37 次 / 每 15 秒，进程数恒为 3：main + gpu + renderer）

| 指标 | 首次采样 | 末次采样 | 全程均值 | 峰值 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 专用工作集（任务管理器「内存」列口径，3 进程合计） | 188.5MB | **134.2MB** | 172.4MB | 223MB | 先升后降，**净减少 54MB，无泄漏** |
| 工作集（含共享/驱动映射，3 进程合计） | 428.2MB | 391.7MB | 409.6MB | 428.2MB | 缓慢回落，稳定 |
| CPU（按 16 核归一，等同任务管理器百分比） | 0% | **0.006%** | 0.017% | 0.389%（瞬时，启动后第一次交互） | 后半程均值 **0.004%**、峰值 0.018% → **接近 0** |

> 说明：官方目标的 150MB 用「专用工作集」衡量，本实现稳态多在 165–175MB 区间，
> 在 Chromium 完成缓存回收后降到 **134MB**（达标），均值则略高于目标约 10–15%。
> 想再压低，用轻量模式启动（已加进 package.json）：`npm run start:lite`（= `electron . --disable-gpu`）：
> 专用工作集直接掉到 **86–90MB**（2 分钟采样 7 次，全程 3 进程，CPU 0.007%），
> 工作集合计 309MB（GPU 进程 147.9MB → 63.7MB）。
> 代价是悬停/展开动画改由 CPU 合成，流畅度略降；已抓 `artifacts/desknest-nogpu.png` 确认视觉一致（透明圆角无黑边）。
> 另外：透明窗口 + GPU 合成是内存大户，若把目标改成任务管理器里「内存」列，本实现请按 **86MB（lite）/ 134–175MB（默认）** 预期。

对照：Electron 的最小可观测成本来自 3 个 Chromium 进程的固定底座（每个进程 40–90MB 私有内存），
这也是「Electron 版做不到 50MB 内存」的根本原因；要那一步只能用 Tauri/WPF（见 §6）。

---

## 8. 交接记录：清掉两个遗留桌面插件（本机真实执行）

用户在桌面用 **Rainmeter**（桌面小部件）+ **Winstep Nexus**（停靠栏/水印插件）时，两者与 DeskNest 的定位重复。
按"卸载干净"执行并留了回滚：

| 项目 | 结果 |
| --- | --- |
| Rainmeter 4.5.26 | 进程停止 → 官方卸载器 `C:\Program Files\Rainmeter\uninst.exe /S`（退出码 0）→ 残留 `C:\Program Files\Rainmeter`、`HKLM\SOFTWARE\WOW6432Node\Rainmeter`、卸载注册表项、`%APPDATA%\Rainmeter`、启动项 `Startup\Rainmeter.lnk` **全部清除** |
| Winstep Nexus（Xtreme） | 进程停止 → 官方卸载器 `D:\nexus\Winstep\unins000.exe /SILENT` → 注册表项与 `HKLM\Software\WOW6432Node` 子键清除 → 残留目录 `D:\nexus`（含 Nexus.exe/unins000.* 等 19MB）与 `NexusSetup.exe`、桌面 `Nexus.lnk`、HKCU Run 里的 `Nexus` 自启项 **全部清除** |
| 释放空间 | 约 **81MB**（Rainmeter 7.2MB + Winstep 73.6MB，另外还有残留 19MB 一并删掉） |
| 未动的东西 | Wallpaper Engine（在跑动态壁纸，属另一类需求）、OneDrive/百度网盘/夸克/火绒/Everything 等自启项一律没碰 |
| 回滚材料 | `uninstall-backup\<时间戳>\`：`Rainmeter-AppData.zip`（整套配置与 Layouts）、`winstep-config\`（配置文件）、`registry\*.reg`（卸载注册表项导出） |

执行脚本：`tools/uninstall-legacy.ps1`（**需管理员**，会用一次 UAC；日志和结果 JSON 落在 `%TEMP%`）。
因为 `C:\Program Files` 与 HKLM 都需要提权，这一步只能由用户点一次"是"；其余全部由非提权会话完成。

验收：`Get-Process Rainmeter,Nexus` = 0；`D:\nexus`、`C:\Program Files\Rainmeter`、`%APPDATA%\Rainmeter` 均不存在；
`node tools/verify-clean.js` → `legacy_left = []`、`own_shortcut = ["DeskNest"]`、收纳库 64 项 / 10 个文件夹。

---

## 9. 已知边界与未覆盖项

1. **`.lnk` 目标未解析**：为了扫描速度与零 COM 调用，快捷方式只取 Shell 图标并按文件名分类，
   未解析真实目标路径（启动走的仍是 `shell.openPath`，不影响使用）。
   需要「按目标 exe 精确分类」时可加 WScript.Shell COM 解析，代价是每个 lnk 多几毫秒。
2. **桌面图标显隐是本机验证过的**：`HideIcons` + `WM_COMMAND 0x7402`。若某些系统魔改了桌面
   （例如第三方桌面美化接管了 `WPEDesktopCEFWindow`），`SHELLDLL_DefView` 可能不在常规位置，
   此时仍有注册表路径兜底（重启资源管理器后生效）。
3. **首次运行的超长启动**是这颗刚解压的 electron.exe 被安全软件扫描造成，与本项目代码无关；
   安装包分发（签名 exe）后不会出现。
4. 打包脚本给了 `electron-builder` 配置但未在本机安装打包依赖，未产出安装包。
5. 未做多显示器切换、多用户桌面（其他用户桌面不扫描，只扫当前用户 + Public）。