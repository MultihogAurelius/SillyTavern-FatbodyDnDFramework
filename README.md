# Multihog D&D Framework

*A D&D-based RPG platform/simulation engine for SillyTavern.*

What this framework does is essentially turn SillyTavern into something like AI Dungeon, but with actual mechanics/consequences. Losing or dying is actually a thing. In Big Rigs, you're always WINNER. Not in Multihog D&D! That being said, **the system works just as well for casual "slice of life" type scenarios or modern settings, so no need to worry that you're limited to wizards and goblins.**

I wasn't satisfied with any of the commercial offerings available (AI Realm, AI Dungeon, Friends & Fables, etc.), so I made my own D&D platform inside SillyTavern. 

**Crucially, the system is input-output, not just some glorified stats collector. Every single thing has a backend.**

---

<p align="center">
  <img src="https://github.com/user-attachments/assets/cde8b1b9-dc31-4089-97dd-ebd16facd3af" width="80%" alt="A basic character sheet" />
  <br>
  <em>A basic character sheet</em>
</p>

---

### The Core Components:

1. 🖥️ **RPG State Tracker** -  Extracts and maintains HP, inventory, party, buffs, XP, spells, and more via a dedicated second-pass model. Injects a rolling State Memo back into each prompt to keep the AI (and you) on track.
2. 🎲 **Hybrid RNG System** - A dual-engine approach to tabletop physics. 
   - RNG Queue: Pre-seeded deterministic dice injected into every turn. Cheaper than using tool calls and very smooth when a lot of rolls are used in sequence such as in combat.
   - Tool Call RNG: Enables a commitment logic where the AI must declare a DC before seeing the result, completely preventing sycophancy.
3. 🤖 **Lorebook Agent** - Automatically creates, activates/deactivates, updates, consolidates, etc, lorebook entries, ensuring long-term memory despite summarization.
4. 🌍 **World Progression** - A system that creates daily (or more frequent) reports about NPC/world affairs using existing lore entries as well as an optional world "skeleton" created beforehand. The world moves regardless of you.

Together they solve the four core problems of LLM tabletop RP: the AI forgetting your inventory/spells, the AI forgetting long-term context, you always winning (aka. plot armor), and the world being static outside of the immediate player's bubble. I have high confidence in the system's reliability—you can just play and not worry about tinkering with much of anything.

---

## Highlights

- **20+ Rendering Tags** with universal inline support and live preview library.
- **AI-Powered Configuration** — generate custom fields and sysprompt sections from plain language descriptions.
- **Dual-Engine Physics**: Deterministic queue for instant combat, and interactive tool calls for narrative skill checks.
- **Draggable HUD** with HP bars, spell pips, colored status pills, alert badges, and economy coins.
- **Automatic spell slot tracking** via 🔵 pips in the UI; never worry about remembering how many you have left.
- **Buff/debuff temporal decay** via [TIME] delta tracking; statuses expire automatically over time based on time elapsed.
- **Dynamic enemy scaling** — enemies adapt to quest difficulty and player level contextually.
- **Snapshot history + delta log** - easy rollback, and see at a glance what was changed in the state.
- **Auto model-switching** so that you can use a different model for tracking the state.
- **Full-context audit mode** with automatic chunking for massive chat histories.
- **Custom fields, themes, reorderable sections**; track whatever you want beyond the stock fields and customize the visuals to your liking.
- **Automatic D&D wikidot spell links** - look up spells by clicking on them without awkward googling.
- **Mobile support** (open from the wand menu).
- **Talk to the tracker model directly via (💬)**, making editing or adding things easy.
- **Onboarding system** - roll up a random character or describe one to the model.
- **Profile saving** - switch between multiple campaigns without losing your state.
- **Homebrew-friendly** and flexible in general, relying on AI to do a lot of the lifting.
- **Automatic Long-Context Tracking** via the Lorebook Agent with World Engine simulation.
- **AI Portrait Generation** via Pollinations.ai — free, non-profit image generation with full lorebook agent context awareness for accurate character portraits.
- **Inventory Currency Auto-Rendering** — items with a worth value automatically display a styled coin badge (gold, silver, bronze, or dollar) based on the currency type.

<div align="center">
  <figure>
    <img width="1915" height="980" alt="image" src="https://github.com/user-attachments/assets/5cf03cdf-a413-401f-b685-0aa288714267" />
  </figure>
</div>

## Installation

**The packaged releases will likely not be up to date. I recommend cloning the repo or taking the steps below.**

1. Go to the SillyTavern extension menu.
2. Click on "Install extension" at the top.
3. Enter this repo's URL.

## Usage Guide

1. **Initial Setup:** Use the archetype buttons on the empty tracker to roll a new character, or paste an existing sheet into the "Raw View" (if your sheet doesn't align with what the UI expects, ask the model via 💬 to fix the formatting). Create a character card for your "narrator," such as Simulation Engine that I use. You can also name it something like Game Master.
2. **Auto-Tracking:** As you roleplay, the extension intelligently parses assistant responses. It detects losses of HP, new loot, or combat triggers, stitching together multi-part tool-call responses and running background passes to update the state.
3. **Prompt Injection & Execution:** The State Memo and RNG Queue are injected seamlessly into your outgoing prompt to act as the "source of truth." For narrative actions, the framework dynamically catches and resolves the AI's `RollTheDice` tool calls.
4. **Validation:** Use the Delta Log (δ) to verify changes. If the AI ever makes a mistake, step backwards using the Snapshot Navigation (←/→) to restore a clean state. Not really needed much in my experience, but the option is there.

## Suggested Companions

- 🧠 **[Summaryception](https://github.com/Lodactio/Extension-Summaryception):** A brilliant summarizer/context compression extension. Also handy for crunching all the combat mechanics of the context into summarized history.

## Don't Care About D&D?

You can scrap the entire system prompt and all the default fields and track your own things completely. The D&D setup is just a plug & play system that works by default. 

## What Model to Use?
Your primary narrator model must support **Tool Calling** for the Hybrid RNG system to work properly. 

<img width="920" height="246" alt="image" src="https://github.com/user-attachments/assets/f663cb1e-554a-40a2-a25e-f7af62c1a032" />

I like Deepseek 4 a lot so far, though it's still a new model. Gemini 3 is a good all-rounder; very fast and cheap. Sometimes its pace can be a bit much, though. GLM 5.1 is also a solid choice, but it can tend to reason far too long, bogging things down, especially in combat. Experimentation with different models is recommended.

For the state pass, I use Gemini 3.1 Flash Lite or Flash 3 with low reasoning. Very cheap and very good.

---

<p align="center">
  <img src="https://github.com/user-attachments/assets/a0e1c88c-092f-488b-b421-48cabe09e6e2" width="100%" alt="Combat in progress" />
  <br>
  <em>Some combat in progress</em>
</p>

---

<p align="center">
  <img src="https://github.com/user-attachments/assets/bd7debe0-b97d-4aa0-a8ec-49cd0fc527f3" width="500" alt="Lorebook Agent" />
  <br>
  <strong>Lorebook Agent</strong>
</p>

---

## License
MIT

***

*AND YES, IT IS FULLY VIBE-CODED IN ANTIGRAVITY AND CURSOR!*
