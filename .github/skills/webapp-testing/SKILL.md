---
name: webapp-testing
description: "Test local web app flows end-to-end. Use when user asks to verify UI behavior, click through pages, reproduce frontend bugs, capture screenshots, or validate browser-console/network issues."
---

# Web App Testing

## When to use
- Verify login/chat/forum flows from the browser perspective.
- Reproduce visual or interaction bugs that API tests do not catch.
- Capture evidence (screenshots/logs) for debugging.

## Procedure
1. Start the app and make sure target routes are reachable.
2. Navigate like a real user and wait for the page to fully load before interacting.
3. Execute the requested scenario (click, type, submit, navigation, permissions).
4. Report what worked, what failed, and exact UI state at failure points.

## Output expectations
- Include impacted route/page and the failing step.
- Include concise reproduction steps and observed vs expected behavior.
