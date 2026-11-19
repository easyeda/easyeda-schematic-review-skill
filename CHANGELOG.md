# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

本文件记录项目的所有重要变更，格式遵循 Keep a Changelog，版本号遵循语义化版本。

## [Unreleased]

### Fixed / 修复

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

### Changed / 变更

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
