# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

本文件记录项目的所有重要变更，格式遵循 Keep a Changelog，版本号遵循语义化版本。

## [Unreleased]

### Added / 新增

- CLI mode: `--source cli --project <local .eprj3>` reviews a local project
  through the EasyEDA Pro / JLCEDA Pro desktop client's built-in CLI (v4.1.70+).
  The skill opens the project in a session (`open --path`, headless by default;
  `--cli-show` shows the window), reads netlist, BOM, DRC, pins, page SVGs and
  geometry through the same read-only editor APIs as Bridge mode, and closes the
  session it created (`session close --destroy`) even on failure. The `.eprj3`
  file format is never parsed by the skill. After `open` a CLI session has no
  document active, and netlist/DRC/primitive APIs require one: the skill lists
  the schematic pages and opens one (`openDocument` → `waitForDocumentReady` →
  `activateDocument`) — the first page by default, `--page <uuid|名称>` selects
  another (uuid required when page names repeat across schematics). CLI detection
  covers both editions (`lceda-pro` / `easyeda-pro`) with a `--cli <exe>` override;
  the transport layer is injectable, so the collection pipeline is covered by
  tests without a real EDA. Opening a project may upgrade its file format
  (two-way-synced folder projects) — the docs advise a backup.
  CLI 模式：`--source cli --project <本地工程.eprj3>` 经桌面客户端内置 CLI（v4.1.70+）
  审查本地工程。在会话中打开工程（默认 headless，`--cli-show` 显示窗口），通过与桥接模式
  相同的只读 editor API 读取网表、BOM、DRC、引脚、页面 SVG 与几何；`open` 后没有活动文档，
  而网表/DRC/图元 API 需要活动文档，因此会自动取图页列表并打开图页（`openDocument` →
  `waitForDocumentReady` → `activateDocument`，默认第一个图页，`--page <uuid|名称>` 指定
  其他，页名跨原理图重复时用 uuid），并在 finally 中关闭自建会话（`session close
  --destroy`）；**不解析 .eprj3 文件格式**。CLI 自动探测两个发行版（lceda-pro /
  easyeda-pro），可用 `--cli` 指定；传输层支持注入执行器，采集管线可脱离真实 EDA 做回归
  测试。打开工程可能升级文件格式，文档提示先备份。

- Thirteen new deterministic rules from an external schematic-review post-mortem
  (55 total, `R001`–`R060`): `R046` reset pin tied to a rail (P0 to GND / P1 to power),
  `R047` paralleled power outputs on one rail, `R048` USB-C CC1/CC2 missing Rp/Rd,
  `R049` MCU core-regulator pin (VCL/VCAP) missing storage cap, `R050` one supplier
  part with conflicting values, `R051` power-select jumper without a default,
  `R052` VREFH/VREFL decoupling, `R053` decoupling count per power pin (strict),
  `R054` connector data-line ESD/TVS, `R055` cross-power-domain direct connection
  (strict), `R056` LED current estimate outside 0.5–20 mA, `R058` crystal nets
  routed to headers, `R060` auto-named connector nets (strict).
  外部原理图评审复盘落地，新增 13 条确定性规则（共 55 条，R001–R060）：
  R046 复位脚接死电平（接地 P0/接电源 P1）、R047 电源输出直接并联、R048 USB-C CC 缺 Rp/Rd、
  R049 内核稳压脚（VCL/VCAP）缺储能电容、R050 同一料号多个值、R051 电源选择跳线无默认、
  R052 VREFH/VREFL 去耦、R053 去耦数量核对（strict）、R054 连接器数据线 ESD、
  R055 跨电源域直连（strict）、R056 LED 电流估算越界、R058 晶振节点引到排针、
  R060 连接器自动网络名（strict）。
  `R057` (LDO minimum output capacitance) is reserved for v1.1 — it needs a device
  library; `R059` (SWD header pinout) is implemented as an open question because
  there is no universal SWD pinout standard.
  R057（LDO 最小输出电容）预留至 v1.1（需器件库）；R059（SWD 排针线序）因无统一标准，
  实现为 open question 而非编号规则。
