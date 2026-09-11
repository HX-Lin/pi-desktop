/**
 * The instructions behind "压缩为记忆" (compact to memory).
 *
 * pi's own compaction produces a format-only context checkpoint: enough to keep
 * working, nothing that survives the next compaction. Compacting *to memory* is
 * a bigger job, so these instructions are appended to pi's summarization prompt
 * (as its "additional focus") to add the memory requirements on top of the
 * checkpoint format:
 *
 * - durable knowledge that stays true across sessions (environment, decisions,
 *   pitfalls, exact paths/errors) instead of a status snapshot
 * - reusable operations handed back as scripts, which are then written to the
 *   session's memory-script directory and exposed to the model on every turn
 *
 * Only this path (`compactToMemory`) uses them. Compactions triggered by pi on
 * its own token threshold stay plain "压缩上下文".
 */
import { writeMemoryScript } from "./memory-store";

/** ```` ```script:name.sh ```` fences the model uses to hand back a script. */
const SCRIPT_BLOCK_PATTERN = /```script:([^\s`]{1,80})\r?\n([\s\S]*?)```/g;
const SEDIMENTED_HEADING = "## 已沉淀的记忆脚本";

export const MEMORY_DISTILLATION_PROMPT = `这是一次「压缩为记忆」，不是普通的上下文压缩。

上面的章节格式仍然要遵守，但内容要求更高：不要只写"现在做到哪了"，要写成以后（甚至换个会话）也能直接用上的长期记忆。

必须写进对应章节的内容：
- 用户目标与验收标准；用户的原话关键句能引就引
- 约束与偏好：技术栈、代码风格、语言、明确禁止的做法
- 环境事实：绝对路径、命令、版本号、端口、服务名、密钥/配置所在位置
- 关键决策与理由，包括被否决的方案以及否决原因
- 已完成 / 进行中 / 阻塞 / 下一步
- 踩过的坑：报错原文、根因、最终修复手法
- 仍未解决的问题：现象、已排除的可能、下一步验证方法

禁止：凭印象编造；写「如上所述」「那个文件」这类指代；把临时调试过程当成结论；丢掉精确的文件路径、函数名、命令和报错原文。

可复用脚本：
把「以后还会再执行一次」的操作沉淀成脚本，追加在回答末尾，格式如下：

\`\`\`script:build-and-deploy.sh
#!/usr/bin/env bash
# description: 构建并产出 Linux AppImage
set -euo pipefail
npm run dist
\`\`\`

规则：
- 脚本名只用字母、数字、点、下划线、连字符，不要空格
- 脚本里必须有一行 \`# description: 用途\`，一句话说清干什么
- 写完整、可直接执行的命令，不要占位符、不要省略号
- 已经存在于「已沉淀的记忆脚本」且本次没有变化的脚本，不要重复输出
- 没有值得沉淀的脚本，就完全不要写这一节

脚本会被保存到本会话的记忆脚本目录，之后可以直接执行，正文也不占记忆篇幅——所以不要为了省字而缩写命令。`;

export interface SedimentedScript {
  name: string;
  description: string;
}

/**
 * Move script fences from a memory text into real, executable files.
 *
 * Returns the memory text without the script bodies, plus a one-line record of
 * what was written so the memory stays readable on its own. The rewrite is
 * idempotent: an existing record section is replaced rather than duplicated.
 */
export function sedimentMemoryScripts(sessionId: string, memory: string): string {
  const matches = [...memory.matchAll(SCRIPT_BLOCK_PATTERN)];
  if (matches.length === 0) return memory;

  const written: SedimentedScript[] = [];
  for (const match of matches) {
    const script = writeMemoryScript(sessionId, match[1], normalizeScript(match[2]));
    if (script) written.push({ name: script.name, description: script.description });
  }

  let text = stripSedimentedSection(memory);
  for (const match of matches) text = text.replace(match[0], "");
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  // The script fences sat at the end, so an empty "## 可复用脚本" heading may
  // be left dangling once the bodies are gone.
  text = text.replace(/\n#{2,4}[^\n#]+$/, "").trimEnd();

  if (written.length === 0) return text;
  const lines = written.map((script) => `- \`${script.name}\` — ${script.description}`);
  return `${text}\n\n${SEDIMENTED_HEADING}\n\n${lines.join("\n")}`;
}

/** Keep the shebang semantics: a blank line between shebang and code is harmless. */
function normalizeScript(content: string): string {
  const body = content.replace(/\s+$/, "");
  return body.endsWith("\n") ? body : `${body}\n`;
}

function stripSedimentedSection(text: string): string {
  const start = text.indexOf(`\n${SEDIMENTED_HEADING}`);
  if (start < 0) return text;
  const end = text.indexOf("\n## ", start + 1);
  return end < 0 ? text.slice(0, start) : `${text.slice(0, start)}${text.slice(end)}`;
}
