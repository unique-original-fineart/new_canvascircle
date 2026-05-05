---
name: Staged deploy-and-verify between fixes
description: Working preference — finish one fix, deploy and verify in production, then proceed
type: feedback
originSessionId: 38188128-99a7-4ee8-ade9-9710c34a025f
---
Guy prefers to deploy and verify each code change in production before moving on to the next bug or feature. He'll explicitly confirm ("I deployed it and it works", "okay that all worked") before asking for the next change.

**Why:** Real users (sellers and buyers) are using the system live. Smaller, verified increments mean any regression is contained to one change and easy to revert. He runs his own QA via real-world use rather than test suites — there are no automated tests in the project.

**How to apply:** When tackling multi-step work (e.g., a list of bugs to fix), finish one logical unit and hand it back with a clear test plan. Don't stack multiple unrelated fixes into one big handoff. If you spot a small follow-up while working, mention it but don't slip it into the same change without his sign-off. When something doesn't work after his deploy (e.g., the OAuth-scope error or the wrong PAT permission), help him diagnose and own the mistake clearly — don't bury it.