- Six new deterministic rules (42 total at that point, `R001`–`R045`):
  `R040` isolated ground nets, `R041` UART TX-TX/RX-RX wiring,
  `R042` regulator input capacitor, `R043` optocoupler input series resistor,
  `R044` CAN/RS-485 bus termination (strict), `R045` SWD pair completeness (strict).
  新增 6 条确定性规则（当时共 42 条）：R040 孤立地网络、R041 UART 同方向互连、
  R042 稳压器输入电容、R043 光耦输入限流、R044 CAN/RS-485 终端（strict）、
  R045 SWD 调试对完整性（strict）。
- 43 new regression tests (79 total) covering the BOM TSV contract, noise
  boundaries, classification overrides, all new rules, the merge-flow fixes,
  screenshot page identity (schematic-dimensioned keys, page-local uid
  collisions, page/component verification, legacy SVG viewBox identity), and
  the CLI transport (detection, JSON envelope, session lifecycle, page
  activation and `--page` selection, collection over an injected executor).
  新增 43 条回归测试（共 79 条），覆盖 BOM TSV 契约、噪声边界、分类覆盖、全部新规则、
  合并流程修复、截图页身份（原理图维度页键、页内局部 uid 碰撞、页/器件校验、旧缓存 SVG
  viewBox 身份）与 CLI 传输层（探测、JSON 信封、会话生命周期、图页打开与 `--page`
  选择、注入执行器的完整采集）。

### Fixed / 修复

- Screenshot page identity: page keys now carry the schematic dimension
  (`page-<schematic>__<page>.svg`, Unicode names preserved, UUID suffix on
  collision), so two schematics' same-named pages no longer overwrite each
  other's geometry entry and SVG; `comp.page` / `location.pages` / packet facts
  carry unique `Schematic / Page` labels plus `pageKey` (a bare `P1` was
  ambiguous). EasyEDA primitive uids are **page-local** — on a real
  two-schematic board all 27 core uids collided with the baseboard page as
  different parts — so page mapping and `choosePage` verify designator
  agreement with the netlist before claiming a page, and capture verifies the
  cached SVG's viewBox against the one recorded at collect time. Mismatches
  produce placeholders (`截图不可用（页/器件不匹配）` / `（页面 SVG 与几何不匹配）`)
  instead of wrong red boxes: the real board went from 35 wrong-page screenshots
  to 0 wrong boxes (29/29 correct crops after re-collect). `scope page:P1` still
  works (case-insensitive, bare page name or page key).
  截图页身份修复：页键带原理图维度（`page-<原理图>__<图页>.svg`，保留中文名，碰撞加 UUID 后缀），
  两个原理图的同名图页不再互相覆盖 geometry 与 SVG；comp.page / location.pages / packets 写唯一
  “原理图 / 图页”标签与 pageKey（裸 P1 有歧义）。EasyEDA 图元 uid 是**页内局部的**——真实双原理图
  板卡上核心板 27 个 uid 与底板页全部碰撞且位号不同——页映射与 choosePage 裁剪前校验位号与网表一致，
  capture 还用 collect 记录的 viewBox 校验缓存 SVG 身份；不匹配一律占位
  （截图不可用（页/器件不匹配）/（页面 SVG 与几何不匹配）），不画错框：真实板卡从 35 张错页截图
  变为 0 张错框（重新采集后 29/29 正确裁剪）。scope page:P1 仍兼容（忽略大小写、裸页名或页键）。

- `R016`: the DNP-candidate open question was unreachable (skipped by the
  `addIntoBom` filter); it now fires for `Add into BOM=false` parts with empty values.
  R016 的 DNP 候选 open question 原为死代码，现对 `Add into BOM=false` 且缺值器件正常产生。
- Missing `Add into BOM`/`Convert to PCB` properties now default to `yes` (with a
  model warning) instead of silently disabling R016/R017/R019.
  BOM/PCB 标志属性缺失时默认按 yes 处理并记录 warning，不再整体静默跳过 R016/R017/R019。
- `R012`: ground/power pads of 4-pad crystals no longer trigger missing-load-cap
  findings; active oscillators (with a supply pin) are skipped entirely.
  R012 不再对 4 脚晶振接地焊盘误报；带电源脚的有源振荡器整体跳过。
- `R009` now matches numbered I2C nets with prefixes (`I2C_SCL0`, `MCU_SDA1`).
  R009 支持带前缀和序号的 I2C 网络名。
- `R014` name fallback also recognizes `+`/`-` suffix pairs (`USB_D+`/`USB_D-`).
  R014 命名回退支持 +/- 后缀差分对。
