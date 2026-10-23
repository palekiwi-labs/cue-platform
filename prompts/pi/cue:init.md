---
description: Summarise the injected cue context (Intent, Status, Next Steps)
argument-hint: "[instructions]"
---
<user-instructions>
$ARGUMENTS
</user-instructions>

**Mandatory Instructions:**

1. Analyze the project intent and recent progress in the cue context
   injected into this session (the most recent one if several were
   injected).
2. Provide a lightning-fast, structured summary (Intent, Status, Next Steps).
3. **DO NOT** perform any further research, git commands, or file reads.
4. **DO NOT** engage in any other task.
5. Immediately report the summary to the user and await instructions unless
   provided in `<user-instructions>`.
6. If no cue context was injected, say so and suggest `/cue:context:pins`.
