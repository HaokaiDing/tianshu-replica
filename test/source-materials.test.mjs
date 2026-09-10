import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSourceMaterials, normalizeSourceMaterials } from "../src/source-materials.mjs";

function materials() {
  return {
    creative: "  # 创意\n修理铺收到没有署名的邀请函，以钥匙归属推动谜题。依据：第1集发现邀请函。\n",
    characters: "# 人物小传\nMira Chen：修理铺学徒，发现寄给旧店主的邀请函。依据：第1集。\nRowan Bell 与 Ellis Reed 的对应未知。",
    outline: "# 源剧\n\n## 第1集\nMira Chen在旧钟内发现一封邀请函。\n\n## 第2集\nMira借来钥匙打开抽屉，发现另一封相同的邀请函。\n\n## 第3集\n倒叙：一小时前，信使封上抽屉；邀请对象仍然未知。\n",
    provenance: { sourceKind: "docx", evidenceType: "textual-source", directVideoUnderstanding: false, references: [{ episode: 3, reference: "source.docx:3" }] },
  };
}

test("source materials retain all three texts and provenance exactly, including chronology and uncertain aliases", () => {
  const source = materials();
  const result = normalizeSourceMaterials(source, 3);
  assert.deepEqual(result, source);
  assert.match(result.outline, /第3集\n倒叙：一小时前/);
  assert.match(result.characters, /Rowan Bell 与 Ellis Reed 的对应未知/);
  assert.equal(result.creative.startsWith("  "), true);
});

test("loadSourceMaterials reads a JSON three-material package without rewriting text", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-materials-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.json");
  fs.writeFileSync(file, JSON.stringify(materials()));
  assert.deepEqual(loadSourceMaterials(file, 3), materials());
});

test("missing material, malformed structure and invalid episode sequence cannot enter the source contract", () => {
  for (const value of [null, [], "text"]) assert.throws(() => normalizeSourceMaterials(value, 3), /JSON 对象/);
  for (const field of ["creative", "characters", "outline"]) {
    for (const value of [undefined, "  ", {}, []]) {
      assert.throws(() => normalizeSourceMaterials({ ...materials(), [field]: value }, 3), new RegExp(`${field} 必须是非空文本`));
    }
  }
  for (const value of [undefined, null, [], "source"]) assert.throws(() => normalizeSourceMaterials({ ...materials(), provenance: value }, 3), /provenance 必须是来源信息对象/);
  assert.throws(() => normalizeSourceMaterials({ ...materials(), outline: materials().outline.replace("第2集", "第4集") }, 3), /连续有序且不重复/);
  assert.throws(() => normalizeSourceMaterials(materials(), 4), /实际识别 3 集/);
});