- Zero-ohm values `0R0`/`0.0`/`000` are recognized by R029 (rail shorts),
  R035 (jumper exemption), and R008 (one-hop decoupling).
  0Ω 识别覆盖 0R0/0.0/000 等写法（R029/R035/R008）。
- `R002` treats `_NC`/`(NC)`/numbered NC pin-name variants as NC candidates per PRD.
  R002 按 PRD 识别 `_NC`/`(NC)` 等 NC 引脚名变体。
- `R006` downgrades floating optional power-output pins (`VOUT`/`VBUS`) to P1;
  `R018` now reports the no-BOM/no-PCB-with-connections combination (P2).
  R006 可选电源输出脚悬空降为 P1；R018 补齐 false/false 且有连接引脚的组合（P2）。
- `R033`/`R034`/`R036` check every matching pin, not only the first one.
  R033/R034/R036 逐一检查所有匹配引脚（多 EN/多路输出不再漏检）。
- Placeholder value set now includes `N/C`/`DNP`/`DNI`; mechanical parts are
  exempt from R016; R020 pre-filters net pairs by length for large designs.
  占位符集合补充 N/C/DNP/DNI；机械件豁免 R016；R020 增加长度预过滤提升大设计性能。
- Live collection works with run-api-gateway 4.1.105, which executes code as an
  `async function(eda){}` body: every execute payload now returns explicitly, and
  the synchronous `getEditorCurrentVersion()` is guarded with `try/catch`.
  适配 run-api-gateway 4.1.105 的 `async function(eda){}` 执行模型：所有执行代码
  显式 `return`，同步的 `getEditorCurrentVersion()` 改用 `try/catch`。
- File-level `open_questions` in `ai/findings.ai.*.json` are now merged into the
  report instead of being dropped.
  合并 AI 结果文件顶层的 `open_questions`，不再丢失文件级待确认问题。
- Findings show the schematic name and page name (`Schematic1 / P1`), resolved via
  `getAllSchematicPagesInfo()` / `getAllSchematicsInfo()`.
  问题条目展示原理图名与图页名（如 `Schematic1 / P1`）。
- The report header shows the review model, total duration, and token usage
  (exact when recorded in `review-context.json`, otherwise marked as estimated).
  报告头部展示审查模型、总用时与 Token 消耗（有精确值时直接展示，否则标注估算）。
- `R026` BOM parsing: EasyEDA's `getBomFile('bom','csv')` actually exports **TSV**;
  the comma-only parser mapped every column to index 0, producing ~106 noise
  findings on a real board (wrong quantities, missing designators, part-number
  mismatches — all one bug). The delimiter is now auto-detected from the header
  line (`\t`/`,`/`;`), quoted-comma CSV still works, quantities >10000 become a
  warning instead of a finding, and supplier-part comparison ignores case/whitespace.
  R026 BOM 解析：嘉立创 `getBomFile('bom','csv')` 实际导出 TSV，原逗号解析器把所有列
  映射到索引 0，真实板卡上产生约 106 条噪声（数量错、位号丢、料号不一致——同一个 bug）。
  现按首行自动识别分隔符，带引号逗号 CSV 仍兼容；数量 >10000 只 warning；料号比较忽略大小写与空白。
- `R020` no longer flags port-style auto names (`P000`/`P001`), names of length ≤3
  (`DN`/`DP`), or intentional complementary pairs (`DP/DN`, `+/-`, `SCL/SDA`, …).
  R020 不再误报端口式自动名（P000/P001）、长度 ≤3 短名（DN/DP）与互补后缀有意配对（DP/DN、+/-、SCL/SDA 等）。
- Component classification: the generic `U` prefix no longer beats a specific
  description — `U1` named `HDR-TH_12P` is a connector, `U11` named `AMS1117-3.3`
  is a regulator (common JLC library parts). Added regulator part-number and
  HDR/SIP/HEAD/TYPE-C description patterns, `AVCC`/`AVSS`/`VREF` pin classes, and
  `/`-segment matching for composite pin names (`P010/VREFH0`, `P300/SWCLK`).
  器件分类：通用 U 前缀不再压过具体描述——名为 HDR-TH_12P 的 U1 是连接器、名为
  AMS1117-3.3 的 U11 是稳压器（嘉立创库常见件）；补充稳压器料号与 HDR/SIP/HEAD/TYPE-C
  描述模式、AVCC/AVSS/VREF 引脚分类、复合引脚名（P010/VREFH0）按 / 分段匹配。
