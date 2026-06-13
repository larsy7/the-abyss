---
name: kick-off
description: Start a new feature development cycle. Use when the user says "kick off", "start a new feature", "new feature", "begin work on", "let's build", or describes a new piece of work to begin.
---

# Kick Off — Start a New Feature Cycle

Set up the workspace and establish a plan before writing any code.

## Steps

1. **Sync with main**
   - `git fetch origin main`
   - `git checkout main && git pull origin main`
   - If the working tree is dirty, warn the user before proceeding

2. **Create the feature branch**
   - If a branch name was assigned by the session environment (e.g. `claude/*`), use that
   - Otherwise create one: `feature/<short-description>`
   - Push the branch so it exists on origin: `git push -u origin <branch-name>`

3. **Orient on the codebase**
   - Read `app.js`, `index.html`, and `styles.css` to understand current state
   - Note which modules, DOM sections, and patterns the new feature will touch
   - Call out any risks: Firebase schema changes, CSS conflicts, large refactors

4. **Present a plan**
   - Summarize the feature in 1-2 sentences
   - List the files that will be modified
   - Outline the implementation approach in a few bullet points
   - Wait for the user to confirm or adjust before writing code
