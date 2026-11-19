# 规则目录（v1.0）

> 这里是**确定性规则引擎**实现的 36 条规则（`R001~R039`，剔除废弃/预留号）。
> 完整的 AI/人工审查面见 `references/review-checklist.md`（约 280 项，含电源树、保护、时序、
> 模拟、接口、安规、可制造性等）。规则只是清单中可自动化的子集。

模式口径：`quick` 跑确定性规则集；`standard` 跑全部 v1 核心规则；`strict` 额外跑 strict-only。
规则只使用 `categoryConfidence >= medium` 的分类；低置信度时跳过并记录。

| ID | 规则 | 级别 | 模式 | 证据 |
| --- | --- | --- | --- | --- |
| R001 | 单引脚网络 | P2 | quick | net + pin |
| R002 | 器件引脚悬空 | P1/P2 | quick | pin |
| R003 | 重复位号 | P0/P3 | quick | component × N |
| R004 | 网络无引脚 | P2 | quick | net |
| R005 | DRC 悬空网络 | P2 | quick | drc (+ net) |
| R006 | 电源/地引脚悬空 | P0/P1 | quick | pin |
| R007 | 电源网络无来源 | P2 | standard | net + 拓扑 |
| R008 | IC 去耦缺失 | P2 | standard | pin + net |
| R009 | I2C 上拉缺失 | P1 | standard | net |
| R010 | 复位上拉缺失 | P2 | standard | pin + 相邻器件 |
| R011 | BOOT 引脚悬空 | P1 | standard | pin |
| R012 | 晶振负载电容缺失 | P2 | standard | crystal + net |
| R013 | LED 限流电阻缺失 | P1 | standard | led + net |
| R014 | 差分对不完整 | P2 | quick | net / differentialPairGroups |
| R015 | 连接器电源/地引脚悬空 | P1 | quick | pin |
| R016 | 缺值/占位值 | P2 | quick | component:Value |
| R017 | 缺封装 | P1 | quick | component |
| R018 | BOM/PCB 标志组合 | P3 | standard | component 属性 |
| R019 | 料号缺失 | P3 | standard | component 属性 |
| R020 | 网络名近似重复 | P3 | standard/strict | net × 2 |
| R023 | 电源入口保护缺失 | P3 | strict | net + 连接器 |
| R025 | 关键电源轨缺测试点 | P3 | strict | net |
| R026 | BOM/网表一致性 | P2/P3 | quick | bom |
| R027 | 未用运放通道输入悬空 | P3 | strict | pin |
| R028 | 未用逻辑门输入悬空 | P2 | strict | pin |
| R029 | 电源/地网络冲突 | P0 | quick | pin × N / component |
| R030 | MOSFET 栅极缺少下拉 | P2 | standard | pin + 电阻 |
| R031 | 三极管基极缺少限流电阻 | P2 | standard | pin + 电阻 |
| R032 | 继电器线圈缺少续流二极管 | P1 | standard | pin + 二极管 |
| R033 | 稳压器反馈分压不完整 | P2 | standard | FB pin + 电阻 |
| R034 | 稳压器使能脚悬空 | P1 | standard | pin |
| R035 | 两脚器件两端同网络 | P2 | standard | pin × 2 |
| R036 | 稳压器输出缺少电容 | P2 | standard | OUT pin + 电容 |
| R037 | LED 极性可能反接 | P1 | standard | pin A/K |
| R038 | 电解电容极性可能反接 | P1 | standard | pin +/- |
| R039 | 继电器续流二极管方向错误 | P1 | standard | relay + diode |

## 误报边界

### R001
- `testpoint` / `antenna` 器件、位号前缀 `TP/TEST/ANT/JMP`、单针连接器豁免。
- 电源符号/网络标签不是器件，仍可能产生单引脚网络；报告保留以便人工确认。

### R002
- `noConnect === true` 跳过。
- 无 `pins.json` 时降为 `P2/medium`，文案提示"可能故意不接"。
- 引脚名为 `NC/DNC/NO_CONNECT/RESERVED` 时转为 open question，不报 finding。

### R003
- 相同非空 `Group ID`、位号后缀 `U1A/U1B`、同 Device/Manufacturer Part 且引脚号集合不相交（或仅电源脚重叠）视为多部件，不报或降 P3。