- `R007` accepts pin-name power-output evidence (`VBUS`/`VOUT`/`V3` on ic-classified
  parts such as CH330N/AMS1117) and traverses 2–3-pin power-select jumpers whose
  pins all sit on power nets.
  R007 认可引脚名电源输出证据（CH330N/AMS1117 等被分类为 ic 的 VBUS/VOUT/V3），
  并允许穿越全电源网络的 2–3 脚电源选择跳线。
- `R010` reset pin pattern extended to `RES`/`XRES`/`MCLR` (Renesas RA), skips
  connectors/testpoints, and skips pins tied directly to rails (R046 owns those).
  R010 复位引脚模式扩展 RES/XRES/MCLR（瑞萨 RA），跳过连接器/测试点，
  直接 tied 到电源/地的引脚交由 R046。
- `R005` (DRC dangling) now suppresses `R001` on the same net — one net, one finding.
  R005（DRC 悬空）抑制同一网络的 R001，一个网络只报一条。
- `R002`: floating Type-C `SBU1/SBU2` pins become an open question (usually
  intentional in USB2.0 designs), not a defect.
  R002：Type-C SBU1/SBU2 悬空转为 open question（USB2.0 设计通常故意不接），不报缺陷。
- `R016` downgrades to P3/medium when the BOM already provides a valid value
  (netlist annotation gap, not a missing parameter).
  R016 在 BOM 已提供有效值时降为 P3/medium（网表标注不完整，而非缺参数）。
- Merge flow: a single shared net no longer deduplicates distinct findings
  (e.g. R007 "no source" vs an AI "paralleled outputs" finding on the same rail);
  AI enhancements match the stable `findingKey` first (now emitted by lint and
  carried in packets) instead of the drifting display id; merged severity only
  escalates; `--max-findings` truncation never cuts P0/P1, AI conclusions, or
  enhanced findings, drops R020/R026 noise first, and records per-rule omission
  counts (`coverage.omittedByRule`) shown in the report.
  合并流程：仅共享一个网络不再判重（同一电源轨上 R007 无来源 vs AI 双输出并联必须各自保留）；
  AI 增强优先按稳定 findingKey 关联（lint 输出即分配、packets 携带），不再依赖会漂移的显示 id；
  合并严重度只升不降；--max-findings 截断永不砍 P0/P1、AI 结论与增强条目，优先砍 R020/R026
  噪声，并按规则记录省略数量（coverage.omittedByRule）在报告中注明。

### Changed / 变更

- `R023` (power-entry protection) promoted from strict-only to standard — USB-powered
  boards need the entry-protection check in a default review.
  R023（电源入口保护）从 strict-only 提升到 standard——USB 供电板在默认评审下也需要入口保护检查。
- Pin-level suppression order extended: `R046 > R048 > R006 > R015 > R011 >
  R027/R028 > R034 > R036/R042 > R008 > R010 > R002`; net-level `R005 > R004 > R001`.
  引脚级抑制顺序扩展：R046 > R048 > R006 > R015 > R011 > R027/R028 > R034 > R036/R042 > R008 > R010 > R002；
  网络级 R005 > R004 > R001。

- The agent asks the user for the report output directory (`--out`) before
  running a review.
  审查开始前先询问用户报告输出目录（`--out`）。
- Report layout uses the full window width instead of a fixed 1200 px column.
  报告页面改为自适应全宽，取消固定 1200px 宽度。

### Planned / 计划中

- Protel2 `.net` input support (v1 currently supports EasyEDA `.enet` only).
  支持 Protel2 `.net` 输入（v1 仅支持 EasyEDA `.enet`）。
- Finding waivers via `waivers.json`.
  通过 `waivers.json` 配置问题豁免。
- Optional PNG screenshots (`--image-format png`) when the Bridge is available.
  Bridge 可用时支持可选 PNG 截图（`--image-format png`）。
- Revision-to-revision netlist comparison.
  改版网表对比。

## [1.0.0] - 2026-11-19

### Added / 新增

- Initial public release as a standard Agent Skill for Claude Code and other
  Agent Skills-compatible tools.
  首次公开发布，作为适用于 Claude Code 及其他兼容 Agent Skills 工具的标准 Skill。
