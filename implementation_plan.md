# Goal
Implement the "World Engine" feature via the Lorebook Agent, explicitly designed for **Basic Mode** (without tool calls). This feature generates reports tracking off-screen NPC actions, tying generation to the end of a day/long rest with a fallback mechanism. It will use a dedicated `WORLD` tag (so it gets its own category "World Engine" in the Campaign Records and its own Lorebook). It also handles timeskips (Weeks/Months), ensures only the 3 most recent reports are active, and is toggleable.

## User Review Required
> [!IMPORTANT]
> The plan now introduces a dedicated `WORLD` module (just like NPC, LOC, FAC) instead of grouping these under EVENTs. Please review the updated prompt instructions, especially the logic for handling timeskips (Weeks/Months).

## Open Questions
1. **Day Parsing:** The narrator currently outputs `*Level [X] | [HH:MM AM/PM], Day [X]*`. I plan to extract this "Day [X]" using a regex to pass to the Lorebook Agent. Is there any edge case where the "Day" isn't consistently formatted?
2. **Triggering:** Do you manually trigger the Lorebook Agent (e.g., via a button on long rest), or is it set to run automatically every X turns?

## Proposed Changes

### 1. Dedicated Category & Toggle (`state-manager.js`)
Instead of mixing reports into `EVENT`, we will create a dedicated `WORLD` category.
- Update `DEFAULT_MODULES` in `state-manager.js` to include a new module:
  ```javascript
  world: { enabled: false, tag: 'WORLD', format: 'Name | Details | Keywords', instruction: 'World Engine reports tracking off-screen NPC actions and events. Name must be the time period (e.g. "Day 1", "Week 1 (Days 1-7)").' }
  ```
- Because it's added to `DEFAULT_MODULES`, it will automatically appear in the extension settings UI as a toggleable module alongside NPC, LOC, FAC, etc.

### 2. Extracting the Current Day (`memo-processor.js` or `router.js`)
We need to know what day it currently is so the Lorebook Agent knows what to generate.
- Add a regex parser to extract `Day (\d+)` from the latest chat history.
- Pass this `currentDay` variable into the `runRouterPass` context.

### 3. Basic Mode Lorebook Agent Logic (`router.js`)
Modify the **Basic Mode** (`settings.routerBasicMode`) system prompt to inject the World Engine rules when the module is enabled.

- Inject this dynamic instruction block into the agent's context:
  ```markdown
  ## WORLD ENGINE (DAY REPORTS & TIMESKIPS)
  Current Day is: [currentDay]
  You are responsible for generating and managing "World Engine" reports (Category: WORLD).
  - Check the ARCHIVE INDEX. If the current or just-passed time period (e.g., "Day [currentDay - 1]") is missing, generate and record it using the WORLD tag: `[[WORLD: Day [currentDay - 1] | <content> | day report, world engine, day [currentDay - 1] ]]`
  - TIMESKIPS: If a significant amount of time has passed (a timeskip), you may generate a report covering a Week or a Month as a single entry. Format the Name accordingly, for example: `[[WORLD: Week 1 (Days 1-7) | <content> | ...]]` or `[[WORLD: Month 2 (Days 30-60) | <content> | ...]]`.
  - In a World Engine report, invent plausible actions that NPCs and factions took off-screen or out of the user's view during that time, advancing their own agendas. Examples of off-screen actions include (but are not limited to):
    * Factions mobilizing resources, changing leadership, or plotting against rivals.
    * NPCs traveling between cities, acquiring items, or pursuing personal vendettas.
    * Monsters migrating, weather events causing damage, or rumors spreading.
    Do not be limited by these examples. Use your creativity based on the current state of the world and NPC motivations.
  - You MUST activate the 3 most recent WORLD reports (e.g., `[[ACTIVATE: Day [currentDay - 1]]]`).
  - You MUST deactivate any older WORLD reports to save context space.
  ```

### 4. Preventing Forced References (`sysprompt.txt`)
To prevent the main narrative AI from awkwardly forcing these background events into the conversation, we will add a strict constraint to `sysprompt.txt` (or inject it directly above the lore blocks).

- Add the following to `sysprompt.txt`:
  ```xml
  <world_engine>
  The active lore/context may contain recent "World Engine" reports detailing off-screen NPC actions.
  - These events happened in the background, outside of {{user}}'s view.
  - DO NOT force characters to spontaneously talk about these events.
  - DO NOT randomly introduce these events into the current scene unless {{user}} investigates them or they directly intersect with {{user}}'s immediate location.
  - Use them strictly as internal context for NPC positioning and motivations.
  </world_engine>
  ```

## Verification Plan
### Automated & Manual Testing
- Enable the `WORLD` module toggle in Settings.
- Set chat state to "Day 4".
- Run the Lorebook Agent in Basic Mode.
- Verify that it outputs `[[WORLD: Day 3 | ...]]` if missing.
- Verify that it outputs `[[ACTIVATE: Day 3]]` etc.
- Review Campaign Records and verify they appear under the "WORLD" category.
- Chat with the Narrative AI and verify it does NOT bring up the day report events unprompted.