### R004 / R005
- R005 对 DRC `SHOWDANDLING` 的网络无论是否存在于模型都报告；网络不存在时用 `drc.primitiveId` 作为证据。
- R005 优先于 R004（更具体）。

### R006 / R015
- 引脚名匹配电源/地模式且 `net === ""`。
- `noConnect === true` 时降 P1/medium，不按 P0。
- 同一引脚 R006 优先于 R015、R002。

### R007
- 从电源网络出发，最多 5 跳，经 2 引脚无源件（R/C/L/FB/FUSE/SW）寻找连接器、稳压器、电池等来源。
- 电源符号不是器件，只有网络标签的板子可能被报；这是有意保留的审查提示。

### R008
- 仅检查 `ic` / `regulator` 的电源引脚网络；电容必须在同一网络与地之间，或经磁珠/0Ω 电阻一跳到地。
- `powerKind === "reference"` 的 `VREF/VPP` 跳过。

### R009
- 网络名匹配 `SCL/SDA`（含前后缀）。
- 排阻存在但内部拓扑未知时转 open question，不直接报 P1。

### R012 / R013
- 晶振两侧都需要对地电容；LED 以整体判定，A/K 任一侧有串联电阻即可。
- 位号 `D` 的 LED 可能被分类为 `diode`，导致 R013 漏报；该限制写入报告。

### R016
- 判定 `rawValue`，不是 `displayValue`；`valuePlaceholder` 由 parse 预计算。
- 连接器、测试点不报。
- `Add into BOM=false` 仅产生 open question，不产生 high-confidence finding。

### R018
- `addIntoBom=true && convertToPcb=false` 或反向组合报 P3；机械件/测试点跳过。

### R020
- 排除自动网络 `$...`、电源/地网络、完全相同名称。
- standard：归一化后 Levenshtein ≤ 1；strict：≤ 2。

### R026
- BOM 不可用时跳过并写入 `coverage.skippedRules`。
- 支持 UTF-8/GBK 与中英文列头；数量/位号/料号不一致分别报。

### R029
- 同一网络同时存在电源与地属性引脚 → P0。
- 两条不同电源轨经 0Ω/跳线/焊盘直接合并 → P0。
- `VREF/VPP` 为 reference，不参与"电源轨互短"的简单判定。

### R030 / R031
- 仅当栅极/基极已联网且未找到到源极/地/驱动侧的电阻时报告。
- 栅极由推挽驱动或基极由恒流源驱动时可能误报；只报 P2/medium，报告注明需结合驱动方式确认。

### R032
- 仅对 `relay` 类别且线圈两端都有网络的器件检查；固态继电器/光耦继电器可能不需要续流二极管，分类为 `relay` 时需人工确认。
- 二极管必须跨接在线圈两端；串联在驱动回路中不算续流。

### R033
- 仅对 `regulator` 且存在 FB/VFB/FEEDBACK/ADJ 引脚的器件检查。
- 固定输出版本可能没有外部 FB 分压；若 FB 引脚存在但网络为空，R002/R033 会提示，最终以数据手册为准。

### R034
- 仅对 `regulator` 的 EN/ENABLE/SHDN/UVLO 引脚检查。
- 使能脚可能由内部上拉/下载或外部逻辑驱动；无网络时仍报 P1/medium，提示核对默认状态。

### R035
- 仅对两端都有网络的 2 引脚无源/分立器件检查。
- 0Ω/跳线明确标注时豁免；开关/测试点/连接器不参与。
- 同一网络可能是画图时的临时短接，通常应视为错误。

### R036
- 仅对 `regulator` 的 OUT/VOUT/VO 引脚检查；输出电容必须直接到地（经磁珠/0Ω 的间接去耦暂不视为输出电容）。
- 某些模块内部已有输出电容或允许无电容，需以数据手册为准。

### R037
- 仅在 LED 有 A/K 引脚名且阳极网络为地时报告；阳极接地几乎总是反向偏置。
- 若符号库用 `1/2` 而不是 `A/K`，规则不触发，转入人工复核。

### R038
- 仅对引脚名为 `+`/`-` 的极性电容检查；普通陶瓷电容不参与。
- 正极接地或负极接电源轨都视为反接；需结合封装极性标记确认。

### R039
- 仅当继电器线圈一端是电源网络、且能找到跨接在线圈两端的二极管时检查方向。
- 二极管阳极接电源侧视为错误；若线圈两端都不是电源网络，跳过。
