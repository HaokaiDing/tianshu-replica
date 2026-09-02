const US_ANCHORS = [
  "United States", "USA", "U.S.", "美国", "New York", "纽约", "Los Angeles", "洛杉矶",
  "Chicago", "芝加哥", "Miami", "迈阿密", "Boston", "波士顿", "Brooklyn", "布鲁克林",
];

const US_BANNED_CONTEXT = [
  "温家", "林晚", "温绮罗", "陆砚", "苏瓷", "阿棠", "嘉和拍卖行", "佛堂", "旗袍",
];

function targetLine(input) {
  return String(input).split("\n").find((line) => /(?:目标市场|目标受众|目标地区|市场)\s*[:：]/i.test(line)) || String(input);
}

export function inferMarketIntent(input) {
  const source = targetLine(input);
  if (/(?:美区|美国|北美|\bUS\b|United States|America)/i.test(source)) {
    return {
      id: "us",
      country: "United States",
      locale: "en-US",
      audience: "US vertical-drama audience",
      anchors: US_ANCHORS,
      bannedContext: US_BANNED_CONTEXT,
      rule: "故事发生在美国。角色使用自然的美国姓名；家庭、职业、金钱、继承、机构和日常空间必须符合美国语境。中文可以作为制作语言，但不是故事所在地或人物文化。",
    };
  }
  const match = source.match(/(?:目标市场|目标受众|目标地区|市场)\s*[:：]\s*([^\n]+)/i);
  if (!match) throw new Error("brief must state a target country or market");
  const country = match[1].trim();
  return {
    id: country.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "custom",
    country,
    locale: "planner-defined",
    audience: country,
    anchors: [country],
    bannedContext: [],
    rule: `故事必须发生在${country}，人物姓名、社会制度、日常空间、文化符号和对白习惯均以${country}为准。中文可作为制作语言，但不能把中国语境当作默认值。`,
  };
}

export function marketContractMarkdown(contract) {
  return [
    "# 市场与文化合同",
    "",
    `- 目标国家：${contract.country}`,
    `- Locale：${contract.locale}`,
    `- 受众：${contract.audience}`,
    `- 硬规则：${contract.rule}`,
    `- 文化锚点：${contract.anchors.join("、")}`,
    contract.bannedContext.length ? `- 禁止沿用的旧语境：${contract.bannedContext.join("、")}` : "",
  ].filter(Boolean).join("\n");
}

export function validateMarketSubmission(intent, market) {
  const failures = [];
  if (!market || typeof market !== "object") return ["missing market contract"];
  if (String(market.country || "").toLowerCase() !== intent.country.toLowerCase()) failures.push(`market country must be ${intent.country}`);
  for (const field of ["setting", "characterNaming", "socialContext"]) if (!String(market[field] || "").trim()) failures.push(`market.${field} is required`);
  if (!Array.isArray(market.culturalAnchors) || market.culturalAnchors.length < 2) failures.push("market.culturalAnchors requires two concrete anchors");
  return failures;
}

export function marketChecks(text, market) {
  const failures = [];
  const value = String(text || "");
  const anchors = market?.anchors || [];
  if (anchors.length && !anchors.some((anchor) => value.toLowerCase().includes(String(anchor).toLowerCase()))) failures.push(`missing ${market.country} cultural anchor`);
  for (const token of market?.bannedContext || []) if (value.includes(token)) failures.push(`contains foreign-market carryover: ${token}`);
  return [...new Set(failures)];
}

export function marketArtifactDigest(runDir) {
  const jsonFile = path.join(runDir, "canonical", "market.json");
  const markdownFile = path.join(runDir, "canonical", "market-contract.md");
  if (!fs.existsSync(jsonFile) || !fs.existsSync(markdownFile)) throw new Error("market contract artifacts are incomplete");
  return crypto.createHash("sha256").update(`${fs.readFileSync(jsonFile, "utf8")}\n${fs.readFileSync(markdownFile, "utf8")}`).digest("hex");
}
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
