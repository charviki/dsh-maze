/**
 * 故事线生成：把环序模板 + 目标合成发给主会话的紧凑「启程」消息。
 *
 * 模型只需要任务规格，不需要理解西部世界概念（那是配置层的语言）：
 * 所有数字（拆解上限、并行数、回溯轮数）由生成器预计算写死，模型
 * 零算术；「子任务」是唯一的结构词。固定流程：第 0 环（拆解）在当前
 * 会话执行——基石 + 子任务清单，停下等确认；确认后从第 1 环起按骨架
 * 执行 workflow；单环故事线不启编排（清单即交付）。
 * @module dsh-maze/narrative-script
 */
/**
 * 环接待员的调用配置展开（子任务分派交给 pipeline 运行时轮转，宿主不预分配）。
 * @param layer - 目标环。
 * @param hostOf - 接待员名册查找。
 */
function hostBuckets(layer, hostOf) {
    return layer.hosts.map(host => {
        const hostName = hostOf(host.hostId) ?? host.hostId;
        const spec = {
            // agent/model 空串 = 跟随环境默认：不传覆盖，继承会话/路由默认
            ...(host.agent === '' ? {} : { provider: host.agent }),
            ...(host.model === '' ? {} : { model: host.model }),
            label: hostName,
        };
        return { host, hostName, spec };
    });
}
/** 生成 JS 字符串字面量（JSON.stringify 转义引号/反斜杠，防 O'Brien 类内容破坏骨架）。 */
function jsStr(value) {
    return JSON.stringify(value);
}
/** 多行提示词压成单行（拼进环列表行，骨架侧 jsStr 已做转义无需处理）。 */
function oneLine(text) {
    return text.replace(/[\r\n]+/g, ' ').trim();
}
/** 环的并行总容量（Σ接待员并行数）：拆解上限与「最多 N 路并行」都来自它。 */
function ringCapacity(layer) {
    return layer.hosts.reduce((sum, a) => sum + a.parallel, 0);
}
/** 环列表行（非首环）：环名（接待员，最多 N 路并行）：提示词一行；质检环附退回与 schema 说明。 */
function ringLine(layer, tpl, hostOf) {
    const cast = layer.hosts.map(a => {
        const name = hostOf(a.hostId) ?? a.hostId;
        const via = a.agent === '' ? '' : `·${a.agent}`;
        return `${name}${via}`;
    }).join(' / ');
    let line = `- ${layer.name}（${cast}，最多 ${ringCapacity(layer)} 路并行）：${oneLine(layer.prompt)}`;
    const rt = layer.retry;
    if (rt !== undefined) {
        const target = tpl.layers.find(l => l.id === rt.toLayerId)?.name ?? rt.toLayerId;
        line += `\n  不合格子任务退回「${target}」重做（≤${rt.maxRounds} 轮）；按子任务给结论 { verdicts: [{ task, verdict: "pass"|"fail", issues }] }；代码产物先加载 open-code-review-delegate skill（ocr 圈文件配规则，diff 由你读）。`;
    }
    return line;
}
/** agent 调用覆盖的脚本片段（空配置=省略，继承环境默认；值经 JSON 转义）。 */
export function agentOptsLiteral(spec) {
    const parts = [`label: ${jsStr(spec.label)}`];
    if (spec.provider !== undefined)
        parts.push(`provider: ${jsStr(spec.provider)}`);
    if (spec.model !== undefined)
        parts.push(`model: ${jsStr(spec.model)}`);
    return `{ ${parts.join(', ')} }`;
}
/**
 * 合成启程消息（紧凑规格）：目标一行 + 第一步（当前会话：基石+拆解，等确认）
 * + 执行环节列表 + 骨架代码块。单环故事线只有第一步，不启编排。
 * @param tpl - 环序模板。
 * @param hostOf - 接待员名册查找。
 * @param goal - 用户目标（''=纯从对话总结）；只是基石的种子，不跳过确认。
 * @returns 完整启程消息文本。
 */
