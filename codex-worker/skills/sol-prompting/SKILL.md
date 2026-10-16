---
name: sol-prompting
description: How to write prompts for Codex workers running GPT-6.1 Sol (and other GPT-6 models), based on OpenAI's latest-model guide — prompt skeleton, follow-through, instruction priority over AGENTS.md/skills, output style, test calibration, and reasoning-effort choice. Load before writing any codex-worker prompt file.
user-invocable: false
---

# Prompting GPT-6.1 Sol workers

Source: OpenAI "Latest model" guide (developers.openai.com/api/docs/guides/latest-model), adapted for Codex jobs that Claude launches with `codex-worker:worker`.

## What to know about the model

- **Sol (`gpt-6.1-sol`)** is the default, balancing speed, cost and intelligence; it performs close to Astra. **Astra** (`gpt-6-astra`) is the top model and is slower. **Luna** (`gpt-6-luna`) is the fast, cheap model for narrow, high-volume tasks.
- **Effort:** Sol accepts `low`, `medium` (the default), `high`, `xhigh` and `max`. It does **not** accept `none` or `minimal`, and the runtime maps those to `low`.
- The GPT-6 family tends to:
  - stop and ask clarifying questions instead of finishing the work;
  - follow `AGENTS.md` and skill files very closely, even when they conflict with the task;
  - write long, heavily formatted replies;
  - test more than a small change needs;
  - delegate less than you want.

  The prompt blocks below counter each of these.

## Choosing effort

| Task | `--effort` |
|---|---|
| Mechanical edits, renames, lookups, one-line answers | `low` |
| Normal implementation or bug fix with clear scope | leave unset (`medium`) |
| Root-cause debugging, cross-file refactors, tricky algorithms | `high` |
| Hard design or debugging where a wrong answer is expensive | `xhigh` |
| Rare, worst-case problems where time doesn't matter | `max` |

Tighten the prompt before you raise effort. A clear finish line and verification step help more than extra reasoning.

## Prompt skeleton

Write the prompt to a file and pass `--prompt-file`. Use XML-tagged blocks and include only the ones the job needs.

```xml
<task>
What to do and where (paths, functions). Why it matters. Facts you already established,
so Codex doesn't rediscover them. Codex has none of the Claude conversation.
</task>

<instruction_priority>
This task's instructions override AGENTS.md files and skill guidelines when they conflict.
If you pause or deviate because of such a file, name the exact file and the instruction,
and separate explicit requirements from your own interpretation.
</instruction_priority>

<follow_through>
Infer intent and scope from this task and bias toward action. Treat it as an instruction
to do the work, not an offer to help. Carry it through to completion; don't stop at a plan,
an acknowledgment, or a partial result. Ask only if a missing detail would change
correctness or require an irreversible action; otherwise pick the most reasonable
low-risk reading, note the assumption, and keep going. Skip warnings, disclaimers and
safety checklists about hypothetical risk.
</follow_through>

<constraints>
Scope limits: files to leave alone, no unrelated refactors, match the surrounding style.
</constraints>

<done_when>
A concrete finish line: behavior that works, tests that pass, output that exists.
</done_when>

<verification>
Run the tests that fit this change (name the command). Don't write tests for reversible,
low-impact changes that only mirror the implementation. Once the targeted checks pass,
broaden testing only when new changes, failures or open concerns justify it.
</verification>

<final_report>
Plain, concise paragraphs, main point first, active voice. Use lists only for genuinely
parallel items. Cover: what changed (files), how it was verified (commands and results),
and anything unresolved or assumed. No recap of the task, no stock phrases.
</final_report>
```

## Which blocks for which job

| Job | Blocks |
|---|---|
| Implementation or fix (`--write`/`--worktree`) | task, instruction_priority, follow_through, constraints, done_when, verification, final_report |
| Diagnosis or root cause (read-only) | task, follow_through, `grounding` (below), final_report as facts → inference → next step |
| Review or second opinion | task, `grounding`, final_report as findings ordered by severity with file:line |
| Research or recommendation | task, `grounding`, final_report with sources or file paths for each claim |
| Follow-up on `--thread` | **only the delta**: what to change next. Don't restate the original prompt |

```xml
<grounding>
Base every claim on code you read or commands you ran; cite file:line or the command.
Mark hypotheses as hypotheses. If you couldn't verify something, say so.
</grounding>
```

More blocks (structured output, missing-context gating, action safety, dig-deeper nudges) are in [references/prompt-blocks.md](references/prompt-blocks.md). End-to-end templates are in [references/codex-prompt-recipes.md](references/codex-prompt-recipes.md), and failure modes are in [references/codex-prompt-antipatterns.md](references/codex-prompt-antipatterns.md).

## Rules of thumb

- Give one job per prompt. Split unrelated asks into separate workers. Parallel workers each get their own prompt file and their own `--worktree`.
- Say what *done* means. Sol stops early when the finish line is vague.
- Hand over what you already know: the error text, the file you suspect, the approach you ruled out. Anything you leave out, Codex has to rediscover from scratch.
- When the output must be machine-readable, use `--output-schema` instead of describing JSON in prose.
- Write the prompt in English, even if the conversation is in Korean. Ask for the final report in Korean only when you'll pass it to the user verbatim.
- Never put secrets, tokens or credentials in a prompt.
