---
name: ship-it
description: Push, create a PR, merge, and deploy the current feature branch to GitHub Pages. Use when the user says "ship it", "deploy", "merge and deploy", or asks to go through the deploy cycle.
---

# Ship It — Merge & Deploy Cycle

Run through the full cycle to get the current feature branch merged and deployed to GitHub Pages.

## Steps

1. **Ensure changes are committed and pushed**
   - Run `git status` to check for uncommitted changes
   - If there are uncommitted changes, stage and commit them with a descriptive message
   - Push the branch to origin with `git push -u origin <branch-name>`
   - If push fails due to network errors, retry up to 4 times with exponential backoff

2. **Create a Pull Request**
   - Use `mcp__github__create_pull_request` (load via ToolSearch if needed)
   - Owner: `larsy7`, Repo: `the-abyss`, Base: `main`
   - Write a concise title and body summarizing the changes with a test plan
   - Report the PR URL to the user

3. **Merge the Pull Request**
   - Use `mcp__github__merge_pull_request` (load via ToolSearch if needed)
   - Use squash merge method
   - Report the merge result

4. **Confirm deployment**
   - Let the user know GitHub Pages will auto-deploy to https://larsy7.github.io/the-abyss/ within a couple minutes