- Live review mode that exports netlist, BOM, DRC, pin metadata, page SVG, and
  geometry from the currently open EasyEDA project through the
  `easyeda-api-skill` Bridge. Read-only by design.
  实时审查模式：通过 `easyeda-api-skill` Bridge 从当前打开的 EasyEDA 工程导出
  网表、BOM、DRC、引脚元数据、页面 SVG 和几何数据，全程只读。
- Offline review mode driven by an exported `.enet` file, with optional BOM and
  DRC inputs.
  离线审查模式：仅依赖导出的 `.enet` 文件，可选附带 BOM 与 DRC。
- Deterministic rule engine with 36 rules (`R001`–`R039`, excluding the retired
  `R021` and v1.1 placeholders), covering connectivity, power/ground,
  interfaces, component-level checks, parameters/BOM, and polarity.
  确定性规则引擎，共 36 条规则（`R001`–`R039`，不含已废弃的 `R021` 和 v1.1
  预留号），覆盖连接性、电源/地、接口、器件级检查、参数/BOM 和极性。
- Packet-based AI review: prioritized power, IC, interface, connector, passive,
  and consistency packets; per-packet context isolation; evidence-only
  findings; merge-time schema and evidence validation, deduplication, and
  stable `findingKey` generation.
  逐包 AI 审查：按优先级生成电源、IC、接口、连接器、无源件和一致性审查包；
  包间上下文隔离；结论必须带证据；合并阶段执行 schema 与证据校验、去重，并生成
  稳定的 `findingKey`。
- Self-contained HTML report with severity dashboard, coverage percentages,
  filtering, search, lightbox, dark mode, print layout, local review status,
  and Markdown minutes export.
  离线 HTML 报告：级别仪表盘、覆盖率、筛选、搜索、放大、深色模式、打印样式、
  本地评审状态和 Markdown 纪要导出。
- Annotated SVG screenshots for P0/P1 findings, cropped locally from cached page
  SVG with red highlight boxes; graceful placeholders when geometry is
  unavailable.
  P0/P1 问题的红框 SVG 截图：基于缓存的页面 SVG 本地裁剪；缺少几何数据时显示占位
  提示，不绘制错误坐标。
- Chinese and English output (`--lang zh|en`).
  中英文输出（`--lang zh|en`）。
- CLI with `run`, `collect`, `lint`, `packets`, `merge`, `capture`, `report`,
  and `ai-done` subcommands; CI thresholds and documented exit codes.
  提供 `run`、`collect`、`lint`、`packets`、`merge`、`capture`、`report`、
  `ai-done` 子命令，以及 CI 阈值和完整退出码。
- Prompt-injection resistance: packet text is treated strictly as data, with
  suspicious embedded instructions reported as open questions.
  提示注入防护：审查包中的文本一律按数据处理，疑似嵌入指令作为待确认问题报告。
- Test suite using Node.js built-in test runner, with synthetic rule fixtures.
  基于 Node.js 内置测试运行器的测试套件，使用匿名合成 fixture。
- Documentation: bilingual README, product requirements document, complete
  review checklist (~280 items), rule catalog, netlist format notes, AI prompt
  contract, report schemas, and screenshot coordinate conventions.
  文档：中英双语 README、产品需求文档、完整审查清单（约 280 项）、规则目录、
  网表格式说明、AI 提示词契约、报告 schema 和截图坐标约定。

### Known limitations / 已知限制

- Does not review PCB layout, routing, signal integrity, EMC, or simulation.
  不审查 PCB 布局布线、信号完整性、EMC 或仿真。
- Does not replace manual review or EasyEDA ERC/DRC.
  不替代人工评审或 EasyEDA 自带的 ERC/DRC。
- Does not verify symbol-library/footprint-library internal pin mappings.
  不验证符号库/封装库内部引脚映射。
- Live mode reviews only the currently active engineering project and board;
  it does not open or switch projects automatically.
  实时模式只审查当前激活的工程和板卡，不自动打开或切换工程。
- Offline mode has no schematic geometry, so screenshot generation is skipped.
  离线模式没有原理图几何数据，因此不生成截图。
- LED symbols that use the `D` designator may be classified as diodes, which can
  cause LED-specific rules to be skipped.
  使用 `D` 位号的 LED 可能被归为二极管，导致部分 LED 规则跳过。
