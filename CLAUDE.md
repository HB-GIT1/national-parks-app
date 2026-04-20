This project is a route-first national parks trip planner built as a single-page HTML/CSS/JS app.

Core principle:
This is NOT a generic map app. It is a planning tool for real road trips.

--------------------------------
PRODUCT MODEL
--------------------------------

The app has two parallel systems:

1. Curated loops (primary product)
   - prebuilt national park routes
   - OSRM-based official road lines
   - structured itineraries (legs, bases, airports)

2. Build Mode (secondary system)
   - user-defined custom park sequences
   - lightweight routing (OSRM + fallback)
   - no overnight base logic
   - no deep itinerary engine

These systems MUST remain separate.

--------------------------------
ENGINEERING RULES
--------------------------------

- Do NOT rewrite architecture
- Do NOT introduce frameworks
- Do NOT split into multiple files unless necessary
- Work inside index.html unless explicitly required otherwise
- loops.json is the only data file allowed to change

- Prefer small, explicit helper functions
- Reuse existing state and render flow
- Avoid adding new global state unless absolutely required

--------------------------------
ROUTING RULES
--------------------------------

- Curated loops:
  - Use prebuilt GeoJSON (official routes)
  - Never recompute these routes
  - Preserve "official vs preview" distinction

- Build Mode:
  - Use OSRM for routing
  - Fallback to straight-line if OSRM fails
  - Never block UI on routing failure

--------------------------------
EXPORT RULES
--------------------------------

- Export must NEVER fail silently

Google Maps:
- Max ~10 stops per request
- If route is too long or fails:
  → split into segments (A→B, B→C, etc.)
- Return multiple links if needed

Apple Maps:
- Prefer simple routes (start + end)
- If few stops → include middle
- Otherwise fallback cleanly

--------------------------------
MAP RULES
--------------------------------

- Core route = source of truth
- Do NOT fake or redraw official routes

- Overlays:
  - connectors (airport)
  - build mode routes
  - overnight bases

These must be visually distinct:
- official = strong
- preview = weak
- build = teal
- connectors = secondary

--------------------------------
UI RULES
--------------------------------

- Do NOT redesign layout
- Only make small, high-impact improvements

Focus on:
- clarity
- readability
- trip execution

--------------------------------
LEG CARD RULES
--------------------------------

Each leg must be immediately understandable:

Required clarity:
- What kind of day is this? (arrival, drive, base, return)
- Where do I sleep?
- Is this a long drive?

Rules:
- Highlight long drives (>4h)
- Show overnight explicitly
- Avoid generic text
- Use operational language

--------------------------------
IMAGES
--------------------------------

- Each park should have ONE strong image
- Use background-image with gradient overlay
- Ensure text readability

Fallback:
- if image fails → fallback image
- if none → neutral background

Do NOT:
- add galleries
- add sliders
- overcomplicate media

--------------------------------
BUILD MODE RULES
--------------------------------

- Build mode is lightweight and fast
- Park click = add to route
- No complex trip logic

- Keep:
  - ordered stops
  - OSRM route
  - export

Do NOT:
- mix with curated trip engine
- add itinerary complexity here

--------------------------------
CODE STYLE
--------------------------------

- Clear naming > clever naming
- No unnecessary abstractions
- No premature optimization

- Prefer:
  function doThing() {}
  over:
  const doThing = () => {}

--------------------------------
WHEN MODIFYING CODE
--------------------------------

Always:
1. Audit current behavior first
2. Identify exact weakness
3. Apply minimal fix
4. Do NOT break existing flows

--------------------------------
OUTPUT STYLE
--------------------------------

When responding:

1. Short audit summary
2. Exact problems
3. Exact fixes
4. Updated code

Be direct. No long explanations.