export function composeNarrativeMessage(tpl, hostOf, goal) {
    const single = tpl.layers.length === 1;
    const first = tpl.layers[0];
    const execRings = tpl.layers.slice(1);
    // 拆解上限 = 第一个执行环的并行总容量（生成器算好写死，模型不算术）
    const cap = execRings.length > 0 ? ringCapacity(execRings[0]) : 0;
    const goalLine = goal === '' ? '（未给目标：从当前对话提炼）' : goal;
    const step = tpl.decompose === false
        ? `第一步（当前会话，先停下等确认）：
1. 明确任务：目标 / 范围 / 验收，各一行——${oneLine(first.prompt)}
2. 不拆分子任务：整个对象作为一个任务执行。`
        : `第一步（当前会话，先停下等确认）：
1. 明确任务：目标 / 范围 / 验收，各一行。
2. 拆解：把需求拆成${single ? '可并行的' : `不超过 ${cap} 个可并行的`}子任务——${oneLine(first.prompt)}每个子任务三句话：目标 / 涉及文件 / 怎么算完成。按此格式输出：
   [ { "goal": "...", "files": [...], "accept": "..." } ]`;
    if (single) {
        return `【${tpl.name}】目标：${goalLine}

${step}

确认后：子任务清单即交付——在本会话逐条完成并汇报，无需编排。`;
    }
    const rings = execRings.map(layer => ringLine(layer, tpl, hostOf)).join('\n');
    return `【${tpl.name}】目标：${goalLine}

${step}

确认后用 workflow 工具按以下环节执行（meta.name 用《${tpl.name}》）：

${rings}

每步的完整指令 = 任务说明 + 本环节要求 + 上一环的结果 + 当前子任务（退回重做的附 issues）。
子代理数量保持最少：并行数是上限不是配额，顺序能完成就用 1 个代理；不要为汇总/合稿另开代理（汇总由质检或末环完成）。

\`\`\`js
${buildScriptSkeleton(tpl, hostOf)}
\`\`\``;
}
/**
 * 脚本骨架（多环故事线）：从第 1 环起每环一段——工作环 pipeline、质检环
 * verdicts+退回循环、末环收束；接待员覆盖参数按接待员表生成（多接待员轮转）。
 * 单环故事线返回空串（不启编排）。
 * @param tpl - 环序模板。
 * @param hostOf - 接待员名册查找。
 */
export function buildScriptSkeleton(tpl, hostOf) {
    if (tpl.layers.length <= 1)
        return '';
    const execRings = tpl.layers.slice(1);
    const phaseOf = (layer) => `phase(${jsStr(`《${tpl.name}》· ${layer.name}`)})`;
    const lines = [
        '// 确认任务后执行：tasks 填入拆解结果，按环节推进',
        `const brief = '<任务说明：目标/范围/验收>'`,
        tpl.decompose === false
            ? `let out = [ { goal: '<整个任务：目标/范围/验收>' } ]`
            : `let out = [ /* 确认后的子任务 */ ]`,
    ];
    execRings.forEach((layer, i) => {
        const buckets = hostBuckets(layer, hostOf);
        const last = i === execRings.length - 1;
        const rt = layer.retry;
        lines.push(phaseOf(layer));
        if (buckets.length > 1) {
            // 多接待员：轮转分派（并行上限由每接待员 parallel 之和决定，运行时调度）
            lines.push(`const o${i + 1} = [${buckets.map(b => agentOptsLiteral(b.spec)).join(', ')}]`);
        }
        const call = (promptHint) => buckets.length > 1
            ? `agent(${promptHint}, o${i + 1}[i % o${i + 1}.length])`
            : `agent(${promptHint}, ${agentOptsLiteral(buckets[0].spec)})`;
        // 变量名按环 id 后缀化：多条质检环（如 修复线 review+recheck）各自独立，
        // 不后缀会生成重复 const 声明——骨架照抄即 SyntaxError
        const v = (base) => `${base}_${layer.id.replace(/-/g, '_')}`;
        if (rt !== undefined) {
            const target = tpl.layers.find(l => l.id === rt.toLayerId)?.name ?? rt.toLayerId;
            // 质检环多接待员：check/wrap 按声明序轮转（单接待员退化为字面量）
            const qOpts = (k) => buckets.length > 1
                ? `o${i + 1}[${k % buckets.length}]`
                : agentOptsLiteral(buckets[0].spec);
            lines.push(`const ${v('review')} = await agent(check(out), ${qOpts(0)})`);
            lines.push(`let ${v('rounds')} = 0`);
            lines.push(`while (failed(${v('review')}).length > 0 && ${v('rounds')} < ${rt.maxRounds}) { out = await redo(${jsStr(target)}, failed(${v('review')})); ${v('rounds')}++ }`);
            if (last)
                lines.push(`const ${v('summary')} = await agent(wrap(out, ${v('review')}), ${qOpts(1)})`);
            return;
        }
        if (last) {
            lines.push(`const ${v('summary')} = await agent(wrap(out), ${buckets.length > 1 ? `o${i + 1}[${buckets.length - 1}]` : agentOptsLiteral(buckets[0].spec)})`);
            return;
        }
        // 多接待员工作环：单个任务时全员各自处理一遍（多视角评审场景），多个任务则轮转分派
        lines.push(buckets.length > 1
            ? `out = out.length === 1 ? await Promise.all(o${i + 1}.map(o => agent(review(out[0]), o))) : await pipeline(out, (t, i) => agent(run(t), o${i + 1}[i % o${i + 1}.length]))`
            : `out = await pipeline(out, (t, i) => ${call('run(t)')})`);
    });
    return lines.join('\n');
}
