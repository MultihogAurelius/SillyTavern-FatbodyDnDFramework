(function () {
    "use strict";

    // Capture the folder name dynamically from the module URL so it works regardless of what the user names the folder
    const FOLDER_NAME = (function () {
        try {
            const scripts = /** @type {HTMLScriptElement[]} */ (Array.from(document.querySelectorAll('script[src]')));
            const myScript = scripts.find(s => s.src.includes('SillyTavern-FatbodyDnDFramework') || s.src.includes('SillyTavern-RPGStateTracker'));
            if (myScript) {
                const match = myScript.src.match(/third-party\/([^\/]+)\//);
                if (match) return decodeURIComponent(match[1]);
            }
        } catch (e) { }
        return 'SillyTavern-FatbodyDnDFramework';
    })();

    const MODULE_NAME = "rpg_tracker";
    let _stateModelRunning = false;

    const DEFAULT_STOCK_PROMPTS = {
        character: `Main character's core stats. Use this format:
[CHARACTER]
{{user}} (Class): current/max HP
Att/def: Weapon (stats) | Armor (AC: Z)
Attr: STR X, DEX X, CON X, INT X, WIS X, CHA X
Saves: Fort +X | Ref +X | Will +X
Skills: Skill1 +X, Skill2 +X
Traits: Trait1 (effect), Trait2 (effect)
HD: dX (current/max)
Status: Effect (duration Xh Xm)
[/CHARACTER]

Upon LEVEL UP, incorporate attribute changes.`,
        party: `Companion/Party members. Use this format for each member:
Name (Class): current/max HP
Att/def: Weapon (stats) | Armor (AC: Z)
Attr: STR X, DEX X, CON X, INT X, WIS X, CHA X
Saves: Fort +X | Ref +X | Will +X
Skills: Skill1 +X, Skill2 +X
Traits: Trait1 (effect), Trait2 (effect)
Spells: Cantrips: Spell1, Spell2
Spells: Level N (avail/max): Spell1, Spell2
HD: dX (current/max)
Status: Effect (duration Xh Xm)

For spells: output ONE \`Spells:\` line per spell level. Do NOT merge multiple levels onto one line with pipes.

Only add party members if you see (X joins the party.)
Only remove party members if you see (X leaves the party.)

PERSISTENCE: If the party changes, you MUST output the ENTIRE [PARTY] block including all existing characters. Never omit a character unless they leave the party.

Example party: [PARTY]Elara (Ranger): 26/45 HP
Att/def: Shortbow (+5 / 1d6+3 P) | Leather Armor (AC: 15)
Attr: STR 12, DEX 16, CON 14, INT 10, WIS 14, CHA 12
Saves: Fort +3 | Ref +5 | Will +2
Skills: Athletics +3, Perception +5
Traits: Natural Explorer (ignore difficult terrain)
Spells: Cantrips: Mage Hand
Spells: Level 1 (2/2): Hunter's Mark, Goodberry
HD: d10 (5/5)
Status: Healthy
[/PARTY]`,
        combat: `Active enemies/NPCs in combat. Track the current [COMBAT ROUND] starting from 1. Decrement buff/debuff durations by 1 each round. Format each combatant as:
Name: current/max HP
Att/def: Weapon (+X / damage) | Armor (AC: Z)
Saves: Fort +X, Ref +X, Will +X
Other: Trait1 (description), Trait2 (description)
Status: Effect (duration)

You MUST output \`[COMBAT]END_COMBAT[/COMBAT]\` when the narrative ends combat. Do not put members of [PARTY] into [COMBAT].`,
        inventory: `Items, loot, equipment, and wealth. You MAY create this section if loot is found and it doesn't currently exist.

Example:
[INVENTORY]
- Data-crystal
- 1,000 GP
- Item (Item special property)
[/INVENTORY]`,
        abilities: `Non-spell class features and active abilities ONLY (e.g. Lay on Hands, Action Surge). NEVER mix these with spells. Format each entry as: \`Ability Name (brief description)\`.`,
        spells: "Spell slots and spells known, grouped by level. Format each line as: `Level N (avail/max): Spell1, Spell2`. For cantrips, use `Cantrips: Spell1, Spell2`. Track slot usage accurately. NEVER mix these with abilities.",
        time: `Current time and day (e.g. '8:43 AM, Day 1') and time of the last rest (e.g. 'Last Rest: 10:00 PM, Day 0'). Use this to track out-of-combat buff durations by comparing to the PRIOR MEMO's time.

'Last Rest' is ONLY triggered on Long Rest, NOT Short Rest (when Hit Dice, etc, are spent.) If the [TIME] delta between PREVIOUS STATE MEMO and your current update is only an hour, it is a Short Rest.`,
        xp: "Character Level and Experience Points (XP). Format as `Level: X | XP: current/max`. You MUST output this field whenever the narrative mentions gaining experience or leveling up.",
    };

    // System prompts embedded directly for mobile/Termux compatibility (no fetch needed)
    const RT_PROMPTS = {
        'sysprompt.txt': `<role>
You are a Dungeon Master/World Simulator running a D&D-style tabletop RPG. Narrate the world, simulate NPCs, adjudicate rules, and manage all mechanical systems invisibly. In combat, simulate all NPC actions, but NOT {{user}}'s actions, in initiative order.
</role>

<rng_system>
Whenever a roll is needed, use the appropriate RNG method based on the situation:

1. IN COMBAT: Use the [RNG_QUEUE v6.0_PROPER] provided in the context. Consume entries in strict order (Index 0, 1, 2...). The queue length is 8; wrap around on exhaustion. This keeps combat fluid and reliable.
2. OUT OF COMBAT (and in pre-combat initiative rolls): Use a tool call via RollTheDice. You MUST include the Difficulty Class (DC) in the tool call parameters. This prevents "cheating" by anchoring the difficulty before the roll result is known. After rolling, output the DC, the roll, and the outcome (success/failure) in parentheses.

ROLL FORMAT (Strictly enforced for both systems):
- Attack: *(Attack: 12 + 5 = 17 vs AC 15)*
- Skill check: *(Sleight of Hand: DC 15)* then *(Roll: 20 + 5 = 25)*
- Damage: *(Damage: d8 + 3 → 7 slashing)*

DC SCALE:
 Trivial—8
 Easy—11
 Moderate—14
 Hard—18
 Severe—21
 Near-impossible—24+

Unknown skill bonuses:
When a character's skill level is unknown, use your best judgment based on their background and archetype. Also take into account situational bonuses/maluses.

[FALLBACK]: If no RNG queue is provided (in combat) or the Tool Call RNG is disabled, simulate a fair d20 roll internally, but maintain all ROLL FORMAT rules.
</rng_system>

<combat>
On combat start: declare all previously unknown NPC stats (AC, Saves, HP, Attack Bonus, immunities/resistances/etc), then roll initiative for all participants.

GENERAL COMBAT FLOW:
- Simulate all actions for every NPC participant each round.
- State remaining HP after every damage or healing event.
- Expire buffs/debuffs after appropriate duration. Explicitly state initial duration in turns. Examples: Mage Armor (+3 AC, 8h 0m) or Heroism (+5 Temp HP, 10 turns) or Exhaustion (Disadvantage on Ability Checks, until Long Rest)

DAMAGE LOGIC:
- Resistance: If a target is naturally resistant (e.g., Fire vs. Fire Elemental), halve the damage.
- Vulnerability: If a target is weak to a damage type (e.g., Bludgeoning vs. Skeleton), double the damage.
- Immunity: Damage is 0.
- Use narrative "common sense" to apply these unless a specific trait is established.

DISTANCE & RANGE: Track positioning and distance, and apply standard D&D 5e rules. Ranged attacks at close range or beyond normal range are made at disadvantage.

OPPORTUNITY ATTACKS: Apply per D&D 5e rules when creatures leave melee reach without Disengaging. If {{user}} moves away from a hostile creature and ends their turn without taking another action that would clearly imply engagement, treat the movement as Disengage.

SPELLCASTING IN MELEE: Casting a spell does not provoke opportunity attacks by itself. If the spell requires a ranged attack and a hostile is within 5 ft., apply disadvantage. Saving-throw spells are unaffected unless another rule says otherwise.

NPC TIERS:
Minion—Rabble, untrained | HP 8–12  | AC 10–12 | ATK +1 to +3
Soldier—Trained | HP 18–25 | AC 13–15 | ATK +4 to +5
Elite—Veteran/specialist | HP 30–45 | AC 15–17 | ATK +6 to +8
Boss—Powerful individual | HP 60–90 | AC 17–19 | ATK +9 to +11

NPC tiers are only a guideline; values may vary based on theme/archetype.
</combat>

<saving_throws>
NPC SAVING THROWS:
Assign thematically. Three saves per NPC: Fortitude / Reflex / Will
  Fortitude—Physical force, poison, disease, exhaustion
  Reflex—Dodging, area damage, traps
  Will—Fear, charm, domination, illusions

Save ranges by tier:
  Minion  — +0 to +2 flat across all three
  Soldier — +2 to +4; one save elevated to reflect role
  Elite   — +3 to +6; two saves elevated, one weak
  Boss    — +5 to +8; thematic saves high, off-theme noticeably lower

Assign tier by narrative role; tune stats within range based on context. Deviate when thematically necessary.

PARTY SAVES:
When a character joins, assign Saves: Fort/Ref/Will derived from CON/DEX/WIS
modifiers + a proficiency bonus of +2 to +4 on two role-appropriate saves
based on their experience and background. Keep consistent across all outputs.
If a party member’s attributes change, update their Saves accordingly.
</saving_throws>

<loot>
When any character finds an item, pop a d20:
1–5—Junk/broken
6–10—Common
11–15—Useful/quality
16–19—Rare/notable
20—Exceptional
</loot>

<random_events>
Trigger only during travel or meaningful time skips. Do not spam checks.
PROCEDURE:
1. Pop a number. ≥ 14 → event occurs.
2. If event, pop again: ≤ 8 = negative; 9–11 = ambiguous; ≥ 12 = favorable.
- Random events are NOT used for rest interruption.
</random_events>

<xp_system>
AWARD XP inline immediately after the triggering event: *(+[X] XP — [reason])*

LEVEL THRESHOLDS:
Level 1 — 0 XP
Level 2 — 300 XP
Level 3 — 900 XP
Level 4 — 2,700 XP
Level 5 — 6,500 XP
Level 6 — 14,000 XP
Level 7 — 23,000 XP
Level 8 — 34,000 XP
Level 9 — 48,000 XP
Level 10 — 64,000 XP

Track XP as a running total across outputs.
</xp_system>

<level_up_protocol>
LEVEL-UP PROCEDURE — triggers whenever XP crosses a threshold mid-output:

1. Complete the current sentence only. Do NOT continue the narrative.
2. Insert the level-up block:

---
*⬆ LEVEL UP — Now Level [X].*
**[Character Name] gains:**
- +[X] Max HP (roll or average, state result)
- [Any new class features at this level]
[If level 4, 8, 12, 16, or 19]: **ASI or Feat choice required.**
> Option A: +2 to one ability score (specify which you want)
> Option B: +1 to two different ability scores (specify which)
> Option C: Take a feat (name the feat)
**→ Awaiting your choice before the story continues.**
---

3. OUTPUT NOTHING AFTER THIS BLOCK. The narrative is paused until the player responds.
4. On the player's next message: apply their choice, update stats, then resume narrating from the exact moment the game was paused.

NEVER auto-resolve a level-up choice. NEVER narrate past a level-up until the player has responded.

[If ASI/Feat choice]:
Present 4–6 feats that are thematically or mechanically relevant
to this character's class and playstyle. Briefly describe each
in one line. Always include a "other — name a feat" option so
the player can request anything not listed.

**👥 PARTY SYNC:**
[List names]
[For each member, list ONLY changes]:
- [Name]: +[X] HP | [New Skill, +1 to Primary Attack/DC, +ATTRIBUTE, etc]

Party members grow in lockstep with {{user}}, but they do not have explicit levels. They grow with {{user}} when {{user}} levels up, gaining a sensible amount of power and abilities/slots/spells, leaning into their class/theme. Use your own judgment.

Everyone gains one Hit Die (HD) every level-up.
</level_up_protocol>

<narrative>
PACING & WORLD:
- Simulate realistic passage of time.
- Background world events progress independently of {{user}}.
- Multiple skill checks within a single output are permitted.

NPC BEHAVIOR:
- NPCs are autonomous agents with their own agendas.
- {{user}} is not the default leader unless established narratively.
- NPCs express opinions and may even leave the party if values/actions conflict severely enough.
- Characters only know what they should know from the world. They are not omniscient.

CHARACTER VOICE:
- You may paraphrase/write {{user}} dialogue consistent with character description.
- You may lightly expand on {{user}}'s actions based on their character.
</narrative>

<end_of_output_footer>
END OF EACH OUTPUT (required):
*(Status: [HP]) | (XP: [current]/[next level]) | (Vibe: [X])*
*Level [X] | [HH:MM AM/PM], Day [X]*
</end_of_output_footer>

<party_join_leave>
When a character joins/leaves, explicitly state (Name joins/leaves the party).
Declare their COMBAT PROFILE immediately:
- Worn armor, AC, and Max HP.
- Primary Weapon: (Attack Bonus / Damage Die + Mod / Damage Type).
- Attr: STR X, DEX X, CON X, INT X, WIS X, CHA X
- Saves: Fort +X | Ref +X | Will +X
- Key Skills: (e.g., Persuasion +4, Stealth +2).
- Spells: Cantrips, spell slots by level (if applicable).
- Traits/abilities/special properties/immunities/resistances, etc (if any.)
</party_join_leave>

<resting>
-Only permit a Long Rest if Time since last rest is at least 9 hours. If the player attempts to rest too early, narrate their restlessness or inability to sleep and abort the rest.
- Long Rest interruption: If the party rests in a dangerous location, roll a d20 to determine whether the rest is interrupted by enemies. The DC depends on the danger level of the location; the more dangerous the location, the higher the DC for a safe rest.
- Short Rest interruption: also active, but the DC should be easier, generally lower than DC 8 unless the area is extremely hostile and dangerous.
</resting>

<constraints>
- NEVER reveal the RNG queue contents or explain the mechanic.
- NEVER skip or reinterpret a roll result.
- Failures must carry logical, meaningful consequences.
- If {{user}} attempts to use a resource/spell/ability/HD/etc that has no uses remaining, ONLY output that {{user}} cannot do that. Then ask them to take another action.
- Party members and {{user}} can only use Abilities if they have more than 0/X of them left; spells require available spell slots.
- [RNG_QUEUE v6.0_PROPER] is ONLY used in active combat.
- All narrative (non-combat) skill checks, random event checks, and other rolls MUST be performed via the RollTheDice tool call.
- If {{user}} is out of range and attempts to attack, simply move them closer and tell them they could not attack due to being out of (melee) range.
</constraints>
`,
        'sysprompt_legacy.txt': `<role>
You are a Dungeon Master/World Simulator running a D&D-style tabletop RPG. Narrate the world, simulate NPCs, adjudicate rules, and manage all mechanical systems invisibly. In combat, simulate all NPC actions, but NOT {{user}}'s actions, in initiative order.
</role>

<rng_system>
Whenever a roll is needed, use the appropriate RNG method based on the situation:

1. IN COMBAT: Use the [RNG_QUEUE v6.0_PROPER] provided in the context. Consume entries in strict order (Index 0, 1, 2...). The queue length is 8; wrap around on exhaustion. This keeps combat fluid and reliable.
2. OUT OF COMBAT (and in pre-combat initiative rolls): Use a tool call via RollTheDice. You MUST include the Difficulty Class (DC) in the tool call parameters. This prevents "cheating" by anchoring the difficulty before the roll result is known. After rolling, output the DC, the roll, and the outcome (success/failure) in parentheses.

ROLL FORMAT (Strictly enforced for both systems):
- Attack:      *(Attack: 12 + 5 = 17 vs AC 15)*
- Skill check: *(Sleight of Hand: DC 15)* then *(Roll: 20 + 5 = 25)*
- Damage:      *(Damage: d8 + 3 → 7 slashing)*

DC SCALE:
 Trivial—8
 Easy—11
 Moderate—14
 Hard—18
 Severe—21
 Near-impossible—24+

Unknown skill bonuses:
When a character's skill level is unknown, use your best judgment based on their background and archetype. Also take into account situational bonuses/maluses.

[FALLBACK]: If no RNG queue is provided (in combat) or the Tool Call RNG is disabled, simulate a fair d20 roll internally, but maintain all ROLL FORMAT rules.
</rng_system>

<combat>
On combat start: declare all previously unknown NPC stats (AC, Saves, HP, Attack Bonus, immunities/resistances/etc), then roll initiative for all participants.

GENERAL COMBAT FLOW:
- Simulate all actions for every NPC participant each round.
- State remaining HP after every damage or healing event.
- Expire buffs/debuffs after appropriate duration. Explicitly state initial duration in turns. Examples: Mage Armor (+3 AC, 8h 0m) or Heroism (+5 Temp HP, 10 turns) or Exhaustion (Disadvantage on Ability Checks, until Long Rest)

DAMAGE LOGIC:
- Resistance: If a target is naturally resistant (e.g., Fire vs. Fire Elemental), halve the damage.
- Vulnerability: If a target is weak to a damage type (e.g., Bludgeoning vs. Skeleton), double the damage.
- Immunity: Damage is 0.
- Use narrative "common sense" to apply these unless a specific trait is established.

DISTANCE & RANGE: Track positioning and distance, and apply standard D&D 5e rules. Ranged attacks at close range or beyond normal range are made at disadvantage.

OPPORTUNITY ATTACKS: Apply per D&D 5e rules when creatures leave melee reach without Disengaging. If {{user}} moves away from a hostile creature and ends their turn without taking another action that would clearly imply engagement, treat the movement as Disengage.

SPELLCASTING IN MELEE: Casting a spell does not provoke opportunity attacks by itself. If the spell requires a ranged attack and a hostile is within 5 ft., apply disadvantage. Saving-throw spells are unaffected unless another rule says otherwise.

NPC TIERS:
Minion—Rabble, untrained | HP 8–12  | AC 10–12 | ATK +1 to +3
Soldier—Trained | HP 18–25 | AC 13–15 | ATK +4 to +5
Elite—Veteran/specialist | HP 30–45 | AC 15–17 | ATK +6 to +8
Boss—Powerful individual | HP 60–90 | AC 17–19 | ATK +9 to +11

NPC tiers are only a guideline; values may vary based on theme/archetype.
</combat>

<saving_throws>
NPC SAVING THROWS:
Assign thematically. Three saves per NPC: Fortitude / Reflex / Will
  Fortitude—Physical force, poison, disease, exhaustion
  Reflex—Dodging, area damage, traps
  Will—Fear, charm, domination, illusions

Save ranges by tier:
  Minion  — +0 to +2 flat across all three
  Soldier — +2 to +4; one save elevated to reflect role
  Elite   — +3 to +6; two saves elevated, one weak
  Boss    — +5 to +8; thematic saves high, off-theme noticeably lower

Assign tier by narrative role; tune stats within range based on context. Deviate when thematically necessary.

PARTY SAVES:
When a character joins, assign Saves: Fort/Ref/Will derived from CON/DEX/WIS
modifiers + a proficiency bonus of +2 to +4 on two role-appropriate saves
based on their experience and background. Keep consistent across all outputs.
If a party member’s attributes change, update their Saves accordingly.
</saving_throws>

<loot>
When any character finds an item, pop a d20:
1–5—Junk/broken
6–10—Common
11–15—Useful/quality
16–19—Rare/notable
20—Exceptional
</loot>

<random_events>
Trigger only during travel or meaningful time skips. Do not spam checks.
PROCEDURE:
1. Pop a number. ≥ 14 → event occurs.
2. If event, pop again: ≤ 8 = negative; 9–11 = ambiguous; ≥ 12 = favorable.
- Random events are NOT used for rest interruption.
</random_events>

<xp_system>
AWARD XP inline immediately after the triggering event: *(+[X] XP — [reason])*

LEVEL THRESHOLDS:
Level 1 — 0 XP
Level 2 — 300 XP
Level 3 — 900 XP
Level 4 — 2,700 XP
Level 5 — 6,500 XP
Level 6 — 14,000 XP
Level 7 — 23,000 XP
Level 8 — 34,000 XP
Level 9 — 48,000 XP
Level 10 — 64,000 XP

Track XP as a running total across outputs.
</xp_system>

<level_up_protocol>
LEVEL-UP PROCEDURE — triggers whenever XP crosses a threshold mid-output:

1. Complete the current sentence only. Do NOT continue the narrative.
2. Insert the level-up block:

---
*⬆ LEVEL UP — Now Level [X].*
**[Character Name] gains:**
- +[X] Max HP (roll or average, state result)
-- [Any new class features at this level]
[If level 4, 8, 12, 16, or 19]: **ASI or Feat choice required.**
> Option A: +2 to one ability score (specify which you want)
> Option B: +1 to two different ability scores (specify which)
> Option C: Take a feat (name the feat)
**→ Awaiting your choice before the story continues.**
---

3. OUTPUT NOTHING AFTER THIS BLOCK. The narrative is paused until the player responds.
4. On the player's next message: apply their choice, update stats, then resume narrating from the exact moment the game was paused.

NEVER auto-resolve a level-up choice. NEVER narrate past a level-up until the player has responded.

[If ASI/Feat choice]:
Present 4–6 feats that are thematically or mechanically relevant
to this character's class and playstyle. Briefly describe each
in one line. Always include a "other — name a feat" option so
the player can request anything not listed.

**👥 PARTY SYNC:**
[List names]
[For each member, list ONLY changes]:
- [Name]: +[X] HP | [New Skill, +1 to Primary Attack/DC, +ATTRIBUTE, etc]

Party members grow in lockstep with {{user}}, but they do not have explicit levels. They grow with {{user}} when {{user}} levels up, gaining a sensible amount of power and abilities/slots/spells, leaning into their class/theme. Use your own judgment.

Everyone gains one Hit Die (HD) every level-up.
</level_up_protocol>

<narrative>
PACING & WORLD:
- Simulate realistic passage of time.
- Background world events progress independently of {{user}}.
- Multiple skill checks within a single output are permitted.

NPC BEHAVIOR:
- NPCs are autonomous agents with their own agendas.
- {{user}} is not the default leader unless established narratively.
- NPCs express opinions and may even leave the party if values/actions conflict severely enough.
- Characters only know what they should know from the world. They are not omniscient.

CHARACTER VOICE:
- You may paraphrase/write {{user}} dialogue consistent with character description.
- You may lightly expand on {{user}}'s actions based on their character.
</narrative>

<end_of_output_footer>
END OF EACH OUTPUT (required):
*(Status: [HP]) | (XP: [current]/[next level]) | (Vibe: [X])*
*Level [X] | [HH:MM AM/PM], Day [X]*
</end_of_output_footer>

<party_join_leave>
When a character joins/leaves, explicitly state (Name joins/leaves the party).
Declare their COMBAT PROFILE immediately:
- Worn armor, AC, and Max HP.
- Primary Weapon: (Attack Bonus / Damage Die + Mod / Damage Type).
- Attr: STR X, DEX X, CON X, INT X, WIS X, CHA X
- Saves: Fort +X | Ref +X | Will +X
- Key Skills: (e.g., Persuasion +4, Stealth +2).
- Spells: Cantrips, spell slots by level (if applicable).
- Traits/abilities/special properties/immunities/resistances, etc (if any.)
</party_join_leave>

<resting>
-Only permit a Long Rest if Time since last rest is at least 9 hours. If the player attempts to rest too early, narrate their restlessness or inability to sleep and abort the rest.
- Long Rest interruption: If the party rests in a dangerous location, roll a d20 to determine whether the rest is interrupted by enemies. The DC depends on the danger level of the location; the more dangerous the location, the higher the DC for a safe rest.
- Short Rest interruption: also active, but the DC should be easier, generally lower than DC 8 unless the area is extremely hostile and dangerous.
</resting>

<constraints>
- NEVER reveal the RNG queue contents or explain the mechanic.
- NEVER skip or reinterpret a roll result.
- Failures must carry logical, meaningful consequences.
- If {{user}} attempts to use a resource/spell/ability/HD/etc that has no uses remaining, ONLY output that {{user}} cannot do that. Then ask them to take another action.
- Party members and {{user}} can only use Abilities if they have more than 0/X of them left; spells require available spell slots.
- [RNG_QUEUE v6.0_PROPER] is ONLY used in active combat.
- All narrative (non-combat) skill checks, random event checks, and other rolls MUST be performed via the RollTheDice tool call.
- If {{user}} is out of range and attempts to attack, simply move them closer and tell them they could not attack due to being out of (melee) range.
</constraints>
`
    };

    function getDiceToolName() {
        return 'RollTheDice';
    }

    function getDiceCommandName() {
        return 'roll';
    }

    function getDiceCommandAliases() {
        return ['r'];
    }

    /**
     * Get or initialize extension settings.
     */
    function getSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        const defaults = {
            currentMemo: "",
            prevMemo1: "",
            prevMemo2: "",
            memoHistory: [],
            lastDelta: "",
            enabled: true,
            debugMode: true,
            connectionSource: "default",
            connectionProfileId: "",
            completionPresetId: "",
            renderedViewActive: true,
            maxTokens: 0,
            fontSize: 14,
            rngEnabled: true,
            diceFunctionTool: true,
            systemPromptTemplate:
                `You are the State Extractor Model. Your task is to maintain a structured State Memo based on the roleplay narrative.
<core_directives>
IGNORE NARRATIVE FLUFF: Do not track temporary dialogue or actions. Only track persistent state changes.
INTEGRATION: Track all durations stated by the narrative (e.g. 'poisoned for 3 turns'). Decrement by 1 each round in [COMBAT]. For out-of-combat/time-based durations, calculate the delta between the current [TIME] and the [TIME] in the PRIOR MEMO.
CREATION: You MAY create a section that did not exist in the Prior Memo when the narrative warrants it based on your enabled modules.
DELETION: To REMOVE a section entirely, you MUST output: \`[TAG]REMOVED[/TAG]\`.
</core_directives>

<modules>
You must track the following enabled modules:
{{modulesText}}
</modules>

<rules>
1. Read the PRIOR MEMO and the NARRATIVE OUTPUT carefully.
2. Determine which sections changed. Only output sections that actually changed.
3. Use strict [TAG]...[/TAG] structure based on the modules requested above. ALWAYS include the closing tag.
4. Omit unchanged sections entirely. Do NOT output a section if its contents did not change.
5. BLOCK PERSISTENCE: For list-based sections ([PARTY], [INVENTORY], [ABILITIES], [SPELLS], [COMBAT]), if any single item within that section changes, you MUST re-output the ENTIRE section containing all items. Never omit existing members or items unless they are explicitly logically removed.
6. If there are absolutely NO CHANGES to any section, you MUST output exactly: \`NO_CHANGES_DETECTED\`
7. Output ONLY the changed sections (or NO_CHANGES_DETECTED). No preamble, no explanation, no commentary.
</rules>


<list_formatting>
For sections with multiple items ([ABILITIES], [INVENTORY], [SPELLS], [PARTY]):
1. Use a bulleted list with \`-\`.
2. Format: \`- Name (Resource/Max, Effect Description)\`.
3. If no resource tracker is needed, use: \`- Name (Effect Description)\`.
4. The parentheses MUST contain the resource count FIRST, followed by a comma, then the description.
</list_formatting>

<buff_debuff_logic>
Duration Tracking: Record all durations explicitly. Use turns for combat (e.g., for 3 turns) and H:M for narrative time (e.g., 1h 30m).
Restoration Anchors: When a buff or debuff modifies a base statistic (AC, Attributes, etc.), record the base value directly in the respective field—e.g., 'AC 18 (base 13)'.
Status Formatting: Output the buff/debuff in the Status line with its absolute mathematical effect in parentheses. Example: 'Shield (+5 AC, 1 turn)'.
Auto-Reversion: During each State Sync, check if a duration has expired. If it has, use the modifier in the Status line to reverse the math on the base statistic (e.g., subtracting the +5 AC), restore the field, and remove the buff from the list.
Conditional Buffs: For effects without a set time, use event-based anchors. Example: 'Exhaustion (Disadvantage on Ability Checks, until Long Rest)'.
STATUS LABELING: In [CHARACTER], [PARTY], and [COMBAT] blocks, prefix positive status effects (buffs) with \`(+)\` and negative status effects (debuffs) with \`(-)\`. Every status MUST include its effect AND duration in parentheses. Example: \`Status: (+) Heroism (+2 Temp HP per turn, 9 turns), (-) Poisoned (Disadvantage on attacks, 2 turns)\`. Healthy or no effects needs no prefix.
</buff_debuff_logic>

<progression_logic>
Update abilities/attributes/HP/etc accordingly, such as an ability's 1d6 bonus increasing to 2d6, etc.
</progression_logic>

<custom_formatting>
You may be asked to use Markers: ((PILLS)), ((BAR)), ((XPBAR)), ((BADGE)), ((HIGHLIGHT)). These are for graphical rendering options; use them if instructed but only if instructed in a specific [MODULE].
</custom_formatting>`,
            modules: {
                character: true,
                party: true,
                combat: true,
                inventory: true,
                abilities: true,
                spells: true,
                time: true,
                xp: true
            },
            stockPrompts: { ...DEFAULT_STOCK_PROMPTS },
            customFields: [],
            profiles: {},
            activeProfile: "",
            fullViewSections: [],
            blockOrder: ['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME'],
            legacyDiceNaming: false,
            closeCount: 0,
            lookbackMessages: 2,
            directPromptContext: 5,
            trackerHistoryCount: 1,
            ctxWorldInfo: false,
            lorebookFilter: [],

        };

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = {};
        }

        // Deep merge config to prevent missing 'modules' object in updates
        for (const [key, value] of Object.entries(defaults)) {
            if (extensionSettings[MODULE_NAME][key] === undefined) {
                extensionSettings[MODULE_NAME][key] = value;
            } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                if (extensionSettings[MODULE_NAME][key] === undefined) extensionSettings[MODULE_NAME][key] = {};
                for (const [subKey, subValue] of Object.entries(value)) {
                    if (extensionSettings[MODULE_NAME][key][subKey] === undefined) {
                        extensionSettings[MODULE_NAME][key][subKey] = subValue;
                    }
                }
            }
        }
        return extensionSettings[MODULE_NAME];
    }

    /**
     * One-time migration: custom fields with an old monolithic `renderType` get
     * that field removed and an empty `rows` array inserted in its place.
     * Runs every settings load — safe to call repeatedly.
     */
    function migrateCustomFields() {
        const s = getSettings();
        (s.customFields || []).forEach(field => {
            // Migration 1: Convert single renderType to empty rows (old)
            if (field.renderType !== undefined && !field.rows && !field.template) {
                field.rows = [];
                delete field.renderType;
            }
            // Migration 2: Convert rows to template (New)
            if (field.rows && !field.template) {
                const UI_TO_MARKER = {
                    'pills': 'PILLS', 'badge': 'BADGE', 'highlight': 'HIGHLIGHT',
                    'hp_bar': 'BAR', 'xp_bar': 'XPBAR', 'text': 'TEXT', 'kv': 'TEXT'
                };
                field.template = field.rows.map(row => {
                    const marker = UI_TO_MARKER[row.renderType] || 'TEXT';
                    const content = row.label || '';
                    return `((${marker})) ${content}`;
                }).join('\n').trim();
                delete field.rows;
                delete field.renderType;
            }
        });
    }

    /**
     * RNG Engine Implementation
     */
    const RNG_QUEUE_LEN = 8;
    function rollDie(sides) {
        const buf = new Uint32Array(1);
        const limit = Math.floor(4294967296 / sides) * sides;
        let roll;
        do { crypto.getRandomValues(buf); roll = buf[0]; } while (roll >= limit);
        return (roll % sides) + 1;
    }
    function makeRngQueue(n = RNG_QUEUE_LEN) {
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push({
                d20: rollDie(20),
                d4: rollDie(4),
                d6: rollDie(6),
                d8: rollDie(8),
                d10: rollDie(10),
                d12: rollDie(12)
            });
        }
        return out;
    }

    /**
     * Dice Rolling Implementation
     */
    async function doDiceRoll(customDiceFormula, quiet = false) {
        const nullValue = { total: '', rolls: [] };
        let value = typeof customDiceFormula === 'string' ? customDiceFormula.trim() : '1d20';

        if (value === 'custom') {
            const { Popup } = SillyTavern.getContext();
            value = await Popup.show.input('Enter the dice formula:<br><i>(for example, <tt>2d6</tt>)</i>', '', 'Roll', { cancelButton: 'Cancel' });
        }

        if (!value) return nullValue;

        const droll = SillyTavern.libs.droll;
        if (!droll) {
            toastr['error']('Dice library (droll) not found.');
            return nullValue;
        }

        const isValid = droll.validate(value);
        if (isValid) {
            const result = droll.roll(value);
            if (!result) return nullValue;
            if (!quiet) {
                const context = SillyTavern.getContext();
                context.sendSystemMessage('generic', `${context.name1} rolls a ${value}. The result is: ${result.total} (${result.rolls.join(', ')})`, { isSmallSys: true });
            }
            return { total: String(result.total), rolls: result.rolls.map(String) };
        } else {
            toastr['warning']('Invalid dice formula');
            return nullValue;
        }
    }

    function registerDiceFunctionTool() {
        try {
            const ctx = SillyTavern.getContext();
            const { registerFunctionTool, unregisterFunctionTool } = ctx;
            if (!registerFunctionTool || !unregisterFunctionTool) return;

            unregisterFunctionTool('RollTheDice');
            unregisterFunctionTool('FatbodyRollTheDice');

            const settings = getSettings();
            if (!settings.diceFunctionTool) return;

            const toolName = getDiceToolName();
            const isLegacy = settings.legacyDiceNaming;

            const rollDiceSchema = isLegacy ? {
                type: 'object',
                properties: {
                    who: { type: 'string', description: 'The name of the persona rolling the dice' },
                    formula: { type: 'string', description: 'A dice formula to roll, e.g. 1d6' },
                },
                required: ['who', 'formula'],
            } : {
                type: 'object',
                properties: {
                    who: { type: 'string', description: 'The name of the persona rolling the dice' },
                    formula: { type: 'string', description: 'A dice formula to roll, e.g. 1d20' },
                    dc: { type: 'number', description: 'The Difficulty Class (DC) for this roll. Anchors the difficulty before the roll is made.' },
                },
                required: ['who', 'formula', 'dc'],
            };

            registerFunctionTool({
                name: toolName,
                displayName: isLegacy ? 'Dice Roll' : 'Dice Roll (with DC)',
                description: 'Rolls the dice using the provided formula and returns the numeric result. Use when it is necessary to roll the dice to determine the outcome of an action or when the user requests it.',
                parameters: rollDiceSchema,
                action: async (args) => {
                    const formula = args?.formula || (isLegacy ? '1d6' : '1d20');
                    const roll = await doDiceRoll(formula, true);
                    const total = parseInt(roll.total) || 0;

                    if (isLegacy) {
                        return args.who
                            ? `${args.who} rolls a ${formula}. The result is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`
                            : `The result of a ${formula} roll is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`;
                    }

                    const dc = Number(args?.dc) || 0;
                    let result = args.who
                        ? `${args.who} rolls a ${formula} against DC ${dc}. The result is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`
                        : `The result of a ${formula} roll against DC ${dc} is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`;

                    if (dc > 0) {
                        result += ` (Result: ${total >= dc ? 'SUCCESS' : 'FAILURE'})`;
                    }
                    return result;
                },
                formatMessage: () => '',
            });
        } catch (error) {
            console.error('[RPG Tracker] Error registering dice function tool', error);
        }
    }

    function registerDiceSlashCommand() {
        const { SlashCommand, SlashCommandParser, ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = SillyTavern.getContext();
        if (!SlashCommand || !SlashCommandParser) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: getDiceCommandName(),
            aliases: getDiceCommandAliases(),
            callback: async (args, value) => {
                const quiet = String(args.quiet) === 'true';
                const result = await doDiceRoll(String(value || (getSettings().legacyDiceNaming ? '1d6' : '1d20')), quiet);
                return result.total;
            },
            helpString: 'Roll the dice.',
            returns: 'roll result',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'quiet',
                    description: 'Do not display the result in chat',
                    isRequired: false,
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'dice formula, e.g. 2d6',
                    isRequired: true,
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
            ],
        }));
    }
    function buildRngBlock(queue) {
        const turnId = Date.now();
        const formattedQueue = queue.map(dice => {
            return `${dice.d20}(d4:${dice.d4},d6:${dice.d6},d8:${dice.d8},d10:${dice.d10},d12:${dice.d12})`;
        }).join(", ");
        return `[RNG_QUEUE v6.0_PROPER]\nturn_id=${turnId}\nscope=this_response\nqueue=[${formattedQueue}]\n[/RNG_QUEUE]\n\n`;
    }

    globalThis.rpgTrackerInterceptor = async function (chat, contextSize, abort, type) {
        const settings = getSettings();
        if (!settings.enabled) return;

        // Find the last user message to prepend injections
        let idx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]['role'] === "user" || chat[i].is_user) {
                idx = i;
                break;
            }
        }

        if (idx === -1) return;

        const msg = chat[idx];
        const content = msg['content'] || msg.mes || '';

        let injections = "";

        // 1. RNG Injection
        if (settings.rngEnabled && !content.includes("[RNG_QUEUE v6.0_PROPER]")) {
            const queue = makeRngQueue(RNG_QUEUE_LEN);
            injections += buildRngBlock(queue);
        }

        // 2. State Memo Injection (strip display-only HTML before sending to AI)
        if (settings.currentMemo && !content.includes("### STATE MEMO (DO NOT REPEAT)")) {
            injections += `### STATE MEMO (DO NOT REPEAT)\n${stripMemoHtml(settings.currentMemo)}\n\n`;
        }

        if (!injections) return;

        if (typeof msg.content === "string") msg.content = injections + msg.content;
        else if (typeof msg.mes === "string") msg.mes = injections + msg.mes;
        if (settings.debugMode) console.log("[Fatbody Framework] Injections pushed to request.");
    };

    /**
     * Event handler for GENERATION_ENDED.
     * Triggers the State Model pass ONLY after the entire generation loop (including tool calls) finishes.
     */
    /**
     * Helper to collect AI narrative from the chat.
     * @param {any[]} chat - The SillyTavern chat array.
     * @param {number} limit - If -1, collects since last user message. Otherwise, collects N valid assistant blocks.
     */
    function getNarrativeBlocks(chat, limit = -1) {
        if (!chat || chat.length === 0) return "";
        let narrativeBlocks = [];
        let foundCount = 0;

        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];

            // Mode A: Stop at user message
            if (limit === -1 && msg.is_user) break;

            // Mode B: Stop at limit
            if (limit !== -1 && foundCount >= limit) break;

            // Always skip system/hidden
            if (msg.is_system || /** @type {any} */ (msg).is_hidden) continue;

            let mes = (msg.mes || '').trim();
            if (!mes) continue;

            // Ignore typical "summary" patterns
            if (mes.startsWith('[Summary') || mes.startsWith('(Summary') || mes.includes('Summary of past events:')) continue;
            if (msg.extra?.['summary'] || msg.extra?.['is_summary'] || msg.extra?.['summary_data']) continue;

            // ─── Strip Tool Call & Thinking UI ───
            mes = mes.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, '');
            mes = mes.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '');
            mes = mes.replace(/<thought\b[^>]*>([\s\S]*?)<\/thought>/gi, '');
            mes = mes.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, '');
            mes = mes.replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi, '');
            mes = mes.trim();

            if (mes) {
                narrativeBlocks.unshift(mes);
                foundCount++;
            }
        }
        return narrativeBlocks.join('\n\n');
    }

    async function onGenerationEnded() {
        const settings = getSettings();
        if (!settings.enabled || _stateModelRunning) return;

        const { chat } = SillyTavern.getContext();
        const combinedNarrative = getNarrativeBlocks(chat, -1);

        if (!combinedNarrative) return;

        if (settings.debugMode) console.log("[RPG Tracker] Assistant generation ended. Triggering State Model pass...", combinedNarrative);
        runStateModelPass(combinedNarrative);
    }

    /**
     * Update the visual status of the panel (active, running, paused)
     */
    function updatePanelStatus() {
        const settings = getSettings();
        const panel = document.getElementById('rpg-tracker-panel');
        const indicator = document.getElementById('rpg-tracker-status');
        const pauseBtn = document.getElementById('rpg-tracker-pause-btn');

        if (!panel || !indicator || !pauseBtn) return;

        if (settings.enabled) {
            panel.classList.remove('is-paused');
            indicator.classList.add('active');
            pauseBtn.textContent = '⏸';
            pauseBtn.title = 'Pause Tracker';
        } else {
            panel.classList.add('is-paused');
            indicator.classList.remove('active');
            pauseBtn.textContent = '▶';
            pauseBtn.title = 'Resume Tracker';
        }

        if (_stateModelRunning) {
            indicator.classList.add('running');
        } else {
            indicator.classList.remove('running');
        }
    }

    /**
     * Connection Profile Helpers (Switch-Execute-Restore Pattern)
     */
    async function checkConnectionProfilesActive() {
        return $('#sys-settings-button').find('#connection_profiles').length > 0;
    }

    async function getConnectionProfiles() {
        if (!(await checkConnectionProfilesActive())) return [];
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        const result = await executeSlashCommandsWithOptions(`/profile-list`);
        try {
            return JSON.parse(result.pipe);
        } catch {
            return [];
        }
    }

    async function getCurrentCompletionPreset() {
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        const result = await executeSlashCommandsWithOptions(`/preset`);
        return result?.pipe?.trim() || null;
    }

    async function setCompletionPreset(name) {
        if (!name) return;
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        await executeSlashCommandsWithOptions(`/preset "${name}"`);
    }

    /**
     * Send the request through the configured backend.
     */
    async function sendStateRequest(settings, systemPrompt, userPrompt) {
        const context = SillyTavern.getContext();

        // ── Diagnostic: log connection settings on every call ──
        console.log(`[RPG Tracker] sendStateRequest — source: "${settings.connectionSource}", profileId: "${settings.connectionProfileId}", preset: "${settings.completionPresetId}"`);

        // ── Profile mode: use ConnectionManagerRequestService (silent, no UI flicker) ──
        if (settings.connectionSource === 'profile' && settings.connectionProfileId) {
            const service = context.ConnectionManagerRequestService;

            if (!service || typeof service.sendRequest !== 'function') {
                // Graceful fallback: warn and fall through to generateRaw
                console.warn('[RPG Tracker] ConnectionManagerRequestService not available (ST too old?). Falling back to generateRaw with profile switch.');
            } else {
                if (settings.debugMode) console.log(`[RPG Tracker] Sending via profile (silent): ${settings.connectionProfileId}${settings.completionPresetId ? `, preset override: ${settings.completionPresetId}` : ''}`);

                // ── Manual Profile Implementation ──
                // We bypass the standard service because it doesn't allow per-call preset overrides.
                // This logic is adapted from ST's ConnectionManagerRequestService.
                let profile;
                try {
                    // Try by ID first (UUID)
                    profile = service.getProfile(settings.connectionProfileId);
                } catch {
                    // Fallback: try to find by name (for older settings)
                    const profiles = context.extensionSettings?.connectionManager?.profiles || [];
                    profile = profiles.find(p => p.name === settings.connectionProfileId || p.id === settings.connectionProfileId);
                }

                if (!profile) throw new Error(`[RPG Tracker] Connection Profile not found: ${settings.connectionProfileId}`);

                const selectedApiMap = service.validateProfile(profile);
                const messages = [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt   },
                ];

                const maxTokens = settings.maxTokens && settings.maxTokens > 0 ? settings.maxTokens : undefined;
                const presetToUse = settings.completionPresetId || profile.preset;

                let raw;
                if (selectedApiMap.selected === 'openai') {
                    const proxies = context.proxies || [];
                    const proxyPreset = proxies.find((p) => p.name === profile.proxy);
                    raw = await context.ChatCompletionService.processRequest({
                        stream: false,
                        messages,
                        max_tokens: maxTokens,
                        model: profile.model,
                        chat_completion_source: selectedApiMap.source,
                        secret_id: profile['secret-id'],
                        custom_url: profile['api-url'],
                        vertexai_region: profile['api-url'],
                        zai_endpoint: profile['api-url'],
                        siliconflow_endpoint: profile['api-url'],
                        minimax_endpoint: profile['api-url'],
                        reverse_proxy: proxyPreset?.url,
                        proxy_password: proxyPreset?.password,
                        custom_prompt_post_processing: profile['prompt-post-processing'],
                    }, {
                        presetName: presetToUse,
                    }, true);
                } else if (selectedApiMap.selected === 'textgenerationwebui') {
                    raw = await context.TextCompletionService.processRequest({
                        stream: false,
                        prompt: messages, // TextCompletionService handles message arrays
                        max_tokens: maxTokens,
                        model: profile.model,
                        api_type: selectedApiMap.type,
                        api_server: profile['api-url'],
                        secret_id: profile['secret-id'],
                    }, {
                        instructName: profile.instruct,
                        presetName: presetToUse,
                    }, true);
                } else {
                    throw new Error(`[RPG Tracker] Unsupported API type: ${selectedApiMap.selected}`);
                }

                // Normalise return type (mirrors Summaryception's handling)
                if (typeof raw === 'string') return raw;
                const r = /** @type {any} */ (raw);
                const text = r?.content
                    ?? r?.message?.content
                    ?? r?.choices?.[0]?.message?.content
                    ?? r?.choices?.[0]?.text
                    ?? null;

                if (text) return text;
                throw new Error(`[RPG Tracker] Profile request returned unexpected type: ${JSON.stringify(raw).substring(0, 200)}`);
            }
        }

        // ── Default mode: generateRaw through the active connection ──
        const { generateRaw } = context;
        if (!generateRaw) throw new Error('[RPG Tracker] generateRaw is not available.');

        let originalPreset = null;
        try {
            if (settings.completionPresetId) {
                originalPreset = await getCurrentCompletionPreset();
                if (settings.debugMode) console.log(`[RPG Tracker] Switching Preset: ${originalPreset} -> ${settings.completionPresetId}`);
                await setCompletionPreset(settings.completionPresetId);
            }

            const options = {
                prompt: userPrompt,
                systemPrompt: systemPrompt,
                bypassAll: true,
            };

            if (settings.maxTokens && settings.maxTokens > 0) {
                options.responseLength = settings.maxTokens;
            }

            const result = await generateRaw(options);

            if (typeof result === 'string') return result;
            const r = /** @type {any} */ (result);
            return r?.choices?.[0]?.message?.content
                ?? r?.choices?.[0]?.text
                ?? r?.message?.content
                ?? r?.content
                ?? JSON.stringify(result);

        } catch (err) {
            console.error('[RPG Tracker] Request failed:', err);
            throw err;
        } finally {
            if (originalPreset && settings.completionPresetId && originalPreset !== settings.completionPresetId) {
                if (settings.debugMode) console.log(`[RPG Tracker] Restoring preset: ${originalPreset}`);
                await setCompletionPreset(originalPreset);
            }
        }
    }

    /**
     * Sanitizes a memo string to ensure no duplicate [TAG] sections exist.
     * If duplicates are found, the last one in the string is preserved.
     */
    function deduplicateMemo(memo) {
        if (!memo) return "";
        const settings = getSettings();

        // Find all tags in the string
        const tagRegex = /\[([A-Z_]+)\]/gi;
        const tags = new Set();
        let match;
        while ((match = tagRegex.exec(memo)) !== null) {
            tags.add(match[1].toUpperCase());
        }

        let cleanedMemo = memo;
        for (const tag of tags) {
            const escapedTag = escapeRegex(tag);
            const pattern = new RegExp(`\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`, 'gi');
            const blocks = [...memo.matchAll(pattern)];

            if (blocks.length > 1) {
                if (settings.debugMode) console.warn(`[RPG Tracker] Deduplication: Found ${blocks.length} instances of [${tag}]. Keeping the last one.`);

                // Remove all instances of the tag
                cleanedMemo = cleanedMemo.replace(pattern, "---DEDUP_MARKER---");

                // Put back only the last one
                const lastBlock = blocks[blocks.length - 1][0];

                // We use a temporary marker to avoid double-replacing if the tag content
                // accidentally contains its own tag name.
                const split = cleanedMemo.split("---DEDUP_MARKER---");
                cleanedMemo = split.join("").trim() + "\n\n" + lastBlock;
            }
        }

        return cleanedMemo.replace(/\n{3,}/g, '\n\n').trim();
    }

    /**
     * Merge partial AI output into the existing memo.
     * Finds all [TAG]...[/TAG] blocks in the AI output and replaces the
     * matching section in the current memo. New sections are appended.
     * If the AI output contains no bracket tags at all, the full output
     * replaces the memo (full-replacement fallback).
     */
    function mergeMemo(currentMemo, aiOutput) {
        const settings = getSettings();

        // Find all [TAG]...[/TAG] pairs in the AI's output (case-insensitive, whitespace-tolerant)
        const tagPattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
        const matches = [...aiOutput.matchAll(tagPattern)];

        // Fallback: if the AI output contains no [TAG] blocks, it likely output a
        // "no changes needed" explanation instead of structured data.
        // In this case, preserve the current memo entirely — do NOT replace it.
        if (matches.length === 0) {
            console.warn("[RPG Tracker] No valid [TAG]...[/TAG] blocks found in model output — treating as no-change. Output was:", aiOutput);
            return currentMemo;
        }

        if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: found ${matches.length} tag(s):`, matches.map(m => m[1]));

        let memo = currentMemo;

        for (const match of matches) {
            const tag = match[1].trim();         // e.g. "CHARACTER"
            const newContent = match[2].trim();  // new content for that section

            // Handle removal keywords
            const isRemoval = /^(?:REMOVED|EXPIRED|CLEARED|NONE|END_COMBAT)$/i.test(newContent);

            // Build pattern to find existing section in memo
            const escapedTag = escapeRegex(tag);
            const existingPattern = new RegExp(
                `\\s*\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`,
                'i'
            );

            if (settings.debugMode) {
                console.log(`[RPG Tracker] mergeMemo: processing [${tag}], pattern: ${existingPattern}`);
            }

            if (isRemoval) {
                memo = memo.replace(existingPattern, "").trim();
                if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] REMOVED`);
            } else {
                const fullBlock = `[${tag}]\n${newContent}\n[/${tag}]`;
                const before = memo;
                memo = memo.replace(existingPattern, () => '\n\n' + fullBlock);
                if (memo !== before) {
                    if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] REPLACED`);
                } else {
                    // Section doesn't exist yet — append it
                    memo = memo.trimEnd() + '\n\n' + fullBlock;
                    if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] APPENDED (new section)`);
                }
            }
        }

        // Final cleanup and deduplication
        const cleaned = memo.replace(/\n{3,}/g, '\n\n').trim();
        return deduplicateMemo(cleaned);
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Extract and clean the last user message from the chat,
     * stripping injected blocks (STATE MEMO, RNG_QUEUE) so only
     * the player's actual typed input remains.
     * @returns {string} The cleaned user action text, or an empty string.
     */
    function getLastUserAction() {
        const { chat } = SillyTavern.getContext();
        if (!chat || chat.length === 0) return '';

        let raw = '';
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user || chat[i]['role'] === 'user') {
                raw = chat[i].mes || chat[i]['content'] || '';
                break;
            }
        }

        if (!raw) return '';

        // Strip ### STATE MEMO ... (ends at a blank line before the next section or RNG block)
        raw = raw.replace(/###\s*STATE MEMO[^]*?(?=\n\[RNG_QUEUE|\n###|\n\[(?!RNG_QUEUE)[A-Z]|$)/i, '');

        // Strip [RNG_QUEUE ...]...[/RNG_QUEUE] blocks
        raw = raw.replace(/\[RNG_QUEUE[^\]]*\][\s\S]*?\[\/RNG_QUEUE\]/gi, '');

        // Strip any residual [TAG]...[/TAG] injected memo blocks that may linger
        raw = raw.replace(/\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]/g, '');

        return raw.trim();
    }

    /**
     * Reads context sources (Lorebooks) from user settings
     * and assembles them into blocks that are prepended to the user prompt.
     */
    async function buildLorebookContext() {
        const settings = getSettings();
        const stCtx = SillyTavern.getContext();
        const parts = [];

        if (settings.ctxWorldInfo) {
            try {
                const allowedBooks = settings.lorebookFilter || [];
                let booksToLoad = allowedBooks.length > 0
                    ? allowedBooks
                    : (await stCtx.getWorldInfoNames() || []);

                const entries = [];
                for (const bookName of booksToLoad) {
                    try {
                        const bookData = await stCtx.loadWorldInfo(bookName);
                        if (!bookData?.entries) continue;
                        for (const entry of Object.values(/** @type {any} */(bookData).entries)) {
                            const e = /** @type {any} */ (entry);
                            if (!e.disable && e.content) entries.push(e.content);
                        }
                    } catch (bookErr) {
                        console.warn(`[RPG Tracker] Failed to load lorebook "${bookName}":`, bookErr);
                    }
                }

                if (entries.length > 0) {
                    const label = allowedBooks.length > 0 ? `Filtered: ${allowedBooks.join(', ')}` : 'All Books';
                    parts.push(`## WORLD LORE (${label})\n${entries.join('\n---\n')}`);
                }
            } catch (e) {
                console.warn('[RPG Tracker] Could not inject World Info:', e);
            }
        }

        return parts.join('\n\n');
    }

    /**
     * The State Model pass: Extract state changes from the narrative.
     * @param {string} narrativeOutput The last narrative message to parse.
     * @param {boolean} isFullContext Whether to perform a long-horizon audit of the entire chat.
     */
        /**
     * Builds the complete modules instruction block for the system prompt.
     * @param {any} settings - The extension settings.
     * @returns {string} The instruction block.
     */
    function buildModulesInstructionText(settings) {
        let modulesText = "";
        const promptsMap = settings.stockPrompts || DEFAULT_STOCK_PROMPTS;
        
        // 1. Stock Modules
        modulesText += "### CORE MODULES\n";
        for (const [key, prompt] of Object.entries(promptsMap)) {
            if (settings.modules[key]) {
                modulesText += `- [${key.toUpperCase()}]: ${prompt}\n`;
            }
        }
        
        // 2. Custom Modules
        const enabledCustomFields = (settings.customFields || []).filter(f => f.enabled && f.tag);
        if (enabledCustomFields.length > 0) {
            modulesText += "\n### CUSTOM MODULES\n";
            enabledCustomFields.forEach(f => {
                const instruction = buildModuleFormatInstruction(f);
                if (instruction) {
                    modulesText += `- [${f.tag.toUpperCase()}]: ${instruction}\n`;
                }
            });
        }
        return modulesText.trim();
    }

    function buildModuleFormatInstruction(field) {
        return field.prompt || '';
    }

    /**
     * The State Model pass: Extract state changes from the narrative.
     * @param {string} narrativeOutput The last narrative message to parse.
     * @param {boolean} isFullContext Whether to perform a long-horizon audit of the entire chat.
     */
    async function runStateModelPass(narrativeOutput, isFullContext = false, overrideLookback = null) {
        const settings = getSettings();
        const { generateRaw, saveSettingsDebounced } = SillyTavern.getContext();

        if (!generateRaw) {
            console.error("[RPG Tracker] generateRaw not found in context.");
            return;
        }

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');

            const modulesText = buildModulesInstructionText(settings);

            let systemPrompt = settings.systemPromptTemplate.replace("{{modulesText}}", modulesText);
            if (isFullContext) {
                systemPrompt = systemPrompt
                    .replace(/Only output sections that actually changed/gi, "Perform a full audit of the narrative history and output the COMPLETE state for all enabled modules")
                    .replace(/Omit unchanged sections entirely/gi, "Do NOT omit any section; output a complete, verified state memo");
            }

            const worldLore = await buildLorebookContext();
            const worldLoreSection = worldLore ? worldLore + '\n\n' : '';

            const { chat } = SillyTavern.getContext();
            // overrideLookback comes from the Lookback Update menu; it wins over settings
            const N = overrideLookback !== null ? overrideLookback
                    : isFullContext          ? chat.length
                    : (settings.lookbackMessages !== undefined ? settings.lookbackMessages : 2);
            const recentChat = chat.slice(-N);
            const chatLog = recentChat.map(m => {
                const name = m.is_user ? 'Player' : (m.name || 'Narrator');
                return `${name}: ${m.mes}`;
            }).join('\n\n');

            let priorMemoText = `## TRACKER STATE 0 (Current)\n${stripMemoHtml(settings.currentMemo)}\n\n`;
            const historyCount = (settings.trackerHistoryCount || 1) - 1;
            if (historyCount > 0 && settings.memoHistory && settings.memoHistory.length > 0) {
                const historyToInclude = settings.memoHistory.slice(0, historyCount).reverse();
                const historyString = historyToInclude.map((memo, i) => {
                    const offset = -(historyToInclude.length - i);
                    return `## TRACKER STATE ${offset}\n${stripMemoHtml(memo)}`;
                }).join('\n\n');
                priorMemoText = historyString + '\n\n' + priorMemoText;
            }

            let userPrompt = "";

            if (isFullContext) {
                userPrompt =
                    worldLoreSection +
                    priorMemoText +
                    `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n${chatLog}\n\n` +
                    `## TASK\nAnalyze the entire narrative history provided above. Rebuild the State Memo to ensure every detail (HP, AC, Inventory, Abilities, XP, Party members) is perfectly accurate to the current moment in the story. Correct any errors or omissions found in the Prior Memo.\n\n` +
                    `## OUTPUT THE COMPLETE VERIFIED STATE MEMO:`;
            } else {
                userPrompt =
                    worldLoreSection +
                    priorMemoText +
                    `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n${chatLog}\n\n` +
                    `## OUTPUT ONLY CHANGED SECTIONS:`;
            }

            const result = await sendStateRequest(settings, systemPrompt, userPrompt);            if (result && typeof result === 'string') {
                if (settings.debugMode) console.log("[RPG Tracker] Raw Result:", result);

                // ── Pre-clean: strip <memo> wrapper tags before any merge logic ──
                // The model may wrap its output in <memo>...</memo> regardless of our prompt.
                // We extract the last complete block's content, or strip orphaned tags.
                let cleanedOutput = result;
                const memoBlocks = [...result.matchAll(/<memo>([\s\S]*?)<\/memo>/gi)];
                if (memoBlocks.length > 0) {
                    // Take the last complete <memo>...</memo> block
                    cleanedOutput = memoBlocks[memoBlocks.length - 1][1].trim();
                } else {
                    // Strip any orphaned <memo> / </memo> tags
                    cleanedOutput = result.replace(/<\/?memo>/gi, '').trim();
                }

                // Also sanitize the current stored memo in case it was previously
                // contaminated by a prior session that saved raw tags.
                const sanitizedCurrent = settings.currentMemo.replace(/<\/?memo>/gi, '').trim();

                const merged = mergeMemo(sanitizedCurrent, cleanedOutput);

                if (settings.debugMode) {
                    console.log(`[RPG Tracker] Memo ${merged !== sanitizedCurrent ? 'updated (partial merge)' : 'unchanged'}.`);
                }

                // Push snapshot to rolling history (max 5)
                const delta = computeDelta(sanitizedCurrent, merged);
                settings.memoHistory.unshift(sanitizedCurrent);
                if (settings.memoHistory.length > 1000) settings.memoHistory.length = 1000;

                // Persist delta and update panel
                settings.lastDelta = delta;
                const deltaPanel = document.getElementById('rpg-tracker-delta-content');
                if (deltaPanel) deltaPanel.innerHTML = delta;

                // Rotation logic (legacy compat)
                settings.prevMemo2 = settings.prevMemo1;
                settings.prevMemo1 = sanitizedCurrent;
                settings.currentMemo = merged;

                updateUIMemo(merged);
                syncMemoView();
                refreshRenderedView();
                saveSettingsDebounced();

                if (settings.debugMode) console.log("[RPG Tracker] State Model pass complete.");

                // Check for Level Up
                if (/LEVEL_UP=true/i.test(merged)) {
                    handleLevelUp();
                }
            }
        } catch (error) {
            console.error("[RPG Tracker] State Model pass failed:", error);
        } finally {
            _stateModelRunning = false;
            updateStatusIndicator('active');
        }
    }

    function handleLevelUp() {
        const { sendSystemMessage } = SillyTavern.getContext();
        toastr['success']("Level Up Detected! System prompt injected.", "RPG Tracker");

        if (sendSystemMessage) {
            sendSystemMessage('generic', "SYSTEM: Level Up Detected! The character has gained a level. Acknowledge this immediately and prompt the user to make their level-up choices or grant them their logical boons.");
        }
    }

    /**
     * Send a direct instruction to the State Model bypassing the narrative pipeline.
     * Used for initial character setup and manual corrections.
     */
    async function sendDirectPrompt(message) {
        if (_stateModelRunning) {
            toastr['info']('State Model is already running. Please wait.', 'RPG Tracker');
            return;
        }

        const settings = getSettings();
        const { generateRaw, saveSettingsDebounced } = SillyTavern.getContext();
        if (!generateRaw) return;

        try {
            _stateModelRunning = true;
            updateStatusIndicator('running');
            const worldLore = await buildLorebookContext();
            const worldLoreSection = worldLore ? worldLore + '\n\n' : '';

            let modulesText = '';
            const promptsMap = settings.stockPrompts || DEFAULT_STOCK_PROMPTS;
            for (const [key, prompt] of Object.entries(promptsMap)) {
                if (settings.modules[key]) {
                    modulesText += `- [${key.toUpperCase()}]: ${prompt}\n`;
                }
            }
            if (settings.customFields && settings.customFields.length > 0) {
                settings.customFields.forEach(f => {
                    if (f.enabled && f.tag && f.prompt) {
                        modulesText += `- [${f.tag.toUpperCase()}]: ${f.prompt}\n`;
                    }
                });
            }

            const systemPrompt = settings.systemPromptTemplate.replace('{{modulesText}}', modulesText);

            const sanitizedCurrent = stripMemoHtml(settings.currentMemo.replace(/<\/?memo>/gi, '').trim());

            const { chat } = SillyTavern.getContext();
            const N = settings.directPromptContext !== undefined ? settings.directPromptContext : 5;
            let chatLog = '';
            if (N > 0 && chat && chat.length > 0) {
                const recentChat = chat.slice(-N);
                chatLog = `## NARRATIVE HISTORY (Last ${recentChat.length} messages)\n` + recentChat.map(m => {
                    const name = m.is_user ? 'Player' : (m.name || 'Narrator');
                    return `${name}: ${m.mes}`;
                }).join('\n\n') + '\n\n';
            }

            const userPrompt =
                worldLoreSection +
                chatLog +
                `## PRIOR MEMO\n${sanitizedCurrent || '(empty — this is the initial setup)'}\n\n` +
                `## USER INSTRUCTION\n${message}\n\n` +
                `## OUTPUT ONLY CHANGED OR NEW SECTIONS:`;

            const result = await sendStateRequest(settings, systemPrompt, userPrompt);

            if (result && typeof result === 'string') {
                let cleanedOutput = result;
                const memoBlocks = [...result.matchAll(/<memo>([\s\S]*?)<\/memo>/gi)];
                if (memoBlocks.length > 0) {
                    cleanedOutput = memoBlocks[memoBlocks.length - 1][1].trim();
                } else {
                    cleanedOutput = result.replace(/<\/?memo>/gi, '').trim();
                }

                const merged = mergeMemo(sanitizedCurrent, cleanedOutput);

                if (merged !== sanitizedCurrent) {
                    const delta = computeDelta(sanitizedCurrent, merged);
                    settings.lastDelta = delta;
                    settings.memoHistory.unshift(sanitizedCurrent);
                    if (settings.memoHistory.length > 5) settings.memoHistory.length = 5;

                    const dp = document.getElementById('rpg-tracker-delta-content');
                    if (dp) dp.innerHTML = delta;

                    settings.prevMemo2 = settings.prevMemo1;
                    settings.prevMemo1 = sanitizedCurrent;
                    settings.currentMemo = merged;

                    updateUIMemo(merged);
                    syncMemoView();
                    refreshRenderedView();
                    saveSettingsDebounced();
                    toastr['success']('Tracker updated.', 'RPG Tracker');
                } else {
                    toastr['info']('No changes were made.', 'RPG Tracker');
                }
            }
        } catch (err) {
            console.error('[RPG Tracker] Direct prompt failed:', err);
            toastr['error']('Direct prompt failed. Check console.', 'RPG Tracker');
        } finally {
            _stateModelRunning = false;
            updateStatusIndicator('active');
        }
    }



    /**
     * Panel geometry persistence
     */
    const GEOMETRY_KEY = 'rpg_tracker_geometry';

    /**
     * @param {HTMLElement} panel
     */
    function savePanelGeometry(panel) {
        const rect = panel.getBoundingClientRect();
        localStorage.setItem(GEOMETRY_KEY, JSON.stringify({
            left: rect.left, top: rect.top,
            width: rect.width, height: rect.height
        }));
    }

    /**
     * @param {HTMLElement} panel
     */
    function loadPanelGeometry(panel) {
        try {
            const saved = JSON.parse(localStorage.getItem(GEOMETRY_KEY));
            if (!saved) return;

            // Sanitize coordinates to prevent "bricking" off-screen
            const left = saved.left !== undefined ? Math.max(0, Math.min(window.innerWidth - 50, saved.left)) : undefined;
            const top = saved.top !== undefined ? Math.max(0, Math.min(window.innerHeight - 50, saved.top)) : undefined;

            if (left !== undefined) { panel.style.left = left + 'px'; panel.style.right = 'auto'; }
            if (top !== undefined) { panel.style.top = top + 'px'; panel.style.bottom = 'auto'; }
            if (saved.width) panel.style.width = saved.width + 'px';
            if (saved.height) panel.style.height = saved.height + 'px';
        } catch { /* ignore */ }
    }

    const DELTA_HEIGHT_KEY = 'rpg_tracker_delta_height';

    function saveDeltaHeight(height) {
        localStorage.setItem(DELTA_HEIGHT_KEY, String(height));
    }

    function loadDeltaHeight() {
        const v = parseInt(localStorage.getItem(DELTA_HEIGHT_KEY) || '');
        return isNaN(v) ? 120 : Math.max(40, v);
    }

    /**
     * Profile system
     */
    function saveProfile(name) {
        const s = getSettings();
        if (!name) return;
        if (!s.profiles) s.profiles = {};
        s.profiles[name] = {
            currentMemo: s.currentMemo,
            memoHistory: JSON.parse(JSON.stringify(s.memoHistory)),
            modules: JSON.parse(JSON.stringify(s.modules)),
            blockOrder: JSON.parse(JSON.stringify(s.blockOrder || BLOCK_ORDER)),
            stockPrompts: JSON.parse(JSON.stringify(s.stockPrompts || DEFAULT_STOCK_PROMPTS)),
            customFields: JSON.parse(JSON.stringify(s.customFields || [])),
            lastDelta: s.lastDelta || ''
        };
        s.activeProfile = name;
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function loadProfile(name) {
        const s = getSettings();
        const p = s.profiles?.[name];
        if (!p) return;
        s.currentMemo = p.currentMemo ?? '';
        s.memoHistory = p.memoHistory ?? [];
        s.modules = { ...s.modules, ...p.modules };
        s.blockOrder = p.blockOrder ? JSON.parse(JSON.stringify(p.blockOrder)) : s.blockOrder;
        s.stockPrompts = p.stockPrompts ? JSON.parse(JSON.stringify(p.stockPrompts)) : { ...DEFAULT_STOCK_PROMPTS };
        s.customFields = p.customFields ? JSON.parse(JSON.stringify(p.customFields)) : [];
        s.lastDelta = p.lastDelta ?? '';
        s.activeProfile = name;
        _historyViewIndex = -1;
        SillyTavern.getContext().saveSettingsDebounced();
        // Refresh UI
        refreshOrderList();
        // Refresh delta panel
        const dp = document.getElementById('rpg-tracker-delta-content');
        if (dp) dp.innerHTML = s.lastDelta || '<span class="delta-empty">No changes yet.</span>';
        syncMemoView();
    }

    function deleteProfile(name) {
        const s = getSettings();
        if (!s.profiles?.[name]) return;
        delete s.profiles[name];
        if (s.activeProfile === name) s.activeProfile = '';
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function refreshProfileDropdown() {
        const s = getSettings();
        const sel = document.getElementById('rpg_tracker_profile_select');
        if (!sel) return;
        const names = Object.keys(s.profiles || {});
        sel.innerHTML = '<option value="">-- No Profile --</option>' +
            names.map(n => `<option value="${escapeHtml(n)}"${n === s.activeProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    }

    /**
     * Line-level delta between two memo strings.
     * Returns an HTML string for the delta panel.
     */
    function computeDelta(oldMemo, newMemo) {
        if (!oldMemo && !newMemo) return '<span class="delta-empty">No memo yet.</span>';
        if (!oldMemo) return '<span class="delta-added">+ (initial memo created)</span>';

        const oldLines = new Set(oldMemo.split('\n').map(l => l.trim()).filter(Boolean));
        const newLines = new Set(newMemo.split('\n').map(l => l.trim()).filter(Boolean));

        const added = [...newLines].filter(l => !oldLines.has(l));
        const removed = [...oldLines].filter(l => !newLines.has(l));

        if (added.length === 0 && removed.length === 0) {
            return '<span class="delta-empty">No changes detected.</span>';
        }

        const html = [
            ...removed.map(l => `<div class="delta-removed">- ${escapeHtml(l)}</div>`),
            ...added.map(l => `<div class="delta-added">+ ${escapeHtml(l)}</div>`),
        ];
        return html.join('');
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** Wraps parenthetical groups in a highlight span. */
    function highlightParens(text) {
        return text.replace(/\(([^)]+)\)/g, '<span class="rt-paren-highlight">($1)</span>');
    }




    /**
     * Renders a line according to a row rule (label → renderType → color).
     * Flexible "salad bar" renderers — hp_bar and xp_bar accept any X/Y value.
     */
    function renderSubFieldByRule(rule, line) {
        const colonIdx = line.indexOf(':');
        // If there's no colon, the whole line is the value (no label)
        const hasLabel = colonIdx !== -1;
        const labelText = hasLabel ? line.substring(0, colonIdx + 1).trim() : '';
        const value     = hasLabel ? line.substring(colonIdx + 1).trim() : line.trim();
        const labelStyle = rule.color ? ` style="color:${rule.color}"` : '';
        const labelHtml  = labelText
            ? `<span class="rt-entity-sub-label"${labelStyle}>${escapeHtml(labelText)}</span>`
            : '';

        switch (rule.renderType) {
            case 'pills':
                return `<div class="rt-entity-sub-line rt-units-container">${labelHtml} ${renderPills(value)}</div>`;
            case 'badge':
                return `<div class="rt-entity-sub-line rt-units-container">${labelHtml} <span class="rt-unit-pill no-desc"><span class="rt-unit-name">${escapeHtmlWithColor(value)}</span></span></div>`;
            case 'highlight':
                return `<div class="rt-entity-sub-line">${labelHtml} ${highlightParens(escapeHtmlWithColor(value))}</div>`;
            case 'hp_bar': {
                // Flexible: parses any "X/Y" optionally with extra text e.g. "45/100 (5 temp)"
                const m = value.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
                if (m) {
                    const cur = parseInt(m[1].replace(/,/g, ''), 10);
                    const max = parseInt(m[2].replace(/,/g, ''), 10);
                    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
                    const extra = value.replace(m[0], '').trim();
                    // Use custom color if set, else fall back to red gradient
                    const barBg = rule.color
                        ? rule.color
                        : 'linear-gradient(90deg,#e74c3c,#c0392b)';
                    return `<div class="rt-entity-sub-line" style="gap:6px;">
                        ${labelHtml}
                        <div class="rt-hp-bar-wrap" style="flex:1; position:relative; height:14px; border-radius:4px; overflow:hidden; background:rgba(255,255,255,0.1);">
                            <div class="rt-hp-bar" style="width:${pct.toFixed(1)}%; height:100%; border-radius:4px; background:${barBg}; transition:width 0.3s;"></div>
                        </div>
                        <span style="font-size:0.82em; opacity:0.85; white-space:nowrap;">${cur}/${max}${extra ? ' ' + escapeHtml(extra) : ''}</span>
                    </div>`;
                }
                // Fallback: plain text
                return `<div class="rt-entity-sub-line">${labelHtml} ${escapeHtmlWithColor(value)}</div>`;
            }
            case 'xp_bar': {
                // Flexible: parses any "X/Y" with optional "Level N" anywhere in value
                const xm = value.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
                const lm = value.match(/level\s*(\d+)/i);
                if (xm) {
                    const cur = parseInt(xm[1].replace(/,/g, ''), 10);
                    const max = parseInt(xm[2].replace(/,/g, ''), 10);
                    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
                    const levelStr = lm ? `<span style="font-size:0.8em; opacity:0.75;">Lv ${lm[1]}</span> ` : '';
                    // Use custom color if set, else fall back to orange gradient
                    const barBg = rule.color
                        ? rule.color
                        : 'linear-gradient(90deg,#f39c12,#e67e22)';
                    return `<div class="rt-entity-sub-line" style="gap:6px; flex-wrap:wrap;">
                        ${labelHtml} ${levelStr}
                        <div class="rt-hp-bar-wrap" style="flex:1; min-width:60px; position:relative; height:10px; border-radius:4px; overflow:hidden; background:rgba(255,255,255,0.1);">
                            <div style="width:${pct.toFixed(1)}%; height:100%; border-radius:4px; background:${barBg}; transition:width 0.3s;"></div>
                        </div>
                        <span style="font-size:0.78em; opacity:0.8; white-space:nowrap;">${xm[1]}/${xm[2]}</span>
                    </div>`;
                }
                return `<div class="rt-entity-sub-line">${labelHtml} ${escapeHtmlWithColor(value)}</div>`;
            }
            case 'kv':
                return `<div class="rt-card-kv"><span class="rt-card-key">${labelHtml}</span><span class="rt-card-val">${escapeHtmlWithColor(value)}</span></div>`;
            case 'text':
            default:
                return `<div class="rt-entity-sub-line">${labelHtml} ${escapeHtmlWithColor(value)}</div>`;
        }
    }

    /**
     * If `line` begins with a ((MARKER)) prefix, renders it and returns HTML.
     * Returns null if no marker is present, so callers can fall through to
     * their own renderer. This makes markers work in ALL stock blocks.
     */
    function tryRenderMarker(line) {
        const m = line.match(/^\(\((PILLS|BAR|HPBAR|XPBAR|TEXT|BADGE|HIGHLIGHT)\)\)\s*(.*)$/i);
        if (!m) return null;
        const typeMap = { PILLS:'pills', BAR:'hp_bar', HPBAR:'hp_bar', XPBAR:'xp_bar', TEXT:'text', BADGE:'badge', HIGHLIGHT:'highlight' };
        const renderType = typeMap[m[1].toUpperCase()] || 'text';
        return renderSubFieldByRule({ renderType }, m[2].trim());
    }

    /**
     * Renders a single line from a custom block (non-built-in tag).
     */
    function renderCustomBlockLine(tag, line, lineIdx = 0) {
        const asMarker = tryRenderMarker(line);
        if (asMarker !== null) return asMarker;

        // Plain kv fallback
        const kv = line.match(/^([^:]+):\s*(.+)$/);
        if (kv) return `<div class="rt-card-kv"><span class="rt-card-key">${escapeHtmlWithColor(kv[1].trim())}:</span><span class="rt-card-val">${escapeHtmlWithColor(kv[2].trim())}</span></div>`;
        return `<div class="rt-card-line">${escapeHtmlWithColor(line.trim())}</div>`;
    }

    /**
     * Strip all HTML tags from a memo string, preserving inner text.
     * Used before sending the memo to the AI to avoid token bloat from
     * color markup (<font>, <span>, etc.) that is purely for display.
     */
    function stripMemoHtml(text) {
        if (!text) return text;
        // First convert <br> variants to newlines so line structure is preserved
        let stripped = text.replace(/<br\s*\/?>/gi, '\n');
        // Remove rendering markers like ((PILLS)), ((BAR)), etc.
        stripped = stripped.replace(/^\(\((PILLS|BAR|XPBAR|TEXT|BADGE|HIGHLIGHT|HPBAR)\)\)\s*/gim, '');
        // Remove all remaining HTML tags, keeping their inner text
        stripped = stripped.replace(/<[^>]+>/g, '');
        return stripped;
    }

    /**
     * Like escapeHtml but allows <font color="#hex"> and <font color="name"> tags through,
     * converting them to safe <span style="color:"> elements.
     * Use this for all AI/user content rendered into tracker cards.
     */
    function escapeHtmlWithColor(str) {
        if (!str) return '';

        // Rarity tag map (WoW-style item quality)
        const RARITY_COLORS = {
            'poor': '#9d9d9d',
            'common': '#ffffff',
            'uncommon': '#1eff00',
            'rare': '#0070dd',
            'epic': '#a335ee',
            'legendary': '#ff8000',
            'artifact': '#e6cc80',
            'heirloom': '#00ccff'
        };

        // Shared placeholder system — placeholders survive escapeHtml unchanged
        const OPEN = '\x01';
        const CLOSE = '\x02';
        const spans = [];

        // 1. Process [Rarity] tags. They hide the tag and color everything that follows them.
        const rarityRx = /\[(poor|common|uncommon|rare|epic|legendary|artifact|heirloom)\]\s*([\s\S]*)/gi;
        let processed = str.replace(rarityRx, (match, rarity, rest) => {
            const color = RARITY_COLORS[rarity.toLowerCase()];
            // Recursively process 'rest' for any font tags, but skip rarity tags (already handled)
            const safeInner = escapeHtmlWithColor(rest);
            spans.push(`<span style="color:${color}">${safeInner}</span>`);
            return OPEN + (spans.length - 1) + CLOSE;
        });

        // 2. Replace <font color=...>inner</font> tags (author-written color markup).
        //    The inner text is recursively processed so nested tags work correctly.
        const colorRx = /<font\s+color\s*=\s*["']?(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)["']?>([\s\S]*?)<\/font>/gi;
        const tokenized = processed.replace(colorRx, (_, color, inner) => {
            // inner may contain more font tags but NOT rarity tags (already replaced above)
            const safeInner = escapeHtmlWithColor(inner);
            spans.push(`<span style="color:${color}">${safeInner}</span>`);
            return OPEN + (spans.length - 1) + CLOSE;
        });

        // 3. Escape everything that remains, then restore the safe span placeholders.
        return escapeHtml(tokenized).replace(/\x01(\d+)\x02/g, (_, i) => spans[parseInt(i)]);
    }

    const splitSmart = (text) => {
        const res = [];
        let cur = '', depth = 0;
        for (const c of text) {
            if (c === '(') depth++; else if (c === ')') depth--;
            if (c === ',' && depth === 0) { res.push(cur.trim()); cur = ''; }
            else cur += c;
        }
        if (cur.trim()) res.push(cur.trim());
        return res;
    };

    const renderPills = (text) => {
        return splitSmart(text).map(t => {
            // Detect buff/debuff prefix
            let pillClass = 'rt-unit-pill';
            let displayText = t;
            if (t.startsWith('(+)') || t.startsWith('(+) ')) {
                pillClass += ' rt-pill-buff';
                displayText = t.replace(/^\(\+\)\s*/, '');
            } else if (t.startsWith('(-)') || t.startsWith('(-) ')) {
                pillClass += ' rt-pill-debuff';
                displayText = t.replace(/^\(-\)\s*/, '');
            }

            const m = displayText.match(/^(.+?)\s*\((.+)\)$/);
            if (m) {
                const [, name, desc] = m;

                // Extract resource count if present (e.g., "2/3")
                let iconHtml = '';
                const resourceMatch = desc.match(/(\d+)\s*\/\s*(\d+)/);
                if (resourceMatch) {
                    iconHtml = `<span class="rt-unit-icon">${escapeHtmlWithColor(resourceMatch[0])}</span>`;
                }

                return `<span class="${pillClass}">
                    <span class="rt-unit-name">${escapeHtmlWithColor(name)}</span>
                    ${iconHtml}
                    <span class="rt-unit-descr">(${escapeHtmlWithColor(desc)})</span>
                </span>`;
            }
            return `<span class="${pillClass} no-desc"><span class="rt-unit-name">${escapeHtmlWithColor(displayText)}</span></span>`;
        }).join('');
    };

    // ── History index: -1 means "live", 0 = most recent snapshot, higher = older
    let _historyViewIndex = -1;

    /** Whether the rendered card view is active */
    let _renderedViewActive = false;

    /**
     * Parse the memo's [TAG]...[/TAG] blocks and return structured object.
     */
    function parseMemoBlocks(memo) {
        const blocks = {};
        const pattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
        for (const [, tag, content] of memo.matchAll(pattern)) {
            blocks[tag.trim().toUpperCase()] = content.trim();
        }
        return blocks;
    }



    const BLOCK_ICONS = { TIME: '🕒', XP: '🇽🇵', CHARACTER: '🧙', PARTY: '👥', COMBAT: '⚔️', INVENTORY: '🎒', ABILITIES: '✨', SPELLS: '📖' };
    const BLOCK_ORDER = ['COMBAT', 'CHARACTER', 'PARTY', 'INVENTORY', 'ABILITIES', 'SPELLS', 'XP', 'TIME'];
    const PAGE_SIZE = 8;
    // Sections that should NEVER be paginated (show all entries always)
    const NO_PAGINATE = new Set(['CHARACTER', 'ABILITIES']);
    const COLLAPSE_KEY = 'rpg_tracker_collapsed';
    const DETACHED_KEY = 'rpg_tracker_detached';

    const _sectionPages = {};

    function getPageSize(renderType) {
        return renderType === 'SPELLS' ? 5 : PAGE_SIZE;
    }

    function loadCollapsed() {
        try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); }
        catch { return new Set(); }
    }
    function saveCollapsed(set) {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
    }

    function loadDetached() {
        try { return new Set(JSON.parse(localStorage.getItem(DETACHED_KEY) || '[]')); }
        catch { return new Set(); }
    }
    function saveDetached(set) {
        localStorage.setItem(DETACHED_KEY, JSON.stringify([...set]));
    }



    function blockToItems(tag, content, renderTypeOverride = null) {
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
        let renderType = renderTypeOverride || tag;
        const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
        if (!renderTypeOverride && customField && customField.renderType) {
            renderType = customField.renderType;
        }

        switch (renderType) {
                        case 'COMBAT':
            case 'PARTY':
            case 'CHARACTER': {
                const results = [];
                let lastEntityIdx = -1;

                const MARKER_RX = /^\(\((PILLS|BAR|XPBAR|TEXT|BADGE|HIGHLIGHT|HPBAR)\)\)\s*(.*)/i;
                const MARKER_TYPE_MAP = {
                    'PILLS': 'pills', 'BAR': 'hp_bar', 'HPBAR': 'hp_bar',
                    'XPBAR': 'xp_bar', 'TEXT': 'text', 'BADGE': 'badge', 'HIGHLIGHT': 'highlight'
                };

                const renderSpellGroup = (groupStr) => {
                    const m = groupStr.trim().match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*(?::\s*(.+))?$/i);
                    if (!m) return null;
                    const [, lbl, availStr, maxStr, spellList] = m;
                    const isCantrip = /cantrip/i.test(lbl);
                    let pipsHtml = '';
                    if (!isCantrip && availStr !== undefined && maxStr !== undefined) {
                        const avail = parseInt(availStr, 10), maxSlots = parseInt(maxStr, 10);
                        pipsHtml = `<span class="rt-slot-pips">${Array.from({ length: maxSlots }, (_, i) =>
                            `<span class="rt-slot-pip${i < avail ? ' rt-slot-available' : ' rt-slot-used'}"></span>`).join('')}</span>`;
                    }
                    let spellsHtml = '';
                    if (spellList) {
                        spellsHtml = `<div class="rt-spell-list">${spellList.split(',').map(s => {
                            const name = s.trim();
                            const slug = name.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-');
                            return `<a href="https://dnd5e.wikidot.com/spell:${slug}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtmlWithColor(name)}</a>`;
                        }).join('')}</div>`;
                    }
                    return `<div class="rt-spell-row"><span class="rt-spell-level">${escapeHtmlWithColor(lbl.trim())}</span><div class="rt-spell-inline-group">${pipsHtml}${spellsHtml}</div></div>`;
                };

                for (let i = 0; i < lines.length; i++) {
                    const rawLine = lines[i];
                    const mm = rawLine.match(MARKER_RX);
                    const explicitType = mm ? MARKER_TYPE_MAP[mm[1].toUpperCase()] : null;
                    const line = mm ? mm[2].trim() : rawLine;

                    // 1. Combat Round header
                    if (tag === 'COMBAT' && /Combat Round\s*\d+/i.test(line)) {
                        results.push(`<div class="rt-combat-round">${escapeHtmlWithColor(line)}</div>`);
                        lastEntityIdx = -1;
                        continue;
                    }

                    // 2. Entity anchor: classic "Name: X/Y HP ..." — fires with no marker OR BAR/HPBAR
                    const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP\s*[:|,]?\s*(.*)$/i);
                    if (hpMatch && (explicitType === null || explicitType === 'hp_bar')) {
                        const [, name, curRaw, maxRaw, rest] = hpMatch;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = maxRaw ? Number(maxRaw.replace(/,/g, '')) : undefined;
                        const hasMax = max !== undefined;
                        const pct = hasMax ? Math.max(0, Math.min(100, (cur / max) * 100)) : 100;
                        const hpColor = !hasMax ? '#00ffaa' : pct > 60 ? '#00ffaa' : pct > 30 ? '#ffaa00' : '#ff5555';
                        const status = rest.trim().replace(/^\|\s*/, '');
                        const label = hasMax ? `${curRaw}/${maxRaw}` : `${curRaw}`;

                        lastEntityIdx = results.length;
                        results.push(`<div class="rt-entity-row"><div class="rt-entity-name">${escapeHtmlWithColor(name.trim())}</div><div class="rt-hp-bar-wrap" title="${label} HP"><div class="rt-hp-bar" style="width:${pct.toFixed(1)}%;background:${hpColor};"></div></div><span class="rt-hp-label">${label}</span></div>`);

                        if (status) {
                            const parts = status.split('|').map(p => p.trim()).filter(Boolean);
                            let genericInfo = [];
                            for (const part of parts) {
                                if (part.toLowerCase().startsWith('ac:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">AC:</span> ${escapeHtmlWithColor(part.substring(3).trim())}</div>`;
                                } else if (part.toLowerCase().startsWith('saves:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Saves:</span> ${highlightParens(escapeHtmlWithColor(part.substring(6).trim()))}</div>`;
                                } else if (part.toLowerCase().startsWith('status:')) {
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Status:</span> ${renderPills(part.substring(7).trim())}</div>`;
                                } else if (part.toLowerCase().startsWith('other:') || part.toLowerCase().startsWith('res:')) {
                                    const lbl = part.toLowerCase().startsWith('res:') ? 'Res:' : 'Other:';
                                    const start = part.toLowerCase().startsWith('res:') ? 4 : 6;
                                    results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">${lbl}</span> ${renderPills(part.substring(start).trim())}</div>`;
                                } else { genericInfo.push(part); }
                            }
                            if (genericInfo.length > 0) {
                                results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Info:</span> ${highlightParens(escapeHtmlWithColor(genericInfo.join(' | ')))}</div>`;
                            }
                        }
                        continue;
                    }

                    // 3. Explicit ((TYPE)) marker — attach to entity or push standalone
                    if (explicitType) {
                        const rendered = renderSubFieldByRule({ renderType: explicitType }, line);
                        if (lastEntityIdx !== -1) { results[lastEntityIdx] += rendered; }
                        else { results.push(rendered); }
                        continue;
                    }

                    // 4. Keyword-based sub-lines (backward compat)
                    if (lastEntityIdx !== -1) {
                        const ll = line.toLowerCase();
                        if (ll.startsWith('attr:') || ll.startsWith('attributes:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-entity-attributes"><span class="rt-entity-sub-label">Attr:</span> ${escapeHtmlWithColor(line.substring(line.indexOf(':') + 1).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('skills:') || ll.startsWith('key skills:')) {
                            const sm = line.match(/^(?:key\s+)?skills:\s*(.+)$/i);
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Skills:</span> ${escapeHtmlWithColor(sm ? sm[1].trim() : line.split(':')[1]?.trim() || '')}</div>`;
                            continue;
                        }
                        if (ll.startsWith('saves:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Saves:</span> ${highlightParens(escapeHtmlWithColor(line.substring(6).trim()))}</div>`;
                            continue;
                        }
                        if (ll.startsWith('status:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Status:</span> ${renderPills(line.substring(7).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('primary weapon:') || ll.startsWith('att/def:')) {
                            const lbl = ll.startsWith('att/def:') ? 'Att/Def:' : 'Weapon:';
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">${lbl}</span> ${highlightParens(escapeHtmlWithColor(line.substring(line.indexOf(':') + 1).trim()))}</div>`;
                            continue;
                        }
                        if (ll.startsWith('hd:')) {
                            let hdText = line.substring(3).trim();
                            let pipsHtml = escapeHtmlWithColor(hdText);
                            const hm = hdText.match(/^([^(]+?)\s*(?:\(([\d,]+)\/([\d,]+)\))?$/);
                            if (hm && hm[2] && hm[3]) {
                                const cur = parseInt(hm[2].replace(/,/g, ''), 10);
                                const max = parseInt(hm[3].replace(/,/g, ''), 10);
                                pipsHtml = `<span class="rt-hd-label">[ ${escapeHtmlWithColor(hm[1].trim())} ]</span> <span class="rt-hd-pips">${Array.from({ length: max }, (_, i) => `<span class="rt-hd-pip${i < cur ? ' rt-hd-available' : ''}"></span>`).join('')}</span>`;
                            }
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">HD:</span> <span>${pipsHtml}</span></div>`;
                            continue;
                        }
                        if (ll.startsWith('traits:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Traits:</span> ${renderPills(line.substring(7).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('other:') || ll.startsWith('resistances:')) {
                            results[lastEntityIdx] += `<div class="rt-entity-sub-line rt-units-container"><span class="rt-entity-sub-label">Other:</span> ${renderPills(line.substring(line.indexOf(':') + 1).trim())}</div>`;
                            continue;
                        }
                        if (ll.startsWith('spells:')) {
                            const spellLine = line.substring(7).trim();
                            const isCompound = /\|/.test(spellLine) && /(?:Level\s*\d+|Cantrips?)/i.test(spellLine);
                            const groups = isCompound ? spellLine.split(/\s*\|\s*/) : [spellLine];
                            let renderedAny = false;
                            for (const group of groups) {
                                const rowHtml = renderSpellGroup(group);
                                if (rowHtml) { results[lastEntityIdx] += rowHtml; renderedAny = true; }
                            }
                            if (!renderedAny) { results[lastEntityIdx] += `<div class="rt-entity-sub-line"><span class="rt-entity-sub-label">Spells:</span> ${highlightParens(escapeHtmlWithColor(spellLine))}</div>`; }
                            continue;
                        }
                    }

                    // 5. Fallback: plain card line, resets entity context
                    results.push(`<div class="rt-card-line">${escapeHtmlWithColor(rawLine)}</div>`);
                    lastEntityIdx = -1;
                }
                return results;
            }
            case 'TIME': {
                let currentTotalMins = 0;
                let parsedCurrent = false;

                const parseTimeStr = (str) => {
                    let d = 0, h = 0, m = 0;
                    const dayMatch = str.match(/(?:Day|D)\s*(\d+)/i);
                    if (dayMatch) d = parseInt(dayMatch[1], 10);
                    const timeMatch = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
                    if (timeMatch) {
                        let tmph = parseInt(timeMatch[1], 10);
                        m = parseInt(timeMatch[2], 10);
                        if (timeMatch[3]) {
                            const ampm = timeMatch[3].toUpperCase();
                            if (ampm === 'PM' && tmph < 12) tmph += 12;
                            if (ampm === 'AM' && tmph === 12) tmph = 0;
                        }
                        h = tmph;
                    }
                    if (!dayMatch && !timeMatch) return null;
                    return (d * 24 * 60) + (h * 60) + m;
                };

                for (let line of lines) {
                    if (line.toLowerCase().startsWith('last rest:')) continue;
                    if (!parsedCurrent) {
                        const t = parseTimeStr(line);
                        if (t !== null) {
                            currentTotalMins = t;
                            parsedCurrent = true;
                        }
                    }
                }

                    return lines.map(line => {
                        if (line.toLowerCase().startsWith('last rest:')) {
                            const restVal = line.substring(line.indexOf(':') + 1).trim();
                            let append = "";
                            if (parsedCurrent) {
                                const restMins = parseTimeStr(restVal);
                                if (restMins !== null) {
                                    const diff = currentTotalMins - restMins;
                                    if (diff >= 0) {
                                        const dH = Math.floor(diff / 60);
                                        const dM = diff % 60;
                                        append = ` <i style="opacity: 0.7; font-size: 0.9em;">(${dH > 0 ? dH + ' hours ' : ''}${dM > 0 ? dM + ' minutes ' : ''}ago)</i>`;
                                        if (diff === 0) append = ` <i style="opacity: 0.7; font-size: 0.9em;">(just now)</i>`;
                                        if (dH >= 24) {
                                            const dDays = Math.floor(dH / 24);
                                            const dRemH = dH % 24;
                                            append = ` <i style="opacity: 0.7; font-size: 0.9em;">(${dDays} days ${dRemH > 0 ? dRemH + ' hours ' : ''}ago)</i>`;
                                        }
                                    }
                                }
                            }
                            return `<div class="rt-card-line"><b>Last Rest:</b> ${escapeHtmlWithColor(restVal)}${append}</div>`;
                        }
                        const asMarker = tryRenderMarker(line);
                        if (asMarker !== null) return asMarker;
                        return `<div class="rt-card-line">${escapeHtmlWithColor(line)}</div>`;
                    });
            }
            case 'XP':
                return lines.map(line => {
                    const asMarker = tryRenderMarker(line);
                    if (asMarker !== null) return asMarker;

                    // New format: Total: 1,200 / 2,700 XP (Level 3)
                    let m = line.match(/Total:\s*([\d,]+)\s*\/\s*([\d,]+)\s*XP\s*\(Level\s*(\d+)\)/i);
                    if (m) {
                        const [, curRaw, maxRaw, level] = m;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = Number(maxRaw.replace(/,/g, ''));
                        const pct = Math.max(0, Math.min(100, (cur / max) * 100));
                        return `<div class="rt-xp-row">
                            <div class="rt-xp-label"><span>Level ${level}</span><span>XP: ${curRaw} / ${maxRaw}</span></div>
                            <div class="rt-xp-bar-wrap">
                                <div class="rt-xp-bar" style="width:${pct.toFixed(1)}%;"></div>
                            </div>
                        </div>`;
                    }

                    // Legacy format: XP: 1,200/2,700 or Level: 3 | XP: 1,200/2,700
                    m = line.match(/(?:Level:\s*(\d+)\s*\|?\s*)?XP:\s*([\d,]+)\/([\d,]+)/i);
                    if (m) {
                        const [, level, curRaw, maxRaw] = m;
                        const cur = Number(curRaw.replace(/,/g, ''));
                        const max = Number(maxRaw.replace(/,/g, ''));
                        const pct = Math.max(0, Math.min(100, (cur / max) * 100));
                        const levelHtml = level ? `<span>Level ${level}</span>` : '';
                        return `<div class="rt-xp-row">
                            <div class="rt-xp-label">${levelHtml}<span>XP: ${curRaw} / ${maxRaw}</span></div>
                            <div class="rt-xp-bar-wrap">
                                <div class="rt-xp-bar" style="width:${pct.toFixed(1)}%;"></div>
                            </div>
                        </div>`;
                    }

                    return `<div class="rt-card-line">${escapeHtmlWithColor(line)}</div>`;
                });
            case 'SPELLS': {
                // Lines: "Level N (avail/max): Spell1, Spell2" or "Cantrips: Spell1, Spell2"
                return lines.map(line => {
                    const asMarker = tryRenderMarker(line);
                    if (asMarker !== null) return asMarker;

                    const m = line.match(/^(Level\s*\d+|Cantrips?)\s*(?:\((\d+)\/(\d+)[^)]*\))?\s*:\s*(.+)$/i);
                    if (!m) return `<div class="rt-card-line">${escapeHtmlWithColor(line)}</div>`;
                    const [, label, availStr, maxStr, spellList] = m;
                    const isCantrip = /cantrip/i.test(label);
                    let pipsHtml = '';
                    if (!isCantrip && availStr !== undefined && maxStr !== undefined) {
                        const avail = parseInt(availStr, 10), max = parseInt(maxStr, 10);
                        const pips = Array.from({ length: max }, (_, i) =>
                            `<span class="rt-slot-pip${i < avail ? ' rt-slot-available' : ' rt-slot-used'}"></span>`
                        ).join('');
                        pipsHtml = `<span class="rt-slot-pips">${pips}</span>`;
                    }
                    const spells = spellList.split(',').map(s => {
                        const name = s.trim();
                        const slug = name.toLowerCase()
                            .replace(/'/g, '')
                            .replace(/[^a-z0-9]+/g, '-');
                        const url = `https://dnd5e.wikidot.com/spell:${slug}`;
                        return `<a href="${url}" target="_blank" class="rt-spell-name" title="View spell on Wikidot">${escapeHtmlWithColor(name)}</a>`;
                    }).join('');
                    return `<div class="rt-spell-row">
                        <span class="rt-spell-level">${escapeHtmlWithColor(label.trim())}</span>
                        <div class="rt-spell-inline-group">${pipsHtml}<div class="rt-spell-list">${spells}</div></div>
                    </div>`;
                });
            }
            case 'INVENTORY': {
                // Lines with a ((MARKER)) prefix bypass the bullet-list renderer
                const inventoryResults = [];
                const pendingBullets = [];

                const flushBullets = () => {
                    if (!pendingBullets.length) return;
                    pendingBullets.forEach(i => inventoryResults.push(`<div class="rt-card-item">• ${escapeHtmlWithColor(i)}</div>`));
                    pendingBullets.length = 0;
                };

                for (const line of lines) {
                    const asMarker = tryRenderMarker(line);
                    if (asMarker !== null) {
                        flushBullets();
                        inventoryResults.push(asMarker);
                        continue;
                    }
                    // Original bullet/comma logic
                    if (line.trim().match(/^[-*]\s+/)) {
                        pendingBullets.push(line.trim().replace(/^[-*]\s*/, ''));
                    } else {
                        line.split(/,(?![^(]*\))/).map(i => i.trim()).filter(Boolean)
                            .forEach(i => pendingBullets.push(i));
                    }
                }
                flushBullets();
                return inventoryResults;
            }
            case 'ABILITIES': {
                const abilityResults = [];
                for (const line of lines) {
                    const asMarker = tryRenderMarker(line);
                    if (asMarker !== null) { abilityResults.push(asMarker); continue; }
                    const l = line.trim();
                    const items = l.match(/^[-*]\s+/) ? [l.replace(/^[-*]\s*/, '')] : splitSmart(l);
                    items.forEach(t => abilityResults.push(renderPills(t)));
                }
                return abilityResults;
            }
            default:
                // Custom blocks: resolve each line via module rows → global rules → kv fallback
                // Pass line index so positional row matching works even without label prefixes
                return lines.map((line, idx) => renderCustomBlockLine(tag, line, idx));
        }
    }

    function renderMemoAsCards(memo) {
        if (!memo || !memo.trim()) {
            return `<div class="rt-empty" style="text-align: left; align-items: flex-start; padding: 12px; gap: 10px; overflow-y: auto;">
                <div style="text-align: center; width: 100%; margin-bottom: 4px; flex-shrink: 0;">
                    <div class="rt-empty-icon">📜</div>
                    <div style="font-size: 17px; font-weight: bold; color: var(--rt-text);">Fatbody D&D Framework</div>
                </div>

                <div style="font-size: 13px; opacity: 0.9; margin-top: 4px; flex-shrink: 0; line-height: 1.4;">
                    <b style="color: var(--rt-accent); font-size: 14px;">Initial Setup:</b><br><br>
                    1. Use the archetype buttons below to roll a new character, paste an existing sheet into the "Raw View", or <b>manually describe a character</b> by clicking 💬 and asking the tracker to create one for you (e.g., "Create a level 5 Orc Paladin").<br><br>
                    2. Create a character card for your "narrator", such as Simulation Engine or Game Master.<br><br>
                    3. Finally, copy <code>sysprompt.txt</code> (or from the SYSPROMPT button) into your Quick Prompts "Main" box.<br><br>
                    <span style="color: #ffaa00;"><b>NOTE:</b> When you update Fatbody D&D Framework, make sure you copy SYSPROMPT from the bottom right again and also reset the prompts in the extension settings. The system prompt is often also updated.</span>
                </div>
                <div style="display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; margin: 8px 0 4px 0; flex-shrink: 0;">
                    <span style="font-size: 12px; opacity: 0.8; font-weight: bold; font-style: italic;">Starting Level:</span>
                    <select id="rt-starting-level" class="text_pole" style="width: auto; min-width: 60px; padding: 2px 4px; font-size: 12px; height: 24px; border-radius: 4px; background: var(--black70a);">
                        ${[...Array(20).keys()].map(i => `<option value="${i + 1}">Level ${i + 1}</option>`).join('')}
                    </select>
                </div>
                <div class="rt-onboarding-buttons" style="width: 100%; justify-content: center; margin: 4px 0; flex-shrink: 0;">
                    <button class="rt-random-char-btn" data-archetype="magic">✨ Magic</button>
                    <button class="rt-random-char-btn" data-archetype="melee">⚔️ Melee</button>
                    <button class="rt-random-char-btn" data-archetype="rogue">🗡️ Rogue</button>
                </div>

                <div style="font-size: 13px; opacity: 0.9; display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; line-height: 1.4;">
                    <div><b style="color: var(--rt-accent);">Auto-Tracking:</b> As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, running background passes to update the state.</div>

                    <div><b style="color: var(--rt-accent);">Prompt Injection:</b> The State Memo and RNG Queue are injected seamlessly into your outgoing prompt. It acts as the "source of truth," assuring the model accurately remembers HP, inventory, and mechanical outcomes.</div>

                    <div><b style="color: var(--rt-accent);">Validation:</b> Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state.</div>
                </div>
            </div>`;
        }

        const blocks = parseMemoBlocks(memo);
        if (Object.keys(blocks).length === 0) {
            return `<div class="rt-empty">No structured blocks found.<br><small>Switch to Raw view to inspect the memo.</small></div>`;
        }

        const s = getSettings();
        const order = s.blockOrder || BLOCK_ORDER;
        const sorted = [
            ...order.filter(k => blocks[k] !== undefined),
            ...Object.keys(blocks).filter(k => !order.includes(k)).sort()
        ];

        const collapsed = loadCollapsed();
        const detached = loadDetached();

        // If filtering by a single tag (detached window context)
        const tagsToRender = arguments[1] ? [arguments[1]] : sorted;

        return tagsToRender.map(tag => {
            const content = blocks[tag];
            if (content === undefined && arguments[1]) {
                return `<div class="rt-empty">Waiting for ${tag} data...</div>`;
            }
            if (content === undefined) return '';

            // If main panel context, filter out detached windows
            if (!arguments[1] && detached.has(tag)) {
                return `<div class="rt-detached-placeholder" data-tag="${tag}">
                    <span class="rt-placeholder-icon">⧉</span> ${tag} is detached
                    <button class="rt-reattach-btn-inline" data-tag="${tag}" title="Re-attach">↓</button>
                </div>`;
            }

            const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
            const icon = customField?.icon || BLOCK_ICONS[tag] || '📄';
            const displayName = customField?.label || tag;
            const items = blockToItems(tag, content);
            const isCollapsed = collapsed.has(tag);

            const renderType = customField?.renderType || tag;
            const isFullView = getSettings().fullViewSections.includes(tag) || NO_PAGINATE.has(renderType);
            const localPageSize = getPageSize(renderType);

            const page = isFullView ? 0 : (_sectionPages[tag] ?? 0);
            const totalPages = isFullView ? 1 : Math.ceil(items.length / localPageSize);
            const safePage = Math.min(page, Math.max(0, totalPages - 1));
            if (!isFullView) _sectionPages[tag] = safePage;

            const pageItems = isFullView ? items : items.slice(safePage * localPageSize, (safePage + 1) * localPageSize);
            const bodyClass = `rt-section-body${renderType === 'ABILITIES' ? ' rt-abilities-body' : ''}`;

            const pagination = totalPages > 1 ? `
                <div class="rt-pagination">
                    <button class="rt-page-btn" data-tag="${tag}" data-dir="-1"${safePage === 0 ? ' disabled' : ''}>&#8249;</button>
                    <span>${safePage + 1}&thinsp;/&thinsp;${totalPages}</span>
                    <button class="rt-page-btn" data-tag="${tag}" data-dir="1"${safePage >= totalPages - 1 ? ' disabled' : ''}>&#8250;</button>
                </div>` : '';

            // Don't show detach button if already in detached context (filterTag provided)
            const detachBtn = !arguments[1] ? `
                <button class="rt-detach-btn" data-tag="${tag}" title="Detach panel">
                    ⧉
                </button>
            ` : '';

            const fullViewBtn = NO_PAGINATE.has(renderType) ? '' : `
                <button class="rt-fullview-btn${isFullView ? ' active' : ''}" data-tag="${tag}" title="${isFullView ? 'Switch to Paged View' : 'Switch to Full List'}">
                    ${isFullView ? '📜' : '📑'}
                </button>
            `;

            return `<div class="rt-section-card${isCollapsed ? ' rt-collapsed' : ''}" data-tag="${tag}">
                <div class="rt-section-header" data-tag="${tag}">
                    <span>${icon} ${displayName}</span>
                    <div class="rt-section-header-right">
                        ${detachBtn}
                        ${fullViewBtn}
                        <span class="rt-item-count">${items.length} ${items.length === 1 ? 'entry' : 'entries'}</span>
                        <span class="rt-collapse-icon">${isCollapsed ? '&#9656;' : '&#9662;'}</span>
                    </div>
                </div>
                <div class="${bodyClass}">${pageItems.join('')}${pagination}</div>
            </div>`;
        }).join('');
    }

    function bindRenderedCardEvents(el, memo, isDetachedContext = false, onRefresh = null) {
        const refresh = onRefresh || refreshRenderedView;
        el.querySelectorAll('.rt-random-char-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const archetype = btn.dataset.archetype;
                const level = el.querySelector('#rt-starting-level')?.value || 1;
                const labels = { magic: '✨ Casting...', melee: '⚔️ Training...', rogue: '🗡️ Sneaking...' };
                const prompts = {
                    magic: `Generate a random Level ${level} D&D Magic User (Wizard, Sorcerer, or Warlock). Output [CHARACTER], [SPELLS], [INVENTORY], and [ABILITIES] blocks. Include appropriate spells (using 'Cantrips:' for level 0 spells), items, and attributes consistent with Level ${level}.`,
                    melee: `Generate a random Level ${level} D&D Melee Fighter (Fighter, Barbarian, or Paladin). Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks. Focus on high physical attributes, heavy armor, and signature weapons consistent with Level ${level}.`,
                    rogue: `Generate a random Level ${level} D&D Rogue or Thief-style character. Output [CHARACTER], [INVENTORY], and [ABILITIES] blocks. Focus on high Dexterity, stealth-related equipment (thieves' tools, daggers), and class features like Sneak Attack consistent with Level ${level}.`
                };

                el.querySelectorAll('.rt-random-char-btn').forEach(b => b.disabled = true);
                btn.textContent = labels[archetype] || '🎲 Rolling...';
                await sendDirectPrompt(prompts[archetype]);
            });
        });

        el.querySelectorAll('.rt-section-header').forEach(header => {
            // Unbind to prevent duplicate listeners
            const oldHeader = header;
            const newHeader = oldHeader.cloneNode(true);
            oldHeader.parentNode.replaceChild(newHeader, oldHeader);

            newHeader.addEventListener('click', (e) => {
                // Prevent toggle if clicking on a button
                if (e.target.closest('button')) return;
                const tag = newHeader.dataset.tag;
                if (!tag) return;
                const col = loadCollapsed();
                if (col.has(tag)) col.delete(tag); else col.add(tag);
                saveCollapsed(col);
                refresh();
            });
        });

        el.querySelectorAll('.rt-page-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tag = btn.dataset.tag;
                const dir = parseInt(btn.dataset.dir);
                if (!tag) return;
                const curBlocks = parseMemoBlocks(memo);
                const items = blockToItems(tag, curBlocks[tag] ?? '');

                const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
                const renderType = customField?.renderType || tag;
                const localPageSize = getPageSize(renderType);

                const totalPages = Math.ceil(items.length / localPageSize);
                const cur = _sectionPages[tag] ?? 0;
                _sectionPages[tag] = Math.max(0, Math.min(totalPages - 1, cur + dir));
                refresh();
            });
        });

        el.querySelectorAll('.rt-fullview-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tag = btn.dataset.tag;
                if (!tag) return;
                const s = getSettings();
                const idx = s.fullViewSections.indexOf(tag);
                if (idx === -1) s.fullViewSections.push(tag);
                else s.fullViewSections.splice(idx, 1);
                SillyTavern.getContext().saveSettingsDebounced();
                refresh();
            });
        });

        if (!isDetachedContext) {
            el.querySelectorAll('.rt-detach-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tag = btn.dataset.tag;
                    if (!tag) return;
                    const detached = loadDetached();
                    detached.add(tag);
                    saveDetached(detached);
                    createDetachedPanel(tag);
                    refresh();
                });
            });

            el.querySelectorAll('.rt-reattach-btn-inline').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tag = btn.dataset.tag;
                    if (!tag) return;
                    const detached = loadDetached();
                    detached.delete(tag);
                    saveDetached(detached);
                    const panel = document.getElementById(`rt-detached-panel-${tag}`);
                    if (panel) panel.remove();
                    refresh();
                });
            });
        }

        // Add toggle behavior for Unit Pills (Traits/Abilities)
        el.querySelectorAll('.rt-unit-pill').forEach(unit => {
            unit.addEventListener('click', (e) => {
                e.stopPropagation();
                // Toggle active class to show/hide description
                const wasActive = unit.classList.contains('active');
                // Close others first for a clean experience
                el.querySelectorAll('.rt-unit-pill.active').forEach(u => u.classList.remove('active'));
                if (!wasActive) unit.classList.add('active');
            });
        });

        // Global deselect when clicking anything else
        const deselectHandler = (e) => {
            if (!e.target.closest('.rt-unit-pill')) {
                el.querySelectorAll('.rt-unit-pill.active').forEach(u => u.classList.remove('active'));
            }
        };
        // Use capture phase or just a standard listener on the panel/document
        // Adding it to document is most reliable for "any empty space"
        document.addEventListener('click', deselectHandler);
        // Note: We might want to clean this up later in an unmount/cleanup phase if ST supports it,
        // but for now this is standard ST extension behavior.
    }

    function refreshRenderedView() {
        if (!_renderedViewActive) return;
        const s = getSettings();
        const memo = _historyViewIndex === -1
            ? s.currentMemo
            : (s.memoHistory[_historyViewIndex] ?? '');
        const el = document.getElementById('rpg-tracker-render');
        if (el) {
            el.innerHTML = renderMemoAsCards(memo);
            bindRenderedCardEvents(el, memo, false);
        }

        // Update any detached panels
        const detached = loadDetached();
        detached.forEach(tag => {
            const panel = document.getElementById(`rt-detached-panel-${tag}`);
            if (panel) {
                const body = panel.querySelector('.rpg-tracker-detached-body');
                if (body) {
                    body.innerHTML = renderMemoAsCards(memo, tag);
                    bindRenderedCardEvents(body, memo, true);
                }
            } else {
                // Panel missing, recreate it
                createDetachedPanel(tag);
            }
        });
    }

    function createDetachedPanel(tag) {
        if (document.getElementById(`rt-detached-panel-${tag}`)) return;

        const customField = (getSettings().customFields || []).find(f => f.tag.toUpperCase() === tag);
        const icon = customField?.icon || BLOCK_ICONS[tag] || '📄';
        const displayName = customField?.label || tag;

        const settings = getSettings();
        const panel = document.createElement('div');
        panel.id = `rt-detached-panel-${tag}`;
        panel.className = `rpg-tracker-panel rpg-tracker-detached-panel ${settings.trackerTheme || 'rt-theme-native'}`;
        panel.innerHTML = `
            <div class="rpg-tracker-header rt-detached-header">
                <div class="rpg-tracker-header-left">
                    <span>${icon} ${displayName}</span>
                </div>
                <div class="rpg-tracker-header-right">
                    <button class="rpg-tracker-icon-btn rt-reattach-btn" data-tag="${tag}" title="Re-attach">✕</button>
                </div>
            </div>
            <div class="rpg-tracker-content rpg-tracker-detached-body">
                <!-- Content injected here via refreshRenderedView() -->
            </div>
        `;

        document.body.appendChild(panel);

        const header = panel.querySelector('.rt-detached-header');
        if (header instanceof HTMLElement) {
            makeDraggable(panel, header, `rpg_tracker_geometry_${tag}`);
        }

        // Setup specialized geometry keys
        const geoKey = `rpg_tracker_geometry_${tag}`;

        try {
            const saved = JSON.parse(localStorage.getItem(geoKey));
            if (saved && saved.left !== undefined) {
                // Sanitize coordinates
                const left = Math.max(0, Math.min(window.innerWidth - 50, saved.left));
                const top = Math.max(0, Math.min(window.innerHeight - 50, saved.top));

                panel.style.left = left + 'px'; panel.style.right = 'auto';
                panel.style.top = top + 'px'; panel.style.bottom = 'auto';
                if (saved.width) panel.style.width = saved.width + 'px';
                if (saved.height) panel.style.height = saved.height + 'px';
            } else {
                const mainPanel = document.getElementById('rpg-tracker-panel');
                if (mainPanel) {
                    const rect = mainPanel.getBoundingClientRect();
                    // spawn adjacent to the main panel if no stored position
                    let spawnLeft = rect.left - 270;
                    if (spawnLeft < 0) spawnLeft = rect.right + 10;
                    panel.style.left = Math.max(10, spawnLeft) + 'px';
                    panel.style.top = rect.top + 'px';
                    panel.style.right = 'auto';
                    panel.style.bottom = 'auto';
                }
            }
        } catch { /* ignore */ }

        // Debounced save geometry
        let _resizeTimer;
        const ro = new ResizeObserver(() => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => {
                const rect = panel.getBoundingClientRect();
                localStorage.setItem(geoKey, JSON.stringify({
                    left: rect.left, top: rect.top,
                    width: rect.width, height: rect.height
                }));
            }, 300);
        });
        ro.observe(panel);

        panel.querySelector('.rt-reattach-btn').addEventListener('click', () => {
            const detached = loadDetached();
            detached.delete(tag);
            saveDetached(detached);
            panel.remove();
            refreshRenderedView();
        });

        // Trigger an initial render to fill its body
        refreshRenderedView();
    }





    /**
     * UI Implementation
     */
    function createPanel() {
        const settings = getSettings();

        const panel = document.createElement('div');
        panel.id = 'rpg-tracker-panel';
        panel.className = `rpg-tracker-panel ${settings.trackerTheme || 'rt-theme-native'}`;
        panel.style.setProperty('--rt-base-size', (settings.fontSize || 13) + 'px');
        panel.innerHTML = `
            <div class="rt-resizer-tr" id="rt-resizer-tr" title="Resize from top-right"></div>
            <div class="rpg-tracker-header" id="rpg-tracker-header">
                <div class="rpg-tracker-header-left">
                    <span>Fatbody D&D Framework</span>
                    <div class="rpg-tracker-status-indicator active" id="rpg-tracker-status"></div>
                    <button class="rpg-tracker-stop-btn" id="rpg-tracker-stop-btn" title="Stop Generation" style="display:none;">■</button>
                </div>
                <div class="rpg-tracker-header-right">
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-update-btn" title="Update State Now">🔄</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-pause-btn" title="Pause Tracker">⏸</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-prompt-btn" title="Toggle direct prompt">💬</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-view-btn" title="Toggle rendered view">⊞</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-delta-btn" title="Toggle change log">δ</button>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-close-btn" title="Hide panel">✕</button>
                </div>
            </div>
            <div class="rpg-tracker-content">
                <textarea class="rpg-tracker-memo-area" id="rpg-tracker-memo">${settings.currentMemo}</textarea>
                <div class="rpg-tracker-render-view" id="rpg-tracker-render" style="display:none;"></div>
            </div>
            <div class="rpg-tracker-delta-resize-handle" id="rpg-tracker-delta-handle" style="display:none;"></div>
            <div class="rpg-tracker-delta-panel" id="rpg-tracker-delta" style="display:none;">
                <div class="rpg-tracker-delta-toolbar">
                    <span class="rpg-tracker-delta-title">Change Log</span>
                    <button class="rpg-tracker-icon-btn" id="rpg-tracker-delta-clear" title="Clear log">✕</button>
                </div>
                <div id="rpg-tracker-delta-content">${settings.lastDelta || '<span class="delta-empty">No changes yet.</span>'}</div>
            </div>
            <div class="rpg-tracker-prompt-bar" id="rpg-tracker-prompt-bar" style="display:none;">
                <textarea class="rpg-tracker-prompt-input" id="rpg-tracker-prompt-input" rows="2" placeholder="Instruct the tracker model… (Enter to send, Shift+Enter for newline)"></textarea>
                <div style="display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: flex-end;">
                    <div class="rt-prompt-ctx-control" style="font-size: 9px; display: flex; flex-direction: column; align-items: center; gap: 0;" title="Context: number of recent messages to include">
                        <input type="number" id="rt-prompt-context-val" value="${settings.directPromptContext || 5}" min="0" max="50" style="width: 28px; height: 16px; font-size: 9px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: white; border-radius: 3px; text-align: center; padding: 0;">
                        <span style="opacity: 0.5; font-size: 8px; line-height: 1;">msg</span>
                    </div>
                    <button class="rpg-tracker-prompt-send" id="rpg-tracker-prompt-send" title="Send instruction">▶</button>
                </div>
            </div>
            <div class="rpg-tracker-footer" id="rt-main-footer">
                <div class="rt-mobile-top-row">
                    <button class="rt-footer-toggle-btn" id="rt-footer-expand-btn" title="Toggle Settings Drawer"><i class="fa-solid fa-chevron-up"></i></button>
                    <div class="rpg-tracker-nav">
                        <button class="rpg-tracker-nav-btn" id="rpg-tracker-nav-back" title="View previous snapshot">←</button>
                        <span class="rpg-tracker-nav-label" id="rpg-tracker-nav-label">Live</span>
                        <button class="rpg-tracker-nav-btn" id="rpg-tracker-nav-fwd" title="View next snapshot">→</button>
                    </div>
                </div>
                <div class="flex-container gap-1 alignitemscenter rt-rng-footer-group">
                    <button id="rt-rng-toggle-overlay" class="rt-rng-toggle-overlay" title="Toggle RNG Queue Injection">
                        <i class="fa-solid fa-dice"></i> <span class="rt-rng-label-text">RNG Queue: </span><span id="rt-rng-status-text" class="rt-rng-status-text">OFF</span>
                    </button>
                    <button id="rt-dice-tool-toggle" class="rt-rng-toggle-overlay" title="Toggle Tool Call RNG">
                        <i class="fa-solid fa-robot"></i> <span class="rt-rng-label-text">Tool Call RNG: </span><span id="rt-dice-tool-status-text" class="rt-rng-status-text">OFF</span>
                    </button>
                </div>
                <div class="flex-container gap-1 alignitemscenter rt-utility-footer-group">
                    <span id="rpg-tracker-count">~${Math.round(settings.currentMemo.length / 2.62)} tokens</span>
                    <button class="rpg-tracker-nav-btn" id="rpg-tracker-memo-clear" style="padding: 1px 5px; font-size: 9px; opacity: 0.8; margin-left: 5px;" title="Clear memo and history">CLEAR</button>
                    <div style="position: relative; display: flex; align-items: center;">
                        <div id="rt-sysprompt-menu" class="rt-sysprompt-menu" style="display: none;">
                            <button class="rt-sysprompt-opt" data-file="sysprompt.txt"><b>v1.4.0</b> (Tool Call + Queue)</button>
                            <button class="rt-sysprompt-opt" data-file="sysprompt_legacy.txt"><b>v1.3.x</b> (Queue Only)</button>
                        </div>
                        <button class="rpg-tracker-nav-btn" id="rt-copy-sysprompt" style="padding: 1px 5px; font-size: 9px; opacity: 0.8; margin-left: 5px;" title="Copy Narrator System Prompt">SYSPROMPT</button>
                    </div>
                    <button id="rt-rng-help-btn" class="rt-rng-toggle-overlay" style="min-width: 20px; justify-content: center; padding: 2px 4px; margin-left: auto;" title="RNG Help">
                        <i class="fa-solid fa-question-circle"></i>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        const header = panel.querySelector('#rpg-tracker-header');
        if (header instanceof HTMLElement) {
            makeDraggable(/** @type {HTMLElement} */(panel), header);
        }
        setupResizeObserver(/** @type {HTMLElement} */(panel));
        loadPanelGeometry(/** @type {HTMLElement} */(panel));

        const resizerTR = panel.querySelector('#rt-resizer-tr');
        if (resizerTR instanceof HTMLElement) {
            makeResizableTR(/** @type {HTMLElement} */(panel), resizerTR);
        }

        const stopBtn = panel.querySelector('#rpg-tracker-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const { stopGeneration } = SillyTavern.getContext();
                if (stopGeneration) stopGeneration();
            });
        }

        const pauseBtn = panel.querySelector('#rpg-tracker-pause-btn');
        if (pauseBtn) {
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const s = getSettings();
                s.enabled = !s.enabled;
                SillyTavern.getContext().saveSettingsDebounced();

                // Update settings UI checkbox if it exists
                const cb = document.getElementById('rpg_tracker_enabled');
                if (cb instanceof HTMLInputElement) cb.checked = s.enabled;

                updatePanelStatus();
            });
        }

        updatePanelStatus();

        // Handle manual edits to live memo
        const textarea = panel.querySelector('#rpg-tracker-memo');
        let _rawEditDebounce = null;
        textarea.addEventListener('input', (e) => {
            if (_historyViewIndex !== -1) return;
            settings.currentMemo = /** @type {HTMLTextAreaElement} */ (e.target).value;
            panel.querySelector('#rpg-tracker-count').textContent = `~${Math.round(settings.currentMemo.length / 2.62)} tokens`;
            SillyTavern.getContext().saveSettingsDebounced();
            // Refresh the rendered view live so changes are visible without toggling modes
            clearTimeout(_rawEditDebounce);
            _rawEditDebounce = setTimeout(refreshRenderedView, 400);
        });

        // ── RNG & Dice Toggle Logic ──
        const rngBtn = panel.querySelector('#rt-rng-toggle-overlay');
        const diceToolBtn = panel.querySelector('#rt-dice-tool-toggle');

        const syncFooterToggles = () => {
            const s = getSettings();

            // Sync RNG Engine
            const rngText = panel.querySelector('#rt-rng-status-text');
            if (rngText) rngText.textContent = s.rngEnabled ? 'ON' : 'OFF';
            if (rngBtn) {
                if (s.rngEnabled) rngBtn.classList.add('active');
                else rngBtn.classList.remove('active');
            }
            const rngCb = document.getElementById('rpg_tracker_rng_enabled');
            if (rngCb) /** @type {HTMLInputElement} */ (rngCb).checked = s.rngEnabled;

            // Sync AI Dice Tool
            const diceText = panel.querySelector('#rt-dice-tool-status-text');
            if (diceText) diceText.textContent = s.diceFunctionTool ? 'ON' : 'OFF';
            if (diceToolBtn) {
                if (s.diceFunctionTool) diceToolBtn.classList.add('active');
                else diceToolBtn.classList.remove('active');
            }
            const diceCb = document.getElementById('rpg_tracker_dice_function_tool');
            if (diceCb) /** @type {HTMLInputElement} */ (diceCb).checked = s.diceFunctionTool;
        };

        if (rngBtn) {
            rngBtn.addEventListener('click', () => {
                const s = getSettings();
                s.rngEnabled = !s.rngEnabled;
                SillyTavern.getContext().saveSettingsDebounced();
                syncFooterToggles();
                toastr['info'](`RNG Queue ${s.rngEnabled ? 'Enabled' : 'Disabled'}.`, 'Fatbody Framework');
            });
        }

        if (diceToolBtn) {
            diceToolBtn.addEventListener('click', () => {
                const s = getSettings();
                s.diceFunctionTool = !s.diceFunctionTool;
                SillyTavern.getContext().saveSettingsDebounced();
                syncFooterToggles();
                registerDiceFunctionTool();
                toastr['info'](`Tool Call RNG ${s.diceFunctionTool ? 'Enabled' : 'Disabled'}.`, 'Fatbody Framework');
            });
        }

        const helpBtn = panel.querySelector('#rt-rng-help-btn');
        if (helpBtn) {
            helpBtn.addEventListener('click', () => {
                const { Popup } = SillyTavern.getContext();
                const content = `
                    <div style="text-align: left; line-height: 1.4; max-height: 70vh; overflow-y: auto; padding-right: 5px;">
                        <h4 style="margin-top: 0; color: var(--rt-accent);">RNG Queue (Combat)</h4>
                        <p>Generates a list of pre-rolled dice and injects them into the story context. This keeps combat fast and fluid because the AI doesn't need to stop for a tool call on every attack—it just uses the next roll in the queue.</p>
                        <p>Functions perfectly in combat because combat works on a "grid" determined by initiative, taking any opportunity of mechanical sycophancy away from the AI.</p>

                        <h4 style="color: var(--rt-accent);">Tool Call RNG (Narrative)</h4>
                        <p>A reactive tool call where the AI proactively asks to roll specific dice for a specific action (e.g., picking a lock). This prevents "cheating" by forcing the AI to commit to a difficulty (DC) before seeing the roll result.</p>
                        <p style="background: rgba(255, 165, 0, 0.1); border-left: 3px solid orange; padding: 10px; font-size: 11px; color: #eee; border-radius: 0 4px 4px 0;">
                            <b>NOTE:</b> "Enable function calling" <b>must</b> be enabled in SillyTavern's <b>AI Response Configuration</b> for tool calls to work.
                        </p>

                        <h4 style="color: var(--rt-accent);">System Prompt Selection</h4>
                        <p>Click the <b>SYSPROMPT</b> button in the bottom right of the UI to copy the appropriate system prompt for your chosen RNG/dice rolling method:</p>
                        <ul style="padding-left: 20px;">
                            <li style="margin-bottom: 8px;"><b>Tool Call + Queue</b>: The modern hybrid system. Mandatory for the Tool Call RNG toggle to function.</li>
                            <li><b>Queue Only</b>: The legacy behavior. Ideal if your model doesn't support tool calling or if you prefer the classic "always-in-context" RNG.</li>
                        </ul>
                    </div>
                `;
                Popup.show.confirm('RNG Systems Explained', content, { okButton: 'OK', cancelButton: false });
            });
        }

        syncFooterToggles();

        // View toggle (Raw ↔ Rendered)
        let _viewBtn = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-view-btn'));
        const ta = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-memo'));
        const rv = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-render'));

        if (settings.renderedViewActive !== undefined) {
            _renderedViewActive = settings.renderedViewActive;
        } else {
            _renderedViewActive = true;
            settings.renderedViewActive = true;
        }

        const applyViewState = () => {
            if (_renderedViewActive) {
                ta.style.display = 'none';
                rv.style.display = 'block';
                _viewBtn.textContent = '≡';
                _viewBtn.title = 'Switch to Raw view';
                refreshRenderedView();
            } else {
                ta.style.display = '';
                rv.style.display = 'none';
                _viewBtn.textContent = '⊞';
                _viewBtn.title = 'Switch to Rendered view';
            }
        };

        applyViewState();

        _viewBtn.addEventListener('click', () => {
            _renderedViewActive = !_renderedViewActive;
            settings.renderedViewActive = _renderedViewActive;
            SillyTavern.getContext().saveSettingsDebounced();
            applyViewState();
        });

        // Delta toggle — also shows/hides the resize handle
        panel.querySelector('#rpg-tracker-delta-btn').addEventListener('click', () => {
            const deltaEl = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta'));
            const handleEl = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta-handle'));
            const isVisible = deltaEl.style.display !== 'none';
            deltaEl.style.display = isVisible ? 'none' : 'flex';
            handleEl.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                const h = loadDeltaHeight();
                deltaEl.style.height = h + 'px';
            }
        });

        // Delta clear button
        panel.querySelector('#rpg-tracker-delta-clear').addEventListener('click', () => {
            settings.lastDelta = '';
            const dp = document.getElementById('rpg-tracker-delta-content');
            if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
            SillyTavern.getContext().saveSettingsDebounced();
        });

        // Delta resize handle drag
        setupDeltaResize(/** @type {HTMLElement} */(panel));

        // Close panel
        panel.querySelector('#rpg-tracker-close-btn').addEventListener('click', () => {
            panel.style.display = 'none';
            settings.closeCount = (settings.closeCount || 0) + 1;
            // Only show toast on the 1st close and every 10th close thereafter
            if (settings.closeCount === 1 || settings.closeCount % 10 === 0) {
                toastr['info']('Tracker hidden. You can reopen it at any time from the Extensions (Wand) Menu.', 'RPG Tracker');
            }
            SillyTavern.getContext().saveSettingsDebounced();
        });

        // Direct prompt toggle
        panel.querySelector('#rpg-tracker-prompt-btn').addEventListener('click', () => {
            const bar = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-prompt-bar'));
            const isVisible = bar.style.display !== 'none';
            bar.style.display = isVisible ? 'none' : 'flex';
            if (!isVisible) /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-prompt-input')).focus();
        });

        // Direct prompt send
        const promptSend = async () => {
            const input = /** @type {HTMLTextAreaElement} */ (panel.querySelector('#rpg-tracker-prompt-input'));
            const msg = input.value.trim();
            if (!msg) return;
            input.value = '';
            await sendDirectPrompt(msg);
        };
        panel.querySelector('#rpg-tracker-prompt-send').addEventListener('click', promptSend);
        panel.querySelector('#rpg-tracker-prompt-input').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); promptSend(); }
        });
        panel.querySelector('#rt-prompt-context-val').addEventListener('change', (e) => {
            settings.directPromptContext = parseInt(/** @type {HTMLInputElement} */(e.target).value) || 0;
            SillyTavern.getContext().saveSettingsDebounced();
        });

        // Manual update from panel button
        const manualUpdate = async (type = 'regular') => {
            const { chat, Popup } = SillyTavern.getContext();
            let narrative = "";
            let isFullAudit = false;
            let customLookbackN = null;

            if (type === 'regular') {
                narrative = getNarrativeBlocks(chat, -1);
            } else if (type === 'full') {
                isFullAudit = true;
            } else if (type === 'custom') {
                const count = await Popup.show.input("RPG Tracker", "How many messages back should I parse?", "5");
                if (!count || isNaN(parseInt(count))) return;
                customLookbackN = parseInt(count);
                narrative = getNarrativeBlocks(chat, customLookbackN);
            }

            if (type !== 'full' && !narrative) return toastr['info']("No assistant message to parse.", "RPG Tracker");

            toastr['info'](isFullAudit ? "Triggering Full Context Audit..." : "Triggering manual State Update...", "RPG Tracker");
            await runStateModelPass(narrative, isFullAudit, customLookbackN);
        };

        const updateBtn = panel.querySelector('#rpg-tracker-update-btn');
        const updateMenu = document.createElement('div');
        updateMenu.className = 'rt-update-menu';
        updateMenu.style.display = 'none';
        updateMenu.innerHTML = `
            <div class="rt-menu-item" id="rt-update-regular"><b>Regular Update</b><small>Since last user message</small></div>
            <div class="rt-menu-item" id="rt-update-custom"><b>Lookback Update</b><small>Last N messages</small></div>
            <div class="rt-menu-item" id="rt-update-full"><b>Full Context Audit</b><small>Re-examine whole history</small></div>
        `;
        panel.appendChild(updateMenu);

        updateBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = updateMenu.style.display !== 'none';

            // Close all other menus possibly
            document.querySelectorAll('.rt-update-menu').forEach(m => /** @type {HTMLElement} */(m).style.display = 'none');

            if (!isVisible) {
                const rect = updateBtn.getBoundingClientRect();
                const panelRect = panel.getBoundingClientRect();
                updateMenu.style.top = (rect.bottom - panelRect.top + 5) + 'px';
                updateMenu.style.right = (panelRect.right - rect.right) + 'px';
                updateMenu.style.display = 'flex';

                const closeMenu = () => {
                    updateMenu.style.display = 'none';
                    document.removeEventListener('click', closeMenu);
                };
                setTimeout(() => document.addEventListener('click', closeMenu), 10);
            }
        });

        updateMenu.querySelector('#rt-update-regular').addEventListener('click', () => manualUpdate('regular'));
        updateMenu.querySelector('#rt-update-custom').addEventListener('click', () => manualUpdate('custom'));
        updateMenu.querySelector('#rt-update-full').addEventListener('click', () => manualUpdate('full'));

        // Link the settings button too if it's already rendered
        // For settings button, we'll keep it simple or just trigger regular
        $('#rpg_tracker_btn_update').off('click').on('click', () => manualUpdate('regular'));

        // Snapshot navigation
        panel.querySelector('#rpg-tracker-nav-back').addEventListener('click', () => navigateSnapshot(1));
        panel.querySelector('#rpg-tracker-nav-fwd').addEventListener('click', () => navigateSnapshot(-1));

        // Footer Expand/Collapse (Mobile)
        panel.querySelector('#rt-footer-expand-btn').addEventListener('click', () => {
            const footer = document.getElementById('rt-main-footer');
            if (footer) {
                footer.classList.toggle('rt-footer-expanded');
                const icon = footer.querySelector('#rt-footer-expand-btn i');
                if (icon) {
                    if (footer.classList.contains('rt-footer-expanded')) {
                        icon.classList.replace('fa-chevron-up', 'fa-chevron-down');
                    } else {
                        icon.classList.replace('fa-chevron-down', 'fa-chevron-up');
                    }
                }
            }
        });

        // Restore via label click
        panel.querySelector('#rpg-tracker-nav-label').addEventListener('click', () => {
            const s = getSettings();
            if (_historyViewIndex === -1) return;
            const snapshot = s.memoHistory[_historyViewIndex];
            if (snapshot === undefined) return;

            // Restore: set currentMemo, trim history forward from this point (discarding the 'future' snapshots)
            s.memoHistory = s.memoHistory.slice(_historyViewIndex + 1);
            s.currentMemo = snapshot;
            _historyViewIndex = -1;
            SillyTavern.getContext().saveSettingsDebounced();
            syncMemoView();
        });

        // Clear memo button
        panel.querySelector('#rpg-tracker-memo-clear').addEventListener('click', () => {
            if (confirm("Are you sure you want to clear the memory history and wipe the tracker?")) {
                settings.currentMemo = "";
                settings.prevMemo1 = "";
                settings.prevMemo2 = "";
                settings.memoHistory = [];
                settings.lastDelta = "";
                _historyViewIndex = -1;
                SillyTavern.getContext().saveSettingsDebounced();
                syncMemoView();
                const dp = document.getElementById('rpg-tracker-delta-content');
                if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
                toastr['success']("RPG Tracker logic wiped.", "RPG Tracker");
            }
        });

        // Copy System Prompt logic
        const syspromptMenu = /** @type {HTMLElement} */ (panel.querySelector('#rt-sysprompt-menu'));
        const syspromptBtn = /** @type {HTMLElement} */ (panel.querySelector('#rt-copy-sysprompt'));

        syspromptBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = syspromptMenu.style.display === 'flex';
            syspromptMenu.style.display = isVisible ? 'none' : 'flex';
        });

        panel.querySelectorAll('.rt-sysprompt-opt').forEach(opt => {
            opt.addEventListener('click', async (e) => {
                const fileName = /** @type {HTMLElement} */ (e.currentTarget).getAttribute('data-file');
                let content;

                // Attempt to fetch the live file from disk first
                try {
                    const response = await fetch(`/scripts/extensions/third-party/SillyTavern-FatbodyDnDFramework/${fileName}`);
                    if (response.ok) {
                        content = await response.text();
                        console.log(`[Fatbody Framework] Loaded ${fileName} from live file.`);
                    } else {
                        throw new Error(`Server returned ${response.status}`);
                    }
                } catch (err) {
                    console.warn(`[Fatbody Framework] Could not fetch ${fileName} from live file, using hardcoded fallback:`, err);
                    content = RT_PROMPTS[fileName];
                }

                if (!content) {
                    toastr['error'](`Prompt not found: ${fileName}`, "Fatbody Framework");
                    return;
                }

                // Use a hidden textarea fallback — works on HTTP (Termux) where navigator.clipboard is blocked
                const ta = document.createElement('textarea');
                ta.value = content;
                ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                try {
                    document.execCommand('copy');
                    toastr['success'](`${fileName} copied to clipboard!`, "Fatbody Framework");
                    syspromptMenu.style.display = 'none';
                } catch (err) {
                    console.error("[Fatbody Framework] execCommand copy failed:", err);
                    toastr['error']('Could not copy to clipboard.', "Fatbody Framework");
                } finally {
                    document.body.removeChild(ta);
                }
            });
        });

        // Close menu when clicking outside
        window.addEventListener('click', (e) => {
            if (syspromptMenu && syspromptMenu.style.display === 'flex' && !syspromptMenu.contains(/** @type {Node} */(e.target)) && e.target !== syspromptBtn) {
                syspromptMenu.style.display = 'none';
            }
        });

        syncMemoView();
    }

    function navigateSnapshot(direction) {
        const s = getSettings();
        const maxIndex = s.memoHistory.length - 1;
        const newIndex = _historyViewIndex + direction;

        if (newIndex < -1 || newIndex > maxIndex) return;
        _historyViewIndex = newIndex;
        syncMemoView();
    }

    function syncMemoView() {
        const s = getSettings();
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('rpg-tracker-memo'));
        const navLabel = document.getElementById('rpg-tracker-nav-label');
        const btnBack = /** @type {HTMLButtonElement|null} */ (document.getElementById('rpg-tracker-nav-back'));
        const btnFwd = /** @type {HTMLButtonElement|null} */ (document.getElementById('rpg-tracker-nav-fwd'));
        const counter = document.getElementById('rpg-tracker-count');
        if (!textarea || !navLabel) return;

        const histLen = s.memoHistory.length;

        if (_historyViewIndex === -1) {
            // Live view
            textarea.value = s.currentMemo;
            textarea.readOnly = false;
            navLabel.textContent = '[ LIVE ]';
            navLabel.classList.remove('clickable');
            navLabel.title = 'Current Live State';
            btnBack.disabled = histLen === 0;
            btnFwd.disabled = true;
            if (counter) counter.textContent = `~${Math.round(s.currentMemo.length / 2.62)} tokens`;
        } else {
            // Snapshot view
            const snapshot = s.memoHistory[_historyViewIndex];
            textarea.value = snapshot ?? '';
            textarea.readOnly = true;
            navLabel.textContent = `[ -${_historyViewIndex + 1} 🔄 ]`;
            navLabel.classList.add('clickable');
            navLabel.title = 'Click to RESTORE this snapshot to Live';
            btnBack.disabled = _historyViewIndex >= histLen - 1;
            btnFwd.disabled = false; // can always navigate forward toward Live
            if (counter) counter.textContent = `~${Math.round((snapshot ?? '').length / 2.62)} tokens`;
        }
        refreshRenderedView();
    }

    /**
     * @param {HTMLElement} panel
     * @param {HTMLElement} handle
     */
    function makeDraggable(panel, handle, customKey = null) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            // Ignore clicks on buttons inside the header
            if (e.target instanceof Element && e.target.closest('button')) return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const left = startLeft + (e.clientX - startX);
            const top = startTop + (e.clientY - startY);

            // Constrain to viewport (ensure header stays reachable)
            const boundedLeft = Math.max(0, Math.min(window.innerWidth - 100, left));
            const boundedTop = Math.max(0, Math.min(window.innerHeight - 50, top));

            panel.style.left = boundedLeft + 'px';
            panel.style.top = boundedTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                if (customKey) {
                    const rect = panel.getBoundingClientRect();
                    localStorage.setItem(customKey, JSON.stringify({
                        left: rect.left, top: rect.top,
                        width: rect.width, height: rect.height
                    }));
                } else {
                    savePanelGeometry(panel);
                }
            }
        });
    }

    /**
     * Top-Right corner resizer logic
     * @param {HTMLElement} panel 
     * @param {HTMLElement} handle 
     */
    function makeResizableTR(panel, handle) {
        let isResizing = false;
        let startX, startY, startWidth, startHeight, startTop, startLeft;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isResizing = true;
            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            startTop = rect.top;
            startLeft = rect.left;

            // Switch to absolute/fixed values before moving
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';

            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newWidth = Math.max(220, startWidth + dx);
            const newHeight = Math.max(200, startHeight - dy);
            const newTop = startTop + dy;

            panel.style.width = newWidth + 'px';
            // Only apply height/top if we're above min-height to prevent jumping
            if (newHeight > 200) {
                panel.style.height = newHeight + 'px';
                panel.style.top = newTop + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                savePanelGeometry(panel);
            }
        });
    }

    function setupResizeObserver(panel) {
        // Debounced save on resize
        let _resizeTimer;
        const ro = new ResizeObserver(() => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => savePanelGeometry(panel), 300);
        });
        ro.observe(panel);
    }

    function setupDeltaResize(panel) {
        const handle = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta-handle'));
        const deltaEl = /** @type {HTMLElement} */ (panel.querySelector('#rpg-tracker-delta'));
        let startY, startH;

        handle.addEventListener('mousedown', (e) => {
            startY = e.clientY;
            startH = deltaEl.offsetHeight;
            e.preventDefault();

            const onMove = (ev) => {
                // dragging up = bigger console
                const newH = Math.max(40, startH - (ev.clientY - startY));
                deltaEl.style.height = newH + 'px';
            };
            const onUp = () => {
                saveDeltaHeight(deltaEl.offsetHeight);
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function updateUIMemo(text) {
        if (_historyViewIndex !== -1) return; // don't clobber snapshot view
        const textarea = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('rpg-tracker-memo'));
        if (textarea) textarea.value = text;
        const counter = document.getElementById('rpg-tracker-count');
        if (counter) counter.textContent = `~${Math.round(text.length / 2.62)} tokens`;
    }

    function updateStatusIndicator(state) {
        const indicator = document.getElementById('rpg-tracker-status');
        const stopBtn = /** @type {HTMLElement} */ (document.getElementById('rpg-tracker-stop-btn'));
        if (!indicator) return;

        indicator.className = 'rpg-tracker-status-indicator ' + state;
        if (stopBtn) {
            stopBtn.style.display = (state === 'running') ? 'flex' : 'none';
        }
    }

    const RENDER_HINTS = {
        CHARACTER: {
            label: 'Entity Rows — HP Bars (Characters)',
            description: 'Each entity is one row with an HP bar. First line: "Name (Race/Class): cur/max HP". Sub-lines: Att/def, Attr, Saves, Skills, Traits, HD, Status.',
            example: 'Korgath Iron-Hide (Dwarven Warrior): 32/32 HP\nAtt/def: Volcanic Mace (+1 / 2d6+3) | Furs (AC: 13)\nAttr: STR 16, DEX 12, CON 16, INT 8, WIS 16, CHA 6\nSaves: Fort +6 | Ref +1 | Will +1\nSkills: Athletics +5, Intimidation +4\nHD: d10 (2/2)\nStatus: Healthy'
        },
        COMBAT: {
            label: 'Entity Rows — HP Bars (Enemies)',
            description: 'Same entity-row format as Characters. Optionally starts with a "COMBAT ROUND N" header line. Each enemy: "Name (Type): cur/max HP". Sub-lines: Att/def, Saves, Status.',
            example: 'COMBAT ROUND 1\nSkritch (Goblin Minion): 8/8 HP\nAtt/def: Pickaxe (+3 / 1d6+1 P) | Furs (AC: 12)\nSaves: Fort +0, Ref +2, Will +0\nStatus: Healthy\n\nGrak (Goblin Minion): 8/8 HP\nAtt/def: Jagged Stone (+3 / 1d4+1 B) | Furs (AC: 12)\nStatus: Healthy'
        },
        SPELLS: {
            label: 'Spell Pips — Slot Tracker',
            description: 'One line per spell level. Cantrips: comma-separated names. Slots: "Level N (available/max): Spell1, Spell2".',
            example: 'Cantrips: Guidance, Resistance\nLevel 1 (2/2): Cure Wounds, Shield of Faith\nLevel 2 (1/3): Hold Person, Silence'
        },
        INVENTORY: {
            label: 'Bullet Points — Item List',
            description: 'One item per line. Leading "- " dashes are stripped. Supports <font color=...> tags for rarity/class coloring.',
            example: '- <font color=#ff8000>Volcanic Mace (+1 / 2d6+3 Fire)</font>\n- <font color=#a335ee>Cloak of Displacement</font>\n- <font color=#0070dd>Healing Potion (Greater)</font> x2\n- <font color=#1eff00>Iron Buckler (AC +2)</font>\n- <font color=#aaaaaa>Rope (50 ft)</font>\n- 80 gold pieces'
        },
        ABILITIES: {
            label: 'Oval Pills — Trait Tags',
            description: 'Each line becomes a clickable pill. Text in parentheses (e.g. 10/15) is tracked as a resource. Supports <font color=...> tags.',
            example: '- Lay on Hands (10/15, Heal 1 HP per point)\n- Divine Sense (3/4, Detect celestials/fiends/undead)\n- <font color=#ffaa00>Hasted (Double speed, +2 AC)</font>\n- <font color=#ff5555>Poisoned (Disadvantage on attacks)</font>'
        }
    };

    // Row type options shared by both the custom field editor and the global sub-field rules list
    const ROW_TYPE_OPTIONS = [
        ['pills',     'Pills (comma-separated chips)'],
        ['badge',     'Badge (single chip)'],
        ['highlight', 'Highlight (paren emphasis)'],
        ['hp_bar',    'HP Bar (X/Y progress)'],
        ['xp_bar',    'XP Bar (X/Y with optional level)'],
        ['kv',        'Key / Value pair'],
        ['text',      'Plain Text'],
    ];

    function buildRowTypeSelect(selectedVal) {
        const sel = document.createElement('select');
        sel.className = 'text_pole';
        sel.style.cssText = 'flex:2; min-width:110px; height:28px; padding:2px 4px; font-size:12px;';
        ROW_TYPE_OPTIONS.forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val; opt.textContent = label;
            if (val === selectedVal) opt.selected = true;
            sel.appendChild(opt);
        });
        return sel;
    }

    function openCustomFieldEditor(index) {
        const isSmallScreen = window.innerWidth <= 700;
        const s = getSettings();
        const field = s.customFields[index];
        const overlay = document.createElement('div');
        overlay.id = 'rt_cfe_overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);backdrop-filter:blur(2px);z-index:10000000;display:none;align-items:center;justify-content:center;overflow-y:auto;';

        overlay.innerHTML = `
            <div id="rt_cfe_modal" class="popup shadowBase" style="
                width: min(540px, 94vw);
                height: ${isSmallScreen ? '85vh' : 'auto'};
                max-height: ${isSmallScreen ? '90vh' : '850px'};
                margin: auto;
                display: flex;
                flex-direction: column;
                padding: 0;
                overflow: hidden;
            ">
                <div class="popup-header">
                    <h3 class="margin0" style="font-size:14px; flex:1;">Custom Module Editor</h3>
                    <button id="rt_cfe_preview_btn" class="menu_button interactable" style="font-size:11px;padding:3px 8px;display:none;margin-right:6px;"><i class="fa-solid fa-eye"></i> Preview</button>
                    <div id="rt_cfe_close" class="popup-close interactable" title="Close"><i class="fa-solid fa-times"></i></div>
                </div>
                <div class="popup-body flex-container flexFlowColumn gap-1" style="padding:10px 14px; overflow-y:auto; flex:1;">
                    <!-- Identity row -->
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                        <input type="text" id="rt_cfe_icon" class="text_pole" style="width:44px;text-align:center;" title="Icon (emoji)">
                        <input type="text" id="rt_cfe_tag"  class="text_pole" style="width:100px;font-family:monospace;" placeholder="TAG">
                        <input type="text" id="rt_cfe_label" class="text_pole" style="flex:1;min-width:80px;" placeholder="Display label">
                    </div>

                    <!-- Template Definition -->
                    <div style="margin-top:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                             <b style="font-size:13px;">Module Template & Examples <i class="fa-solid fa-circle-question" style="opacity:0.5; cursor:help; font-size:11px;" title="This box is ONLY for testing how the UI renders your formatting. Nothing from this box is sent to the AI. You must manually include any formatting examples in the 'AI Instructions' box below."></i></b>
                             <div style="display:flex; gap:4px;">
                                <button id="rt_cfe_color_guide" class="menu_button interactable" style="font-size:10px; padding:2px 6px; opacity:0.8;" title="Load color and rarity examples"><i class="fa-solid fa-palette"></i> Color Guide</button>
                                <button id="rt_cfe_guide" class="menu_button interactable" style="font-size:10px; padding:2px 6px; opacity:0.8;" title="Load formatting examples"><i class="fa-solid fa-lightbulb"></i> Formatting Guide</button>
                             </div>
                        </div>
                        <textarea id="rt_cfe_template" class="text_pole" rows="8" style="resize:vertical; width:100%; font-family:monospace; font-size:12px;" placeholder="Example:\n((PILLS)) Skills: Stealth, Deception\nHP: 10/100"></textarea>
                        <div style="font-size:11px; opacity:0.5; margin-top:4px;">
                            Markers: <code>((PILLS))</code>, <code>((BAR))</code>, <code>((XPBAR))</code>, <code>((BADGE))</code>, <code>((HIGHLIGHT))</code>
                        </div>
                    </div>

                    <!-- AI Instructions -->
                    <div style="margin-top:15px; padding:10px; background:rgba(0,0,0,0.2); border-radius:8px; border:1px solid rgba(255,255,255,0.05);">
                        <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
                            <i class="fa-solid fa-robot" style="opacity:0.7;"></i>
                            <b style="font-size:12px;">AI Instructions</b>
                        </div>
                        <textarea id="rt_cfe_prompt" class="text_pole" rows="10" style="resize:vertical; width:100%;" placeholder="What should the AI track and in what format? Define the instructions. You can use the box above with the live preview (desktop only for now!) to create and paste a formatting instructions template here.&#10;&#10;Example: Track the Limit Break charge level of the protagonist. Increment Times Used on use; increase level by 1 on each use.&#10;&#10;Format:&#10;[LIMIT BREAK]&#10;((XPBAR)) Limit Break: 10/100 Level 4&#10;Times Used: 3&#10;[/LIMIT BREAK]"></textarea>
                    </div>
                </div>
                <!-- Footer -->
                <div class="popup-footer flex-container gap-1 justifycontentend" style="padding:8px 14px; border-top:1px solid rgba(255,255,255,0.08); flex-shrink:0;">
                    <button id="rt_cfe_delete" class="menu_button interactable" style="color:#ff5555;margin-right:auto;font-size:12px;"><i class="fa-solid fa-trash"></i> Delete</button>
                    <button id="rt_cfe_cancel" class="menu_button interactable" style="font-size:12px;">Cancel</button>
                    <button id="rt_cfe_save" class="menu_button interactable" style="font-size:12px;">Save Changes</button>
                </div>
            </div>
            <!-- Floating preview -->
            <div id="rt_cfe_preview" class="rpg-tracker-panel" style="margin:0;display:none;flex-direction:column;cursor:default;height:auto;min-height:44px;width:300px;position:fixed;">
                <div id="rt_cfe_preview_header" class="rpg-tracker-header" style="cursor:move;user-select:none;font-size:0.75em;opacity:0.7;padding:5px 10px;"><i class="fa-solid fa-grip-lines" style="margin-right:6px;"></i>UI Live Preview</div>
                <div id="rt_cfe_preview_view" class="rpg-tracker-render-view"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', e => e.stopPropagation());
        overlay.addEventListener('click', e => e.stopPropagation());

        const iconEl     = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_icon'));
        const tagEl      = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_tag'));
        const labelEl    = /** @type {HTMLInputElement}    */ (document.getElementById('rt_cfe_label'));
        const templateEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_cfe_template'));
        const promptEl   = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_cfe_prompt'));
        const previewEl  = document.getElementById('rt_cfe_preview');

        iconEl.value     = field.icon  || '📄';
        tagEl.value      = field.tag   || '';
        labelEl.value    = field.label || '';
        templateEl.value = field.template || '';
        // Legacy cleanup: clear the old placeholder text if it's stored as a value
        if (field.prompt === 'What should the AI track for this new field? Describe it here.') {
            field.prompt = '';
        }
        promptEl.value   = field.prompt || '';

        // ── Live Preview ──
        let _previewDebounce = null;
        let _bgRefreshDebounce = null;
        const schedulePreview = () => {
            clearTimeout(_previewDebounce);
            _previewDebounce = setTimeout(updatePreview, 180);
            clearTimeout(_bgRefreshDebounce);
            _bgRefreshDebounce = setTimeout(refreshRenderedView, 300);
        };

        const renderPreviewInto = (targetEl) => {
            const renderView = targetEl || document.getElementById('rt_cfe_preview_view');
            if (!renderView) return;

            const testContent = templateEl.value || 'No template defined.';
            const previewTag = '__PREVIEW__';
            const fakeMemo = `[${previewTag}]\n${testContent}\n[/${previewTag}]`;

            const ghostField = {
                tag:     previewTag,
                label:   labelEl.value || tagEl.value || 'Preview',
                icon:    iconEl.value || '📄',
                template: templateEl.value,
                prompt:  '',
                enabled: true
            };
            const savedCustomFields = s.customFields;
            s.customFields = [...savedCustomFields, ghostField];
            try {
                renderView.innerHTML = renderMemoAsCards(fakeMemo, previewTag);
                bindRenderedCardEvents(renderView, fakeMemo, true, () => renderPreviewInto(targetEl));
            } finally {
                s.customFields = savedCustomFields;
            }
        };

        const updatePreview = () => renderPreviewInto(null);

        const EXAMPLES = `((BAR)) Health: 45/100
((XPBAR)) Level 3: 1,200/2,700 XP
((PILLS)) Skills: Stealth (Expert), Deception (Proficient)
((BADGE)) Status: Inspired
((HIGHLIGHT)) Emphasis: (Special Item)
((TEXT)) Note: Simple text row.`;

        const COLOR_EXAMPLES = `<font color=#b07a4f>LEGENDARY BATTLE AXE</font>\n[Legendary] A Winning Lottery Ticket\n[Common] Buggy Software`;

        document.getElementById('rt_cfe_guide').onclick = () => {
            if (!templateEl.value || confirm("This will replace your current template with examples. Continue?")) {
                templateEl.value = EXAMPLES;
                schedulePreview();
            }
        };

        document.getElementById('rt_cfe_color_guide').onclick = () => {
            if (!templateEl.value || confirm("This will replace your current template with color examples. Continue?")) {
                templateEl.value = COLOR_EXAMPLES;
                schedulePreview();
            }
        };

        iconEl.addEventListener('input', schedulePreview);
        tagEl.addEventListener('input', schedulePreview);
        labelEl.addEventListener('input', schedulePreview);
        templateEl.addEventListener('input', schedulePreview);

        updatePreview();
        overlay.style.display = 'flex';

        const modal = document.getElementById('rt_cfe_modal');
        const previewHeader = (document.getElementById('rt_cfe_preview_header'));
        const previewBtn = document.getElementById('rt_cfe_preview_btn');

        if (modal && previewEl && previewHeader) {
            const rect = modal.getBoundingClientRect();
            const spaceOnRight = window.innerWidth - rect.right;
            if (spaceOnRight >= 320 && !isSmallScreen) {
                previewEl.style.display = 'flex';
                previewEl.style.left = (rect.right + 20) + 'px';
                previewEl.style.top  = rect.top + 'px';
                // @ts-ignore
                makeDraggable(previewEl, previewHeader);
                if (previewBtn) {
                    previewBtn.style.display = 'flex';
                    previewBtn.addEventListener('click', () => {
                        if (previewEl) previewEl.style.display = previewEl.style.display === 'none' ? 'flex' : 'none';
                    });
                }
            }
        }

        const save = () => {
            field.icon  = iconEl.value;
            const newTag = tagEl.value.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase();
            if (!newTag) { toastr['error']('Tag cannot be empty.', 'RPG Tracker'); return; }
            if (BLOCK_ORDER.includes(newTag)) { toastr['error'](`[${newTag}] is a reserved stock module name.`, 'RPG Tracker'); return; }
            const dup = s.customFields.find((f, i) => i !== index && f.tag.toUpperCase() === newTag);
            if (dup) { toastr['error'](`Tag [${newTag}] is already in use.`, 'RPG Tracker'); return; }

            field.tag      = newTag;
            field.label    = labelEl.value;
            field.template = templateEl.value;
            field.prompt   = promptEl.value;
            delete field.rows;
            delete field.renderType;

            overlay.remove();
            SillyTavern.getContext().saveSettingsDebounced();
            refreshOrderList();
            refreshRenderedView();
        };

        const del = () => {
            const tagToDelete = field.tag.toUpperCase();
            if (confirm(`Delete custom module [${tagToDelete}]? This will also remove its data from the current tracker.`)) {
                s.customFields.splice(index, 1);
                if (s.blockOrder) s.blockOrder = s.blockOrder.filter(t => t !== tagToDelete);
                const memoBlocks = parseMemoBlocks(s.currentMemo || '');
                if (memoBlocks[tagToDelete] !== undefined) {
                    delete memoBlocks[tagToDelete];
                    s.currentMemo = Object.entries(memoBlocks).map(([k, v]) => `[${k}]\n${v}\n[/${k}]`).join('\n\n');
                    updateUIMemo(s.currentMemo);
                }
                overlay.remove();
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            }
        };

        const close = () => overlay.remove();
        document.getElementById('rt_cfe_save').onclick   = save;
        document.getElementById('rt_cfe_delete').onclick = del;
        document.getElementById('rt_cfe_cancel').onclick = close;
        document.getElementById('rt_cfe_close').onclick  = close;
    }
    function openPromptEditor(title, currentText, defaultText, onSave) {
        let overlay = document.getElementById('rt_pe_overlay');

        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'rt_pe_overlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '0';
            overlay.style.left = '0';
            overlay.style.width = '100vw';
            overlay.style.height = '100vh';
            overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
            overlay.style.zIndex = '10000000';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.innerHTML = `
                <div class="popup shadowBase" style="min-width: 400px; max-width: 600px;">
                    <div class="popup-header">
                        <h3 class="margin0" id="rt_pe_title">Edit Prompt</h3>
                        <div id="rt_pe_close" class="popup-close interactable"><i class="fa-solid fa-times"></i></div>
                    </div>
                    <div class="popup-body flex-container flexFlowColumn gap-1" style="padding: 10px;">
                        <textarea id="rt_pe_text" class="text_pole" rows="6" style="width: 100%; resize: vertical;"></textarea>
                        <div class="flex-container gap-1 justifycontentend">
                            <button id="rt_pe_reset" class="menu_button interactable" style="margin-right: auto;"><i class="fa-solid fa-arrow-rotate-left"></i> Reset</button>
                            <button id="rt_pe_cancel" class="menu_button interactable">Cancel</button>
                            <button id="rt_pe_save" class="menu_button interactable">Save Changes</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }

        const titleEl = document.getElementById('rt_pe_title');
        const textEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('rt_pe_text'));
        const saveBtn = document.getElementById('rt_pe_save');
        const resetBtn = document.getElementById('rt_pe_reset');
        const close = () => { overlay.style.display = 'none'; };

        titleEl.textContent = title;
        textEl.value = currentText;
        overlay.style.display = 'flex';

        const saveHandler = () => {
            onSave(textEl.value);
            close();
        };

        const resetHandler = () => {
            if (confirm("Reset this prompt to the factory default?")) {
                textEl.value = defaultText;
            }
        };

        const cleanup = () => {
            saveBtn.removeEventListener('click', saveHandler);
            resetBtn.removeEventListener('click', resetHandler);
            document.getElementById('rt_pe_close').removeEventListener('click', close);
            document.getElementById('rt_pe_cancel').removeEventListener('click', close);
        };

        saveBtn.onclick = saveHandler;
        resetBtn.onclick = resetHandler;
        document.getElementById('rt_pe_close').onclick = close;
        document.getElementById('rt_pe_cancel').onclick = close;
    }



    function refreshOrderList() {
        const s = getSettings();
        const list = document.getElementById('rpg_tracker_order_list');
        if (!list) return;

        list.innerHTML = '';

        const getIcon = (tag) => {
            if (BLOCK_ICONS[tag]) return BLOCK_ICONS[tag];
            const custom = (s.customFields || []).find(f => f.tag.toUpperCase() === tag);
            return custom?.icon || '📄';
        };

        if (!s.blockOrder) s.blockOrder = [...BLOCK_ORDER];

        // --- Sanitization Pass: Ensure unique tags and no stock conflicts ---
        const seenTags = new Set(BLOCK_ORDER);
        (s.customFields || []).forEach(f => {
            let baseTag = f.tag.toUpperCase().replace(/[^A-Z0-9_]/g, '');
            if (!baseTag) baseTag = 'CUSTOM';
            let finalTag = baseTag;
            let counter = 1;
            while (seenTags.has(finalTag)) {
                finalTag = `${baseTag}_${counter++}`;
            }
            if (f.tag !== finalTag) {
                console.log(`[RPG Tracker] Sanitized tag: ${f.tag} -> ${finalTag}`);
                f.tag = finalTag;
            }
            seenTags.add(finalTag);
        });

        // Add any missing tags to blockOrder
        const allCustomTags = (s.customFields || []).map(f => f.tag.toUpperCase());
        [...BLOCK_ORDER, ...allCustomTags].forEach(tag => {
            if (!s.blockOrder.includes(tag)) s.blockOrder.push(tag);
        });

        // Current order, filtered for validity
        const validCustomTags = new Set(allCustomTags);
        const order = s.blockOrder.filter(tag => BLOCK_ORDER.includes(tag) || validCustomTags.has(tag));
        s.blockOrder = order;

        order.forEach((tag, index) => {
            const isStock = BLOCK_ORDER.includes(tag);
            const customIndex = s.customFields.findIndex(f => f.tag.toUpperCase() === tag);
            const field = isStock ? null : s.customFields[customIndex];

            const isEnabled = isStock ? (s.modules[tag.toLowerCase()] ?? false) : (field?.enabled ?? false);

            const item = document.createElement('div');
            item.className = 'flex-container gap-1 alignitemscenter rt-order-item';
            item.style.padding = '5px';
            item.style.background = isEnabled ? 'var(--black30a)' : 'transparent';
            item.style.opacity = isEnabled ? '1' : '0.6';
            item.style.borderRadius = '4px';
            item.style.border = '1px solid var(--smartThemeBorderColor)';

            // 1. Checkbox
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isEnabled;
            cb.style.margin = '0 5px';
            cb.onchange = () => {
                if (isStock) {
                    s.modules[tag.toLowerCase()] = cb.checked;
                } else {
                    field.enabled = cb.checked;
                }
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            };

            // 2. Label
            const label = document.createElement('span');
            label.style.flex = '1';
            label.style.fontSize = '12px';
            label.style.cursor = 'default';
            label.textContent = `${getIcon(tag)} ${tag}`;

            // 3. Button Group
            const btnGroup = document.createElement('div');
            btnGroup.className = 'flex-container gap-1';

            // Edit Button
            const editBtn = document.createElement('button');
            editBtn.className = 'menu_button interactable rt-order-btn';
            editBtn.style.padding = '2px 6px';
            editBtn.title = isStock ? 'Edit Prompt' : 'Edit Custom Field';
            editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
            editBtn.onclick = () => {
                if (isStock) {
                    const mod = tag.toLowerCase();
                    if (!s.stockPrompts) s.stockPrompts = { ...DEFAULT_STOCK_PROMPTS };
                    openPromptEditor(
                        `Edit Default [${tag}] Prompt`,
                        s.stockPrompts[mod],
                        DEFAULT_STOCK_PROMPTS[mod],
                        (newVal) => {
                            s.stockPrompts[mod] = newVal;
                            SillyTavern.getContext().saveSettingsDebounced();
                            toastr['success'](`[${tag}] prompt updated.`, 'RPG Tracker');
                        }
                    );
                } else {
                    openCustomFieldEditor(customIndex);
                }
            };

            // Up/Down Arrows
            const upBtn = document.createElement('button');
            upBtn.className = 'menu_button interactable rt-order-btn';
            upBtn.style.padding = '2px 6px';
            upBtn.innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
            upBtn.disabled = index === 0;
            upBtn.onclick = () => {
                const newOrder = [...order];
                [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
                s.blockOrder = newOrder;
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            };

            const downBtn = document.createElement('button');
            downBtn.className = 'menu_button interactable rt-order-btn';
            downBtn.style.padding = '2px 6px';
            downBtn.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
            downBtn.disabled = index === order.length - 1;
            downBtn.onclick = () => {
                const newOrder = [...order];
                [newOrder[index + 1], newOrder[index]] = [newOrder[index], newOrder[index + 1]];
                s.blockOrder = newOrder;
                SillyTavern.getContext().saveSettingsDebounced();
                refreshOrderList();
                refreshRenderedView();
            };

            item.appendChild(cb);
            item.appendChild(label);
            btnGroup.appendChild(editBtn);
            btnGroup.appendChild(upBtn);
            btnGroup.appendChild(downBtn);
            item.appendChild(btnGroup);
            list.appendChild(item);
        });
    }

    /**
     * Initialization
     */
    (async function init() {
        const ctx = SillyTavern.getContext();
        const { eventSource, event_types, renderExtensionTemplateAsync } = ctx;

        getSettings();
        migrateCustomFields();
        createPanel();

        try {
            // Load Settings UI using the dynamic folder name
            // Use a cache-busting parameter to ensure we get the fresh file from the server
            const html = await renderExtensionTemplateAsync(`third-party/${FOLDER_NAME}`, 'settings', { v: Date.now() });
            // Third-party plugins should go to extensions_settings2 (right column) if available
            if ($('#extensions_settings2').length) {
                $('#extensions_settings2').append(html);
            } else {
                $('#extensions_settings').append(html);
            }

            const settings = getSettings();

            $('#rpg_tracker_enabled').prop('checked', settings.enabled).on('change', function () {
                settings.enabled = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_debug').prop('checked', settings.debugMode).on('change', function () {
                settings.debugMode = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_legacy_dice').prop('checked', settings.legacyDiceNaming).on('change', function () {
                settings.legacyDiceNaming = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
                registerDiceFunctionTool();
                registerDiceSlashCommand();
                toastr['info']("Dice logic updated.", "RPG Tracker");
            });

            $('#rpg_tracker_dice_function_tool').prop('checked', settings.diceFunctionTool).on('change', function () {
                settings.diceFunctionTool = !!$(this).prop('checked');
                ctx.saveSettingsDebounced();
                registerDiceFunctionTool();
            });

            // ─── Event Hooks ───
            eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
            eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);

            // ─── Dice System ───
            registerDiceFunctionTool();
            registerDiceSlashCommand();

            // Connection Settings
            const sourceSelect = $('#rpg_tracker_connection_source');
            const profileGroup = $('#rpg_tracker_profile_group');
            const profileSelect = $('#rpg_tracker_connection_profile');
            const maxTokensInput = $('#rpg_tracker_max_tokens');

            sourceSelect.val(settings.connectionSource).on('change', function () {
                settings.connectionSource = $(this).val();
                profileGroup.toggle(settings.connectionSource === 'profile');
                ctx.saveSettingsDebounced();
            });
            profileGroup.toggle(settings.connectionSource === 'profile');

            maxTokensInput.val(settings.maxTokens || "").on('input', function () {
                settings.maxTokens = parseInt(/** @type {string} */($(this).val())) || 0;
                ctx.saveSettingsDebounced();
            });

            // Advanced Options
            const lookbackInput = $('#rpg_tracker_lookback_messages');
            if (lookbackInput.length) {
                lookbackInput.val(settings.lookbackMessages !== undefined ? settings.lookbackMessages : 2).on('input', function () {
                    settings.lookbackMessages = parseInt(/** @type {string} */($(this).val())) || 2;
                    ctx.saveSettingsDebounced();
                });
            }
            const historyCountInput = $('#rpg_tracker_history_count');
            if (historyCountInput.length) {
                historyCountInput.val(settings.trackerHistoryCount !== undefined ? settings.trackerHistoryCount : 1).on('input', function () {
                    settings.trackerHistoryCount = parseInt(/** @type {string} */($(this).val())) || 1;
                    ctx.saveSettingsDebounced();
                });
            }

            // ── Lorebook Context UI ──
            async function refreshLorebookList() {
                const $container = $('#rpg_tracker_lorebook_list');
                $container.empty();
                const stCtx = SillyTavern.getContext();
                let worldNames = [];
                try {
                    worldNames = await stCtx.getWorldInfoNames() ?? [];
                } catch (e) {
                    console.warn('[RPG Tracker] getWorldInfoNames() failed:', e);
                }

                if (!worldNames || worldNames.length === 0) {
                    $container.append('<i style="opacity:0.6;">No lorebooks found.</i>');
                    return;
                }

                const currentFilter = settings.lorebookFilter || [];
                const sortedBooks = [...worldNames].sort();

                sortedBooks.forEach(bookName => {
                    const isChecked = currentFilter.includes(bookName);
                    const $item = $(`<label class="checkbox_label" style="font-size: 0.9em;">
                        <input type="checkbox" data-book="${bookName}" ${isChecked ? 'checked' : ''} />
                        <span>${bookName}</span>
                    </label>`);

                    $item.find('input').on('change', function () {
                        const book = $(this).data('book');
                        if (!Array.isArray(settings.lorebookFilter)) settings.lorebookFilter = [];
                        if ($(this).prop('checked')) {
                            if (!settings.lorebookFilter.includes(book)) {
                                settings.lorebookFilter.push(book);
                            }
                        } else {
                            settings.lorebookFilter = settings.lorebookFilter.filter(b => b !== book);
                        }
                        ctx.saveSettingsDebounced();
                    });
                    $container.append($item);
                });
            }

            $('#rpg_tracker_ctx_worldinfo').prop('checked', settings.ctxWorldInfo ?? false).on('change', async function () {
                settings.ctxWorldInfo = !!$(this).prop('checked');
                if (settings.ctxWorldInfo) await refreshLorebookList();
                $('#rpg_tracker_lorebook_filter_group').toggle(settings.ctxWorldInfo);
                ctx.saveSettingsDebounced();
            }).trigger('change');

            $('#rpg_tracker_lorebook_list_refresh').on('click', async function () {
                await refreshLorebookList();
            });

            // Theme Select
            const themeSelect = $('#rpg_tracker_theme_select');
            themeSelect.val(settings.trackerTheme || 'rt-theme-native');
            themeSelect.on('change', function () {
                const newTheme = String($(this).val());
                settings.trackerTheme = newTheme;
                ctx.saveSettingsDebounced();
                // Apply immediately
                const panel = document.getElementById('rpg-tracker-panel');
                if (panel) {
                    panel.className = `rpg-tracker-panel ${newTheme}`;
                    if (!settings.enabled) panel.classList.add('is-paused');
                }
                // Apply to detached panels
                document.querySelectorAll('.rpg-tracker-detached-panel').forEach(dp => {
                    dp.className = `rpg-tracker-panel rpg-tracker-detached-panel ${newTheme}`;
                });
            });

            const fontSizeInput = $('#rpg_tracker_font_size');
            fontSizeInput.val(settings.fontSize || 13).on('input', function() {
                const val = parseInt(String($(this).val()));
                if (isNaN(val) || val < 8 || val > 32) return;
                settings.fontSize = val;
                ctx.saveSettingsDebounced();
                updateTrackerFontSize(val);
            });

            // Populate profiles using handleDropdown (fills real internal IDs, not names)
            if (ctx.ConnectionManagerRequestService?.handleDropdown) {
                /** @type {any} */ (ctx.ConnectionManagerRequestService).handleDropdown(profileSelect[0]);
                profileSelect.val(settings.connectionProfileId);
            } else {
                // Fallback for older ST: /profile-list returns names only
                const profiles = await getConnectionProfiles();
                profileSelect.empty().append('<option value="">-- No Profile Selected --</option>');
                profiles.forEach(p => {
                    profileSelect.append($('<option></option>').val(p).text(p));
                });
                profileSelect.val(settings.connectionProfileId);
            }
            profileSelect.on('change', function () {
                settings.connectionProfileId = $(this).val();
                ctx.saveSettingsDebounced();
            });

            // Populate presets
            const presetSelect = $('#rpg_tracker_completion_preset');
            const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
            if (pm && typeof pm.getAllPresets === 'function') {
                const presets = pm.getAllPresets();
                presetSelect.empty().append('<option value="">-- Use Current Settings --</option>');
                presets.forEach(p => {
                    presetSelect.append($('<option></option>').val(p).text(p));
                });
                presetSelect.val(settings.completionPresetId || '');
            } else {
                presetSelect.empty().append('<option value="">-- Use Current Settings --</option>');
                if (settings.completionPresetId) {
                    presetSelect.append($('<option></option>').val(settings.completionPresetId).text(settings.completionPresetId));
                    presetSelect.val(settings.completionPresetId);
                }
            }
            presetSelect.on('change', function () {
                settings.completionPresetId = $(this).val();
                ctx.saveSettingsDebounced();
            });

            // Initial order list refresh
            refreshOrderList();

            $('#rpg_tracker_add_custom_field').on('click', function () {
                const settings = getSettings();
                if (!settings.customFields) settings.customFields = [];

                let newTag = 'NEW_FIELD';
                let counter = 1;
                const isTagTaken = (tag) => BLOCK_ORDER.includes(tag) || settings.customFields.some(f => f.tag.toUpperCase() === tag);

                while (isTagTaken(counter === 1 ? newTag : `${newTag}_${counter}`)) {
                    counter++;
                }
                if (counter > 1) newTag = `${newTag}_${counter}`;

                settings.customFields.push({
                    tag: newTag, label: 'New Field', icon: '📝',
                    prompt: '',
                    rows: [], enabled: true
                });
                refreshOrderList();
                ctx.saveSettingsDebounced();
            });



            $('#rpg_tracker_core_prompt').val(settings.systemPromptTemplate).on('input', function () {
                settings.systemPromptTemplate = $(this).val();
                ctx.saveSettingsDebounced();
            });

            $('#rpg_tracker_btn_reset_prompt').on('click', function () {
                if (!confirm('Reset the State Model prompt to the built-in default?')) return;
                // Re-read the default from the defaults object by temporarily clearing the stored value
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                const freshSettings = getSettings(); // re-merges defaults
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);
                ctx.saveSettingsDebounced();
                toastr['success']('Core prompt reset to default.', 'RPG Tracker');
            });

            $('#rpg_tracker_btn_reset_all_prompts').on('click', function () {
                if (!confirm('This will reset the Core Prompt, Module Prompts, Active Modules, and Module Order to their factory defaults. This cannot be undone. Proceed?')) return;
                const { extensionSettings } = SillyTavern.getContext();
                delete extensionSettings[MODULE_NAME].systemPromptTemplate;
                delete extensionSettings[MODULE_NAME].stockPrompts;
                delete extensionSettings[MODULE_NAME].blockOrder;
                delete extensionSettings[MODULE_NAME].modules;
                const freshSettings = getSettings();
                $('#rpg_tracker_core_prompt').val(freshSettings.systemPromptTemplate);
                refreshOrderList();
                ctx.saveSettingsDebounced();
                toastr['success']('All prompts, modules, and layout order reset to factory defaults.', 'RPG Tracker');
            });

            $('#rpg_tracker_btn_update').on('click', async function () {
                const { chat } = SillyTavern.getContext();
                if (!chat || chat.length === 0) return toastr['info']("No chat history found.", "RPG Tracker");

                let lastAssistantMsg = "";
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (!chat[i].is_user && !chat[i].is_system) {
                        lastAssistantMsg = chat[i].mes;
                        break;
                    }
                }
                if (!lastAssistantMsg) return toastr['info']("No assistant message to parse.", "RPG Tracker");

                toastr['info']("Triggering manual State Update...", "RPG Tracker");
                await runStateModelPass(lastAssistantMsg);
            });

            $('#rpg_tracker_btn_clear').on('click', function () {
                if (confirm("Are you sure you want to clear the memory history and wipe the tracker?")) {
                    settings.currentMemo = "";
                    settings.prevMemo1 = "";
                    settings.prevMemo2 = "";
                    settings.memoHistory = [];
                    settings.lastDelta = "";
                    ctx.saveSettingsDebounced();
                    updateUIMemo("");
                    const dp = document.getElementById('rpg-tracker-delta-content');
                    if (dp) dp.innerHTML = '<span class="delta-empty">Log cleared.</span>';
                    toastr['success']("RPG Tracker logic wiped.", "RPG Tracker");
                }
            });

            $('#rpg_tracker_btn_factory_reset').on('click', function () {
                if (confirm("⚠️ NUCLEAR OPTION ⚠️\n\nThis will wipe EVERYTHING: all custom fields, character history, saved profiles, and prompt changes. The framework will return to v1.1.0 factory defaults.\n\nProceed?")) {
                    const { extensionSettings } = SillyTavern.getContext();
                    delete extensionSettings[MODULE_NAME];
                    // Force re-initialization of defaults
                    getSettings();
                    ctx.saveSettingsDebounced();
                    toastr['success']("Framework has been reset to factory defaults. Reloading in 2 seconds...", "RPG Tracker");
                    setTimeout(() => location.reload(), 2000);
                }
            });

            // ── Profile System ──
            refreshProfileDropdown();

            $('#rpg_tracker_profile_save').on('click', function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected to overwrite. Use "Save As" for new profiles.', 'RPG Tracker');
                saveProfile(name);
                toastr['success'](`Profile "${name}" overwritten.`, 'RPG Tracker');
            });

            $('#rpg_tracker_profile_save_as').on('click', async function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const existing = sel.value;
                const { Popup } = SillyTavern.getContext();

                let name = null;
                if (Popup && Popup.show && Popup.show.input) {
                    name = await Popup.show.input('Save Profile', 'Save profile as:', existing || '');
                } else {
                    name = prompt('Save profile as:', existing || '');
                }

                name = name?.trim();
                if (!name) return;
                saveProfile(name);
                refreshProfileDropdown();
                toastr['success'](`Profile "${name}" saved.`, 'RPG Tracker');
            });

            $('#rpg_tracker_profile_load').on('click', function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected.', 'RPG Tracker');
                loadProfile(name);
                toastr['success'](`Profile "${name}" loaded.`, 'RPG Tracker');
            });

            $('#rpg_tracker_profile_delete').on('click', async function () {
                const sel = /** @type {HTMLSelectElement} */ (document.getElementById('rpg_tracker_profile_select'));
                const name = sel.value;
                if (!name) return toastr['info']('No profile selected.', 'RPG Tracker');

                const { Popup, POPUP_RESULT } = SillyTavern.getContext();
                if (Popup && Popup.show && Popup.show.confirm) {
                    const confirmResult = await Popup.show.confirm('Delete Profile', `Delete profile "${name}"?`);
                    if (confirmResult !== POPUP_RESULT.AFFIRMATIVE) return;
                } else {
                    if (!confirm(`Delete profile "${name}"?`)) return;
                }

                deleteProfile(name);
                refreshProfileDropdown();
                toastr['success'](`Profile "${name}" deleted.`, 'RPG Tracker');
            });

        } catch (e) {
            console.error("[RPG Tracker] Failed to build settings UI", e);
        }

        // Add wand button to toggle panel visibility
        addWandButton();

    function updateTrackerFontSize(size) {
        const panel = document.getElementById('rpg-tracker-panel');
        if (!panel) return;
        const s = size || getSettings().fontSize || 13;
        panel.style.setProperty('--rt-base-size', s + 'px');
        
        // Also update CFE preview if open
        const cfe = document.getElementById('rt_cfe_preview');
        if (cfe) cfe.style.setProperty('--rt-base-size', s + 'px');
    }

    function addWandButton() {
        const wandContainer = document.getElementById('extensionsMenu');
        if (!wandContainer) return;

        const btn = document.createElement('div');
        btn.id = 'toggle_rpg_tracker_wand_button';
        btn.classList.add('list-group-item', 'flex-container', 'flexGap5');

        btn.innerHTML = `
            <div class="fa-solid fa-clipboard-list extensionsMenuExtensionButton"></div>
            <span>Fatbody D&D Framework</span>
        `;

        btn.addEventListener('click', () => {
            const panel = document.getElementById('rpg-tracker-panel');
            if (panel) {
                const isHidden = panel.style.display === 'none';
                panel.style.display = isHidden ? 'flex' : 'none';
            }
        });

        wandContainer.appendChild(btn);
    }

    })();
})();
