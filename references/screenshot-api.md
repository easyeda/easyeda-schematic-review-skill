# 截图与坐标

## 坐标约定（实测）

- 原理图坐标单位 `0.01 inch`；原点在页面左下，Y 向上。
- SVG 导出坐标：`svgX = schematicX`，`svgY = -schematicY`。
- 实测 A4 `viewBox="-10.5 -835.5 1191 846"`，宽高 1191×846。
- 器件 BBox 由 `sch_Primitive.getPrimitivesBBox([primitiveId])` 返回：

```text
svgLeft   = bbox.minX
svgTop    = -bbox.maxY
svgWidth  = bbox.maxX - bbox.minX
svgHeight = bbox.maxY - bbox.minY
```

`getPrimitivesBBox` 一次只返回一个并集 BBox；需要逐器件 BBox 时必须逐个调用。

## 页面导出

```js
const file = await eda.sch_ManufactureData.getExportDocumentFile(
  'page', 'SVG', undefined, 'Current Schematic Page'
);
const svg = await file.text();
```

- 页面 SVG 缓存在运行目录 `page-<pageFileKey>.svg`。
- `pageFileKey` 复用 `fileKey` sanitize：空格/中文/`/`/Windows 保留名替换。
- 多页导出会切换当前图页；`try/finally` 恢复原文档。

## 本地裁剪

1. 读取缓存的 `page-*.svg`；
2. 将根 `<svg>` 的 `viewBox` 改为目标区域（外扩 40 单位）；
3. 将 `width/height` 设为区域尺寸的 2 倍（上限 2000）；
4. 在 `</svg>` 前插入 `<rect>`：

```html
<rect x="minX" y="-maxY" width="maxX-minX" height="maxY-minY"
      fill="rgba(220,38,38,0.12)" stroke="#DC2626" stroke-width="2"
      vector-effect="non-scaling-stroke"/>
```

- 退化 BBox（缺失、零面积、NaN）不得画框；返回占位卡片并计入 `screenshots.failed`。
- `map_pages=false` 且器件不在当前页时，不画红框，显示占位提示。
- 并集面积 > 页面 70% 时，退回首个器件区域，避免整页截图。

## 可选 PNG（v1.1）

只有 `--image-format png` 且 Bridge 可用时，才把 SVG 送给 `OffscreenCanvas` 光栅化；Bridge 断开/离线自动回退 SVG。v1 默认纯 Node，不依赖 Canvas。
