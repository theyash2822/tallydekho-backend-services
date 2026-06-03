# AGENTS.md — td-backend

## Repo Boundary
You are working ONLY inside `/td-backend`.
Do NOT read or modify: td-web-portal, tallydekho-mobile-V4, td-source/desktop, td-website.

## First Steps (Every Session)
1. Read this file
2. Read BLUEPRINT.md
3. Read TASK_ROUTING.md
4. Read only the source files listed for your task

## Full Scan Rule
Full codebase scan is FORBIDDEN by default.
Only allowed when user explicitly says: **DO FULL CODEBASE REVIEW**

## Before Touching Code
- Read BLUEPRINT.md + TASK_ROUTING.md first
- Identify exact files for the task
- Do not open unrelated files

## Coding Rules
- Make the smallest production-safe patch
- Do not refactor unrelated code
- Do not rename files or change architecture
- Do not change API response format unless explicitly required
- Do not expose secrets (.env, tokens, keys)
- All routes must use `authMiddleware`
- All company-scoped routes must call `verifyCompanyOwnership()`

## After Every Change
- Update CHANGELOG_AGENT.md with: Date, Task, Files changed, Behavior changed, How to test, Risks
- Update API_CONTRACT.md or DB_CONTRACT.md only if behavior/schema changed
- Update BLUEPRINT.md only if module structure changed

## Output Format
Return:
1. Files changed
2. What changed and why
3. How to test
4. Risks / follow-up
