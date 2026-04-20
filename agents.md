Read the codebase and the AGENTS.md file first.

Then do not implement anything yet.

I want you to act as a senior product engineer for this route-first travel planner.

Your task:
Audit the current product and identify the single highest-leverage next functional improvement.

Context:
- The app already has curated loops
- route/park mode
- preview vs official route distinction
- airport selection
- route-focused map UI
- route brief / slideover
- seed/manifest/geojson route architecture

Problem:
The product looks much better now, but it is still not useful enough.
It still feels stronger as an editorial demo than as a practical trip tool.

Your output must include:
1. The top 3 missing functional layers
2. Which one should be built next and why
3. Tradeoffs between:
   - navigation handoff
   - internal routing
   - route customization
   - lodging/gateway towns
4. A concrete milestone recommendation that can be implemented next without overbuilding

Important:
- Think product-first, not engineer-first
- No generic advice
- No future fantasies
- No code yet
- Be specific to this codebase