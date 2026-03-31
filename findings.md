# Findings & Decisions
<!-- 
  WHAT: Your knowledge base for the task. Stores everything you discover and decide.
  WHY: Context windows are limited. This file is your "external memory" - persistent and unlimited.
  WHEN: Update after ANY discovery, especially after 2 view/browser/search operations (2-Action Rule).
-->

## Requirements
<!-- 
  WHAT: What the user asked for, broken down into specific requirements.
  WHY: Keeps requirements visible so you don't forget what you're building.
  WHEN: Fill this in during Phase 1 (Requirements & Discovery).
  EXAMPLE:
    - Command-line interface
    - Add tasks
    - List all tasks
    - Delete tasks
    - Python implementation
-->
<!-- Captured from user request -->
- Build a new Apollo Link package (not an app)
- React Native target, TypeScript
- Link should queue mutations when offline or network error occurs
- Retry queued mutations when connectivity returns

## Research Findings
<!-- 
  WHAT: Key discoveries from web searches, documentation reading, or exploration.
  WHY: Multimodal content (images, browser results) doesn't persist. Write it down immediately.
  WHEN: After EVERY 2 view/browser/search operations, update this section (2-Action Rule).
  EXAMPLE:
    - Python's argparse module supports subcommands for clean CLI design
    - JSON module handles file persistence easily
    - Standard pattern: python script.py <command> [args]
-->
<!-- Key discoveries during exploration -->
- Reference inspiration: apollo-link-queue (queueing until online)
- Current README/examples require manual NetInfo.addEventListener wiring and explicit storage adapter.
- OfflineQueueLink only accepts a QueueStorage object today; no string shorthand for AsyncStorage.
- Apollo Client v4 types define `ApolloLink.from(links: ApolloLink[])` and `ApolloLink.RequestHandler`, so custom handlers should be wrapped with `new ApolloLink(handler)` in v4.
- Community links page lists Apollo link packages with apollo-link/graphql naming; package metadata should emphasize link usage and RN/offline focus.

## Technical Decisions
<!-- 
  WHAT: Architecture and implementation choices you've made, with reasoning.
  WHY: You'll forget why you chose a technology or approach. This table preserves that knowledge.
  WHEN: Update whenever you make a significant technical choice.
  EXAMPLE:
    | Use JSON for storage | Simple, human-readable, built-in Python support |
    | argparse with subcommands | Clean CLI: python todo.py add "task" |
-->
<!-- Decisions made with rationale -->
| Decision | Rationale |
|----------|-----------|
| Target React Native only | User requirement |
| Plain TypeScript with tsc build | User preference for plain TS |
| Queue mutations only by default | Avoid retrying queries and keep behavior aligned with offline mutations |
| Optional storage adapter for persistence | Works with AsyncStorage without hard dependency |
| Retry on network errors or when explicitly offline | Matches offline-first mutation semantics |
| Auto-detect NetInfo when available | Removes manual NetInfo wiring while keeping a fallback for manual control |
| Support storage: "async-storage" shorthand | Simplifies setup for common RN storage usage |
| Expose queue snapshot | Improves inspectability without adding dependencies |
| Export RequestHandler-based link factory | Avoids ApolloLink class type mismatch in monorepos |
| Simplify API, remove custom storage adapters and context whitelist | Reduce surface area and enforce AsyncStorage-only persistence |
| Add queueOperations filter | Allow callers to control which operations are queued/retried |
| Persist option instead of storage selector | Simple boolean to opt into AsyncStorage persistence |

## Issues Encountered
<!-- 
  WHAT: Problems you ran into and how you solved them.
  WHY: Similar to errors in task_plan.md, but focused on broader issues (not just code errors).
  WHEN: Document when you encounter blockers or unexpected challenges.
  EXAMPLE:
    | Empty file causes JSONDecodeError | Added explicit empty file check before json.load() |
-->
<!-- Errors and how they were resolved -->
| Issue | Resolution |
|-------|------------|
|       |            |

## Resources
<!-- 
  WHAT: URLs, file paths, API references, documentation links you've found useful.
  WHY: Easy reference for later. Don't lose important links in context.
  WHEN: Add as you discover useful resources.
  EXAMPLE:
    - Python argparse docs: https://docs.python.org/3/library/argparse.html
    - Project structure: src/main.py, src/utils.py
-->
<!-- URLs, file paths, API references -->
- https://github.com/helfer/apollo-link-queue
- https://graphqlzero.almansi.me/api

## Visual/Browser Findings
<!-- 
  WHAT: Information you learned from viewing images, PDFs, or browser results.
  WHY: CRITICAL - Visual/multimodal content doesn't persist in context. Must be captured as text.
  WHEN: IMMEDIATELY after viewing images or browser results. Don't wait!
  EXAMPLE:
    - Screenshot shows login form has email and password fields
    - Browser shows API returns JSON with "status" and "data" keys
-->
<!-- CRITICAL: Update after every 2 view/browser operations -->
<!-- Multimodal content must be captured as text immediately -->
-

---
<!-- 
  REMINDER: The 2-Action Rule
  After every 2 view/browser/search operations, you MUST update this file.
  This prevents visual information from being lost when context resets.
-->
*Update this file after every 2 view/browser/search operations*
*This prevents visual information from being lost*
