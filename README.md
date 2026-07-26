# 🐍 Snake Rush

A free, browser-based, Slither.io-style snake game — built with **vanilla HTML5 Canvas + JavaScript**, no frameworks, no dependencies. Eat food, grow massive, dodge and bite rival AI snakes, unlock achievements, and climb the leaderboard.

**Live:** https://snakerushgame.vercel.app

Built by [Shiva Saini](https://shivasainiportfolio.vercel.app) — [GitHub](https://github.com/Shiva-sainiiii) · [LinkedIn](https://www.linkedin.com/in/shiva-sainiiii)

---

## 📁 Folder Structure

```
SnakeRush/
├── index.html                  # Main entry point, SEO meta tags, structured data
├── robots.txt
├── sitemap.xml
├── favicon.ico
├── google5f62a4ee91bc28cd.html # Google Search Console verification
├── googledecff8a97b3b7f45.html # Google Search Console verification
│
├── css/
│   └── style.css               # All game + UI styling
│
├── js/
│   ├── game_part1.js           # Settings, persistence, daily challenge,
│   │                            # name generator, kill feed, audio manager
│   ├── game_part2.js           # Snake class (movement, growth, rendering)
│   ├── game_part3.js           # Game engine — collisions, AI, spawning,
│   │                            # scoring, HUD updates
│   ├── game_part4.js           # Additional systems / UI wiring
│   └── game_part5.js           # Bootstrap / init
│
└── assets/
    ├── favicon-512.png / favicon-192.png / favicon-32.png / favicon-16.png
    ├── apple-touch-icon.png
    ├── bgmusic.mp3          # Background music (loop)
    ├── eat.mp3              # Eating food
    ├── run.mp3              # Danger-zone running loop
    ├── panic.mp3            # Low-life panic loop
    ├── nearsnake.mp3        # Enemy snake nearby warning
    ├── enemybite.mp3        # Player bitten by enemy
    ├── kill.mp3             # Player kills an AI snake
    ├── gameover.mp3         # Death / game over
    ├── magnet.mp3           # Magnet power-up active
    ├── lifeline.mp3         # Lifeline power-up active
    ├── bossroar.mp3         # Titan Serpent (boss) spawn
    └── bosskill.mp3         # Titan Serpent defeated
```

> Script load order matters — `js/game_part1.js` through `game_part5.js` must load in sequence (see `<script>` tags in `index.html`), since later parts depend on classes/constants defined earlier.

---

## 🎮 Features

- **Classic & Time Trial** game modes
- **Daily Challenge** — seeded RNG so every player gets the same challenge on a given day (AI count, food count, world size, enabled power-ups all vary)
- **8 unlockable skins:** 4 free from the start (Multicolour, Fatty, Thin, Designer) + 4 earned via achievements/score milestones (Crimson Fang, Toxic Coil, Royal Serpent, Gilded Legend), persisted across sessions
- **8 power-ups:** Magnet, Attack, Shield, Ghost, Mine, Speed Boost, Lifeline
- **AI personalities:** aggressive, coward, hunter, farmer — with flocking behavior for aggressive types
- **Boss Snake** — the Titan Serpent spawns periodically, high risk/reward
- **Combo system** with floating multiplier text
- **Kill feed**, **screen shake**, **hit-stop on kills**, **death cinematic**
- **Achievement system** (8 achievements) with persistent profile stats
- **Live minimap**, **biome zones** (3×3 tinted grid), **animated electric fence border**
- **Firebase Firestore leaderboard**
- Touch **virtual joystick** + optional **gyroscope steering**
- Full SEO setup: JSON-LD `VideoGame`/`Person` schema, Open Graph, Twitter cards, sitemap

---

## ⚡ Performance Notes (Long-Session Optimization)

At very high length (thousands of food eaten in one run), two systems used to scale linearly with body length and caused stutter on mobile:

1. **Snake-vs-snake collision checks** — previously checked every single body segment against nearby snake heads, every frame. Now uses a **stride/sampling step** once a body exceeds 300 segments (segments are only 8px apart while hit-radius is much larger, so skipping some loses no real accuracy).
2. **Segment array growth** — previously the segment array grew forever with every food eaten, so movement (`_moveSegments`) got proportionally slower forever. Now capped at `MAX_PHYSICS_SEGMENTS` (600); beyond that, the snake keeps growing visually via a **girth multiplier** (thicker body) instead of more segments. The **Length** stat shown in the HUD still counts true food eaten, uncapped — only the simulated/physics body is capped.

Net effect: snake keeps looking and feeling bigger the more you eat, but frame cost stays bounded instead of climbing forever.

---

## 🛠️ Tech Stack

- Vanilla JavaScript (ES6 classes), HTML5 Canvas
- Firebase (Firestore leaderboard, Auth if applicable)
- Deployed on Vercel
- No build step — plain `<script>` includes

---

## 🚧 Roadmap / Next Up

- [ ] Live/real-time Firebase leaderboard updates
- [ ] Session streak / daily login rewards (XP or cosmetic per day)
- [ ] Mini in-session quests ("Kill 3 snakes", "Eat 50 food")
- [ ] Share-score card / screenshot export
- [ ] Difficulty curve — AI gets smarter the longer a session runs
- [ ] Randomized boss spawn interval (currently fixed at 90s)
