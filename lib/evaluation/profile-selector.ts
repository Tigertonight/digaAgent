import type { WorkflowCapability } from "@/lib/workflows/types";

export interface InferEvaluationProfileInput {
  objective?: string;
  rationale?: string;
  capabilities?: readonly WorkflowCapability[];
  criteriaText?: string;
  defaultProfileId?: string;
}

export function inferEvaluationProfileId(
  input: InferEvaluationProfileInput
): string {
  const text = [
    input.objective,
    input.rationale,
    input.criteriaText,
    input.capabilities?.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    /\b(send|publish|deploy|delete|remove|email|message|post|publish release|deploy release|production release|secret|token|key)\b/.test(
      text
    ) ||
    /发送|发布|部署|删除|密钥|隐私|外部账号|生产环境/.test(text)
  ) {
    return "desktop.external-action";
  }

  if (
    /\b(skill|skills|test case|near-miss|eval set|evaluation set)\b/.test(text) ||
    /技能|评测集|测试用例|负样本|正样本/.test(text)
  ) {
    return "skill.eval";
  }

  if (
    /\b(teacher|teaching|lesson|classroom|homework|student|worksheet)\b/.test(text) ||
    /老师|教师|教学|备课|课堂|作业|学生|练习/.test(text)
  ) {
    return "teacher.workflow";
  }

  if (
    /\b(attribution|root cause|causal|retrospective|postmortem|driver analysis)\b/.test(
      text
    ) ||
    /归因|复盘|原因|主要矛盾|驱动因素|结构原因/.test(text)
  ) {
    return "attribution.analysis";
  }

  if (
    /\b(ui|ux|react|component|screen|screenshot|css|layout|button|modal|frontend)\b/.test(
      text
    ) ||
    /界面|前端|组件|截图|交互|样式|按钮|弹窗/.test(text)
  ) {
    return "coding.frontend-ui";
  }

  if (
    /\b(code|coding|bug|fix|test|build|typescript|api|refactor|diff|file)\b/.test(
      text
    ) ||
    /代码|修复|测试|构建|接口|重构|文件/.test(text)
  ) {
    return "coding.default";
  }

  if (
    /\b(browser|desktop|clipboard|window|local|filesystem)\b/.test(text) ||
    /浏览器|桌面|剪贴板|窗口|本地/.test(text)
  ) {
    return "desktop.default";
  }

  if (
    /\b(research|source|sources|web page|citation|claim|evidence)\b/.test(text) ||
    /调研|来源|网页|证据|引用|事实|不确定/.test(text)
  ) {
    return "analysis.research";
  }

  if (
    /\b(workflow|subagent|artifact|checkpoint|resume|harness)\b/.test(text) ||
    /工作流|子agent|子 agent|检查点|恢复|编排/.test(text)
  ) {
    return "workflow.default";
  }

  return input.defaultProfileId ?? "workflow.default";
}
